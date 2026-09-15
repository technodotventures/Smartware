// Shared commit transaction helper enforcing ops-log-last semantics.
//
// Protocol handlers (observe / correct / forget / compile / revise) wrap
// their cross-artifact writes in `runCommit(...)`. The helper:
//
//   1. Computes commit_ts once and exposes it to the work closure.
//   2. Runs the closure, which performs L0/L1/L2 writes in fixed order.
//   3. After the closure resolves, appends the operations-log entry. This
//      append is the durable commit signal.
//   4. If the closure throws, the ops-log entry is never written and the
//      partial state is detected by the recovery scan on the next startup.
//
// See docs/atomicity.md for the full rationale.
//
// IMPORTANT (this PR): the helper is plumbing only. No existing protocol
// handler adopts it yet — PR-3 (A2) migrates observe/correct/forget to
// use it. We land the API now so consumers can review the shape and so
// the conformance fixture has a target.

import { appendCommittedOpLogEntry, readAllOpLogEntries, type CommitFence } from './log.js';
import type { RecoveryFence } from './recovery.js';
import type { OpLogEntry, OpType } from './types.js';

/**
 * The full fencing surface a mutation carries (ADR-0010): the writer-path commit gate plus the
 * recovery-path dispositions (`RecoveryFence`). One adapter object implements both; handlers
 * that both commit and run a retry-time recovery scan take this type.
 */
export type MutationFence = CommitFence & RecoveryFence;

export interface CommitContext {
  /** Pod-wide `pod_data/operations/` */
  opsDir: string;
  /** Storage-level fencing (ADR-0010). Absent = unfenced caller (legacy behaviour). */
  fence?: MutationFence | null;
}

export class IdempotencyConflictError extends Error {
  constructor(operationId: string) {
    super(`OperationId '${operationId}' already exists with a different payload`);
    this.name = 'IdempotencyConflictError';
  }
}

function findExistingOp(opsDir: string, operationId: string): OpLogEntry | undefined {
  for (const entry of readAllOpLogEntries(opsDir)) {
    if (entry.operation_id === operationId) return entry;
  }
  return undefined;
}

/** Compare descriptor details ignoring the fencing stamp recovery/gating adds (ADR-0010). */
function withoutFenceStamp(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details || details['fence'] === undefined) return details;
  const { fence: _fence, ...rest } = details;
  return rest;
}

export interface CommitDescriptor {
  operation_id: string;
  actor_id: string;
  op: OpType;
  /** Operation-specific details (no PII; use IDs not content). */
  details?: Record<string, unknown>;
}

/**
 * Result of a committed operation. Callers typically return this from their
 * verb handler.
 */
export interface CommitResult<T> {
  /** The single timestamp used across every artifact for this operation. */
  commit_ts: string;
  /** Result produced by the work closure. */
  value: T;
}

/**
 * Run a cross-artifact commit.
 *
 * `work` receives `commit_ts` and must use it for every artifact's
 * timestamp (L1 `version_at`, L2 page `updated`, `forgotten_at`, etc.).
 * On success, the ops-log entry is appended last and `result.commit_ts`
 * mirrors the value the work closure consumed.
 *
 * Throw from `work` to abort. The ops-log entry will NOT be written;
 * any partial L1/L2 state becomes an orphan visible to the recovery scan.
 */
export async function runCommit<T>(
  ctx: CommitContext,
  descriptor: CommitDescriptor,
  work: (commit_ts: string) => Promise<T>,
): Promise<CommitResult<T>> {
  const existing = findExistingOp(ctx.opsDir, descriptor.operation_id);
  if (existing) {
    if (existing.op === descriptor.op
      && JSON.stringify(withoutFenceStamp(existing.details)) === JSON.stringify(withoutFenceStamp(descriptor.details))) {
      return { commit_ts: existing.timestamp, value: undefined as T };
    }
    throw new IdempotencyConflictError(descriptor.operation_id);
  }

  const commit_ts = new Date().toISOString();
  const value = await work(commit_ts);

  const entry: OpLogEntry = {
    operation_id: descriptor.operation_id,
    actor_id: descriptor.actor_id,
    timestamp: commit_ts,
    op: descriptor.op,
    details: descriptor.details,
  };
  appendCommittedOpLogEntry(ctx.opsDir, entry, ctx.fence);

  return { commit_ts, value };
}

export function runCommitSync<T>(
  ctx: CommitContext,
  descriptor: CommitDescriptor,
  work: (commit_ts: string) => T,
): CommitResult<T> {
  const existing = findExistingOp(ctx.opsDir, descriptor.operation_id);
  if (existing) {
    if (existing.op === descriptor.op
      && JSON.stringify(withoutFenceStamp(existing.details)) === JSON.stringify(withoutFenceStamp(descriptor.details))) {
      return { commit_ts: existing.timestamp, value: undefined as T };
    }
    throw new IdempotencyConflictError(descriptor.operation_id);
  }

  const commit_ts = new Date().toISOString();
  const value = work(commit_ts);

  const entry: OpLogEntry = {
    operation_id: descriptor.operation_id,
    actor_id: descriptor.actor_id,
    timestamp: commit_ts,
    op: descriptor.op,
    details: descriptor.details,
  };
  appendCommittedOpLogEntry(ctx.opsDir, entry, ctx.fence);
  return { commit_ts, value };
}
