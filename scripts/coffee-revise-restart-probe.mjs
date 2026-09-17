// Coffee REVISE durability probe (kanban t_336ba0b9).
//
// The measurement the card asks for: does `SmartwareCore.revise` leave the
// claim-FTS lane stale, the way `SmartwareCore.correct` did (kanban
// t_8ddfa350)? The instrument is the one t_8ddfa350 used, pointed at REVISE:
//
//   leg 1  write a fact through the Coffee reference adapter, let a later
//          event-valid window supersede it, then REVISE the superseded claim
//          through the open brain — and recall IN THIS PROCESS;
//   leg 2  stop the owner and bring up a NEW adapter instance over the same
//          brain directory (a supervisor's restart; SmartwareCore.open
//          re-derives the derived rows from the canonical surface and
//          re-syncs the claim index) — recall again;
//   leg 3  the same question from a genuinely separate PROCESS (only the brain
//          directory is shared; the epoch the brain fence requires is minted by
//          the shared arbiter, exactly as a Redis-backed host arbiter would).
//
// The verdict is the same shape as checks 3j–3o: what recall serves right after
// the mutation must be what the durable surface serves. Before the fix this
// process answered without the revised claim while every restart served it
// (measured, t_336ba0b9) — a warranted user revision that answers *nothing*
// is indistinguishable from data loss.
//
// Usage:
//   node coffee-revise-restart-probe.mjs                   # full drill
//   node coffee-revise-restart-probe.mjs --child <payload> # second-process reader
//   GATE_DATA_DIR=<dir> node ...                           # keep the brain here
//
// Exit code 0 only when all legs agree; `--report <path>` writes the JSON.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_SPEC = process.env.GATE_ADAPTER ?? '../examples/coffee-adapter/adapter.mjs';

// ── host ports (in-memory implementations of the documented contracts) ───────
function memoryArbiter({ nextEpoch: reservedEpoch = 1 } = {}) {
  const keys = new Map(); const epochs = new Map();
  return {
    async tryAcquire({ key, holder }) { const current = keys.get(key); if (current) return current.holder === holder; keys.set(key, { holder, expiresAt: null }); return true; },
    async renewIfHeld({ key, holder }) { const current = keys.get(key); return !!current && current.holder === holder; },
    async releaseIfHeld({ key, holder }) { const current = keys.get(key); if (current && current.holder === holder) { keys.delete(key); return true; } return false; },
    async holder(key) { return keys.get(key)?.holder ?? null; },
    async nextEpoch(key) { if (!epochs.has(key)) epochs.set(key, reservedEpoch); else epochs.set(key, epochs.get(key) + 1); return epochs.get(key); },
    async setEpoch(key, value) { epochs.set(key, value); },
    _epochs: epochs,
  };
}
function memoryAppStore() {
  const lists = new Map(); const operations = new Set(); const drift = new Map();
  return {
    async appendOnce({ key, operationId, record }) {
      if (operationId && operations.has(`${key}::${operationId}`)) return { written: false, len: (lists.get(key) ?? []).length };
      if (operationId) operations.add(`${key}::${operationId}`);
      const list = lists.get(key) ?? []; list.push(record); lists.set(key, list);
      return { written: true, len: list.length };
    },
    async list({ key }) { return [...(lists.get(key) ?? [])]; },
    async getDrift({ key }) { return drift.get(key) ?? 0; },
    async incrDrift({ key }) { const next = (drift.get(key) ?? 0) + 1; drift.set(key, next); return next; },
  };
}

// Every canonical claim-version line under the brain dir, oldest file first.
function canonicalClaimRecords(dir) {
  const claimsDir = path.join(dir, 'claims');
  if (!fs.existsSync(claimsDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(claimsDir).filter(n => n.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(claimsDir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (typeof (record?.claim_id ?? record?.id) !== 'string') continue;
      const id = record.claim_id ?? record.id;
      if (!id.startsWith('claim_')) continue;
      out.push({
        file: name, id,
        version: record.version ?? null,
        state: record.state ?? null,
        superseded_by: record.superseded_by ?? null,
        value: record.semantic?.object?.value ?? null,
      });
    }
  }
  return out;
}

// ── second-process mode: open the brain, recall, report, exit ────────────────
if (process.argv[2] === '--child') {
  const payload = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const { CoffeeBrainAdapter } = await import(new URL(payload.adapterUrl, import.meta.url).href);
  const report = { pid: process.pid, role: null, degraded: null, source: null, rows: [], canonical: [] };
  try {
    const adapter = new CoffeeBrainAdapter({
      tenant: payload.tenant,
      brainDir: payload.tenant.data_dir,
      instanceId: payload.instanceId,
      ports: { appStore: memoryAppStore(), arbiter: memoryArbiter({ nextEpoch: payload.fenceEpoch ?? 1 }) },
      leaseTtlMs: payload.leaseTtlMs ?? 8000,
      namespace: payload.namespace ?? 'coffee',
    });
    await adapter.start();
    report.role = adapter.role;
    const recall = await adapter.handleRecall({
      actor: payload.actor, client: payload.client, query: payload.query, limit: payload.limit ?? 10,
    });
    report.ok = recall.ok === true;
    report.degraded = recall.degraded === true;
    report.source = recall.source ?? null;
    report.rows = (recall.results ?? []).map(hit => ({
      id: hit.claim?.id ?? null,
      predicate: hit.claim?.predicate ?? null,
      value: hit.claim?.object?.value ?? null,
      status: hit.claim?.status ?? null,
    }));
    report.canonical = canonicalClaimRecords(payload.tenant.data_dir);
    await adapter.stop();
  } catch (error) {
    report.error = String(error?.stack ?? error);
    report.ok = false;
  }
  console.log(JSON.stringify(report));
  process.exit(report.ok === true ? 0 : 1);
}

// ── full drill ───────────────────────────────────────────────────────────────
const reportPathIndex = process.argv.indexOf('--report');
const reportPath = reportPathIndex === -1 ? null : process.argv[reportPathIndex + 1];
const { CoffeeBrainAdapter, coffeeTenantConfig, newOperationId, brainIdentity, fenceEpochKeyFor } = await import(
  new URL(ADAPTER_SPEC, import.meta.url).href
);

const OWNER = { type: 'person', id: 'user:ava', display_name: 'Ava' };
const STAFF = { type: 'person', id: 'user:gigi', display_name: 'Gigi' };
const SUBJECT = 'B2 Revise Probe Co';
const SCOPE = 'client:acme#1';
const PREDICATE = 'b2_probe_date';
const STALE = '2031-01-01';       // superseded by the later event-valid window
const CURRENT = '2031-02-02';
const QUERY = 'B2 Revise Probe';

const failures = [];
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures.push({ name, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 300)}`}`);
  return ok;
}
const J = value => JSON.stringify(value);

const dataRoot = process.env.GATE_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sw-revise-probe-'));
fs.mkdirSync(dataRoot, { recursive: true });
const brainDir = path.join(dataRoot, 'ava-consulting');
const tenant = coffeeTenantConfig({
  dataDir: brainDir, ownerId: OWNER.id, workspaceId: 'ava-consulting', instanceId: 'smartware_ava',
  clients: [{ id: 'acme', incarnation: 1 }],
  staff: [{ actorId: STAFF.id, actorType: 'person', scopes: [SCOPE], correct: [SCOPE], forget: [SCOPE] }],
  agents: [],
});
const arbiter = memoryArbiter();
const appStore = memoryAppStore();
let adapter = new CoffeeBrainAdapter({
  tenant, brainDir, ports: { appStore, arbiter }, instanceId: 'inst_a', namespace: 'coffee', leaseTtlMs: 60000,
});
await adapter.start();

const claimInput = (value, validityFrom) => ([{
  subject: { name: SUBJECT, type: 'organization' }, predicate: PREDICATE,
  object: { type: 'text', value }, validity_from: validityFrom,
}]);
const write = (text, claims) => adapter.handleWrite({
  actor: STAFF, client: 'acme', text, claims, operation_id: newOperationId(),
});
async function rows() {
  const recall = await adapter.handleRecall({ actor: OWNER, client: 'acme', query: QUERY, limit: 10 });
  return (recall.results ?? [])
    .filter(hit => hit.claim?.predicate === PREDICATE)
    .map(hit => ({ id: hit.claim.id, value: String(hit.claim.object?.value ?? hit.claim.object), status: hit.claim.status }))
    .sort((a, b) => a.value.localeCompare(b.value));
}
function latestVersionOf(claimId) {
  return canonicalClaimRecords(brainDir).filter(record => record.id === claimId)
    .reduce((max, record) => Math.max(max, record.version ?? 0), 0);
}

// leg 1 — write, supersede, REVISE, recall in this process
const first = await write(`${SUBJECT} renewal date is ${STALE}`, claimInput(STALE, '2026-08-01T00:00:00.000Z'));
const firstId = first.claims.outcomes[0]?.claim_id;
const beforeRows = await rows();
check('probe-1 the drill starts from exactly one served row',
  first.ok === true && first.claims.outcomes[0]?.outcome === 'inserted'
  && beforeRows.length === 1 && beforeRows[0].value === STALE,
  J({ write: first.ok, outcomes: first.claims.outcomes, rows: beforeRows }));

const superseding = await write(`${SUBJECT} renewal date moved to ${CURRENT}`, claimInput(CURRENT, '2026-09-01T00:00:00.000Z'));
const supersededRows = await rows();
check('probe-2 a later event-valid window supersedes the earlier one',
  superseding.ok === true && superseding.claims.outcomes[0]?.outcome === 'superseded'
  && supersededRows.length === 1 && supersededRows[0].value === CURRENT,
  J({ outcomes: superseding.claims.outcomes, rows: supersededRows }));

const revise = await adapter.brain.revise({
  actor: OWNER, target: firstId, expected_base_version: latestVersionOf(firstId),
  set_confidence: 'high', reason: 'the earlier window was still in force',
  operation_id: newOperationId(),
});
const inProcessRows = await rows();
const inProcessCanonical = canonicalClaimRecords(brainDir);

// leg 2 — a NEW adapter instance over the same brain (restart)
await adapter.stop();
adapter = new CoffeeBrainAdapter({
  tenant, brainDir, ports: { appStore, arbiter }, instanceId: 'inst_a_restarted', namespace: 'coffee', leaseTtlMs: 60000,
});
await adapter.start();
const restartRows = await rows();
const restartRole = adapter.role;

// leg 3 — a genuinely separate process
const childEpoch = await arbiter.nextEpoch(fenceEpochKeyFor(brainIdentity({ brainDir }), 'coffee'));
const payloadPath = path.join(dataRoot, 'revise-probe-payload.json');
fs.writeFileSync(payloadPath, JSON.stringify({
  adapterUrl: new URL(ADAPTER_SPEC, import.meta.url).href,
  tenant, actor: OWNER, client: 'acme', query: QUERY, limit: 10,
  instanceId: 'inst_ava_second_process', leaseTtlMs: 8000, namespace: 'coffee', fenceEpoch: childEpoch,
}));
const childRun = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', payloadPath], {
  cwd: HERE, encoding: 'utf8', timeout: 120_000, env: process.env,
});
let child = null;
try { child = JSON.parse(String(childRun.stdout ?? '').trim().split('\n').pop()); } catch { child = null; }
const childRows = (child?.rows ?? [])
  .filter(row => row.predicate === PREDICATE)
  .map(row => ({ id: row.id, value: String(row.value), status: row.status }))
  .sort((a, b) => a.value.localeCompare(b.value));
await adapter.stop();

// ── verdicts ─────────────────────────────────────────────────────────────────
check('probe-3 the REVISE itself committed',
  revise.status === 'revised' && typeof revise.new_version === 'number',
  J(revise));

const sameRows = (a, b) => J(a) === J(b);
check('probe-4 recall after the REVISE answers the durable surface (restart leg)',
  sameRows(inProcessRows, restartRows),
  J({ in_process: inProcessRows, after_restart: restartRows }));
check('probe-5 a genuine second process answers the same rows',
  childRun.status === 0 && child?.ok === true && child?.role === 'owner'
  && sameRows(inProcessRows, childRows),
  J({ status: childRun.status, role: child?.role, child: childRows, error: String(child?.error ?? '').slice(0, 200) }));
check('probe-6 the restart legs add no canonical claim record',
  inProcessCanonical.length === canonicalClaimRecords(brainDir).length,
  J({ in_process: inProcessCanonical.length, final: canonicalClaimRecords(brainDir).length }));

const report = {
  ok: failures.length === 0,
  brainDir,
  rows: { after_write: beforeRows, after_supersede: supersededRows, in_process: inProcessRows, after_restart: restartRows, second_process: childRows },
  revise,
  restart_role: restartRole,
  second_process: { status: childRun.status, role: child?.role ?? null, source: child?.source ?? null, degraded: child?.degraded ?? null },
  canonical: inProcessCanonical
    .filter(record => record.id === firstId)
    .map(record => ({ version: record.version, state: record.state, superseded_by: record.superseded_by })),
  failures,
};
if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`# report ${J(report).slice(0, 2000)}`);
console.log(failures.length === 0 ? '# VERDICT: ALL LEGS AGREE' : `# VERDICT: ${failures.length} FAILURE(S)`);
process.exit(failures.length === 0 ? 0 : 1);
