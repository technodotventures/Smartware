// Protocol — HOLD.RELEASE: the audited owner act that lifts a legal hold
// (ADR-0009, pre-production gate card t_463c1ff9).
//
// A hold is opened by the hold lane (FORGET.SCOPE `offboarding`) in the same
// commit that tombstones the scope. While it is open, `FORGET.SCOPE reason:
// erasure` is refused (`legal_hold_open`) and the retention sweep skips the
// scope. Releasing it is owner-only, receipt-backed, and idempotent per
// operation_id; the hold record itself lives in `config.holds`, the canonical
// record of the act is one ops entry (`hold.release`).
//
// Release does NOT revive: the scope stays offboarded (tombstoned claims,
// revoked grants, retained bytes) until erasure or a `#N` return. It only
// lifts the preservation duty.

import type { Actor } from '../layer0/types.js';
import { computePayloadHash } from '../layer0/idempotency.js';
import { loadConfig, saveConfig, type SmartwareConfig } from '../config.js';
import { appendOpLogEntry, OPERATION_ID_PATTERN, readAllOpLogEntries } from '../ops_log/index.js';
import { requireOwner, ProtocolError } from '../auth/middleware.js';

export interface HoldReleaseParams {
  actor: Actor;
  /** The scope id, e.g. `client:acme#1`. */
  scope: string;
  /** Idempotency key — a retry returns the recorded receipt. */
  operation_id?: string;
  /**
   * The owner's hold-release statement — the Coffee F3 attestation ("no
   * pending dispute / verified request / hold released"). Non-PII phrase;
   * recorded in the hold entry and the ops entry.
   */
  statement?: string | null;
}

export interface HoldReleaseResult {
  scope: string;
  status: 'released';
  released_at: string;
  released_by: string;
  statement: string | null;
  operation_id?: string;
}

export interface HoldReleaseDeps {
  /** Pod data directory — contains config.json and operations/. */
  dataDir: string;
  opsDir: string;
  config: SmartwareConfig;
}

function releasePayload(params: HoldReleaseParams): Record<string, unknown> {
  return {
    actor_id: params.actor.id,
    scope: params.scope,
    statement: params.statement ?? null,
  };
}

/**
 * Release an open legal hold. Owner-only; idempotent per operation_id.
 * Refuses `no_open_hold` when the scope has no open hold — except the
 * crash-retry case where config already carries this operation_id (the ops
 * entry, written last, is finalized from the recorded state).
 */
export async function handleHoldRelease(
  params: HoldReleaseParams,
  deps: HoldReleaseDeps,
): Promise<HoldReleaseResult> {
  if (!params.scope) {
    throw new ProtocolError('invalid_parameter', 'A scope is required');
  }
  if (params.scope === 'self' || params.scope === 'workspace') {
    // Same boundary as FORGET.SCOPE: pod-internal scopes are not client
    // erasure/hold boundaries.
    throw new ProtocolError(
      'invalid_parameter',
      `HOLD.RELEASE targets client scopes only; '${params.scope}' is pod-internal`,
    );
  }
  if (params.operation_id && !OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }
  if (params.statement != null && (typeof params.statement !== 'string' || params.statement.trim().length === 0)) {
    throw new ProtocolError('invalid_parameter', 'statement must be a non-empty string');
  }

  requireOwner(params.actor.id, deps.config);

  const payloadHash = computePayloadHash(releasePayload(params));
  const statement = params.statement ?? null;

  // ── Idempotent replay: a committed release with this operation_id returns
  //    the recorded receipt (and conflicts on a different payload).
  if (params.operation_id) {
    const prior = [...readAllOpLogEntries(deps.opsDir)]
      .find(entry => entry.operation_id === params.operation_id && entry.op === 'hold.release');
    if (prior) {
      if (prior.actor_id !== params.actor.id || prior.details?.['payload_hash'] !== payloadHash) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already used with a different payload`);
      }
      const releasedAt = prior.details?.['released_at'];
      const releasedBy = prior.details?.['released_by'];
      if (typeof releasedAt !== 'string' || typeof releasedBy !== 'string') {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' has no replayable HOLD.RELEASE result`);
      }
      return {
        scope: params.scope,
        status: 'released',
        released_at: releasedAt,
        released_by: releasedBy,
        statement: typeof prior.details?.['statement'] === 'string' ? prior.details['statement'] : null,
        operation_id: params.operation_id,
      };
    }
  }

  // Hold state is read fresh from disk: the hold lane writes config directly,
  // and the caller's in-memory config may predate that write.
  const config = loadConfig(deps.dataDir);
  const hold = config.holds?.[params.scope];
  const open = hold != null && hold.released_at == null;

  if (!open) {
    // Crash-retry reconciliation: the hold entry already carries this release
    // (config is written before the ops entry) — finalize the receipt.
    if (hold != null && hold.released_at != null
      && params.operation_id && hold.release_operation_id === params.operation_id) {
      if (hold.release_statement !== statement) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already used with a different payload`);
      }
      const releasedAt = hold.released_at;
      const releasedBy = hold.released_by ?? params.actor.id;
      appendOpLogEntry(deps.opsDir, {
        operation_id: params.operation_id,
        actor_id: params.actor.id,
        timestamp: releasedAt,
        op: 'hold.release',
        details: {
          payload_hash: payloadHash,
          scope: params.scope,
          released_at: releasedAt,
          released_by: releasedBy,
          statement,
        },
      });
      return {
        scope: params.scope,
        status: 'released',
        released_at: releasedAt,
        released_by: releasedBy,
        statement,
        operation_id: params.operation_id,
      };
    }
    throw new ProtocolError('no_open_hold', `Scope '${params.scope}' has no open legal hold`);
  }

  // ── The release: config first, then ONE ops entry (the ops log is the
  //    canonical record; the config entry is provisioning state).
  const now = new Date().toISOString();
  hold.released_at = now;
  hold.released_by = params.actor.id;
  hold.release_operation_id = params.operation_id ?? null;
  hold.release_statement = statement;
  saveConfig(deps.dataDir, config);

  if (params.operation_id) {
    appendOpLogEntry(deps.opsDir, {
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      timestamp: now,
      op: 'hold.release',
      details: {
        payload_hash: payloadHash,
        scope: params.scope,
        released_at: now,
        released_by: params.actor.id,
        statement,
      },
    });
  }

  return {
    scope: params.scope,
    status: 'released',
    released_at: now,
    released_by: params.actor.id,
    statement,
    ...(params.operation_id ? { operation_id: params.operation_id } : {}),
  };
}
