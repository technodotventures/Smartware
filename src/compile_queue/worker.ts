// Compile worker — drains the durable compile queue and turns raw
// observations into L1 claim versions in the background (spec §9.1: sync-raw
// write path, async compile on a durable queue; §10a: state-based freshness).
//
// The OBSERVE write path never extracts claims: it writes the raw
// observation to Layer 0, indexes it raw-searchable ('unverified'), and
// enqueues a compile job. This worker claims jobs in batches, runs the same
// per-observation production the synchronous REFLECT handler uses
// (produceObservationClaims — identical dedup decisions and receipts), and
// commits with batched appends (one fsync per month/day file). Freshness
// transitions are the only compile-queue side effect on the raw window:
//   success → 'EXTRACTED'   (claim ranks above; obs retained as evidence)
//   failure → 'FAILED'      (obs stays raw-searchable forever; flagged)
//
// Durability model: the queue row is the job ledger; claim versions + ops
// entries are flushed BEFORE the job completes, so a crash mid-batch leaves
// the job 'running' → reset to 'pending' on the next open → re-processed.
// The fingerprint index makes re-processing idempotent (matching claims
// already written are deduplicated, and the receipt is re-emitted).

import { readAll } from '../layer0/log.js';
import type { Layer0Index } from '../layer0/index.js';
import type { Observation } from '../layer0/types.js';
import type { ClaimStore } from '../layer1/store.js';
import type { Claim } from '../layer1/types.js';
import type { SearchIndex } from '../layer3/search.js';
import { substrateActorId, type SmartwareConfig } from '../config.js';
import { defaultFingerprintIndexPath, openFingerprintIndex, type FingerprintIndex } from './fingerprint.js';
import { CompileQueue, defaultCompileQueuePath } from './queue.js';
import { nextOperationId } from './ids.js';
import {
  buildReflectClaimOpEntry,
  commitReflectClaimBatch,
  isReflectAutoTerminalReceipt,
  produceObservationClaims,
  type ReflectAutoTerminalOutcome,
} from '../protocol/reflect.js';
import {
  defaultOpsIndexPath,
  openOpsIndex,
  readAllOpLogEntries,
  type CommitContext,
  type OpLogEntry,
  type OpsIndex,
} from '../ops_log/index.js';
import type { ActiveClaimVersion } from '../layer1/jsonl.js';

/** Background loop interval default (used by startCompileWorker). */
export const DEFAULT_COMPILE_INTERVAL_MS = 2000;
/** Default jobs claimed per drain. */
export const DEFAULT_COMPILE_BATCH_LIMIT = 200;

export interface CompileWorkerContext {
  evidenceDir: string;
  /** Pod data dir — <dataDir>/claims is the L1 canonical surface. */
  dataDir: string;
  layer0: Layer0Index;
  store: ClaimStore;
  searchIndex: SearchIndex;
  config: SmartwareConfig;
  opsDir?: string;
  queue: CompileQueue;
  fingerprintIndex: FingerprintIndex;
}

export interface CompileBatchResult {
  claimed: number;
  processed: number;
  new_claims: number;
  claim_versions_written: number;
  extracted: number;
  failed: number;
  failed_observation_ids: string[];
}

/**
 * The substrate ActorId this worker's autonomous writes carry.
 *
 * Kept as the compile-queue barrel's public name; mints through the one
 * canonical helper (`substrateActorId`, src/config.ts) so the queue, the
 * synchronous REFLECT handler and dream write the same identity.
 */
export function podActorId(config: SmartwareConfig): string {
  return substrateActorId(config);
}

/** Body projection used by the shared production function. */
function observationBodyText(obs: Observation): string {
  if (typeof obs.content.body === 'string') return obs.content.body;
  if (obs.content.body && typeof obs.content.body === 'object' && 'body' in obs.content.body) {
    const inner = (obs.content.body as { body: unknown }).body;
    return typeof inner === 'string' ? inner : JSON.stringify(inner);
  }
  return JSON.stringify(obs.content.body);
}

/** Safe error message (no content/PII in durable surfaces). */
function errorLabel(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 240);
}

/**
 * Claim one queue batch and compile it. Empty result when nothing is pending.
 * Never throws for per-observation failures — those become FAILED jobs.
 */
export async function runCompileBatch(
  ctx: CompileWorkerContext,
  opts: { limit?: number; useLLM?: boolean; produce?: typeof produceObservationClaims } = {},
): Promise<CompileBatchResult> {
  const limit = opts.limit ?? DEFAULT_COMPILE_BATCH_LIMIT;
  const jobs = ctx.queue.claimBatch(limit);
  if (jobs.length === 0) {
    return { claimed: 0, processed: 0, new_claims: 0, claim_versions_written: 0, extracted: 0, failed: 0, failed_observation_ids: [] };
  }

  const jobIds = new Set(jobs.map(job => job.observation_id));
  const obsById = new Map<string, Observation>();
  for (const obs of readAll(ctx.evidenceDir)) {
    if (jobIds.has(obs.id)) obsById.set(obs.id, obs);
  }

  const actorId = podActorId(ctx.config);
  const commitCtx: CommitContext | undefined = ctx.opsDir ? { opsDir: ctx.opsDir } : undefined;
  const pendingRecords: ActiveClaimVersion[] = [];
  const pendingOpEntries: OpLogEntry[] = [];
  const produce = opts.produce ?? produceObservationClaims;

  let processedCount = 0;
  let newClaims = 0;
  let claimVersionsWritten = 0;
  let failedCount = 0;
  const failedObservationIds: string[] = [];

  for (const job of jobs) {
    const obs = obsById.get(job.observation_id);
    // Effective-status guard (spec §10): a scope-level erasure/offboarding
    // marker flips an observation's Layer-0 status while its JSONL status
    // stays 'accepted' (the marker is a separate event). Compiling an erased
    // observation would resurrect the content the FORGET.SCOPE retired, so
    // the worker consults Layer 0, not just the raw row.
    const effective = obs ? (ctx.layer0.getEffectiveStatus(obs.id) ?? obs.status) : null;
    if (!obs || effective !== 'accepted' || obs.type === 'claim_extracted' || obs.type === 'correction' || obs.type === 'tombstone' || obs.type === 'erasure') {
      // Nothing to compile: terminal state, or the job is a ghost. Mark done
      // so the ledger stays clean; the raw window is not affected (these
      // observations are either not indexed or status-filtered already).
      ctx.queue.complete(job.observation_id);
      continue;
    }

    try {
      const bodyText = observationBodyText(obs);
      if (!bodyText || bodyText.length < 10) {
        // Observed but not extractable — resolution is terminal, not a failure.
        pendingOpEntries.push(reflectReceipt(obs, actorId, 'ignored_short_content', { candidates_found: 0, claim_versions_written: 0 }));
        processedCount++;
        continue;
      }

      const production = await produce(obs, bodyText, {
        dataDir: ctx.dataDir,
        store: ctx.store,
        config: ctx.config,
        useLLM: opts.useLLM === true,
        podActorId: actorId,
        commitTs: new Date().toISOString(),
        fingerprintIndex: ctx.fingerprintIndex,
      });
      for (const { record, isNew } of production.records) {
        pendingRecords.push(record);
        pendingOpEntries.push(buildReflectClaimOpEntry(record));
        if (isNew) newClaims++;
        claimVersionsWritten++;
      }
      pendingOpEntries.push(reflectReceipt(obs, actorId, production.outcome, {
        candidates_found: production.candidates_found,
        claim_versions_written: production.records.length,
      }));
      processedCount++;
    } catch (error) {
      // Per-observation fault isolation: one bad observation never fails the
      // batch. FAILED stays raw-searchable forever (spec §10a) and the queue
      // keeps the durable ledger entry for audit + explicit retry.
      const label = errorLabel(error);
      ctx.queue.fail(job.observation_id, label);
      ctx.searchIndex.updateObservationFreshness(job.observation_id, 'FAILED');
      pendingOpEntries.push({
        operation_id: nextOperationId(),
        actor_id: actorId,
        timestamp: new Date().toISOString(),
        op: 'reflect.auto',
        details: {
          reflection_complete: false,
          outcome: 'failed',
          freshness: 'FAILED',
          observation_id: job.observation_id,
          scope: job.scope,
          error: label,
        },
      });
      failedCount++;
      failedObservationIds.push(job.observation_id);
      continue;
    }
  }

  // Commit: batched appends (one fsync per month/day file), THEN close the
  // queue rows + flip freshness, so a crash between flush and completion
  // re-runs the job idempotently instead of losing the claims.
  if (pendingRecords.length > 0 || pendingOpEntries.length > 0) {
    commitReflectClaimBatch(ctx.dataDir, pendingRecords, pendingOpEntries, commitCtx);
    // Mirror the new versions into the L1 store. One transaction per
    // connection: the store and the search index share the SQLite FILE but
    // use separate connections, so each writes inside its own transaction
    // (a cross-connection transaction deadlocks on SQLITE_BUSY).
    let mirrored: Claim[] = [];
    ctx.store.transaction(() => {
      for (const record of pendingRecords) {
        ctx.store.syncFromJsonlVersion(record);
        const claim = ctx.store.getClaim(record.claim_id);
        if (claim) mirrored.push(claim);
      }
    });
    if (mirrored.length > 0) ctx.searchIndex.indexSingleClaims(mirrored);
  }

  const succeededJobIds: string[] = [];
  for (const jobSucceeded of jobs) {
    if (failedObservationIds.includes(jobSucceeded.observation_id)) continue;
    if (!obsById.has(jobSucceeded.observation_id)) continue;
    const obs = obsById.get(jobSucceeded.observation_id)!;
    if (obs.status !== 'accepted') continue;
    ctx.queue.complete(jobSucceeded.observation_id);
    succeededJobIds.push(jobSucceeded.observation_id);
  }
  if (succeededJobIds.length > 0) {
    ctx.searchIndex.updateObservationsFreshness(succeededJobIds, 'EXTRACTED');
  }

  return {
    claimed: jobs.length,
    processed: processedCount,
    new_claims: newClaims,
    claim_versions_written: claimVersionsWritten,
    extracted: processedCount,
    failed: failedCount,
    failed_observation_ids: failedObservationIds,
  };
}

/** Terminal receipt with the literal state-based freshness label (§10a). */
function reflectReceipt(
  obs: Observation,
  actorId: string,
  outcome: ReflectAutoTerminalOutcome,
  details: Record<string, unknown>,
): OpLogEntry {
  return {
    operation_id: nextOperationId(),
    actor_id: actorId,
    timestamp: new Date().toISOString(),
    op: 'reflect.auto',
    details: {
      ...details,
      observation_id: obs.id,
      scope: obs.scope,
      reflection_complete: true,
      outcome,
      freshness: 'EXTRACTED',
    },
  };
}

/**
 * Seed/reconcile the durable compile queue with the canonical evidence log.
 * Regenerable check (spec §10a rebuild-equivalence applies to the derived
 * compile state as well):
 *   - jobs left 'running' by a dead process → 'pending' (crash recovery);
 *   - observation with a terminal receipt (ops log) → done + EXTRACTED;
 *   - observation with a failure marker → failed + FAILED;
 *   - any other accepted observation → pending.
 * Returns the number of newly enqueued observations.
 */
export function syncCompileQueue(
  ctx: Pick<CompileWorkerContext, 'evidenceDir' | 'dataDir' | 'layer0' | 'searchIndex' | 'opsDir'>,
  queue: CompileQueue,
): number {
  queue.resetStale();

  const receiptsByObs = new Map<string, { resolved: boolean; failed: boolean }>();
  if (ctx.opsDir) {
    let opsEntries: OpLogEntry[];
    try {
      const opsIndex = openOpsIndex(ctx.opsDir, defaultOpsIndexPath(ctx.dataDir));
      opsEntries = opsIndex.entriesByOp('reflect.auto');
      opsIndex.close();
    } catch {
      opsEntries = [...readAllOpLogEntries(ctx.opsDir)];
    }
    for (const entry of opsEntries) {
      if (isReflectAutoTerminalReceipt(entry)) {
        receiptsByObs.set(entry.details['observation_id'], { resolved: true, failed: false });
      } else if (entry.details?.['outcome'] === 'failed') {
        const obsId = entry.details['observation_id'];
        if (typeof obsId === 'string') {
          receiptsByObs.set(obsId, { resolved: false, failed: true });
        }
      }
    }
  }

  let seeded = 0;
  for (const obs of readAll(ctx.evidenceDir)) {
    if (obs.status !== 'accepted') continue;
    // Layer-0 effective-status guard (spec §10): a scope-level erasure or
    // offboarding marker makes the observation terminal even though its
    // JSONL row says 'accepted'; reseeding it would let the worker re-derive
    // retired content. Terminal observations never enter the queue.
    const effective = ctx.layer0.getEffectiveStatus(obs.id) ?? obs.status;
    if (effective !== 'accepted') continue;
    const state = receiptsByObs.get(obs.id);
    if (state?.resolved) {
      // Regeneration: receipts are the source of terminal outcomes; make the
      // row exist first, then transition it (complete/fail are updates).
      queue.enqueue(obs.id, obs.scope);
      if (queue.get(obs.id)?.status !== 'done') queue.complete(obs.id);
      ctx.searchIndex.updateObservationFreshness(obs.id, 'EXTRACTED');
      continue;
    }
    if (state?.failed) {
      queue.enqueue(obs.id, obs.scope);
      if (queue.get(obs.id)?.status !== 'failed') queue.fail(obs.id, 'compile failed previously');
      ctx.searchIndex.updateObservationFreshness(obs.id, 'FAILED');
      continue;
    }
    const existing = queue.get(obs.id);
    if (existing && (existing.status === 'pending' || existing.status === 'running')) continue;
    queue.enqueue(obs.id, obs.scope);
    seeded++;
  }
  return seeded;
}

/**
 * Open the derived compile-queue artifacts for a pod (queue + fingerprint
 * index) and seed the queue from the evidence log. `undefined` on derived-DB
 * failure (queue disabled, degraded pod).
 */
export async function openCompileQueue(
  ctx: Pick<CompileWorkerContext, 'evidenceDir' | 'dataDir' | 'layer0' | 'searchIndex' | 'opsDir'>,
): Promise<{ queue: CompileQueue; fingerprintIndex: FingerprintIndex } | null> {
  try {
    const queue = new CompileQueue(defaultCompileQueuePath(ctx.dataDir));
    const fingerprintIndex = openFingerprintIndex(ctx.dataDir, defaultFingerprintIndexPath(ctx.dataDir));
    syncCompileQueue(ctx, queue);
    return { queue, fingerprintIndex };
  } catch {
    return null;
  }
}

/**
 * Background loop — one drain per interval. Returns a stop function. The
 * timer is unref'd so it never keeps the process alive by itself.
 */
export function startCompileWorker(
  ctx: CompileWorkerContext,
  opts: { intervalMs?: number; limit?: number } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? DEFAULT_COMPILE_INTERVAL_MS;
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    runCompileBatch(ctx, { limit: opts.limit })
      .catch(() => { /* batch-level failure is logged by the caller */ })
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
