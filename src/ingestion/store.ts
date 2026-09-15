// Ingestion — batch ledger (SQLite, per brain).
//
// The ledger is the durable record behind three host-facing guarantees:
//
//   1. *idempotent cursors* — every committed batch records the stream
//      checkpoint (cursor) it advanced to, per (source, scope), so a host can
//      resume exactly where it stopped even across restarts;
//   2. *replay* — a batch is keyed by its operation_id; retrying it returns
//      the recorded receipt and performs no writes;
//   3. *sync status* — the fold of the ledger is what Coffee renders ("last
//      synced N minutes ago, cursor X, 148 accepted, 0 skipped").
//
// Honesty note (documented, not hidden): this ledger is operational state,
// not canonical evidence. The canonical record is the evidence JSONL the
// batch wrote. If the ledger is lost (index wipe, restore into a fresh data
// dir) the *evidence* is intact; the cursor is a resume hint and re-sending
// items is safe because per-item dedup is keyed on (source app, external id).
// A host should therefore treat a missing cursor as "resume from your own
// checkpoint", never as "the brain lost writes".

import Database from 'better-sqlite3';
import { dirname } from 'node:path';

import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';
import type { IngestItemResult } from './types.js';

const INGESTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS ingestion_batches (
  operation_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  cursor_before TEXT,
  cursor TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  duplicated INTEGER NOT NULL,
  quarantined INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  items_json TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingestion_source_scope
  ON ingestion_batches(source_id, scope);
`;

export interface BatchRecord {
  operation_id: string;
  source_id: string;
  scope: string;
  actor_id: string;
  payload_hash: string;
  cursor_before: string | null;
  cursor: string;
  accepted: number;
  duplicated: number;
  quarantined: number;
  rejected: number;
  items: IngestItemResult[];
  synced_at: string;
}

interface BatchRow {
  operation_id: string;
  source_id: string;
  scope: string;
  actor_id: string;
  payload_hash: string;
  cursor_before: string | null;
  cursor: string;
  accepted: number;
  duplicated: number;
  quarantined: number;
  rejected: number;
  items_json: string;
  synced_at: string;
}

export class IngestionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') ensurePrivateDirectory(dirname(dbPath));
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') ensurePrivateFile(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(INGESTION_SCHEMA);
  }

  /** Durable commit of one batch receipt. The operation_id is the primary key. */
  recordBatch(record: BatchRecord): void {
    this.db.prepare(`
      INSERT INTO ingestion_batches
        (operation_id, source_id, scope, actor_id, payload_hash,
         cursor_before, cursor, accepted, duplicated, quarantined, rejected,
         items_json, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.operation_id,
      record.source_id,
      record.scope,
      record.actor_id,
      record.payload_hash,
      record.cursor_before,
      record.cursor,
      record.accepted,
      record.duplicated,
      record.quarantined,
      record.rejected,
      JSON.stringify(record.items),
      record.synced_at,
    );
  }

  findBatch(operationId: string): BatchRecord | null {
    const row = this.db
      .prepare('SELECT * FROM ingestion_batches WHERE operation_id = ?')
      .get(operationId) as BatchRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Latest committed batch for one stream (source × scope), or null. */
  latestBatch(sourceId: string, scope: string): BatchRecord | null {
    const row = this.db
      .prepare('SELECT * FROM ingestion_batches WHERE source_id = ? AND scope = ? ORDER BY rowid DESC LIMIT 1')
      .get(sourceId, scope) as BatchRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** All committed batches for a source, oldest first. */
  listBatches(sourceId: string): BatchRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM ingestion_batches WHERE source_id = ? ORDER BY rowid ASC')
      .all(sourceId) as BatchRow[];
    return rows.map(toRecord);
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: BatchRow): BatchRecord {
  let items: IngestItemResult[] = [];
  try {
    items = JSON.parse(row.items_json) as IngestItemResult[];
  } catch {
    items = [];
  }
  return {
    operation_id: row.operation_id,
    source_id: row.source_id,
    scope: row.scope,
    actor_id: row.actor_id,
    payload_hash: row.payload_hash,
    cursor_before: row.cursor_before,
    cursor: row.cursor,
    accepted: row.accepted,
    duplicated: row.duplicated,
    quarantined: row.quarantined,
    rejected: row.rejected,
    items,
    synced_at: row.synced_at,
  };
}
