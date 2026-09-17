// Second-process reader for the correction-durability check (B1, kanban t_8ddfa350).
//
// The fixture stops the owner replica, then starts THIS process over the same brain
// directory and asks the two questions a restart has to answer for a corrected fact:
// which rows recall serves, and what the canonical claim log says about the claim the
// correction retracted. A restart is a replay — SmartwareCore.open catches the L0
// evidence log up into the derived rows and re-syncs the claim index — so an unfixed
// brain answers with the corrected-away value as well (measured, t_66f1dd7d §3 B1).
//
// The process reports; it does not judge. The fixture's checks own the assertions.
//
// Usage: node coffee-correction-restart-probe.mjs <payloadFile>
//   payload: { adapterUrl, tenant, actor, client, query, limit, instanceId }
//   stdout : one JSON object — { ok, role, degraded, source, rows, canonical }
import fs from 'node:fs';
import path from 'node:path';

const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { CoffeeBrainAdapter } = await import(payload.adapterUrl);

// The host ports this probe owns are throwaway: the brain directory is the shared
// artifact, and the lease lives in the host's arbiter, not in the brain. The epoch the
// brain fence requires is the one the SHARED arbiter already minted for this takeover
// (passed in the payload) — a Redis INCR in a real host, not something a second process
// can derive locally.
function memoryArbiter({ nextEpoch: reservedEpoch = 1 } = {}) {
  const keys = new Map(); const epochs = new Map();
  const now = () => Date.now();
  const expired = () => { for (const [k, v] of keys) if (v.expiresAt !== null && v.expiresAt <= now()) keys.delete(k); };
  return {
    async tryAcquire({ key, holder, ttlMs }) { expired(); const c = keys.get(key); if (c) return c.holder === holder; keys.set(key, { holder, expiresAt: now() + ttlMs }); return true; },
    async renewIfHeld({ key, holder, ttlMs }) { expired(); const c = keys.get(key); if (!c || c.holder !== holder) return false; c.expiresAt = now() + ttlMs; return true; },
    async releaseIfHeld({ key, holder }) { expired(); const c = keys.get(key); if (c && c.holder === holder) { keys.delete(key); return true; } return false; },
    async holder(key) { expired(); return keys.get(key)?.holder ?? null; },
    async nextEpoch(key) { epochs.set(key, reservedEpoch); return reservedEpoch; },
  };
}
function memoryAppStore() {
  const lists = new Map(); const ops = new Set(); const drift = new Map();
  return {
    async appendOnce({ key, operationId, record }) {
      if (operationId && ops.has(`${key}::${operationId}`)) return { written: false, len: (lists.get(key) ?? []).length };
      if (operationId) ops.add(`${key}::${operationId}`);
      const l = lists.get(key) ?? []; l.push(record); lists.set(key, l); return { written: true, len: l.length };
    },
    async list({ key }) { return [...(lists.get(key) ?? [])]; },
    async getDrift({ key }) { return drift.get(key) ?? 0; },
    async incrDrift({ key }) { const n = (drift.get(key) ?? 0) + 1; drift.set(key, n); return n; },
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
        file: name,
        id,
        version: record.version ?? null,
        state: record.state ?? null,
        value: record.semantic?.object?.value ?? null,
      });
    }
  }
  return out;
}

const report = { pid: process.pid, node: process.version, role: null, degraded: null, source: null, rows: [], canonical: [] };
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
  report.status = recall.status;
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
