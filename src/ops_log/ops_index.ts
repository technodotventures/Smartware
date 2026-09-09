// Derived SQLite ops index — a rebuildable projection over the canonical
// operations JSONL (one file per UTC day).
//
// Same pattern as Layer0Index (src/layer0/index.ts): the JSONL is canonical;
// this SQLite is derived and can be wiped and rebuilt from it at any time.
// It resolves ops-entry *content* by operation_id in O(1) instead of the
// O(N) JSONL full scan measured at p95 ~107ms @50k ops (spec §7 landmine,
// ~12,800x slower than a SQLite PK at 0.008ms).
//
// Consumers: compile intent matching (src/protocol/reflect.ts) and
// history/explain ops-payload resolution (metadata.origin.ops_entry_id).
//
// Durability note: this index is a follower, never a source of truth. A
// crash between a canonical JSONL append and the next catch-up simply means
// the entry is not indexed yet; the next catch-up repairs it. The reverse
// (index ahead of canonical) never happens because the index is only ever
// populated from the JSONL.

import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';
import type { OpLogEntry, OpType } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops_entries (
  operation_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  op TEXT NOT NULL,
  details TEXT,
  file_day TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  UNIQUE (file_day, line_index)
);

CREATE INDEX IF NOT EXISTS idx_ops_op ON ops_entries(op);
CREATE INDEX IF NOT EXISTS idx_ops_timestamp ON ops_entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_ops_actor ON ops_entries(actor_id);

CREATE TABLE IF NOT EXISTS sync_state (
  day TEXT PRIMARY KEY,
  lines INTEGER NOT NULL,
  size INTEGER NOT NULL
);
`;

interface EntryRow {
  operation_id: string;
  actor_id: string;
  timestamp: string;
  op: string;
  details: string | null;
}

const ENTRY_COLUMNS = 'operation_id, actor_id, timestamp, op, details';

export class OpsIndex {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') ensurePrivateDirectory(dirname(dbPath));
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') ensurePrivateFile(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  /** Wipe the table and replay every entry from the canonical ops JSONL. */
  rebuildIndex(opsDir: string): void {
    this.db.exec('DELETE FROM ops_entries');
    this.db.exec('DELETE FROM sync_state');
    this.indexAllDays(opsDir);
  }

  /**
   * Incrementally replay only the day files whose byte size changed since
   * the last catch-up. The canonical log is append-only per UTC day (see
   * appendOpLogEntry), so size equality implies content equality and an
   * unchanged day is skipped entirely — O(changed bytes), not O(N). A day
   * that did change is re-indexed wholesale, which also repairs truncation
   * and rewrite artifacts.
   */
  catchUp(opsDir: string): void {
    this.indexAllDays(opsDir);
  }

  /** Resolve one ops entry by PK. O(1) vs a JSONL full scan. */
  getByOperationId(operationId: string): OpLogEntry | null {
    const row = this.db.prepare(
      `SELECT ${ENTRY_COLUMNS} FROM ops_entries WHERE operation_id = ?`,
    ).get(operationId) as EntryRow | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  /** Batch resolve ops entries ("history" payloads). Missing ids are absent. */
  getManyByOperationIds(operationIds: string[]): Map<string, OpLogEntry> {
    const result = new Map<string, OpLogEntry>();
    for (let i = 0; i < operationIds.length; i += 500) {
      const chunk = operationIds.slice(i, i + 500);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT ${ENTRY_COLUMNS} FROM ops_entries WHERE operation_id IN (${placeholders})`,
      ).all(...chunk) as EntryRow[];
      for (const row of rows) result.set(row.operation_id, this.rowToEntry(row));
    }
    return result;
  }

  /** All entries of one op type, in canonical (day, line) order. */
  entriesByOp(op: OpType): OpLogEntry[] {
    const rows = this.db.prepare(
      `SELECT ${ENTRY_COLUMNS} FROM ops_entries WHERE op = ? ORDER BY file_day ASC, line_index ASC`,
    ).all(op) as EntryRow[];
    return rows.map(row => this.rowToEntry(row));
  }

  /** Every indexed entry in canonical order — mirror of readAllOpLogEntries. */
  allEntries(): OpLogEntry[] {
    const rows = this.db.prepare(
      `SELECT ${ENTRY_COLUMNS} FROM ops_entries ORDER BY file_day ASC, line_index ASC`,
    ).all() as EntryRow[];
    return rows.map(row => this.rowToEntry(row));
  }

  /** Operation IDs present in the derived index — mirror of loadCommittedOperationIds. */
  committedOperationIds(): Set<string> {
    const rows = this.db.prepare('SELECT operation_id FROM ops_entries').all() as Array<{ operation_id: string }>;
    return new Set(rows.map(row => row.operation_id));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) as count FROM ops_entries').get() as { count: number }).count;
  }

  close(): void {
    this.db.close();
  }

  getDB(): Database.Database {
    return this.db;
  }

  private indexAllDays(opsDir: string): void {
    const seen = new Set<string>();
    if (existsSync(opsDir)) {
      for (const file of readdirSync(opsDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const day = file.slice(0, -'.jsonl'.length);
        seen.add(day);
        this.indexDay(opsDir, day);
      }
    }
    // Purge days that no longer exist on the canonical surface so the index
    // never resurrects a removed day's entries.
    const syncedDays = (this.db.prepare('SELECT day FROM sync_state').all() as Array<{ day: string }>)
      .map(row => row.day);
    for (const day of syncedDays) {
      if (seen.has(day)) continue;
      this.db.prepare('DELETE FROM ops_entries WHERE file_day = ?').run(day);
      this.db.prepare('DELETE FROM sync_state WHERE day = ?').run(day);
    }
  }

  private indexDay(opsDir: string, day: string): void {
    const filePath = join(opsDir, `${day}.jsonl`);
    const size = statSync(filePath).size;
    const state = this.db.prepare('SELECT lines, size FROM sync_state WHERE day = ?')
      .get(day) as { lines: number; size: number } | undefined;
    if (state && state.size === size) return; // unchanged append-only day

    // Day changed (or is new): re-index the day wholesale inside one
    // transaction — batched appends, not per-line commits. A malformed line
    // aborts and rolls back, leaving the prior state fail-closed.
    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM ops_entries WHERE file_day = ?').run(day);

      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO ops_entries
          (operation_id, actor_id, timestamp, op, details, file_day, line_index)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < lines.length; i++) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(lines[i]!);
        } catch {
          throw new Error(`Malformed JSONL in ${filePath}:${i + 1}`);
        }
        const entry = parsed as Partial<OpLogEntry>;
        if (typeof entry.operation_id !== 'string'
          || typeof entry.actor_id !== 'string'
          || typeof entry.timestamp !== 'string'
          || typeof entry.op !== 'string') {
          throw new Error(`Malformed JSONL in ${filePath}:${i + 1}`);
        }
        insert.run(
          entry.operation_id,
          entry.actor_id,
          entry.timestamp,
          entry.op,
          entry.details === undefined ? null : JSON.stringify(entry.details),
          day,
          i,
        );
      }

      this.db.prepare(`
        INSERT INTO sync_state (day, lines, size) VALUES (?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET lines = excluded.lines, size = excluded.size
      `).run(day, lines.length, size);
    })();
  }

  private rowToEntry(row: EntryRow): OpLogEntry {
    return {
      operation_id: row.operation_id,
      actor_id: row.actor_id,
      timestamp: row.timestamp,
      op: row.op as OpType,
      ...(row.details === null ? {} : { details: JSON.parse(row.details) as Record<string, unknown> }),
    };
  }
}

/**
 * Open the derived ops index for a canonical ops directory and bring it up
 * to date. The DB is a derived artifact — delete it freely; catchUp
 * rebuilds it from the JSONL.
 */
export function openOpsIndex(opsDir: string, dbPath: string): OpsIndex {
  const index = new OpsIndex(dbPath);
  index.catchUp(opsDir);
  return index;
}

/**
 * Conventional derived-DB location for a pod: <dataDir>/indices/ops.db.
 * This repository always lays pods out with operations at
 * <dataDir>/operations, and the same `indices/` directory already hosts
 * previews.db.
 */
export function defaultOpsIndexPath(dataDir: string): string {
  return join(dataDir, 'indices', 'ops.db');
}
