// MCP dispatcher-surface claim-FTS lane probe — kanban t_dae50f51.
//
// Drives the exact call shapes `src/index.ts`'s MCP tools use for the two verbs
// whose lane repairs live in wrappers the MCP surface never goes through:
//
//   smartware_correct -> handleCorrect(params, evidenceDir, layer0, store, config, searchIndex)
//                        (transport shape today; the lane arg is the t_a6bf30a8 addition)
//   smartware_revise  -> handleRevise(params, dataDir, store, config, { opsDir },
//                                     undefined, undefined, searchIndex)
//                        (transport shape after this lane's fix; the trailing args are
//                         ignored at the pre-fix tip, which is exactly the RED condition)
//
// then compares in-process recall (through a live SmartwareCore over the same DB)
// with a fresh open of the same brain.
//
// usage: node scripts/mcp-surface-probe.mjs <dist-dir> [correct-changed|correct-wrong|revise|revise-core|all] [out.jsonl]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

const DIST = process.argv[2];
const SCEN = process.argv[3] ?? 'all';
const OUT = process.argv[4] ?? null;
if (!DIST) {
  console.error('usage: node scripts/mcp-surface-probe.mjs <dist-dir> [correct-changed|correct-wrong|revise|revise-core|all] [out.jsonl]');
  process.exit(2);
}
const imp = (p) => import(pathToFileURL(path.join(DIST, p)).href);

const { SmartwareCore } = await imp('core.js');
const { createDefaultConfig, saveConfig, loadConfig } = await imp('config.js');
const { ClaimStore } = await imp('layer1/store.js');
const { SearchIndex, syncSearchFromClaims } = await imp('layer3/search.js');
const { knownTime, nullTime } = await imp('layer1/types.js');
const { Layer0Index } = await imp('layer0/index.js');
const { handleCorrect } = await imp('protocol/correct.js');
const { handleRevise } = await imp('protocol/revise.js');
const { admitClaim } = await imp('layer1/conflicts.js');
const { iterAllClaimVersions } = await imp('layer1/jsonl.js');

const OWNER = { type: 'person', id: 'user:owner', display_name: 'Owner' };
const SCOPE = 'client:acme#1';
const T1 = '2026-08-01T00:00:00.000Z';
const T2 = '2026-09-01T00:00:00.000Z';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 26);
const opId = () => `op_${[...randomBytes(26)].map(b => CROCKFORD[b % 32]).join('')}`;

function setup(tag) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sw-mcp-${tag}-`));
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
  saveConfig(dataDir, cfg);
  return dataDir;
}

function makeProbeClaim({ id, entityId, subject, value, validFrom, ingestedAt }) {
  return {
    id, subject_id: entityId, subject_name: subject,
    predicate: 'probe_state', object: { type: 'text', value }, scope: SCOPE,
    validity: { from: validFrom, to: null },
    t_ingested: knownTime(ingestedAt), t_invalidated: nullTime(),
    t_valid_from: knownTime(validFrom), t_valid_to: nullTime(),
    source_event_id: `obs_${hash(id + 'src')}`, extraction_event_id: `obs_${hash(id + 'ext')}`,
    supporting_evidence: [`obs_${hash(id + 'ev')}`],
    extraction: { method: 'deterministic', model: null, compiler_version: '0.7.0', prompt_hash: null, extracted_at: ingestedAt },
    status: 'active', epistemic: 'observed', confidence: 0.7, sensitive: false,
    superseded_by: null, contested_by: [],
  };
}

const laneRows = (ix) => ix.getDB().prepare('SELECT claim_id FROM claim_search_index WHERE scope = ?').all(SCOPE).map(r => r.claim_id).sort();
const recallIds = async (core, query) => (await core.recall({ actor: OWNER, query, scope: SCOPE }))
  .results.flatMap(e => (e.claim ? [e.claim.id] : [])).sort();
const rowStatuses = (store) => store.getAllClaims(SCOPE).map(c => `${c.id.slice(0, 12)}=${c.status}`).sort();
const latestVersionOf = (dataDir, claimId) => [...iterAllClaimVersions(dataDir)]
  .filter(v => v.claim_id === claimId)
  .reduce((max, v) => Math.max(max, v.version), 0);

async function freshRecall(dataDir, query) {
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  try {
    return await recallIds(core, query);
  } finally {
    core.close();
  }
}

function report(rec) {
  const line = JSON.stringify(rec);
  console.log(line);
  if (OUT) fs.appendFileSync(OUT, `${line}\n`);
}

// ── Scenario: CORRECT over the MCP call shape ────────────────────────────────
// reason=changed: the correction supersedes the target (state 'active' in its
// canonical record) — a fresh open re-materialises it (the demotion projection
// is not durable on this base: e5f093e/3ae8a6b, not in this branch's ancestry).
// reason=wrong:  the target is retracted (canonical state 'forgotten'), so the
// fresh leg serves only the replacement — demotion-free.
async function scenarioCorrect(reason) {
  const tag = `correct-${reason}`;
  const dataDir = setup(tag);
  const dbPath = path.join(dataDir, 'smartware.db');
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  const layer0 = new Layer0Index(dbPath);
  layer0.catchUp(path.join(dataDir, 'evidence'));
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);

  const subject = reason === 'wrong' ? 'Wrong Carrier Co' : 'Changed Carrier Co';
  const entityId = `entity_${hash(`carrier-${reason}`)}`;
  store.insertEntity({ id: entityId, canonical_name: subject, aliases: [], type: 'concept', scope: SCOPE, created_at: T1 });
  const claimId = `claim_${hash(`target-${reason}`)}`;
  store.insertClaim(makeProbeClaim({ id: claimId, entityId, subject, value: 'before', validFrom: T1, ingestedAt: T1 }));
  syncSearchFromClaims(store, searchIndex, SCOPE);

  const laneBefore = laneRows(searchIndex);
  const config = loadConfig(dataDir);
  let result = null;
  let error = null;
  try {
    result = await handleCorrect(
      { actor: OWNER, target_claim_id: claimId, corrected_object: { type: 'text', value: 'after' }, reason },
      path.join(dataDir, 'evidence'), layer0, store, config, searchIndex,
    );
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  const laneAfter = laneRows(searchIndex);
  const rowsAfter = rowStatuses(store);
  const inProcess = await recallIds(core, subject.split(' ')[0]);
  store.close(); searchIndex.close(); layer0.close(); core.close();

  const fresh = await freshRecall(dataDir, subject.split(' ')[0]);
  fs.rmSync(dataDir, { recursive: true, force: true });

  report({
    scenario: tag, dist: DIST,
    lane_before: laneBefore, lane_after: laneAfter, rows_after: rowsAfter,
    new_claim_id: result?.new_claim_id ?? null, error,
    in_process: inProcess, fresh,
    in_process_serves_replacement: result?.new_claim_id ? inProcess.includes(result.new_claim_id) : null,
    in_process_equals_fresh: JSON.stringify(inProcess) === JSON.stringify(fresh),
  });
}

// ── Scenario: REVISE over the MCP call shape ─────────────────────────────────
// The t_336ba0b9 composition (PR #29): a superseded claim revised by the user.
// The fresh open re-derives the claim's indexable state from its canonical
// version record; the live lane is only rebuilt by a re-sync.
async function buildReviseComposition(tag) {
  const dataDir = setup(tag);
  const dbPath = path.join(dataDir, 'smartware.db');
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  const layer0 = new Layer0Index(dbPath);
  layer0.catchUp(path.join(dataDir, 'evidence'));
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);

  const subject = 'Revise Sync Probe Co';
  const entityId = `entity_${hash('revise-carrier')}`;
  store.insertEntity({ id: entityId, canonical_name: subject, aliases: [], type: 'organization', scope: SCOPE, created_at: T1 });
  const originalId = `claim_${hash('revise-original')}`;
  store.insertClaim(makeProbeClaim({ id: originalId, entityId, subject, value: '2031-01-01', validFrom: T1, ingestedAt: T1 }));
  syncSearchFromClaims(store, searchIndex, SCOPE);

  const replacementId = `claim_${hash('revise-replacement')}`;
  const admission = admitClaim(makeProbeClaim({ id: replacementId, entityId, subject, value: '2031-02-02', validFrom: T2, ingestedAt: T2 }), store);
  syncSearchFromClaims(store, searchIndex, SCOPE);
  const laneBefore = laneRows(searchIndex);
  return { dataDir, dbPath, core, layer0, store, searchIndex, subject, originalId, replacementId, admission, laneBefore };
}

function reviseParams(comp) {
  return {
    actor: OWNER, target: comp.originalId,
    expected_base_version: latestVersionOf(comp.dataDir, comp.originalId),
    set_confidence: 'high',
    reason: 'the earlier window was still in force',
    operation_id: opId(),
  };
}

async function finishRevise(tag, comp, call) {
  const laneAfter = laneRows(comp.searchIndex);
  const rowsAfter = rowStatuses(comp.store);
  const inProcess = await recallIds(comp.core, 'Revise Sync Probe');
  comp.store.close(); comp.searchIndex.close(); comp.layer0.close(); comp.core.close();

  const fresh = await freshRecall(comp.dataDir, 'Revise Sync Probe');
  fs.rmSync(comp.dataDir, { recursive: true, force: true });

  report({
    scenario: tag, dist: DIST,
    admission: comp.admission.outcome, lane_before: comp.laneBefore, lane_after: laneAfter,
    rows_after: rowsAfter, revised: call.result?.claim_id ?? null, error: call.error,
    in_process: inProcess, fresh,
    in_process_serves_revised: call.result?.claim_id ? inProcess.includes(call.result.claim_id) : null,
    in_process_equals_fresh: JSON.stringify(inProcess) === JSON.stringify(fresh),
  });
}

async function scenarioRevise() {
  const comp = await buildReviseComposition('revise');
  let result = null;
  let error = null;
  try {
    result = await handleRevise(
      reviseParams(comp),
      comp.dataDir, comp.store, loadConfig(comp.dataDir), { opsDir: path.join(comp.dataDir, 'operations') },
      undefined, undefined, comp.searchIndex,
    );
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  await finishRevise('revise-mcp-shape', comp, { result, error });
}

// Same composition through SmartwareCore.revise — the surface the shipped
// `smartware` binary (src/mcp.ts) goes through.
async function scenarioReviseCore() {
  const comp = await buildReviseComposition('revise-core');
  let result = null;
  let error = null;
  try {
    result = await comp.core.revise(reviseParams(comp));
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  await finishRevise('revise-core-wrapper', comp, { result, error });
}

const scenarios = SCEN === 'all'
  ? ['correct-changed', 'correct-wrong', 'revise', 'revise-core']
  : [SCEN];
for (const s of scenarios) {
  if (s === 'correct-changed') await scenarioCorrect('changed');
  else if (s === 'correct-wrong') await scenarioCorrect('wrong');
  else if (s === 'revise') await scenarioRevise();
  else if (s === 'revise-core') await scenarioReviseCore();
  else { console.error(`unknown scenario '${s}'`); process.exit(2); }
}
