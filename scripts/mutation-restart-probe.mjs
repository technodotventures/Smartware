// Claim-mutation durability probe (kanban t_12c79071).
//
// The class this instrument measures, the same one t_8ddfa350 (CORRECT) and
// t_336ba0b9 (REVISE) measured: a core verb that moves claim rows through the
// store without re-syncing the claim-FTS lane leaves the live process
// disagreeing with every restart. `SmartwareCore.open` re-derives the derived
// rows from the canonical surface and re-syncs, so a durable surface and a live
// process must answer the same question the same way.
//
// Three legs, the shape t_336ba0b9's coffee-revise-restart-probe.mjs used:
//
//   leg 1  mutate through the open brain (FORGET / expireRetention, then a
//          later write, then REVIVE) and recall IN THIS PROCESS;
//   leg 2  a NEW core instance over the same brain directory in this process
//          (a supervisor's restart) — recall again;
//   leg 3  the same question from a genuinely separate PROCESS (only the brain
//          directory is shared) — recall again.
//
// Deviation from the t_336ba0b9 instrument, stated plainly: that one drove its
// mutation and its reads through the Coffee reference adapter
// (examples/coffee-adapter/adapter.mjs). The adapter exposes no FORGET/REVIVE
// surface (its only claim mutation is correctClaim), so this variant drives
// SmartwareCore directly — the surface the survey is about — and keeps the
// three-leg structure, the report shape and the exit-code contract.
//
// Usage:
//   node mutation-restart-probe.mjs --scenario forget-revive
//   node mutation-restart-probe.mjs --scenario retention-revive
//   node mutation-restart-probe.mjs --child <payload.json>     # second process
//   GATE_DATA_DIR=<dir> node ...                               # keep the brain
//   --report <path> writes the JSON report (also printed).
//
// Exit code 0 only when all three legs agree on what recall serves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = process.env.PROBE_DIST ?? path.join(ROOT, 'dist');

const { SmartwareCore } = await import(path.join(DIST, 'core.js'));
const { createDefaultConfig, saveConfig } = await import(path.join(DIST, 'config.js'));
const { ClaimStore } = await import(path.join(DIST, 'layer1/store.js'));
const { SearchIndex, syncSearchFromClaims } = await import(path.join(DIST, 'layer3/search.js'));
const { knownTime, nullTime } = await import(path.join(DIST, 'layer1/types.js'));

const OWNER = { type: 'person', id: 'user:owner', display_name: 'Owner' };
const SCOPE = 'client:acme#1';
const T1 = '2026-08-01T00:00:00.000Z';
const AS_OF = '2026-09-10T00:00:00.000Z';
const SUBJECT = 'Zircon Harbour Freight';
const PREDICATE = 'freight_contract_state';
const INTERVENING_SUBJECT = 'Basalt Ridge Survey';

function ulid() {
  // Crockford base32, monotonic-enough for a probe fixture.
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function scaffold(dataDir, { retention }) {
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
  if (retention) {
    cfg.retention = {
      default: { policy: 'forever', duration_days: null },
      scope_overrides: { [SCOPE]: { policy: 'duration', duration_days: 1 } },
    };
  }
  saveConfig(dataDir, cfg);
}

// ── canonical + derived state of one claim, for the report ───────────────────
function canonicalRecords(dataDir, claimId) {
  const claimsDir = path.join(dataDir, 'claims');
  if (!fs.existsSync(claimsDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(claimsDir).filter(n => n.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(claimsDir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      const id = record?.claim_id ?? record?.id;
      if (id !== claimId) continue;
      out.push({ file: name, version: record.version ?? null, state: record.state ?? null, revived_via: record.revived_via ?? null });
    }
  }
  return out;
}

function storeRow(dataDir, claimId) {
  const dbPath = path.join(dataDir, 'smartware.db');
  if (!fs.existsSync(dbPath)) return null;
  const store = new ClaimStore(dbPath);
  try {
    const claim = store.getClaim(claimId);
    return claim ? { status: claim.status, scope: claim.scope, superseded_by: claim.superseded_by ?? null } : null;
  } finally {
    store.close();
  }
}

async function recallRows(core, query) {
  const result = await core.recall({ actor: OWNER, query, scope: SCOPE });
  return {
    rows: result.results.map(hit => ({
      claim_id: hit.claim?.id ?? null,
      predicate: hit.claim?.predicate ?? null,
      value: hit.claim?.object?.value ?? null,
      status: hit.claim?.status ?? null,
    })),
    total_found: result.total_found,
    filtered_out: result.filtered_out,
  };
}

async function openCore(dataDir) {
  return SmartwareCore.open({ dataDir, ownerId: OWNER.id });
}

// ── second-process mode ──────────────────────────────────────────────────────
if (process.argv[2] === '--child') {
  const payload = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const core = await openCore(payload.dataDir);
  try {
    const served = await recallRows(core, payload.query);
    const report = {
      pid: process.pid,
      served,
      canonical: canonicalRecords(payload.dataDir, payload.claimId),
      row: storeRow(payload.dataDir, payload.claimId),
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    core.close();
  }
  process.exit(0);
}

// ── mutation legs ────────────────────────────────────────────────────────────
async function buildFixture(dataDir, { retention, evidenceObservation }) {
  scaffold(dataDir, { retention });
  const core = await openCore(dataDir);
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);

  const subjectEntity = `entity_${ulid()}`;
  store.insertEntity({
    id: subjectEntity, canonical_name: SUBJECT, aliases: [], type: 'organization', scope: SCOPE, created_at: T1,
  });
  const claimId = `claim_${ulid()}`;
  let evidence = [`obs_${ulid()}`];
  if (evidenceObservation) {
    const obs = await core.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: `${SUBJECT} contract closed` },
      scope: SCOPE, observed_at: T1,
    });
    evidence = [obs.id];
  }
  store.insertClaim({
    id: claimId,
    subject_id: subjectEntity,
    subject_name: SUBJECT,
    predicate: PREDICATE,
    object: { type: 'text', value: 'renewed-2031' },
    scope: SCOPE,
    validity: { from: T1, to: null },
    t_ingested: knownTime(T1),
    t_invalidated: nullTime(),
    t_valid_from: knownTime(T1),
    t_valid_to: nullTime(),
    source_event_id: evidence[0],
    extraction_event_id: evidence[0],
    supporting_evidence: evidence,
    extraction: { method: 'deterministic', model: null, compiler_version: '0.7.0', prompt_hash: null, extracted_at: T1 },
    status: 'active',
    epistemic: 'observed',
    confidence: 0.7,
    sensitive: false,
    superseded_by: null,
    contested_by: [],
  });
  syncSearchFromClaims(store, searchIndex, SCOPE);
  return { core, store, searchIndex, claimId, evidenceId: evidence[0] };
}

/** A later write in the same scope: CONSOLIDATE re-syncs the scope. */
async function laterWrite(core, store, searchIndex) {
  const ids = [];
  for (const [name, value] of [[`${INTERVENING_SUBJECT} Alpha`, 'one'], [`${INTERVENING_SUBJECT} Beta`, 'two']]) {
    const entityId = `entity_${ulid()}`;
    store.insertEntity({ id: entityId, canonical_name: name, aliases: [], type: 'organization', scope: SCOPE, created_at: T1 });
    const id = `claim_${ulid()}`;
    store.insertClaim({
      id,
      subject_id: entityId,
      subject_name: name,
      predicate: 'survey_state',
      object: { type: 'text', value },
      scope: SCOPE,
      validity: { from: T1, to: null },
      t_ingested: knownTime(T1),
      t_invalidated: nullTime(),
      t_valid_from: knownTime(T1),
      t_valid_to: nullTime(),
      source_event_id: `obs_${ulid()}`,
      extraction_event_id: `obs_${ulid()}`,
      supporting_evidence: [`obs_${ulid()}`],
      extraction: { method: 'deterministic', model: null, compiler_version: '0.7.0', prompt_hash: null, extracted_at: T1 },
      status: 'active',
      epistemic: 'observed',
      confidence: 0.6,
      sensitive: false,
      superseded_by: null,
      contested_by: [],
    });
    ids.push(id);
  }
  syncSearchFromClaims(store, searchIndex, SCOPE);
  return core.consolidate({
    actor: OWNER,
    claim_ids: ids,
    summary: `${INTERVENING_SUBJECT} Alpha and Beta are both under review.`,
    subject_name: `${INTERVENING_SUBJECT} Review`,
    predicate: 'survey_review',
    scope: SCOPE,
    operation_id: `op_${ulid()}`,
  });
}

// ── main ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argValue(flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}
const scenario = argValue('--scenario', 'forget-revive');
const keepDir = process.env.GATE_DATA_DIR ?? null;
const dataDir = keepDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `sw-${scenario}-`));

const report = { scenario, dataDir, legs: {}, canonical: [], row: {}, verdict: null };
const { core, store, searchIndex, claimId, evidenceId } = await buildFixture(dataDir, {
  retention: scenario === 'retention-revive',
  // both the sweep and an observation-target FORGET leave the claim's only
  // source observation terminal, so both need a real L0 observation to point at
  evidenceObservation: scenario !== 'forget-revive',
});
report.claimId = claimId;
report.query = SUBJECT;

const beforeMutation = await recallRows(core, SUBJECT);
report.legs.before_mutation = beforeMutation;

if (scenario === 'retention-revive') {
  report.sweep = await core.expireRetention({ actor: OWNER, scope: SCOPE, as_of: AS_OF });
} else if (scenario === 'forget-observation-revive') {
  report.forget = await core.forget({
    actor: OWNER, target: { type: 'observation', id: evidenceId },
    mode: 'tombstone', reason: 'probe', operation_id: `op_${ulid()}`,
  });
} else {
  report.forget = await core.forget({
    actor: OWNER, target: { type: 'claim', id: claimId }, mode: 'tombstone',
    reason: 'probe', operation_id: `op_${ulid()}`,
  });
}
report.legs.after_mutation = await recallRows(core, SUBJECT);

report.later_write = await laterWrite(core, store, searchIndex);
report.legs.after_later_write = await recallRows(core, SUBJECT);

report.revive = await core.revive({
  actor: OWNER, tombstone_id: `tomb_${claimId.slice(6)}`,
  reason: 'the fact stands after all', operation_id: `op_${ulid()}`,
});

// leg 1 — the process that performed the mutation.
report.legs.leg1_in_process = await recallRows(core, SUBJECT);

// leg 2 — a new core instance in this process (restart semantics).
const restarted = await openCore(dataDir);
try {
  report.legs.leg2_restart = await recallRows(restarted, SUBJECT);
} finally {
  restarted.close();
}

// leg 3 — a genuinely separate process over the same brain dir.
const payloadPath = path.join(dataDir, 'child-payload.json');
fs.writeFileSync(payloadPath, JSON.stringify({ dataDir, query: SUBJECT, claimId }));
const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', payloadPath], {
  encoding: 'utf8', env: { ...process.env, PROBE_DIST: DIST },
});
if (child.status !== 0) {
  report.legs.leg3_second_process = { error: child.stderr?.slice(0, 800) ?? `exit ${child.status}` };
} else {
  report.legs.leg3_second_process = JSON.parse(child.stdout.trim());
}

report.canonical = canonicalRecords(dataDir, claimId);
report.row = storeRow(dataDir, claimId);

const serveIds = leg => (leg?.served?.rows ?? leg?.rows ?? []).map(row => row.claim_id).sort();
const leg1 = serveIds(report.legs.leg1_in_process).join(',');
const leg2 = serveIds(report.legs.leg2_restart).join(',');
const leg3 = serveIds(report.legs.leg3_second_process).join(',');
const allAgree = leg1 === leg2 && leg2 === leg3;
const durableServesClaim = [leg2, leg3].every(ids => ids.split(',').includes(claimId));
report.verdict = {
  served_in_process: leg1,
  served_restart: leg2,
  served_second_process: leg3,
  all_legs_agree: allAgree,
  durable_surface_serves_revived_claim: durableServesClaim,
  pass: allAgree,
};

store.close();
searchIndex.close();
core.close();
if (!keepDir) fs.rmSync(dataDir, { recursive: true, force: true });

const text = JSON.stringify(report, null, 2);
const reportPath = argValue('--report');
if (reportPath) fs.writeFileSync(reportPath, `${text}\n`);
process.stdout.write(`${text}\n`);
process.exit(report.verdict.pass ? 0 : 1);
