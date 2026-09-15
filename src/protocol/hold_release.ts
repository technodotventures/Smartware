// Protocol — HOLD.RELEASE: the audited owner act that lifts a legal hold
// (ADR-0009, pre-production gate card t_463c1ff9; hardened by t_7a64ded2).
//
// A hold is opened by the hold lane (FORGET.SCOPE `offboarding`) in the same
// commit that tombstones the scope. While it is open, `FORGET.SCOPE reason:
// erasure` is refused (`legal_hold_open`) and the retention sweep skips the
// scope. Releasing it is owner-only, receipt-backed, and idempotent per
// operation_id; the hold record itself lives in `config.holds`, the canonical
// record of the act is one ops entry (`hold.release`).
//
// `operation_id` is REQUIRED (finding F1, card t_7a64ded2): it is the key that
// makes the act audited and replayable. A keyless release performed the act
// but wrote no canonical receipt — an unverifiable claim about a preservation
// duty, which is exactly what ADR-0009 §5 forbids.
//
// Replay is self-healing (finding F2): if the config write that pairs with the
// receipt was lost, a retry of the same operation_id re-publishes the recorded
// release into `config.holds` instead of answering "released" while the scope
// still reads OPEN. The ops entry is canonical; the config entry is state.
// (`saveConfig` is atomic + fsync since t_7a64ded2, so the divergence window
// itself is closed at the root; the replay convergence covers pods that
// already diverged, hand-edited configs, and any future writer that is not
// durable.) Convergence is duty-scoped — the receipt records which hold
// (offboarding operation) it lifted, and a hold opened afterwards is a NEW
// duty (ADR-0009 §2) that a stale replay must not lift.
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
  /**
   * Idempotency key — required. It is the audit key of the act: the release
   * writes exactly one `hold.release` ops entry under it, a retry returns the
   * recorded receipt, and a different payload under the same key conflicts.
   */
  operation_id: string;
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
  operation_id: string;
}

export interface HoldReleaseDeps {
  /** Pod data directory — contains config.json and operations/. */
  dataDir: string;
  opsDir: string;
  config: SmartwareConfig;
}

/** The parts of a committed release that are replayed from its ops entry. */
interface RecordedRelease {
  released_at: string;
  released_by: string;
  statement: string | null;
  /** The duty this release lifted: the offboarding op that opened that hold. */
  hold_operation_id: string | null;
}

function releasePayload(params: HoldReleaseParams): Record<string, unknown> {
  return {
    actor_id: params.actor.id,
    scope: params.scope,
    statement: params.statement ?? null,
  };
}

/**
 * Re-publish a recorded release into `config.holds` when the scope still reads
 * OPEN — a lost config write, a hand-edited config, or any non-durable writer.
 * The ops entry is the canonical record of the act (ADR-0009 §5), so a replay
 * must converge state to it rather than return a receipt the substrate itself
 * contradicts. No-op when the hold entry is absent (nothing to lift) or already
 * released (by this operation or another — either way the state is released).
 *
 * Convergence is DUTY-SCOPED: it repairs the divergence for the exact hold the
 * receipt names (`hold_operation_id` — the offboarding that opened it). A hold
 * opened after the release is a NEW duty (ADR-0009 §2); replaying an old
 * release must not lift it. Identity that cannot be established (a receipt from
 * before this field existed, a hold opened without an operation id) fails
 * closed: the refusal stays loud and a fresh release key converges it.
 */
function convergeReleasedHold(
  deps: HoldReleaseDeps,
  scope: string,
  operationId: string,
  recorded: RecordedRelease,
): void {
  if (recorded.hold_operation_id == null) return;
  const config = loadConfig(deps.dataDir);
  const hold = config.holds?.[scope];
  if (hold == null || hold.released_at != null) return;
  if (hold.operation_id !== recorded.hold_operation_id) return;
  hold.released_at = recorded.released_at;
  hold.released_by = recorded.released_by;
  hold.release_operation_id = operationId;
  hold.release_statement = recorded.statement;
  saveConfig(deps.dataDir, config);
}

/**
 * Release an open legal hold. Owner-only; idempotent per operation_id
 * (required). Refuses `no_open_hold` when the scope has no open hold — except
 * the crash-retry case where config already carries this operation_id (the ops
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
  if (typeof params.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(params.operation_id)) {
    // Required, and rejected before any mutation: the act must be receipted.
    throw new ProtocolError(
      'invalid_parameter',
      `HOLD.RELEASE requires an operation_id matching ${OPERATION_ID_PATTERN}`,
    );
  }
  if (params.statement != null && (typeof params.statement !== 'string' || params.statement.trim().length === 0)) {
    throw new ProtocolError('invalid_parameter', 'statement must be a non-empty string');
  }

  requireOwner(params.actor.id, deps.config);

  const payloadHash = computePayloadHash(releasePayload(params));

  // ── Idempotent replay: a committed release with this operation_id returns
  //    the recorded receipt (and conflicts on a different payload). The replay
  //    also re-publishes the release when the duty it names still reads OPEN,
  //    so the receipt and the state can never disagree.
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
    const priorStatement = typeof prior.details?.['statement'] === 'string' ? prior.details['statement'] : null;
    const priorHoldOperationId = typeof prior.details?.['hold_operation_id'] === 'string'
      ? prior.details['hold_operation_id']
      : null;
    convergeReleasedHold(deps, params.scope, params.operation_id, {
      released_at: releasedAt,
      released_by: releasedBy,
      statement: priorStatement,
      hold_operation_id: priorHoldOperationId,
    });
    return {
      scope: params.scope,
      status: 'released',
      released_at: releasedAt,
      released_by: releasedBy,
      statement: priorStatement,
      operation_id: params.operation_id,
    };
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
      && hold.release_operation_id === params.operation_id) {
      if (hold.release_statement !== (params.statement ?? null)) {
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
          statement: hold.release_statement,
          // The duty this release lifted (ADR-0009 §2 identity): a replay
          // converges only this hold, never a hold opened later.
          hold_operation_id: hold.operation_id,
        },
      });
      return {
        scope: params.scope,
        status: 'released',
        released_at: releasedAt,
        released_by: releasedBy,
        statement: hold.release_statement,
        operation_id: params.operation_id,
      };
    }
    throw new ProtocolError('no_open_hold', `Scope '${params.scope}' has no open legal hold`);
  }

  // ── The release: config first (durable), then ONE ops entry (the ops log is
  //    the canonical record; the config entry is provisioning state).
  const now = new Date().toISOString();
  const statement = params.statement ?? null;
  hold.released_at = now;
  hold.released_by = params.actor.id;
  hold.release_operation_id = params.operation_id;
  hold.release_statement = statement;
  saveConfig(deps.dataDir, config);

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
      // The duty this release lifted (ADR-0009 §2 identity): a replay
      // converges only this hold, never a hold opened later.
      hold_operation_id: hold.operation_id,
    },
  });

  return {
    scope: params.scope,
    status: 'released',
    released_at: now,
    released_by: params.actor.id,
    statement,
    operation_id: params.operation_id,
  };
}
