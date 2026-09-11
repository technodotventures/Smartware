// Spike: provenance-envelope read-path p95 (claim -> obs ids -> ops entry)
// Binding question from mem0-substrate-spec-draft.md §7:
//   "does L0-L4 provenance stay fast at query time?"
// Measuring the four read paths at realistic company-brain scale:
//   A. getClaim by id (baseline hit)
//   B. envelope assembly (claim row + origin object, no extra I/O)
//   C. observation resolution by id (SQLite PK)
//   D. ops-entry lookup: current JSONL full-scan vs indexed lookup
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { ClaimStore } from '/opt/data/dev-workspaces/repos/smartware/dist/layer1/store.js';
import { appendOpLogEntry, readAllOpLogEntries } from '/opt/data/dev-workspaces/repos/smartware/dist/ops_log/log.js';

const N_CLAIMS = 50000;
const N_OPS = 50000;
const N_OBS = 50000;
const READS = 2000;
const ROOT = '/opt/data/dev-workspaces/repos/smartware/.spike';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// ── Seed L1 claims + entities ──────────────────────────────────────────
const store = new ClaimStore(join(ROOT, 'claims.db'));
const now = new Date().toISOString();
const t = { value: now, state: 'known', basis: null };
for (let i = 0; i < 200; i++) {
  store.insertEntity({ id: `entity_${i}`, canonical_name: `Entity ${i}`, aliases: [], type: 'concept', scope: 'personal', created_at: now });
}
console.log('seeding', N_CLAIMS, 'claims...');
for (let i = 0; i < N_CLAIMS; i++) {
  store.insertClaim({
    id: `claim_${i}`,
    subject_id: `entity_${i % 200}`,
    subject_name: `Entity ${i % 200}`,
    predicate: 'status_is',
    object: { type: 'text', value: `value ${i}` },
    scope: 'personal',
    validity: { from: now, to: null },
    t_ingested: t,
    t_invalidated: { value: null, state: 'null', basis: null },
    t_valid_from: t,
    t_valid_to: { value: null, state: 'null', basis: null },
    source_event_id: `obs_${i}`,
    extraction_event_id: `obs_${i}`,
    supporting_evidence: [`obs_${i}`],
    extraction: { method: 'deterministic', model: null, compiler_version: '0.6.3', prompt_hash: null, extracted_at: now },
    status: 'active',
    epistemic: 'observed',
    confidence: 0.5,
    sensitive: false,
    superseded_by: null,
    contested_by: [],
    operation_id: `op_${String(i).padStart(6, '0').padEnd(26, '0').slice(0, 26)}`,
    version_at: now,
  });
}
console.log('claims seeded');

// ── Seed L0 observations ───────────────────────────────────────────────
const obsDb = new Database(join(ROOT, 'obs.db'));
obsDb.pragma('journal_mode = WAL');
obsDb.exec(`CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY, effective_status TEXT NOT NULL, payload TEXT NOT NULL
)`);
obsDb.exec('BEGIN');
const insObs = obsDb.prepare('INSERT OR IGNORE INTO observations (id, effective_status, payload) VALUES (?, ?, ?)');
for (let i = 0; i < N_OBS; i++) insObs.run(`obs_${i}`, 'active', JSON.stringify({ text: `observation ${i}` }));
obsDb.exec('COMMIT');
console.log('observations seeded');

// ── Seed ops log (JSONL, current canonical surface) ────────────────────
const opsDir = join(ROOT, 'operations');
for (let i = 0; i < N_OPS; i++) {
  appendOpLogEntry(opsDir, {
    operation_id: `op_${String(i).padStart(6, '0').padEnd(26, '0').slice(0, 26)}`,
    actor_id: 'substrate:test',
    timestamp: now,
    op: 'reflect.auto',
    details: { claim_ids: [`claim_${i}`] },
  });
}
console.log('ops seeded', N_OPS);

function pct(samples, p) {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}
function stats(name, samples) {
  console.log(`${name}: p50=${pct(samples, 0.5).toFixed(3)}ms p95=${pct(samples, 0.95).toFixed(3)}ms p99=${pct(samples, 0.99).toFixed(3)}ms`);
}

// ── A. Baseline: getClaim by id ────────────────────────────────────────
const a = [];
for (let i = 0; i < READS; i++) {
  const id = `claim_${Math.floor(Math.random() * N_CLAIMS)}`;
  const s = performance.now();
  store.getClaim(id);
  a.push(performance.now() - s);
}
stats('A getClaim (baseline hit)', a);

// ── B. Envelope assembly: getClaim + origin object (inline fields) ─────
const b = [];
for (let i = 0; i < READS; i++) {
  const id = `claim_${Math.floor(Math.random() * N_CLAIMS)}`;
  const s = performance.now();
  const c = store.getClaim(id);
  const origin = {
    claim_id: c.id,
    observation_ids: [...c.supporting_evidence],
    ops_entry_id: c.operation_id,
    version_at: c.version_at,
  };
  JSON.stringify(origin);
  b.push(performance.now() - s);
}
stats('B envelope (claim row only)', b);

// ── C. Observation resolution (SQLite PK) ──────────────────────────────
const getObs = obsDb.prepare('SELECT payload FROM observations WHERE id = ?');
for (let i = 0; i < 100; i++) getObs.get(`obs_${i}`); // warm
const c = [];
for (let i = 0; i < READS; i++) {
  const id = `obs_${Math.floor(Math.random() * N_OBS)}`;
  const s = performance.now();
  getObs.get(id);
  c.push(performance.now() - s);
}
stats('C obs PK lookup', c);

// ── D1. Ops-entry lookup via current JSONL full scan ───────────────────
const d1 = [];
for (let i = 0; i < 100; i++) { // fewer iterations: scan is O(N)
  const target = `op_${String(Math.floor(Math.random() * N_OPS)).padStart(6, '0').padEnd(26, '0').slice(0, 26)}`;
  const s = performance.now();
  const entries = [...readAllOpLogEntries(opsDir)];
  const hit = entries.find(e => e.operation_id === target);
  d1.push(performance.now() - s);
}
stats('D1 ops-entry JSONL full scan (per lookup)', d1);

// ── D2. Ops-entry lookup via SQLite index (proposed) ───────────────────
const opsDb = new Database(join(ROOT, 'ops.db'));
opsDb.pragma('journal_mode = WAL');
opsDb.exec(`CREATE TABLE IF NOT EXISTS ops (operation_id TEXT PRIMARY KEY, actor_id TEXT, timestamp TEXT, op TEXT, details TEXT)`);
opsDb.exec('BEGIN');
const insOp = opsDb.prepare('INSERT OR IGNORE INTO ops (operation_id, actor_id, timestamp, op, details) VALUES (?, ?, ?, ?, ?)');
for (let i = 0; i < N_OPS; i++) insOp.run(`op_${String(i).padStart(6, '0').padEnd(26, '0').slice(0, 26)}`, 'substrate:test', now, 'reflect.auto', '{}');
opsDb.exec('COMMIT');
const getOp = opsDb.prepare('SELECT * FROM ops WHERE operation_id = ?');
for (let i = 0; i < 100; i++) getOp.get(`op_00000100000000000000000000`);
const d2 = [];
for (let i = 0; i < READS; i++) {
  const target = `op_${String(Math.floor(Math.random() * N_OPS)).padStart(6, '0').padEnd(26, '0').slice(0, 26)}`;
  const s = performance.now();
  getOp.get(target);
  d2.push(performance.now() - s);
}
stats('D2 ops-entry SQLite indexed lookup', d2);
console.log(`\nD1/D2 ratio at p95: ${(pct(d1, 0.95) / pct(d2, 0.95)).toFixed(1)}x`);
console.log('spike done');
