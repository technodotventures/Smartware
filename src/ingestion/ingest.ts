// Ingestion — batch admission with idempotent cursors.
//
// The host (Coffee) owns OAuth, scheduling and the connector call itself. It
// polls a source, then hands Smartware *one batch per page* with:
//
//   actor      — the authenticated identity running the sync (required)
//   source_id  — the registered provenance origin (required, fail-closed)
//   scope      — where the evidence belongs (actor's observe grant applies)
//   cursor     — the stream checkpoint AFTER this page (opaque, stored verbatim)
//   operation_id — ULID idempotency key for the batch
//   items      — source-native items (each with its own external_id)
//
// Guarantees:
//   * fail-closed context — missing/unknown/inactive/forbidden source context,
//     a scope the actor cannot write, a malformed operation_id, an empty
//     cursor or an oversized batch are all denied BEFORE any write;
//   * per-item idempotency — an item is one observation keyed by
//     (source app, external_id), so retries and replays never mint twins;
//   * batch idempotency — replaying an operation_id returns the recorded
//     receipt (`status: 'replayed'`) and performs no writes;
//   * convergence — a crash mid-batch leaves written items deduplicated on
//     retry and the remaining items complete exactly once;
//   * honest item failures — a rejected item is recorded with its protocol
//     error code in the receipt and in sync status; the batch still advances
//     (a poisoned mailbox item must not wedge the connector forever).

import type { Observation } from '../layer0/types.js';
import type { SmartwareConfig } from '../config.js';
import type { Layer0Index } from '../layer0/index.js';
import type { SessionStore } from '../session/store.js';
import { ProtocolError, requireGrant } from '../auth/middleware.js';
import { computePayloadHash } from '../layer0/idempotency.js';
import { OPERATION_ID_PATTERN } from '../ops_log/index.js';
import { handleObserve } from '../protocol/observe.js';
import { requireActiveSource } from './sources.js';
import type { IngestionStore } from './store.js';
import type {
  IngestHooks,
  IngestItemResult,
  IngestParams,
  IngestResult,
} from './types.js';

/** Bounded batch: hosts chunk larger pages; keeps item results in one row. */
export const MAX_INGEST_ITEMS = 500;

export interface IngestDeps {
  evidenceDir: string;
  layer0: Layer0Index;
  config: SmartwareConfig;
  store: IngestionStore;
  sessionStore?: SessionStore;
  /** Same post-commit hook the OBSERVE path uses (index + compile queue). */
  afterObservation?: (observation: Observation) => void;
}

export async function handleIngest(
  params: IngestParams,
  deps: IngestDeps,
  hooks?: IngestHooks,
): Promise<IngestResult> {
  const config = deps.config;

  // ── 1. Fail-closed context validation — before any payload hash or write ──
  if (!params.source_id) {
    throw new ProtocolError('source_required', 'Ingestion requires a registered source_id');
  }
  const source = requireActiveSource(config, params.source_id, params.actor.id);
  if (!params.scope) {
    throw new ProtocolError('invalid_scope', 'Scope is required');
  }
  requireGrant(params.actor.id, 'observe', params.scope, config);
  if (!params.operation_id || !OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError(
      'invalid_parameter',
      `Invalid operation_id '${params.operation_id}' for ingestion batch`,
    );
  }
  if (typeof params.cursor !== 'string' || params.cursor.length === 0) {
    throw new ProtocolError('invalid_parameter', 'Ingestion cursor is required (use the stream position reached by this batch)');
  }
  if (!Array.isArray(params.items)) {
    throw new ProtocolError('invalid_parameter', 'Ingestion items must be an array');
  }
  if (params.items.length > MAX_INGEST_ITEMS) {
    throw new ProtocolError(
      'invalid_parameter',
      `Ingestion batch too large (${params.items.length} items; maximum ${MAX_INGEST_ITEMS})`,
    );
  }

  const payloadHash = computePayloadHash({
    actor_id: params.actor.id,
    source_id: source.id,
    scope: params.scope,
    cursor: params.cursor,
    items: params.items,
  });

  // ── 2. Replay: a committed batch returns its recorded receipt verbatim ────
  const committed = deps.store.findBatch(params.operation_id);
  if (committed) {
    if (committed.payload_hash !== payloadHash) {
      throw new ProtocolError(
        'conflict',
        `operation_id '${params.operation_id}' was already used with a different payload`,
      );
    }
    return { ...toResult(committed), status: 'replayed' };
  }

  // ── 3. Stream checkpoint: the previous batch's cursor for this (source, scope)
  const prior = deps.store.latestBatch(source.id, params.scope);
  const cursorBefore = prior?.cursor ?? null;

  // ── 4. Write the items. Each item is an observation; a protocol-level
  //       failure is item-local (recorded, not fatal), never a partial batch.
  const app = params.app ?? source.id;
  const results: IngestItemResult[] = [];
  for (let index = 0; index < params.items.length; index += 1) {
    const item = params.items[index]!;
    let result: IngestItemResult;
    if (!item || typeof item.external_id !== 'string' || item.external_id.length === 0) {
      result = { external_id: '', status: 'rejected', code: 'invalid_parameter' };
    } else {
      try {
        const observed = await handleObserve(
          {
            actor: params.actor,
            type: item.type,
            content: item.content,
            scope: params.scope,
            visibility: item.visibility,
            sensitive: item.sensitive,
            informed_by: item.informed_by,
            parent_ids: item.parent_ids,
            observed_at: item.observed_at,
            app,
            source_id: item.external_id,
            source_ref: source.id,
          },
          deps.evidenceDir,
          deps.layer0,
          config,
          deps.sessionStore,
          undefined,
          { afterObservation: deps.afterObservation },
        );
        result = observed.status === 'duplicate'
          ? { external_id: item.external_id, status: 'duplicate', observation_id: observed.id }
          : { external_id: item.external_id, status: observed.status, observation_id: observed.id };
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        result = { external_id: item.external_id, status: 'rejected', code: error.code };
      }
    }
    results.push(result);
    hooks?.afterItem?.(result, index);
  }

  // ── 5. Commit the batch receipt. Only a fully processed batch advances the
  //       cursor; a crash before this point leaves retryable, deduped items.
  const accepted = results.filter(item => item.status === 'accepted').length;
  const duplicated = results.filter(item => item.status === 'duplicate').length;
  const quarantined = results.filter(item => item.status === 'quarantined').length;
  const rejected = results.filter(item => item.status === 'rejected').length;
  const syncedAt = new Date().toISOString();

  deps.store.recordBatch({
    operation_id: params.operation_id,
    source_id: source.id,
    scope: params.scope,
    actor_id: params.actor.id,
    payload_hash: payloadHash,
    cursor_before: cursorBefore,
    cursor: params.cursor,
    accepted,
    duplicated,
    quarantined,
    rejected,
    items: results,
    synced_at: syncedAt,
  });

  return {
    status: 'ok',
    operation_id: params.operation_id,
    source_id: source.id,
    scope: params.scope,
    cursor: params.cursor,
    cursor_before: cursorBefore,
    accepted,
    duplicated,
    quarantined,
    rejected,
    items: results,
    synced_at: syncedAt,
  };
}

function toResult(record: {
  operation_id: string;
  source_id: string;
  scope: string;
  cursor: string;
  cursor_before: string | null;
  accepted: number;
  duplicated: number;
  quarantined: number;
  rejected: number;
  items: IngestItemResult[];
  synced_at: string;
}): IngestResult {
  return {
    status: 'ok',
    operation_id: record.operation_id,
    source_id: record.source_id,
    scope: record.scope,
    cursor: record.cursor,
    cursor_before: record.cursor_before,
    accepted: record.accepted,
    duplicated: record.duplicated,
    quarantined: record.quarantined,
    rejected: record.rejected,
    items: record.items,
    synced_at: record.synced_at,
  };
}
