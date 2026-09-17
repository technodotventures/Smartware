// Ingestion — sync status projection.
//
// The host (Coffee) owns scheduling and the sync loop; this is the read the
// host renders: per registered source, per scope, where the stream cursor is,
// when it last moved, and what the batches did (accepted / duplicated /
// quarantined / rejected). It is a fold of the durable batch ledger plus the
// source registry — no new state, no new writes.
//
// A registered source with no batches is reported honestly: connected, never
// synced (empty scopes, null last_sync, zero totals). A named source that is
// not registered denies (`source_unregistered`) rather than answering empty —
// an unknown source is a bug in the caller, not "no data".

import type { SmartwareConfig, SourceKind, SourceStatus } from '../config.js';
import { ProtocolError } from '../auth/middleware.js';
import { listSourceEntries } from './sources.js';
import type { IngestionStore } from './store.js';

export interface SourceSyncScope {
  scope: string;
  /** Latest committed checkpoint for this (source, scope) stream. */
  cursor: string;
  cursor_before: string | null;
  synced_at: string;
  batches: number;
  accepted: number;
  duplicated: number;
  quarantined: number;
  rejected: number;
}

export interface SourceLastSync {
  operation_id: string;
  actor_id: string;
  scope: string;
  cursor: string;
  cursor_before: string | null;
  synced_at: string;
  accepted: number;
  duplicated: number;
  quarantined: number;
  rejected: number;
}

export interface SourceSyncStatus {
  source_id: string;
  kind: SourceKind;
  display_name: string;
  status: SourceStatus;
  /** Most recent committed batch for this source, or null (never synced). */
  last_sync: SourceLastSync | null;
  /** Per-scope stream rows, sorted by scope. */
  scopes: SourceSyncScope[];
  totals: {
    batches: number;
    accepted: number;
    duplicated: number;
    quarantined: number;
    rejected: number;
  };
}

export function computeSourceSyncStatus(
  config: SmartwareConfig,
  store: IngestionStore,
  sourceId?: string,
): SourceSyncStatus[] {
  const entries = listSourceEntries(config);
  const selected = sourceId ? entries.filter(entry => entry.id === sourceId) : entries;
  if (sourceId && selected.length === 0) {
    throw new ProtocolError(
      'source_unregistered',
      `Source '${sourceId}' is not registered with this Pod.`,
    );
  }

  return selected.map(entry => {
    const batches = store.listBatches(entry.id); // oldest first
    const byScope = new Map<string, SourceSyncScope>();

    for (const batch of batches) {
      const row = byScope.get(batch.scope);
      if (row) {
        row.cursor = batch.cursor;
        row.cursor_before = batch.cursor_before;
        row.synced_at = batch.synced_at;
        row.batches += 1;
        row.accepted += batch.accepted;
        row.duplicated += batch.duplicated;
        row.quarantined += batch.quarantined;
        row.rejected += batch.rejected;
      } else {
        byScope.set(batch.scope, {
          scope: batch.scope,
          cursor: batch.cursor,
          cursor_before: batch.cursor_before,
          synced_at: batch.synced_at,
          batches: 1,
          accepted: batch.accepted,
          duplicated: batch.duplicated,
          quarantined: batch.quarantined,
          rejected: batch.rejected,
        });
      }
    }

    const scopes = [...byScope.values()].sort((left, right) => left.scope.localeCompare(right.scope));
    const latest = batches.length > 0 ? batches[batches.length - 1]! : null;

    return {
      source_id: entry.id,
      kind: entry.kind,
      display_name: entry.display_name,
      status: entry.status,
      last_sync: latest
        ? {
            operation_id: latest.operation_id,
            actor_id: latest.actor_id,
            scope: latest.scope,
            cursor: latest.cursor,
            cursor_before: latest.cursor_before,
            synced_at: latest.synced_at,
            accepted: latest.accepted,
            duplicated: latest.duplicated,
            quarantined: latest.quarantined,
            rejected: latest.rejected,
          }
        : null,
      scopes,
      totals: {
        batches: batches.length,
        accepted: scopes.reduce((sum, row) => sum + row.accepted, 0),
        duplicated: scopes.reduce((sum, row) => sum + row.duplicated, 0),
        quarantined: scopes.reduce((sum, row) => sum + row.quarantined, 0),
        rejected: scopes.reduce((sum, row) => sum + row.rejected, 0),
      },
    };
  });
}
