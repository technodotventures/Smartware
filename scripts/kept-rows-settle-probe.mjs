// Kept-rows settle probe — kanban t_8779781f (from t_12c79071).
//
// Two arms, each one measurement of the live-vs-rebuild view, plus the mechanism
// asserted rather than assumed. The invariant under test is the survey's:
//
//     after any claim-row mutation, in-process recall == what a fresh open serves
//
// ARM 1 — item 1 settle (the deliberately kept claim-FTS row at FORGET):
//   seed one active claim + lane; FORGET(claim target); recall in-process, then
//   open a fresh core over the same brain dir and recall again. Expected shape:
//   served ids identical ([] both) and counters differ by exactly the kept row
//   (in-process total_found 1 / filtered_out 1 vs fresh 0 / 0). The fresh open's
//   rebuild replaces the shared lane, so a third in-process read shows the two
//   views agree once the lane is replaced — the divergence is row presence only.
//
// ARM 2 — item 2 probe (the async compile worker's incremental lane mirror):
//   (1) OBSERVE a message, then `core.drainCompileQueue()` — the worker mirrors
//       the produced claim C1 into the claim-FTS lane with indexSingleClaims
//       (DELETE+INSERT per handed-over claim; worker.ts:212-217), not a scope
//       replace;
//   (2) a later assertion enters the canonical surface as a claim_extracted
//       event (the replay path replay.ts:194 -> admitClaim -> conflicts.ts:123);
//   (3) a catch-up verb replays it without replacing the claim lane (FORGET's
//       unconditional replayCatchUp, forget.ts:383) — C1 is demoted to
//       `superseded` in the store and the replacement C2 is admitted;
//   (4) a further drain batch mirrors its own claims only;
//   (5) the re-syncing write path (COMPILE stage 4.5, syncSearchFromClaims)
//       replaces the scope's lane as the contrast.
//   Measured after each step: served ids + counters, in-process; then a fresh
//   open of the same brain dir (the rebuild view) last, because its open
//   replaces the shared lane.
//
// Usage:
//   node scripts/kept-rows-settle-probe.mjs [--report <path>]
// Exit 0 = the measurement completed; exit 1 = infrastructure failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = process.env.PROBE_DIST ?? path.join(ROOT, 'dist');

const { SmartwareCore } = await import(path.join(DIST, 'core.js'));
const { createDefaultConfig, saveConfig } = await import(path.join(DIST, 'config.js'));
const { ClaimStore } = await import(path.join(DIST, 'layer1/store.js'));
const { SearchIndex, syncSearchFromClaims } = await import(path.join(DIST, 'layer3/search.js'));
const { knownTime, nullTime } = await import(path.join(DIST, 'layer1/types.js'));
const { appendObservation } = await import(path.join(DIST, 'layer0/log.js'));
const { assignIntegrity } = await import(path.join(DIST, 'layer0/integrity.js'));
const { Layer0Index } = await import(path.join(DIST, 'layer0/index.js'));
const { SMARTWARE_VERSION } = await import(path.join(DIST, 'version.js'));

const OWNER = { type: 'person', id: 'user:owner', display_name: 'Owner' };
const SCOPE = 'client:acme#1';
const T1 = '2026-08-01T00:00:00.000Z';
const T2 = '2026-09-01T00:00:00.000Z';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function opId() {
  let out = '';
  for (let i = 0; i < 26; i += 1) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `op_${out}`;
}
function mintId(prefix) {
  return `${prefix}_${createHash('sha256').update(`${prefix}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 26)}`;
}

function scaffold(dataDir) {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/entities', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = OWNER.id;
  cfg.llm = { provider: 'none', model: '' };
  cfg.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    { id: SCOPE, parent: 'workspace', visibility_default: 'scope' },
  ];
  cfg.grants = [];
  saveConfig(dataDir, cfg);
  return cfg;
}

async function openCore(dataDir) {
  return SmartwareCore.open({ dataDir, ownerId: OWNER.id });
}

/** What recall serves for one query: the rows, and the counters around them. */
async function sig(core, query) {
  const result = await core.recall({ actor: OWNER, query, scope: SCOPE });
  return {
    query,
    ids: result.results.flatMap(entry => (entry.claim ? [entry.claim.id] : [])).sort(),
    total_found: result.total_found,
    filtered_out: result.filtered_out,
  };
}

/** A fresh open of the same brain dir — the rebuild view. NOTE: its open
 *  replaces the shared claim lane, so take every in-process reading FIRST. */
async function freshSigs(dataDir, queries) {
  const core = await openCore(dataDir);
  try {
    const out = {};
    for (const [label, query] of Object.entries(queries)) out[label] = await sig(core, query);
    return out;
  } finally {
    core.close();
  }
}

function storeRow(store, claimId) {
  const claim = store.getClaim(claimId);
  return claim
    ? { id: claim.id, status: claim.status, scope: claim.scope, superseded_by: claim.superseded_by ?? null, value: claim.object.value }
    : null;
}

/** Canonical claim versions of one claim id, straight from the L1 JSONL. */
function canonicalVersions(dataDir, claimId) {
  const claimsDir = path.join(dataDir, 'claims');
  if (!fs.existsSync(claimsDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(claimsDir).filter(n => n.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(claimsDir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.claim_id !== claimId) continue;
      out.push({ file: name, ...record });
    }
  }
  return out;
}

function summariseVersion(record) {
  return {
    file: record.file,
    version: record.version,
    state: record.state,
    supersedes: record.supersedes ?? null,
    superseded_by: record.superseded_by ?? null,
    superseded_at: record.superseded_at ?? null,
    operation_id: record.operation_id ?? null,
    actor_id: record.actor_id ?? null,
    derived_from: record.derived_from ?? null,
    claim_type: record.claim_type ?? null,
    claim_role: record.claim_role ?? null,
    author: record.author ?? null,
    epistemic_owner: record.epistemic_owner ?? null,
    created_at: record.created_at ?? null,
    version_at: record.version_at ?? null,
    content: typeof record.content === 'string' ? record.content.slice(0, 80) : record.content,
  };
}

/**
 * Append one claim_extracted observation to the canonical evidence log, the way
 * a host that owns extraction persisted claims (OBSERVE itself rejects
 * pre-extracted claims, observe.ts:135-137 — this is the retained replay path).
 * Returns the observation id.
 */
function appendClaimExtractedEvent(dataDir, { parentObsId, subjectId, subjectName, predicate, value, validFrom }) {
  const evidenceDir = path.join(dataDir, 'evidence');
  const dbPath = path.join(dataDir, 'smartware.db');
  const config = createDefaultConfig(dataDir);
  const layer0 = new Layer0Index(dbPath);
  layer0.catchUp(evidenceDir);
  const seq = layer0.getLastSequence() + 1;
  const prevHash = layer0.getLatestHashForWriter(config.writer_id);
  const observationId = mintId('obs');
  const claimInput = {
    subject_id: subjectId,
    subject_name: subjectName,
    subject_type: 'concept',
    predicate,
    object: { type: 'enum', value },
    scope: SCOPE,
    validity: { from: validFrom, to: null },
    t_valid_from: validFrom,
    t_valid_to: null,
    epistemic: 'observed',
    confidence: 0.8,
    sensitive: false,
    extraction: { method: 'deterministic', model: null, compiler_version: '0.7.0', prompt_hash: null },
  };
  const obs = {
    id: observationId,
    version: SMARTWARE_VERSION,
    type: 'claim_extracted',
    status: 'accepted',
    source: {
      app: 'settle-probe',
      app_version: SMARTWARE_VERSION,
      source_id: null,
      actor: OWNER,
      captured_at: new Date().toISOString(),
      observed_at: validFrom,
    },
    scope: SCOPE,
    visibility: 'scope',
    content: { format: 'application/json', body: { claims: [claimInput], source_obs_observed_at: validFrom } },
    claims: [claimInput],
    provenance: { parent_ids: [parentObsId], informed_by: [], supersedes: [], context: '' },
    idempotency: null,
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
  };
  const withIntegrity = assignIntegrity(obs, config.writer_id, seq, prevHash);
  appendObservation(evidenceDir, withIntegrity);
  layer0.insertOrSkip(withIntegrity);
  layer0.close();
  return { observation_id: observationId, sequence: seq, claim_input: claimInput };
}

function makeClaimObj({ id, entityId, subject, predicate, value }) {
  return {
    id,
    subject_id: entityId,
    subject_name: subject,
    predicate,
    object: { type: 'text', value },
    scope: SCOPE,
    validity: { from: T1, to: null },
    t_ingested: knownTime(T1),
    t_invalidated: nullTime(),
    t_valid_from: knownTime(T1),
    t_valid_to: nullTime(),
    source_event_id: mintId('obs'),
    extraction_event_id: mintId('obs'),
    supporting_evidence: [mintId('obs')],
    extraction: { method: 'deterministic', model: null, compiler_version: '0.7.0', prompt_hash: null, extracted_at: T1 },
    status: 'active',
    epistemic: 'observed',
    confidence: 0.7,
    sensitive: false,
    superseded_by: null,
    contested_by: [],
  };
}

/** Every claim row in the scope, as the store serves it. */
function dumpClaims(store) {
  return store.getAllClaims(SCOPE)
    .map(row => ({ id: row.id, subject: row.subject_name, predicate: row.predicate, value: row.object.value, status: row.status, superseded_by: row.superseded_by ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every claim-FTS row of the scope, straight from the lane table. */
function dumpLane(searchIndex) {
  const rows = searchIndex.getDB()
    .prepare('SELECT claim_id, substr(content, 1, 60) AS content FROM claim_search_index WHERE scope = ?')
    .all(SCOPE);
  return rows.sort((a, b) => a.claim_id.localeCompare(b.claim_id));
}

function watermark(store) {
  return store.getLastReplayedSequence();
}

// ── Arm 1 — the kept row at FORGET (item 1 settle) ──────────────────────────
async function arm1() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-settle-a1-'));
  scaffold(dataDir);
  const core = await openCore(dataDir);
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);

  const subject = 'Forget Kept Row Probe';
  const entityId = mintId('entity');
  store.insertEntity({ id: entityId, canonical_name: subject, aliases: [], type: 'organization', scope: SCOPE, created_at: T1 });
  const claim = makeClaimObj({ id: mintId('claim'), entityId, subject, predicate: 'probe_state', value: 'written-off' });
  store.insertClaim(claim);
  syncSearchFromClaims(store, searchIndex, SCOPE);

  const report = { claim_id: claim.id, query: subject };
  report.before = await sig(core, subject);

  report.forget = await core.forget({
    actor: OWNER,
    target: { type: 'claim', id: claim.id },
    mode: 'tombstone',
    reason: 'settle probe',
    operation_id: opId(),
  });
  report.after_mutation_in_process = await sig(core, subject);

  // Fresh open last: its rebuild replaces the shared lane.
  report.fresh = (await freshSigs(dataDir, { kept: subject })).kept;
  report.after_fresh_rebuild_in_process = await sig(core, subject);
  report.row = storeRow(store, claim.id);
  report.canonical = canonicalVersions(dataDir, claim.id);

  report.verdict = {
    served_equal_in_process_vs_fresh: JSON.stringify(report.after_mutation_in_process.ids) === JSON.stringify(report.fresh.ids),
    counter_delta_total_found: report.after_mutation_in_process.total_found - report.fresh.total_found,
    counter_delta_filtered_out: report.after_mutation_in_process.filtered_out - report.fresh.filtered_out,
    views_agree_after_rebuild: JSON.stringify(report.after_fresh_rebuild_in_process) === JSON.stringify({ ...report.fresh }),
  };

  store.close();
  searchIndex.close();
  core.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  return report;
}

// ── Arm 2 — the drain's incremental mirror (item 2 probe) ───────────────────
async function arm2() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-settle-a2-'));
  scaffold(dataDir);
  const core = await openCore(dataDir);
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);

  const report = { dataDir };

  // (1) a claim produced through the async compile worker (incremental mirror)
  const o1 = await core.observe({
    actor: OWNER,
    type: 'message',
    content: { format: 'text/plain', body: 'Zircorp Harbour Freight is active.' },
    scope: SCOPE,
    observed_at: T1,
  });
  report.observation_1 = { id: o1.id, body: 'Zircorp Harbour Freight is active.' };
  report.drain_1 = await core.drainCompileQueue();
  const claimsAfterDrain = store.getAllClaims(SCOPE);
  report.step_after_drain_1 = { claims: dumpClaims(store), lane: dumpLane(searchIndex), watermark: watermark(store) };
  report.claims_after_drain_1 = claimsAfterDrain.map(row => ({
    id: row.id, subject: row.subject_name, predicate: row.predicate, value: row.object.value, status: row.status,
  }));
  const c1 = claimsAfterDrain.find(row => row.subject_name === 'Zircorp Harbour Freight');
  if (!c1) throw new Error('arm2: drain produced no Zircorp claim');
  report.c1 = { id: c1.id, subject: c1.subject_name, predicate: c1.predicate, value: c1.object.value, status: c1.status };
  report.before = await sig(core, c1.subject_name);

  // (2) the later assertion, as a claim_extracted event (the replay path)
  report.event_2 = appendClaimExtractedEvent(dataDir, {
    parentObsId: o1.id,
    subjectId: c1.subject_id,
    subjectName: c1.subject_name,
    predicate: c1.predicate,
    value: 'cancelled',
    validFrom: T2,
  });

  // (3) a catch-up verb: FORGET replays unconditionally (forget.ts:383) and does
  //     NOT replace the claim lane. The decoy carries the verb's own effects away.
  const decoy = await core.observe({
    actor: OWNER,
    type: 'message',
    content: { format: 'text/plain', body: 'Logistics note: the harbour route runs twice weekly.' },
    scope: SCOPE,
    observed_at: T1,
  });
  report.decoy_observation = { id: decoy.id };
  report.forget_decoy = await core.forget({
    actor: OWNER,
    target: { type: 'observation', id: decoy.id },
    mode: 'tombstone',
    reason: 'settle probe decoy (the catch-up carrier)',
    operation_id: opId(),
  });

  report.c1_row_after_catchup = storeRow(store, c1.id);
  const c2 = store.getAllClaims(SCOPE).find(row =>
    row.subject_id === c1.subject_id && row.predicate === c1.predicate && row.id !== c1.id);
  report.c2 = c2
    ? { id: c2.id, subject: c2.subject_name, predicate: c2.predicate, value: c2.object.value, status: c2.status }
    : null;
  report.step_after_catchup = { claims: dumpClaims(store), lane: dumpLane(searchIndex), watermark: watermark(store) };
  report.after_catchup = {
    kept_value: await sig(core, 'active'),
    subject: await sig(core, c1.subject_name),
  };

  // (4) a further drain batch — mirrors its own claims only; does it reconcile?
  const o4 = await core.observe({
    actor: OWNER,
    type: 'message',
    content: { format: 'text/plain', body: 'Ridgeway Depot is pending.' },
    scope: SCOPE,
    observed_at: T1,
  });
  report.observation_4 = { id: o4.id };
  report.drain_2 = await core.drainCompileQueue();
  report.step_after_drain_2 = { claims: dumpClaims(store), lane: dumpLane(searchIndex), watermark: watermark(store) };
  report.after_drain_2 = {
    kept_value: await sig(core, 'active'),
    subject: await sig(core, c1.subject_name),
  };

  // (5) the re-syncing write path (COMPILE stage 4.5 replaces the scope's lane)
  report.compile = await core.compile({ actor: OWNER, scope: SCOPE });
  report.step_after_compile = { claims: dumpClaims(store), lane: dumpLane(searchIndex), watermark: watermark(store) };
  report.after_compile = {
    kept_value: await sig(core, 'active'),
    subject: await sig(core, c1.subject_name),
  };

  // Fresh leg last: its open replaces the shared lane. Isolate WHEN the view
  // changes: dump before the open, immediately after the open (before any
  // recall), and after.
  report.pre_fresh = { claims: dumpClaims(store), lane: dumpLane(searchIndex), watermark: watermark(store) };
  const freshCore = await openCore(dataDir);
  report.post_fresh_open_pre_recall = { claims: dumpClaims(store), lane: dumpLane(searchIndex), watermark: watermark(store) };
  report.fresh = {
    kept_value: await sig(freshCore, 'active'),
    subject: await sig(freshCore, c1.subject_name),
  };
  freshCore.close();
  report.step_after_fresh_open = { claims: dumpClaims(store), lane: dumpLane(searchIndex), watermark: watermark(store) };
  report.canonical_c1 = canonicalVersions(dataDir, c1.id).map(summariseVersion);
  report.canonical_c2 = c2 ? canonicalVersions(dataDir, c2.id).map(summariseVersion) : [];

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  report.verdict = {
    c1_demoted_in_store: report.c1_row_after_catchup?.status === 'superseded',
    c1_superseded_by_c2: report.c1_row_after_catchup?.superseded_by === (report.c2?.id ?? null),
    c2_admitted: report.c2 !== null && report.c2.status === 'active',
    // the kept-row shape (same as item 1): served ids identical, counters not
    kept_row_served_equal: same(report.after_catchup.kept_value.ids, report.fresh.kept_value.ids),
    kept_row_counter_delta: report.after_catchup.kept_value.total_found - report.fresh.kept_value.total_found,
    // the replacement claim the catch-up admitted: visible to the rebuild, not to the live lane
    subject_served_in_process: report.after_catchup.subject.ids,
    subject_served_fresh: report.fresh.subject.ids,
    subject_served_equal: same(report.after_catchup.subject.ids, report.fresh.subject.ids),
    // does a further drain batch reconcile the lane? (expected: no)
    drain_2_reconciles_kept: same(report.after_drain_2.kept_value, report.after_catchup.kept_value),
    drain_2_reconciles_subject: same(report.after_drain_2.subject, report.after_catchup.subject),
    // does the re-syncing write path reconcile? (expected: yes)
    compile_reconciles_kept: same(report.after_compile.kept_value, report.fresh.kept_value),
    compile_reconciles_subject: same(report.after_compile.subject, report.fresh.subject),
  };

  store.close();
  searchIndex.close();
  core.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  return report;
}

// ── Arm 3 — the mechanism, minimal: a demotion's canonical record and re-materialisation ──
// What `applyTemporalSupersession` (conflicts.ts:123) does, with nothing else in the way:
// stamp the demotion on the claim (updateClaimStatus), then re-materialise the store from
// the canonical surface the way `SmartwareCore.open` does (ClaimStore.setDataDir).
async function arm3() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-settle-a3-'));
  scaffold(dataDir);
  const core = await openCore(dataDir);
  const dbPath = path.join(dataDir, 'smartware.db');
  let store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);

  const subject = 'Basalt Ridge Depot';
  const entityId = mintId('entity');
  store.insertEntity({ id: entityId, canonical_name: subject, aliases: [], type: 'organization', scope: SCOPE, created_at: T1 });
  const claim = makeClaimObj({ id: mintId('claim'), entityId, subject, predicate: 'probe_state', value: 'demote-me' });
  store.insertClaim(claim);

  const report = { claim_id: claim.id, successor_id: mintId('claim') };
  report.before = storeRow(store, claim.id);

  store.updateClaimStatus(claim.id, 'superseded', report.successor_id, knownTime(T2), knownTime(T2));
  report.after_demotion_live = storeRow(store, claim.id);
  report.canonical_after_demotion = canonicalVersions(dataDir, claim.id).map(summariseVersion);

  store.close();
  store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  report.after_rematerialise = storeRow(store, claim.id);
  report.canonical_after_rematerialise = canonicalVersions(dataDir, claim.id).map(summariseVersion);

  const latest = report.canonical_after_demotion.at(-1);
  report.verdict = {
    demotion_live_status: report.after_demotion_live?.status ?? null,
    canonical_record_state: latest?.state ?? null,
    canonical_record_carries_pointer: !!(latest?.superseded_by),
    demotion_survives_rematerialisation: report.after_rematerialise?.status === 'superseded',
  };

  store.close();
  core.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  return report;
}

// ── main ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argValue(flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}
const reportPath = argValue('--report');
const which = argValue('--arm', 'all');

const report = {
  generated_at: new Date().toISOString(),
  node: process.version,
  dist: DIST,
  task: 't_8779781f',
  arms: which,
};

if (which === 'all' || which === '1') report.arm1 = await arm1();
if (which === 'all' || which === '2') report.arm2 = await arm2();
if (which === 'all' || which === '3') report.arm3 = await arm3();
report.verdict = Object.fromEntries(
  Object.entries(report).filter(([, value]) => value && typeof value === 'object' && value.verdict).map(([key, value]) => [key, value.verdict]),
);

const text = JSON.stringify(report, null, 2);
if (reportPath) fs.writeFileSync(reportPath, `${text}\n`);
process.stdout.write(`${text}\n`);
process.exit(0);
