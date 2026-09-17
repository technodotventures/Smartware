// Deterministic local integration test for the Coffee reference adapter.
//
// This is the executable form of the drop-in contract in
// docs/integration/coffee-adapter.md. It runs the REAL adapter module
// (examples/coffee-adapter/adapter.mjs) against the PUBLISHED package surface
// (imports resolve through package.json "exports", so a path that stops being
// public fails this script), with:
//
//   - no Redis          → in-memory implementations of the two host ports
//   - no model key      → host-side extraction; llm.provider is 'none'
//   - no clock, no sleeps, no network → the arbiter clock is injected
//
// What it proves (one PASS line per behaviour):
//   1.  provisioning + ownership: first replica owns the brain, second is standby
//   2.  a standby refuses a write BEFORE either store is touched
//   3.  an unauthenticated / malformed actor writes nothing
//   4.  an owner write lands in the app store (authoritative) and the brain (additive)
//   5.  retrying the same operation_id is idempotent in both stores
//   6.  a restated fact corroborates instead of minting a twin
//   7.  a contradicting fact is retained and surfaced as contested
//   8.  human staff and an AI agent act under their own grants; a client scope is
//       non-reusable and wildcards are never issued
//   9.  an ungranted actor and a denied read are refusals, not degraded answers
//   10. a standby answers reads from the app store, honestly labelled
//   11. failover: ownership moves, the new epoch writes
//   12. a stalled stale owner is refused (lease guard, then the brain fence):
//       clean refusal leaves nothing; the fenced refusal leaves no canonical artifact
//   13. two businesses never share a key, even with the same client id
//   14. attribution resolves to actor + source through smartware/render
//   15. owner export is scope-exclusive and carries no other client's bytes
//   16. health reports role, holder and epoch without tenant content
//   17. the naive SET..XX renewal is shown to produce dual-owner ownership (why the
//       port contract requires a value-conditional renew)
//
// Run: npm run verify:coffee-adapter   (builds first)
// Env: none required. Optional: --report <path> writes a JSON summary.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { showAttributionByDefault, attributionLine } from '@technodotventures/smartware/render';

import {
  CoffeeBrainAdapter,
  brainIdentity,
  leaseKeyFor,
  messagesKeyFor,
  coffeeTenantConfig,
  newOperationId,
  scopeForClient,
} from '../examples/coffee-adapter/adapter.mjs';

// ── tiny assertion harness ──────────────────────────────────────────────────
const checks = [];
let failed = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  checks.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}
const eq = (actual, expected) => `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`;

// ── the host ports (Coffee replaces these with Redis; the contract is identical) ──

/** In-memory arbiter with Redis SET NX / compare-and-extend semantics. */
function createMemoryArbiter({ now = () => Date.now(), blindRenew = false } = {}) {
  const keys = new Map();     // key -> { holder, expiresAt }
  const epochs = new Map();   // key -> integer
  const expired = () => {
    for (const [key, value] of keys) {
      if (value.expiresAt !== null && value.expiresAt <= now()) keys.delete(key);
    }
  };
  return {
    async tryAcquire({ key, holder, ttlMs }) {
      expired();
      const current = keys.get(key);
      if (current) return current.holder === holder;   // reentrant acquire
      keys.set(key, { holder, expiresAt: now() + ttlMs });
      return true;
    },
    async renewIfHeld({ key, holder, ttlMs }) {
      expired();
      const current = keys.get(key);
      if (!current) return false;
      // The contract: renew ONLY if the value is still ours (Lua compare-and-extend).
      // `blindRenew` reproduces SET..XX — existence-only — to demonstrate the hazard.
      if (!blindRenew && current.holder !== holder) return false;
      current.expiresAt = now() + ttlMs;
      return true;
    },
    async releaseIfHeld({ key, holder }) {
      expired();
      const current = keys.get(key);
      if (current && current.holder === holder) { keys.delete(key); return true; }
      return false;
    },
    async holder(key) {
      expired();
      return keys.get(key)?.holder ?? null;
    },
    async nextEpoch(key) {
      const next = (epochs.get(key) ?? 0) + 1;
      epochs.set(key, next);
      return next;
    },
  };
}

/** In-memory app store: an authoritative message list + a drift counter. */
function createMemoryAppStore() {
  const lists = new Map();
  const operations = new Set();
  const drift = new Map();
  return {
    async appendOnce({ key, operationId, record }) {
      const opKey = `${key}::${operationId}`;
      // Idempotent only when the caller supplied an operation id (the adapter
      // passes one when it has it; without one, retries are not deduplicated
      // and the host must not retry blind).
      if (operationId && operations.has(opKey)) {
        return { written: false, len: (lists.get(key) ?? []).length };
      }
      if (operationId) operations.add(opKey);
      const list = lists.get(key) ?? [];
      list.push(record);
      lists.set(key, list);
      return { written: true, len: list.length };
    },
    async list({ key }) {
      return [...(lists.get(key) ?? [])];
    },
    async getDrift({ key }) {
      return drift.get(key) ?? 0;
    },
    async incrDrift({ key }) {
      const next = (drift.get(key) ?? 0) + 1;
      drift.set(key, next);
      return next;
    },
  };
}

// ── fixtures ────────────────────────────────────────────────────────────────
const OWNER_A = { type: 'person', id: 'user:ava', display_name: 'Ava' };
const OWNER_B = { type: 'person', id: 'user:bob', display_name: 'Bob' };
const GIGI = { type: 'person', id: 'user:gigi', display_name: 'Gigi' };
const NOAH = { type: 'person', id: 'user:noah', display_name: 'Noah' };
const AGENT = { type: 'agent', id: 'agent:coffee-assistant', display_name: 'Coffee' };
const STRANGER = { type: 'person', id: 'user:stranger', display_name: 'Stranger' };

const ACME = 'client:acme#1';
const BCAU = 'client:bcau#1';

let fakeNow = 1_700_000_000_000;
const clock = () => fakeNow;
const advance = (ms) => { fakeNow += ms; };

const tenants = {};
const dirs = [];
function tenantFor(business) {
  if (tenants[business]) return tenants[business];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sw-coffee-adapter-${business}-`));
  dirs.push(dir);
  tenants[business] = coffeeTenantConfig({
    dataDir: dir,
    ownerId: business === 'a' ? 'user:ava' : 'user:bob',
    workspaceId: business === 'a' ? 'ava-consulting' : 'bob-studio',
    instanceId: `smartware_${business}1`,
    clients: [
      { id: 'acme', incarnation: 1 },
      { id: 'bcau', incarnation: 1 },
    ],
    staff: [
      { actorId: 'user:gigi', actorType: 'person', scopes: [ACME, BCAU], correct: [ACME] },
      { actorId: 'user:noah', actorType: 'person', scopes: [BCAU], correct: [] },
    ],
    agents: [
      { actorId: 'agent:coffee-assistant', scopes: [ACME, 'workspace'], compile: ['workspace'] },
    ],
  });
  return tenants[business];
}

const arbiter = createMemoryArbiter({ now: clock });
const appStore = createMemoryAppStore();

function makeAdapter(business, instanceId, extra = {}) {
  return new CoffeeBrainAdapter({
    tenant: tenantFor(business),
    brainDir: tenants[business].data_dir,
    instanceId,
    ports: { appStore, arbiter },
    leaseTtlMs: 8000,
    namespace: 'coffee',
    ...extra,
  });
}

function evidenceCount(dataDir) {
  const dir = path.join(dataDir, 'evidence');
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl') || name.endsWith('.json'))
    .reduce((total, name) => {
      const body = fs.readFileSync(path.join(dir, name), 'utf8');
      return total + body.split('\n').filter(Boolean).length;
    }, 0);
}

const a1 = makeAdapter('a', 'inst_a1');
const a2 = makeAdapter('a', 'inst_a2');
const b1 = makeAdapter('b', 'inst_b1');

try {
  // ── 1. provisioning + ownership ──────────────────────────────────────────
  await a1.start();
  await a2.start();
  await b1.start();

  const identityA = brainIdentity({ tenant: tenants.a });
  const identityB = brainIdentity({ tenant: tenants.b });
  check('1a first replica is the owner of its brain',
    a1.role === 'owner' && (await a1.health({ actor: OWNER_A })).lease.holder === 'inst_a1');
  check('1b second replica starts as standby',
    a2.role === 'standby');
  check('1c ownership claims a monotonic epoch at open',
    a1.brain.fencingState().high_water === 1, JSON.stringify(a1.brain.fencingState()));
  check('1d the other business has its own brain identity and lease key',
    identityA !== identityB && leaseKeyFor(identityA) !== leaseKeyFor(identityB));

  // ── 2. standby refuses a write before either store is touched ────────────
  const refused = await a2.handleWrite({ actor: GIGI, text: 'Acme says hi', client: 'acme' });
  const appListAfterRefusal = (await appStore.list({ key: messagesKeyFor(identityA, ACME) })).length;
  check('2a standby write refused with a retryable lease refusal',
    refused.ok === false && refused.status === 503 && refused.code === 'lease_not_holder'
    && refused.retryable === true && refused.partial_write === false,
    JSON.stringify(refused));
  check('2b refusal names the holder so the host can route to it',
    refused.holder === 'inst_a1');
  check('2c refusal wrote NOTHING to either store',
    appListAfterRefusal === 0 && evidenceCount(tenants.a.data_dir) === 0,
    `app=${appListAfterRefusal} evidence=${evidenceCount(tenants.a.data_dir)}`);

  // ── 3. unauthenticated / malformed actors + a small malformed fuzz ───────
  const noActor = await a1.handleWrite({ actor: { type: 'person', id: '' }, text: 'x', client: 'acme' });
  check('3a an actor without a verified id is refused before any write',
    noActor.ok === false && noActor.status === 401 && noActor.code === 'invalid_actor' && noActor.partial_write === false);
  const fuzz = [
    { actor: { type: 'ghost', id: 'user:x' }, text: 'x', client: 'acme' },
    { actor: GIGI, text: '', client: 'acme' },
    { actor: GIGI, text: 'x', client: '*' },
    { actor: GIGI, text: 'x', client: 'acme', scope: 'client:acme#*' },
    { actor: GIGI, text: 'x', client: 'acme', operation_id: 'not-an-op-id' },
  ];
  const fuzzResults = [];
  for (const bad of fuzz) fuzzResults.push(await a1.handleWrite(bad));
  check('3b malformed writes are refused and write nothing',
    fuzzResults.every(result => result.ok === false && result.partial_write === false)
    && (await appStore.list({ key: messagesKeyFor(identityA, ACME) })).length === 0
    && evidenceCount(tenants.a.data_dir) === 0,
    JSON.stringify(fuzzResults.map(result => [result.status, result.code])));

  // ── 4. staff write: app store authoritative, brain additive ──────────────
  const validityFrom = '2026-08-01T00:00:00.000Z';
  const opWrite = newOperationId();
  const written = await a1.handleWrite({
    actor: GIGI, client: 'acme', text: 'Acme renewal date is 2026-11-02',
    operation_id: opWrite,
    claims: [{
      subject: { name: 'Acme', type: 'organization' }, predicate: 'renewal_date',
      object: { type: 'text', value: '2026-11-02' }, validity_from: validityFrom,
    }],
  });
  check('4a owner write accepted and attributed',
    written.ok === true && written.status === 201 && typeof written.observation.id === 'string'
    && written.app.written === true && written.brain.written === true,
    JSON.stringify(written));
  check('4b the host extractor\'s claim was admitted (not compiled)',
    written.claims.outcomes.length === 1 && written.claims.outcomes[0].outcome === 'inserted'
    && written.claims.inserted === 1,
    JSON.stringify(written.claims));
  const recallA = await a1.handleRecall({ actor: OWNER_A, client: 'acme', query: 'Acme renewal' });
  check('4c the fact is recallable from the brain',
    recallA.ok === true && recallA.degraded === false && recallA.source === 'brain'
    && recallA.results.length === 1 && recallA.results[0].claim.predicate === 'renewal_date',
    JSON.stringify(recallA.results.map(r => r.claim?.predicate)));
  check('4d the app store still holds the authoritative record',
    (await appStore.list({ key: messagesKeyFor(identityA, ACME) })).length === 1);

  // ── 5. operation_id retry is idempotent in both stores ───────────────────
  const replay = await a1.handleWrite({
    actor: GIGI, client: 'acme', text: 'Acme renewal date is 2026-11-02',
    operation_id: opWrite,
    claims: [{
      subject: { name: 'Acme', type: 'organization' }, predicate: 'renewal_date',
      object: { type: 'text', value: '2026-11-02' }, validity_from: validityFrom,
    }],
  });
  check('5a a retried operation is replayed, not duplicated',
    replay.ok === true && replay.replayed === true && replay.app.written === false
    && replay.observation.id === written.observation.id,
    JSON.stringify(replay));
  check('5b replay left both stores at one write each',
    (await appStore.list({ key: messagesKeyFor(identityA, ACME) })).length === 1
    && evidenceCount(tenants.a.data_dir) === 1,
    `app=${(await appStore.list({ key: messagesKeyFor(identityA, ACME) })).length} evidence=${evidenceCount(tenants.a.data_dir)}`);

  // ── 6. restatement corroborates instead of minting a twin ────────────────
  const restated = await a1.handleWrite({
    actor: GIGI, client: 'acme', text: 'Acme confirms: renewal is 2026-11-02',
    claims: [{
      subject: { name: 'Acme', type: 'organization' }, predicate: 'renewal_date',
      object: { type: 'text', value: '2026-11-02' }, validity_from: validityFrom,
    }],
  });
  const recallRestated = await a1.handleRecall({ actor: OWNER_A, client: 'acme', query: 'Acme renewal' });
  const renewalClaims = recallRestated.results.filter(result => result.claim?.predicate === 'renewal_date');
  check('6a a restated fact corroborates the existing claim',
    restated.ok === true && restated.claims.outcomes[0].outcome === 'corroborated',
    JSON.stringify(restated.claims));
  check('6b recall still answers with ONE claim for the fact',
    renewalClaims.length === 1, `${renewalClaims.length} claim(s)`);

  // ── 7. a contradiction is retained and surfaced, never silently resolved ──
  const conflicting = await a1.handleWrite({
    actor: GIGI, client: 'acme', text: 'Acme renewal is 2026-12-15',
    claims: [{
      subject: { name: 'Acme', type: 'organization' }, predicate: 'renewal_date',
      object: { type: 'text', value: '2026-12-15' }, validity_from: validityFrom,
    }],
  });
  const recallConflict = await a1.handleRecall({ actor: OWNER_A, client: 'acme', query: 'Acme renewal' });
  const bothSides = recallConflict.results.filter(result => result.claim?.predicate === 'renewal_date');
  check('7a a conflicting value is admitted as contested',
    conflicting.ok === true && conflicting.claims.outcomes[0].outcome === 'contested',
    JSON.stringify(conflicting.claims.outcomes));
  check('7b recall surfaces both contested sides, not one truth',
    bothSides.length === 2 && bothSides.every(result => result.claim.status === 'contested' && result.claim.epistemic_tag === 'contested'),
    JSON.stringify(bothSides.map(result => [result.claim.object.value, result.claim.status])));

  // ── 8. agents act under their own grants; scopes are non-reusable ────────
  const agentWrite = await a1.handleWrite({
    actor: AGENT, client: 'acme', text: 'Reminder scheduled for the renewal',
    claims: [{
      subject: { name: 'Acme', type: 'organization' }, predicate: 'reminder_set',
      object: { type: 'text', value: 'renewal' }, validity_from: validityFrom,
    }],
  });
  check('8a the agent writes on a granted scope', agentWrite.ok === true, JSON.stringify(agentWrite));
  const agentRecall = await a1.handleRecall({ actor: AGENT, client: 'acme', query: 'renewal' });
  check('8b the agent reads what it is granted', agentRecall.ok === true && agentRecall.degraded === false);
  const agentDenied = await a1.handleRecall({ actor: AGENT, client: 'bcau', query: 'anything' });
  check('8c an ungranted scope is a denial, never a degraded fallback',
    agentDenied.ok === false && agentDenied.status === 403 && agentDenied.code === 'insufficient_permission'
    && !agentDenied.degraded && agentDenied.results === undefined,
    JSON.stringify(agentDenied));
  let wildcardRejected = false;
  try { scopeForClient('acme', '*'); } catch { wildcardRejected = true; }
  let reuseRejected = false;
  try { scopeForClient('acme', 0); } catch { reuseRejected = true; }
  check('8d client scopes are non-reusable: no wildcard, no incarnation 0',
    wildcardRejected && reuseRejected && scopeForClient('acme', 2) === 'client:acme#2'
    && scopeForClient('acme', 2) !== scopeForClient('acme', 1));

  // ── 9. ungranted actor: the brain refuses; the divergence is recorded ────
  const evidenceBeforeStranger = evidenceCount(tenants.a.data_dir);
  const strangerWrite = await a1.handleWrite({ actor: STRANGER, client: 'acme', text: 'let me in' });
  check('9a an actor with no grant is refused by the brain (its code, not a fallback)',
    strangerWrite.ok === false && strangerWrite.status === 403
    && ['actor_unregistered', 'insufficient_permission'].includes(strangerWrite.code)
    && strangerWrite.partial_write === true && strangerWrite.retryable === false,
    JSON.stringify(strangerWrite));
  const listAfterStranger = (await appStore.list({ key: messagesKeyFor(identityA, ACME) })).length;
  check('9b the brain refused it: no canonical artifact, and the app-side divergence is counted',
    evidenceCount(tenants.a.data_dir) === evidenceBeforeStranger && strangerWrite.drift_total >= 1
    && listAfterStranger === 5,
    `evidence=${evidenceCount(tenants.a.data_dir)} drift=${strangerWrite.drift_total} app=${listAfterStranger}`);

  // ── 10. standby degraded read: honest, app-store sourced ─────────────────
  const degraded = await a2.handleRecall({ actor: OWNER_A, client: 'acme', query: 'Acme renewal' });
  check('10a a standby answers from the app store and says so',
    degraded.ok === true && degraded.degraded === true && degraded.source === 'app-store-fallback'
    && degraded.provenance === 'unavailable',
    JSON.stringify(degraded));
  check('10b the degraded answer carries the app-store records, tagged with actor + scope',
    // 'Acme renewal' matches the two renewal messages; the other rows are the
    // agent's reminder, the stranger's refused message and the corroborated restatement.
    degraded.results.length === 2
    && degraded.results.every(record => record.actor?.id && record.scope === ACME && record.operation_id !== undefined)
    && degraded.results.some(record => record.text.includes('2026-12-15')),
    `${degraded.results.length} record(s)`);
  check('10c a degraded read never invents provenance',
    degraded.note.includes('provenance') && degraded.results.every(record => record.provenance === undefined));
  const degradedStranger = await a2.handleRecall({ actor: STRANGER, client: 'acme', query: 'Acme' });
  const degradedUngrantedScope = await a2.handleRecall({ actor: AGENT, client: 'bcau', query: 'anything' });
  check('10d the degraded path fails closed for an unregistered actor',
    degradedStranger.ok === false && degradedStranger.status === 403
    && degradedStranger.code === 'actor_unregistered' && degradedStranger.results === undefined,
    JSON.stringify(degradedStranger));
  check('10e the degraded path fails closed for a scope outside the grant',
    degradedUngrantedScope.ok === false && degradedUngrantedScope.code === 'insufficient_permission'
    && degradedUngrantedScope.results === undefined);

  // ── 11. failover: ownership moves, epoch advances, the new owner writes ──
  const stopped = await a1.stop();
  check('11a shutdown releases the lease (fast failover path)',
    stopped.released === true && (await arbiter.holder(leaseKeyFor(identityA))) === null);
  await a2.refreshOwnership();
  check('11b the standby takes ownership and claims the next epoch',
    a2.role === 'owner' && a2.brain.fencingState().high_water === 2,
    JSON.stringify(a2.brain.fencingState()));
  const afterFailover = await a2.handleWrite({
    actor: GIGI, client: 'acme', text: 'Acme also wants quarterly invoices',
    claims: [{
      subject: { name: 'Acme', type: 'organization' }, predicate: 'billing_cadence',
      object: { type: 'text', value: 'quarterly' }, validity_from: validityFrom,
    }],
  });
  check('11c the new owner writes normally', afterFailover.ok === true && afterFailover.brain.written === true);

  // ── 12. stale owner, two deterministic drills ────────────────────────────
  // 12A: guard catches the lost lease BEFORE either store is touched.
  await a2.stop();
  await a1.start();
  check('12a the restarted replica owns again after a handover', a1.role === 'owner');
  const leaseKey = leaseKeyFor(identityA);
  advance(9000);                                             // the lease lapses
  await a2.refreshOwnership();                               // another replica takes over
  const guardRefusal = await a1.handleWrite({ actor: GIGI, client: 'acme', text: 'stale writer' });
  const listAfterGuard = (await appStore.list({ key: messagesKeyFor(identityA, ACME) })).length;
  check('12b a stale owner is refused by the guard before any write',
    guardRefusal.ok === false && guardRefusal.code === 'lease_lost'
    && guardRefusal.partial_write === false && guardRefusal.retryable === true,
    JSON.stringify(guardRefusal));
  check('12c the guard refusal wrote nothing and demoted the replica',
    listAfterGuard === 6 && a1.role === 'standby', `app=${listAfterGuard} role=${a1.role}`);

  // 12B: the race the guard cannot cover — a stall between guard and the brain
  // call. The hook simulates exactly that window (the gauntlet's SIGSTOP drill).
  await a2.stop();
  await a1.refreshOwnership();
  const epochBeforeStall = a1.brain.fencingState().high_water;
  a1.hooks.afterGuard = async () => {
    advance(9000);
    await a2.refreshOwnership();                             // new epoch, same brain file
  };
  const evidenceBeforeStall = evidenceCount(tenants.a.data_dir);
  const stalled = await a1.handleWrite({ actor: GIGI, client: 'acme', text: 'stalled writer' });
  a1.hooks.afterGuard = null;
  const listAfterStall = (await appStore.list({ key: messagesKeyFor(identityA, ACME) })).length;
  check('12d the brain fence refuses the stalled stale writer',
    stalled.ok === false && stalled.code === 'fencing_token_stale'
    && stalled.partial_write === true && stalled.retryable === true,
    JSON.stringify(stalled));
  check('12e the fenced refusal left NO canonical artifact',
    evidenceCount(tenants.a.data_dir) === evidenceBeforeStall,
    `${evidenceCount(tenants.a.data_dir)} vs ${evidenceBeforeStall}`);
  check('12f the divergence is recorded (app record exists, drift counted)',
    listAfterStall === 7 && stalled.drift_total >= 1,
    `app=${listAfterStall} drift=${stalled.drift_total}`);
  check('12g the refusal is auditable on the brain',
    stalled.brain.fencing_refusals >= 1 && stalled.brain.fencing_high_water > epochBeforeStall,
    JSON.stringify(stalled.brain));
  check('12h the stale replica demoted itself after the refusal', a1.role === 'standby');

  // ── 13. two businesses never share a key, even with the same client id ───
  // B has been idle while the drills advanced the fake clock past its lease
  // TTL, so the host's ownership poll re-acquires (nobody else took it).
  await b1.refreshOwnership();
  const bWrite = await b1.handleWrite({
    actor: { type: 'person', id: 'user:gigi', display_name: 'Gigi' }, client: 'acme',
    text: 'Bob studio onboarding at Acme',
    claims: [{
      subject: { name: 'Acme', type: 'organization' }, predicate: 'onboarding_state',
      object: { type: 'text', value: 'started' }, validity_from: validityFrom,
    }],
  });
  const bIdentity = brainIdentity({ tenant: tenants.b });
  check('13a the second business writes into its own brain and key space',
    bWrite.ok === true
    && messagesKeyFor(bIdentity, ACME) !== messagesKeyFor(identityA, ACME)
    && leaseKeyFor(bIdentity) !== leaseKeyFor(identityA),
    JSON.stringify(bWrite).slice(0, 400));
  const aRecallIsolated = await a2.handleRecall({ actor: OWNER_A, client: 'acme', query: 'Bob studio onboarding' });
  check('13b business A cannot see business B\'s fact',
    aRecallIsolated.ok === true && aRecallIsolated.results.every(result => result.claim?.predicate !== 'onboarding_state'),
    JSON.stringify(aRecallIsolated.results.map(result => result.claim?.predicate)));
  check('13c business B\'s recall cannot see business A\'s facts',
    (await b1.handleRecall({ actor: OWNER_B, client: 'acme', query: 'renewal' }))
      .results.every(result => result.claim?.predicate !== 'renewal_date'));

  // ── 14. attribution: actor + source through smartware/render ────────────
  const provenance = await a2.describeProvenance({ actor: OWNER_A, observation_id: written.observation.id });
  check('14a provenance resolves the authenticated actor and the source',
    provenance.actor.id === 'user:gigi' && provenance.actor.display_name === 'Gigi'
    && typeof provenance.observed_at === 'string',
    JSON.stringify(provenance));
  const staffRender = a2.attribution({ ...provenance.render, surface: 'staff', freshness: 'unverified' });
  const clientRender = a2.attribution({ ...provenance.render, surface: 'client', freshness: 'unverified' });
  check('14b staff-facing attribution renders the actor line; client-facing never does',
    staffRender.show === true && attributionLine({ ...provenance.render, surface: 'staff', freshness: 'unverified' }).includes('Gigi')
    && clientRender.show === false && showAttributionByDefault({ ...provenance.render, surface: 'client', freshness: 'unverified' }) === false,
    JSON.stringify({ staff: staffRender, client: clientRender }));

  const sourceReg = await a2.registerSource({
    actor: OWNER_A,
    source: {
      id: 'src_gmail_ava', kind: 'connector',
      display_name: 'Gmail — ava@harbor-lane', external_ref: 'acct_ava_primary',
    },
  });
  const sourced = await a2.handleWrite({
    actor: GIGI, client: 'acme', text: 'Acme asked for parking details', source_ref: 'src_gmail_ava',
    claims: [{
      subject: { name: 'Acme', type: 'organization' }, predicate: 'asked_for_parking',
      object: { type: 'text', value: 'details' }, validity_from: validityFrom,
    }],
  });
  const sourcedProvenance = await a2.describeProvenance({ actor: OWNER_A, observation_id: sourced.observation.id });
  check('14c a registered source is carried through to provenance',
    sourceReg.ok === true && sourced.ok === true && sourcedProvenance.source.source_ref === 'src_gmail_ava',
    JSON.stringify({ registered: sourceReg.ok, write: sourced.ok, source: sourcedProvenance.source }));

  // ── 15. owner export is scope-exclusive ─────────────────────────────────
  const exported = await a2.exportClientScope({ actor: OWNER_A, client: 'acme' });
  const pkgBytes = fs.readFileSync(path.join(exported.path, 'observations.jsonl'), 'utf8');
  check('15a export is scope-exclusive and reads back from disk',
    exported.manifest.scope_exclusive === true && exported.manifest.scope === ACME && exported.counts.observations > 0);
  check('15b the package cannot contain another client\'s or business\'s bytes',
    !pkgBytes.includes(BCAU) && !pkgBytes.includes('Bob studio onboarding'));

  // ── 16. health: machine-readable, no tenant content ─────────────────────
  const health = await a2.health({ actor: OWNER_A });
  const serialized = JSON.stringify(health);
  check('16a health reports role, holder and epoch',
    health.ok === true && health.role === 'owner' && typeof health.lease.epoch === 'number'
    && health.identity.brain === identityA,
    JSON.stringify({ role: health.role, lease: health.lease }));
  check('16b health carries no tenant content',
    !serialized.includes('Acme renewal') && !serialized.includes('Bob studio')
    && !serialized.includes('let me in') && !serialized.includes('stalled writer'));

  // ── 17. the naive renewal is a hazard, demonstrated ─────────────────────
  const naive = createMemoryArbiter({ now: clock, blindRenew: true });
  await naive.tryAcquire({ key: 'k', holder: 'replica-1', ttlMs: 8000 });
  advance(9000);
  await naive.tryAcquire({ key: 'k', holder: 'replica-2', ttlMs: 8000 });
  const blindRenewed = await naive.renewIfHeld({ key: 'k', holder: 'replica-1', ttlMs: 8000 });
  const correct = await arbiter.tryAcquire({ key: 'probe', holder: 'replica-1', ttlMs: 8000 });
  const correctRenew = correct
    ? await arbiter.renewIfHeld({ key: 'probe', holder: 'replica-1', ttlMs: 8000 })
    : false;
  check('17a SET..XX renewal lets a displaced owner believe it still owns (hazard reproduced)',
    blindRenewed === true);
  check('17b the value-conditional contract refuses it (why the port is specified that way)',
    correct && correctRenew === true
    && (await arbiter.releaseIfHeld({ key: 'probe', holder: 'replica-2' })) === false);
} catch (error) {
  check('adapter smoke completed without an unexpected exception', false, String(error?.stack ?? error));
} finally {
  for (const adapter of [a1, a2, b1]) {
    try { await adapter.stop({ release: false }); } catch { /* already stopped */ }
  }
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

const reportAt = process.argv.indexOf('--report');
if (reportAt !== -1 && process.argv[reportAt + 1]) {
  fs.writeFileSync(process.argv[reportAt + 1], JSON.stringify({
    outcome: failed === 0 ? 'pass' : 'fail',
    total: checks.length,
    passed: checks.length - failed,
    failed,
    checks,
  }, null, 2));
}

console.log('\n=== COFFEE ADAPTER SMOKE ===');
console.log(`checks: ${checks.length - failed}/${checks.length} passed`);
console.log(`ADAPTER_SMOKE_OUTCOME=${failed === 0 ? 'pass' : 'fail'}`);
process.exit(failed === 0 ? 0 : 1);
