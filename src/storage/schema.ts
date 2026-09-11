// Shared SQLite schema helpers.
//
// A brain can be opened by more than one process at a time — two replicas booting
// together, a supervisor restarting a service while the old process drains, a rolling
// upgrade. SQLite serialises the writes, but "check whether the column exists, then add
// it" is a check-then-act race: both processes can observe the column as missing, one
// wins the ALTER, and the loser is handed
//
//   SQLITE_ERROR: duplicate column name: <col>
//
// It dies on startup — no retry, no degraded mode. The migration is idempotent in
// intent: a column added by whoever got there first means the schema is exactly what
// was wanted, so losing that race is a success, not a failure.

import Database from 'better-sqlite3';

export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === column);
}

/**
 * `ALTER TABLE ... ADD COLUMN`, treating "another connection added it first" as success.
 *
 * Any other failure is re-thrown — a malformed definition or a missing table must still
 * surface rather than be swallowed by the concurrency tolerance.
 */
export function alterColumnIgnoringConcurrentAdd(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (hasColumn(db, table, column)) return;
    throw error;
  }
}

/** Idempotent column addition, safe to run from concurrent opens of one database. */
export function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (hasColumn(db, table, column)) return;
  alterColumnIgnoringConcurrentAdd(db, table, column, definition);
}
