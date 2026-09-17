// Tests: derived SQLite ops index (Layer0Index pattern).
//
// Covers the G2 build prerequisite from spec §7: ops-entry content
// resolution must not rely on a JSONL full scan (p95 ~107ms @50k ops).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import {
  appendOpLogEntry,
  defaultOpsIndexPath,
  loadCommittedOperationIds,
  openOpsIndex,
  OpsIndex,
  readAllOpLogEntries,
} from '../../src/ops_log/index.js';
import type { OpLogEntry, OpType } from '../../src/ops_log/types.js';

let tmpDir: string;
let opsDir: string;
let dbPath: string;

function makeEntry(op: OpType, timestamp: string, details?: Record<string, unknown>): OpLogEntry {
  return {
    operation_id: `op_${ulid()}`,
    actor_id: `actor_${ulid()}`,
    timestamp,
    op,
    ...(details ? { details } : {}),
  };
}

function mkOpsIndex(): OpsIndex {
  return new OpsIndex(dbPath);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ops-idx-'));
  opsDir = path.join(tmpDir, 'operations');
  dbPath = path.join(tmpDir, 'indices', 'ops.db');
  fs.mkdirSync(opsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('OpsIndex rebuild equivalence', () => {
  it('rebuildIndex reproduces the canonical log in order (multi-day, details round-trip)', () => {
    const entries = [
      makeEntry('observe', '2026-04-01T09:00:00Z', { payload_hash: 'a'.repeat(64), observation_id: 'obs_1' }),
      makeEntry('forget.scope', '2026-04-01T10:30:00Z', { scope: 'client:acme#1', reason: 'offboarding' }),
      makeEntry('reflect.explicit', '2026-04-02T08:00:00Z', { scope: 'workspace', claims_created: 2 }),
      makeEntry('reflect.auto', '2026-04-02T11:00:00Z', { observation_id: 'obs_2' }),
    ];
    for (const entry of entries) appendOpLogEntry(opsDir, entry);

    const index = mkOpsIndex();
    index.rebuildIndex(opsDir);

    expect(index.allEntries()).toEqual(entries);
    expect(index.count()).toBe(entries.length);
    expect([...index.committedOperationIds()].sort())
      .toEqual([...loadCommittedOperationIds(opsDir)].sort());
    index.close();
  });

  it('rebuildIndex after appends wipes to exactly the canonical state', () => {
    const a = makeEntry('observe', '2026-04-01T09:00:00Z');
    appendOpLogEntry(opsDir, a);
    const index = mkOpsIndex();
    index.catchUp(opsDir);
    expect(index.count()).toBe(1);

    const b = makeEntry('forget', '2026-04-02T09:00:00Z');
    appendOpLogEntry(opsDir, b);
    index.rebuildIndex(opsDir);

    expect(index.allEntries()).toEqual([a, b]);
    expect(index.count()).toBe(2);
    index.close();
  });
});

describe('OpsIndex lookups', () => {
  it('getByOperationId resolves full content (details parsed) in O(1); missing returns null', () => {
    const target = makeEntry('reflect.explicit', '2026-04-01T09:00:00Z', { scope: 'workspace', claims_created: 7 });
    const other = makeEntry('observe', '2026-04-01T10:00:00Z');
    appendOpLogEntry(opsDir, target);
    appendOpLogEntry(opsDir, other);

    const index = mkOpsIndex();
    index.catchUp(opsDir);

    expect(index.getByOperationId(target.operation_id)).toEqual(target);
    expect(index.getByOperationId(other.operation_id)).toEqual(other);
    expect(index.getByOperationId(`op_${ulid()}`)).toBeNull();
    index.close();
  });

  it('getManyByOperationIds returns only the requested present entries', () => {
    const a = makeEntry('observe', '2026-04-01T09:00:00Z');
    const b = makeEntry('forget.scope', '2026-04-02T09:00:00Z', { scope: 'client:acme#2', reason: 'erasure' });
    appendOpLogEntry(opsDir, a);
    appendOpLogEntry(opsDir, b);

    const index = mkOpsIndex();
    index.catchUp(opsDir);

    const resolved = index.getManyByOperationIds([a.operation_id, `op_${ulid()}`, b.operation_id]);
    expect(resolved.get(a.operation_id)).toEqual(a);
    expect(resolved.get(b.operation_id)).toEqual(b);
    expect(resolved.size).toBe(2);
    index.close();
  });

  it('entriesByOp filters by op type and preserves canonical order', () => {
    const obs1 = makeEntry('observe', '2026-04-01T09:00:00Z');
    const refl = makeEntry('reflect.auto', '2026-04-01T10:00:00Z');
    const obs2 = makeEntry('observe', '2026-04-02T09:00:00Z');
    const refl2 = makeEntry('reflect.auto', '2026-04-02T10:00:00Z');
    for (const entry of [obs1, refl, obs2, refl2]) appendOpLogEntry(opsDir, entry);

    const index = mkOpsIndex();
    index.catchUp(opsDir);
    expect(index.entriesByOp('reflect.auto')).toEqual([refl, refl2]);
    expect(index.entriesByOp('observe')).toEqual([obs1, obs2]);
    expect(index.entriesByOp('forget')).toEqual([]);
    index.close();
  });
});

describe('OpsIndex incremental catch-up', () => {
  it('catchUp indexes only changed days and never duplicates', () => {
    const a = makeEntry('observe', '2026-04-01T09:00:00Z');
    appendOpLogEntry(opsDir, a);

    const index = mkOpsIndex();
    index.catchUp(opsDir);
    expect(index.count()).toBe(1);

    // Append two more entries (a new day + same-day append) and re-catch-up.
    const b = makeEntry('forget.scope', '2026-04-01T11:00:00Z');
    const c = makeEntry('forget', '2026-04-02T09:00:00Z');
    appendOpLogEntry(opsDir, b);
    appendOpLogEntry(opsDir, c);
    index.catchUp(opsDir);

    expect(index.allEntries()).toEqual([a, b, c]);
    expect(index.count()).toBe(3);

    // Idempotent: no further changes produce no further rows.
    index.catchUp(opsDir);
    expect(index.count()).toBe(3);
    expect(index.allEntries()).toEqual([a, b, c]);
    index.close();
  });

  it('catchUp repairs a rewritten day file (same-day truncation/rewrite)', () => {
    const a = makeEntry('observe', '2026-04-01T09:00:00Z');
    const b = makeEntry('forget.scope', '2026-04-01T10:00:00Z');
    appendOpLogEntry(opsDir, a);
    appendOpLogEntry(opsDir, b);

    const index = mkOpsIndex();
    index.catchUp(opsDir);
    expect(index.count()).toBe(2);

    // Simulate a day file replaced with only the first entry.
    const dayPath = path.join(opsDir, '2026-04-01.jsonl');
    fs.writeFileSync(dayPath, `${JSON.stringify(a)}\n`, 'utf8');
    index.catchUp(opsDir);

    expect(index.allEntries()).toEqual([a]);
    expect(index.count()).toBe(1);
    index.close();
  });

  it('catchUp purges entries of a day file that disappears', () => {
    const a = makeEntry('observe', '2026-04-01T09:00:00Z');
    const b = makeEntry('forget.scope', '2026-04-02T09:00:00Z');
    appendOpLogEntry(opsDir, a);
    appendOpLogEntry(opsDir, b);

    const index = mkOpsIndex();
    index.catchUp(opsDir);
    expect(index.count()).toBe(2);

    fs.rmSync(path.join(opsDir, '2026-04-01.jsonl'));
    index.catchUp(opsDir);

    expect(index.allEntries()).toEqual([b]);
    expect(index.count()).toBe(1);
    index.close();
  });

  it('openOpsIndex brings the index up to date on open', () => {
    const a = makeEntry('observe', '2026-04-01T09:00:00Z');
    appendOpLogEntry(opsDir, a);

    const index = openOpsIndex(opsDir, dbPath);
    expect(index.getByOperationId(a.operation_id)).toEqual(a);
    expect(index.count()).toBe(1);
    index.close();
  });
});

describe('OpsIndex failure modes', () => {
  it('malformed JSONL throws the identical error as the canonical reader', () => {
    const a = makeEntry('observe', '2026-04-01T09:00:00Z');
    appendOpLogEntry(opsDir, a);
    const dayPath = path.join(opsDir, '2026-04-01.jsonl');
    fs.appendFileSync(dayPath, '{not json\n', 'utf8');

    // Canonical reader already throws; the index must fail the same way.
    let canonicalError = '';
    try { [...readAllOpLogEntries(opsDir)]; } catch (error) { canonicalError = (error as Error).message; }
    expect(canonicalError).toBe(`Malformed JSONL in ${dayPath}:2`);

    const index = mkOpsIndex();
    expect(() => index.catchUp(opsDir)).toThrowError(`Malformed JSONL in ${dayPath}:2`);
    index.close();
  });

  it('missing ops directory behaves like an empty canonical log', () => {
    fs.rmSync(opsDir, { recursive: true, force: true });
    const index = mkOpsIndex();
    index.catchUp(opsDir);
    expect(index.allEntries()).toEqual([]);
    expect(index.count()).toBe(0);
    index.close();
  });
});

describe('OpsIndex placement and permissions', () => {
  it('defaultOpsIndexPath points at the pod indices directory', () => {
    expect(defaultOpsIndexPath('/pod/data')).toBe(path.join('/pod/data', 'indices', 'ops.db'));
  });

  it('creates the database file with private permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    const index = mkOpsIndex();
    appendOpLogEntry(opsDir, makeEntry('observe', '2026-04-01T09:00:00Z'));
    index.catchUp(opsDir);
    index.close();
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
  });
});
