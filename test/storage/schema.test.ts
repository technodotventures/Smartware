// Tests: storage/schema — column migrations that are idempotent and survive two
// processes opening the same database at the same time.
//
// The bug these guard: `ensureColumn` checked `hasColumn` and then issued `ALTER TABLE
// ADD COLUMN`. Two processes opening one brain race that window; the loser's ALTER is
// handed `SQLITE_ERROR: duplicate column name` and the process dies on startup.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaimStore } from '../../src/layer1/store.js';
import {
  alterColumnIgnoringConcurrentAdd,
  ensureColumn,
  hasColumn,
} from '../../src/storage/schema.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smartware-schema-'));
  tempDirs.push(dir);
  return join(dir, 'index.db');
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const CREATE = 'CREATE TABLE IF NOT EXISTS things (id TEXT PRIMARY KEY)';

describe('ensureColumn', () => {
  it('adds a column that is missing', () => {
    const db = new Database(':memory:');
    db.exec(CREATE);
    ensureColumn(db, 'things', 'note', 'TEXT');
    expect(hasColumn(db, 'things', 'note')).toBe(true);
    db.close();
  });

  it('is a no-op when the column already exists, preserving rows', () => {
    const db = new Database(':memory:');
    db.exec(CREATE);
    ensureColumn(db, 'things', 'note', 'TEXT');
    db.prepare('INSERT INTO things (id, note) VALUES (?, ?)').run('a', 'keep me');
    ensureColumn(db, 'things', 'note', 'TEXT');
    expect(db.prepare('SELECT note FROM things WHERE id = ?').get('a')).toEqual({ note: 'keep me' });
    db.close();
  });

  it('still throws when the target table does not exist', () => {
    const db = new Database(':memory:');
    expect(() => ensureColumn(db, 'no_such_table', 'note', 'TEXT')).toThrow();
    db.close();
  });
});

describe('two processes opening one database', () => {
  it('treats a lost ALTER race as success instead of crashing', () => {
    const path = tempDbPath();
    const loser = new Database(path);
    loser.exec(CREATE);

    // Both processes look at the schema at this instant and see the column missing.
    const sawMissing = !hasColumn(loser, 'things', 'note');
    expect(sawMissing).toBe(true);

    // The other process wins the race and commits its ALTER.
    const winner = new Database(path);
    winner.exec('ALTER TABLE things ADD COLUMN note TEXT');

    // Pre-fix behaviour, asserted so this test proves it discriminates: the loser's
    // unchecked ALTER is handed SQLITE_ERROR: duplicate column name, and the process
    // dies on startup.
    expect(() => loser.exec('ALTER TABLE things ADD COLUMN note TEXT'))
      .toThrow(/duplicate column/i);

    // The fix: the same ALTER, now tolerant of a column that another connection added.
    expect(() => alterColumnIgnoringConcurrentAdd(loser, 'things', 'note', 'TEXT')).not.toThrow();
    // And the guard path, once the column is visible to this connection.
    expect(() => ensureColumn(loser, 'things', 'note', 'TEXT')).not.toThrow();
    expect(hasColumn(loser, 'things', 'note')).toBe(true);

    loser.close();
    winner.close();
  });

  it('still reports an ALTER that genuinely fails', () => {
    const path = tempDbPath();
    const db = new Database(path);
    db.exec(CREATE);
    expect(() => alterColumnIgnoringConcurrentAdd(db, 'missing_table', 'note', 'TEXT')).toThrow();
    db.close();
  });

  it('ClaimStore migrates cleanly while another connection holds the database open', () => {
    const path = tempDbPath();
    const first = new ClaimStore(path);
    // A second open re-runs the whole migration against a live connection. Every column
    // is already present, so this must be a no-op rather than a duplicate-column crash.
    expect(() => new ClaimStore(path)).not.toThrow();

    const probe = new Database(path);
    expect(hasColumn(probe, 'claims', 'version_at')).toBe(true);
    probe.close();
    expect(first.getDataDir()).toBeNull();
  });
});
