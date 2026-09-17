// Public-API smoke: prove a SaaS can embed Smartware via the published package
// surface — these imports are the ones a CONSUMER can actually make. Self-reference
// resolves through package.json "exports", so this file fails to run if any of these
// paths stop being public. (It previously imported ../dist/... deep paths, which
// "exports" enforcement blocks for consumers: the example could not be reproduced.)
import { SmartwareCore, createDefaultConfig, knownTime, nullTime, canonicalKey } from 'smartware';
import { showAttributionByDefault, attributionLine, whySentence } from 'smartware/render';
import { ClaimStore } from 'smartware/layer1';
import { addCorroborationEvidence } from 'smartware/layer1/corroboration';
import { admitClaim } from 'smartware/layer1/conflicts';
import { computeConfidence } from 'smartware/layer1/confidence';
import { SearchIndex, syncSearchFromClaims } from 'smartware/layer3';
import { MAX_INGEST_ITEMS } from 'smartware/ingestion';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

const opId = () => `op_${ulid()}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-saas-'));
const okay = [];
const fail = [];

// 1. Provision a Coffee tenant: one business = one Pod, client = scope, staff = exact-id grants.
const cfg = createDefaultConfig(dataDir);
cfg.owner_id = 'user:ava';
cfg.version = '0.7.0';
cfg.scopes = [
  { id: 'self', parent: null, visibility_default: 'private' },
  { id: 'workspace', parent: null, visibility_default: 'workspace' },
  { id: 'client:acme#1', parent: 'workspace', visibility_default: 'scope' },
];
cfg.grants = [
  {
    id: 'grant_gigi', actor_type: 'person', actor_id: 'user:gigi',
    capabilities: { observe: ['client:acme#1'], query: ['client:acme#1'], compile: [], correct: ['client:acme#1'], forget: [], read: ['client:acme#1'] },
    trusted: false, quarantine: false, created_at: new Date().toISOString(), expires_at: null, status: 'active',
  },
  {
    id: 'grant_noah', actor_type: 'person', actor_id: 'user:noah',
    capabilities: { observe: ['client:acme#1'], query: ['client:acme#1'], compile: [], correct: [], forget: [], read: ['client:acme#1'] },
    trusted: false, quarantine: false, created_at: new Date().toISOString(), expires_at: null, status: 'active',
  },
];
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2));

const memory = await SmartwareCore.open({ dataDir });
okay.push(`opened SmartwareCore at ${dataDir}`);

// 2. Staff (gigi) observes on the Acme scope.
const obs = await memory.observe({
  actor: { type: 'person', id: 'user:gigi', display_name: 'Gigi' },
  type: 'meeting',
  content: { format: 'text/markdown', body: 'Acme moved to quarterly billing starting next month.' },
  scope: 'client:acme#1',
  visibility: 'scope',
  operation_id: opId(),
});
if (obs && obs.status) okay.push(`observe ok (${obs.status})`); else fail.push('observe did not return status');

// 3a. Sync-raw freshness (spec §9.1/§10a): the raw observation is FTS-searchable
// before any compile job materializes it. The Coffee product keeps raw
// observations as the evidence window, then persists structured claims
// (extraction runs upstream / LLM-backed). Assert the raw window here.
const rawHits = memory.searchObservations({
  actor: { type: 'person', id: 'user:ava', display_name: 'Ava' },
  query: 'billing',
  scope: 'client:acme#1',
  limit: 10,
});
if (rawHits && rawHits.length > 0) {
  okay.push(`raw-observation window ok (${rawHits.length} raw hit(s))`);
} else {
  fail.push('raw window search returned 0 rows (see searchObservations — compile-independent)');
}

// 3b. Coffee persistence path: persist a structured claim for the client
// (exactly the conformance suite's insertClaimFor) so the claim surface is populated.
const dbPath = path.join(dataDir, 'smartware.db');
const store = new ClaimStore(dbPath);
store.setDataDir(dataDir);
const subjectId = 'entity_acme';
store.insertEntity({
  id: subjectId, canonical_name: 'Acme', aliases: [], type: 'organization',
  scope: 'client:acme#1', created_at: new Date().toISOString(),
});

// A claim's identity is (subject, predicate, scope, validity_from) — held in a variable because
// the same value is what makes a later restatement of this fact resolve back to THIS claim.
const validityFrom = new Date().toISOString();
const claim = {
  id: 'claim_acme_billing', subject_id: subjectId, subject_name: 'Acme',
  predicate: 'prefers_billing', object: { type: 'text', value: 'quarterly' },
  scope: 'client:acme#1', validity: { from: validityFrom, to: null },
  t_ingested: knownTime(validityFrom), t_invalidated: nullTime(),
  t_valid_from: knownTime(validityFrom), t_valid_to: nullTime(),
  source_event_id: obs.id, extraction_event_id: obs.id, supporting_evidence: [obs.id],
  extraction: { method: 'deterministic', model: null, compiler_version: '0.6.3', prompt_hash: null, extracted_at: new Date().toISOString() },
  status: 'active', epistemic: 'observed', confidence: 0, sensitive: false,
  superseded_by: null, contested_by: [],
};
// Confidence is derived, not stored input: corroboration recomputes it from the claim's own
// fields, so a hand-set value is replaced the first time evidence is added. Use the formula.
claim.confidence = computeConfidence(claim);
store.insertClaim(claim);
const searchIndex = new SearchIndex(dbPath);
syncSearchFromClaims(store, searchIndex, 'client:acme#1');

// 3d. The same fact arriving again is CORROBORATION, not a second claim.
//
// Nothing inside Smartware wires identity to the corroboration helper — the host owns
// extraction, so the host owns identity. Skip this step and every restatement mints a twin:
// measured on a pilot, one billing preference restated twelve ways produced 14 recall results
// for 2 distinct facts, because each paraphrase inserted a fresh claim.
const restated = await memory.observe({
  actor: { type: 'person', id: 'user:gigi', display_name: 'Gigi' },
  type: 'message',
  content: { format: 'text/markdown', body: 'Acme confirmed again: they want to be invoiced quarterly.' },
  scope: 'client:acme#1',
  visibility: 'scope',
  operation_id: opId(),
});
const key = canonicalKey(subjectId, 'prefers_billing', 'client:acme#1', validityFrom);
const existing = store.findByCanonicalKey(subjectId, 'prefers_billing', 'client:acme#1', validityFrom);
if (!existing) {
  fail.push(`findByCanonicalKey(${key}) did not resolve the existing claim — corroboration would be skipped`);
} else {
  const evidenceBefore = existing.supporting_evidence.length;
  addCorroborationEvidence(existing.id, restated.id, store);
  syncSearchFromClaims(store, searchIndex, 'client:acme#1');
  const after = store.getClaim(existing.id);
  const active = store.getActiveClaims('client:acme#1');
  // Compare against the same claim scored with one fewer piece of evidence, so the assertion is
  // formula-to-formula rather than against a number this script chose.
  const scoredAlone = computeConfidence({ ...after, supporting_evidence: [obs.id] });
  if (after.supporting_evidence.length === evidenceBefore + 1 && active.length === 1 && after.confidence > scoredAlone) {
    okay.push(`corroboration ok (1 claim, evidence ${evidenceBefore}→${after.supporting_evidence.length}, confidence ${scoredAlone.toFixed(4)}→${after.confidence.toFixed(4)}, no twin inserted)`);
  } else {
    fail.push(`corroboration did not accumulate as expected: evidence ${after.supporting_evidence.length}, active claims ${active.length}, confidence ${after.confidence.toFixed(4)} vs expected >${scoredAlone.toFixed(4)}`);
  }
}
// 3e. Contradiction and temporal lifecycle (P0-2/P0-4) through the public
// admission seam. A same-key disagreement is retained and marked contested —
// recall surfaces both sides instead of a silent empty result. A later
// event-valid window then supersedes deterministically, closing the old window
// at the replacement's start (event-valid time) and recording when it was
// learned (system time).
store.insertEntity({
  id: 'entity_beacon', canonical_name: 'Beacon', aliases: [], type: 'organization',
  scope: 'client:acme#1', created_at: new Date().toISOString(),
});
const conflictWindow = '2026-09-01T00:00:00.000Z';
function beaconClaim(observationId, predicate, value, validFrom = conflictWindow) {
  const built = {
    ...claim,
    id: `claim_${ulid()}`,
    subject_id: 'entity_beacon', subject_name: 'Beacon', predicate,
    object: { type: 'text', value },
    validity: { from: validFrom, to: null },
    t_valid_from: knownTime(validFrom), t_valid_to: nullTime(),
    t_ingested: knownTime(new Date().toISOString()),
    source_event_id: observationId, extraction_event_id: observationId,
    supporting_evidence: [observationId],
    superseded_by: null, contested_by: [],
  };
  built.confidence = computeConfidence(built);
  return built;
}
const beaconObsA = await memory.observe({
  actor: { type: 'person', id: 'user:gigi', display_name: 'Gigi' },
  type: 'message', content: { format: 'text/markdown', body: 'Beacon renewal is 2026-09-30' },
  scope: 'client:acme#1', visibility: 'scope', operation_id: opId(),
});
const beaconObsB = await memory.observe({
  actor: { type: 'person', id: 'user:noah', display_name: 'Noah' },
  type: 'message', content: { format: 'text/markdown', body: 'Beacon renewal is 2026-10-31' },
  scope: 'client:acme#1', visibility: 'scope', operation_id: opId(),
});
const beaconA = beaconClaim(beaconObsA.id, 'renewal_date', '2026-09-30');
const admissionA = admitClaim(beaconA, store);
const beaconB = beaconClaim(beaconObsB.id, 'renewal_date', '2026-10-31');
const admissionB = admitClaim(beaconB, store);
syncSearchFromClaims(store, searchIndex, 'client:acme#1');
const conflictRecall = await memory.recall({
  actor: { type: 'person', id: 'user:ava', display_name: 'Ava' },
  query: 'Beacon renewal', scope: 'client:acme#1', limit: 10,
});
const conflictClaims = (conflictRecall.results ?? []).map(result => result.claim).filter(Boolean);
const conflictSides = conflictClaims.filter(c => c.predicate === 'renewal_date');
if (admissionA.outcome === 'inserted'
  && admissionB.outcome === 'contested'
  && conflictSides.length === 2
  && conflictSides.every(c => c.status === 'contested' && c.epistemic_tag === 'contested')) {
  okay.push(`contradiction semantics ok (admissions ${admissionA.outcome}/${admissionB.outcome}; recall surfaces ${conflictSides.length} contested sides, never silent-empty)`);
} else {
  fail.push(`contradiction semantics failed: outcomes ${admissionA.outcome}/${admissionB.outcome}, recall claim hits ${JSON.stringify(conflictSides.map(c => [c.id, c.status, c.epistemic_tag]))}`);
}

// 3f. Deterministic supersession: a later event-valid window replaces the
// active claim, closes its window at the replacement's start, and drops the
// superseded fact from current recall (history still reaches it).
const supersedeWindow = '2026-09-20T00:00:00.000Z';
const supersedeObsC = await memory.observe({
  actor: { type: 'person', id: 'user:gigi', display_name: 'Gigi' },
  type: 'message', content: { format: 'text/markdown', body: 'Beacon contract tier is gold' },
  scope: 'client:acme#1', visibility: 'scope', operation_id: opId(),
});
const supersedeObsD = await memory.observe({
  actor: { type: 'person', id: 'user:gigi', display_name: 'Gigi' },
  type: 'message', content: { format: 'text/markdown', body: 'Beacon contract tier is platinum' },
  scope: 'client:acme#1', visibility: 'scope', operation_id: opId(),
});
const tierFirst = beaconClaim(supersedeObsC.id, 'contract_tier_is', 'gold', conflictWindow);
const tierAdmissionFirst = admitClaim(tierFirst, store);
const tierReplacement = beaconClaim(supersedeObsD.id, 'contract_tier_is', 'platinum', supersedeWindow);
const tierAdmissionSecond = admitClaim(tierReplacement, store);
syncSearchFromClaims(store, searchIndex, 'client:acme#1');
const superseded = store.getClaim(tierFirst.id);
const currentTier = await memory.recall({
  actor: { type: 'person', id: 'user:ava', display_name: 'Ava' },
  query: 'Beacon contract tier', scope: 'client:acme#1', limit: 10,
});
const currentTierClaims = (currentTier.results ?? []).map(result => result.claim).filter(Boolean);
const tierHits = currentTierClaims.filter(c => c.predicate === 'contract_tier_is');
if (tierAdmissionFirst.outcome === 'inserted'
  && tierAdmissionSecond.outcome === 'superseded'
  && superseded?.status === 'superseded'
  && superseded?.validity?.to === supersedeWindow
  && tierHits.length === 1
  && tierHits[0]?.id === tierReplacement.id) {
  okay.push(`supersession ok (old window closed at ${superseded.validity.to}; current recall returns only the replacement)`);
} else {
  fail.push(`supersession failed: outcomes ${tierAdmissionFirst.outcome}/${tierAdmissionSecond.outcome}, old status ${superseded?.status}, validity.to ${superseded?.validity?.to}, recall ${JSON.stringify(tierHits.map(c => [c.id, c.status]))}`);
}

store.close();
searchIndex.close();

// 3c. Recall the compiled claim via the public API (owner subject bypasses grants).
const hits = await memory.recall({
  actor: { type: 'person', id: 'user:ava', display_name: 'Ava' },
  query: 'Acme billing',
  scope: 'client:acme#1',
});
const rc = Array.isArray(hits) ? hits : (hits.results ?? hits.matches ?? hits.claims ?? []);
if (rc && rc.length > 0) okay.push(`recall ok (${rc.length} claim(s))`); else fail.push(`recall empty: ${JSON.stringify(hits).slice(0, 200)}`);
// The corroborated restatement must not have added a second result for the same fact.
if (rc && rc.length === 1) {
  okay.push('recall returns one claim for the corroborated fact (restating it did not create a twin)');
} else if (rc) {
  fail.push(`recall returned ${rc.length} claims for one fact — corroboration did not prevent a duplicate`);
}

// 4. Provenance render (staff-facing attribution) via smartware/render.
const renderInput = {
  surface: 'staff',
  freshness: 'unverified',
  compileState: 'failed',
  actorKind: 'person',
  actorDisplay: 'Gigi',
  sourceDate: new Date('2026-05-12T00:00:00Z'),
  claimType: 'decision',
  epistemicTag: 'fact',
  confidence: 'high',
  tags: ['price'],
};
const show = showAttributionByDefault(renderInput);
const line = attributionLine(renderInput);
const why = whySentence(renderInput);
if (show && typeof line === 'string') {
  okay.push(`render default-on: "${line}" — "${why}"`);
} else {
  fail.push('render did not default-on for an unverified, consequential, staff-facing fact');
}

// 5. Owner-only export of the scope (spec §10c.4).
const exported = await memory.exportScope({
  actor: { type: 'person', id: 'user:ava', display_name: 'Ava' },
  scope: 'client:acme#1',
  operation_id: opId(),
});
const exportDir = exported.path ?? path.join(exported.export_dir ?? dataDir, 'exports', exported.export_id ?? '');
const hasObservations = fs.existsSync(path.join(exportDir, 'observations.jsonl'));
if (hasObservations) {
  okay.push(`export ok (${exported.export_id} → observations.jsonl, ${exported.counts?.observations?.toString() ?? '?'} obs)`);
} else {
  fail.push(`export dir missing observations: ${exportDir} (${JSON.stringify(exported).slice(0, 200)})`);
}

// ── 6. Sources and connector ingestion (P1-2 contract) ─────────────────────
//
// Coffee owns OAuth login, scheduled jobs and connector credentials. Smartware
// owns the provenance origin (the source registry) and the ingestion contract:
// one batch per polled page, an opaque cursor, an operation_id, and per-item
// dedup keyed on (source, external_id, scope). Context — actor + registered
// source — is fail-closed: the brain refuses to write unattributable evidence.
const owner = { type: 'person', id: 'user:ava', display_name: 'Ava' };

const connector = memory.registerSource({
  actor: owner,
  id: 'src_gmail_ava',
  kind: 'connector',
  display_name: 'Gmail — ava@harbor-lane',
  external_ref: 'acct_ava_primary',
});
if (connector.id === 'src_gmail_ava' && connector.status === 'active') {
  okay.push(`source registry ok (${connector.kind}: ${connector.display_name})`);
} else {
  fail.push(`source registration failed: ${JSON.stringify(connector)}`);
}

// One polled page: two real items, one item carrying a credential (rejected —
// the connector must not be able to wedge on a poisoned message).
const batchOp = opId();
const batch = {
  actor: owner,
  source_id: 'src_gmail_ava',
  scope: 'client:acme#1',
  cursor: 'hist/101',
  operation_id: batchOp,
  items: [
    { external_id: 'msg_101', type: 'message', content: { format: 'text/plain', body: 'Acme onboarding starts Monday.' } },
    { external_id: 'msg_102', type: 'message', content: { format: 'text/plain', body: 'Acme asked for parking details.' } },
    { external_id: 'msg_103', type: 'message', content: { format: 'text/plain', body: 'Deploy key: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
  ],
};
const receipt = await memory.ingest(batch);
if (batch.items.length <= MAX_INGEST_ITEMS && receipt.status === 'ok'
  && receipt.accepted === 2 && receipt.rejected === 1
  && receipt.cursor === 'hist/101' && receipt.cursor_before === null
  && receipt.items.find(item => item.external_id === 'msg_103')?.code === 'secret_detected') {
  okay.push(`ingest ok (2 accepted, 1 rejected secret_detected; cursor ${receipt.cursor})`);
} else {
  fail.push(`ingest failed: ${JSON.stringify(receipt).slice(0, 300)}`);
}

// Replaying the same operation_id returns the recorded receipt — no new writes.
const ingestedId = receipt.items[0]?.observation_id;
const replay = await memory.ingest(batch);
const rawBefore = memory.searchObservations({ actor: owner, query: 'onboarding', scope: 'client:acme#1' });
const rawAfter = memory.searchObservations({ actor: owner, query: 'onboarding', scope: 'client:acme#1' });
if (replay.status === 'replayed' && rawAfter.length === 1 && rawBefore.length === 1) {
  okay.push(`replay ok (${replay.status}; the retried batch wrote nothing again)`);
} else {
  fail.push(`replay failed: status ${replay.status}, raw hits ${rawBefore.length}->${rawAfter.length}`);
}

// A re-sync under a NEW operation_id dedups stored items instead of minting
// twins; the poisoned item is (correctly) rejected again on every attempt.
const resend = await memory.ingest({ ...batch, operation_id: opId(), cursor: 'hist/102' });
if (resend.accepted === 0 && resend.duplicated === 2 && resend.rejected === 1) {
  okay.push(`item dedup ok (re-synced page: 0 accepted, ${resend.duplicated} duplicates, ${resend.rejected} rejected again)`);
} else {
  fail.push(`item dedup failed: ${JSON.stringify({ accepted: resend.accepted, duplicated: resend.duplicated, rejected: resend.rejected })}`);
}

// Sync status: what Coffee's scheduler/UI renders.
const sync = memory.sourceSyncStatus({ actor: owner, source_id: 'src_gmail_ava' })[0];
if (sync && sync.last_sync?.cursor === 'hist/102' && sync.totals.batches === 2
  && sync.totals.accepted === 2 && sync.totals.duplicated === 2 && sync.totals.rejected === 2) {
  okay.push(`sync status ok (last cursor ${sync.last_sync.cursor}, ${sync.totals.batches} batches, accepted ${sync.totals.accepted}, duplicated ${sync.totals.duplicated}, rejected ${sync.totals.rejected})`);
} else {
  fail.push(`sync status wrong: ${JSON.stringify(sync)?.slice(0, 300)}`);
}

// The ingested item resolves to its registered source — provenance, not text matching.
const ingestedEvidence = memory.readObservationEvidence({ actor: owner, observation_id: ingestedId });
if (ingestedEvidence?.source_ref === 'src_gmail_ava') {
  okay.push(`source-scoped provenance ok (${ingestedEvidence.id} ← ${ingestedEvidence.source_ref})`);
} else {
  fail.push(`ingested evidence lost its source: ${JSON.stringify(ingestedEvidence)?.slice(0, 200)}`);
}

// ── 7. Federated reads across client scopes, bounded by grants ──────────────

// The owner reads both client scopes in one call; every result is scope-tagged.
const federated = await memory.recallFederated({ actor: owner, query: 'billing', scopes: ['client:acme#1'] });
const federatedScoped = federated.results.every(result => result.scope === 'client:acme#1');
if (federated.scopes.join(',') === 'client:acme#1' && federatedScoped && federated.results.length > 0) {
  okay.push(`federated read ok (${federated.results.length} scope-tagged result(s) across ${federated.scopes.join(', ')})`);
} else {
  fail.push(`federated read wrong: ${JSON.stringify(federated).slice(0, 300)}`);
}

// A staff actor naming a scope they cannot read gets a denial, never a partial answer.
let partial = null;
try {
  await memory.recallFederated({
    actor: { type: 'person', id: 'user:gigi', display_name: 'Gigi' },
    query: 'billing',
    scopes: ['client:acme#1', 'workspace'],
  });
  partial = 'answered';
} catch (error) {
  partial = error?.code ?? String(error);
}
if (partial === 'insufficient_permission') {
  okay.push('federated denial ok (gigi + workspace → insufficient_permission, no partial answer)');
} else {
  fail.push(`federated denial wrong: ${partial}`);
}

memory.close();

// Teardown
fs.rmSync(dataDir, { recursive: true, force: true });

console.log('\n=== PUBLIC-API SMOKE ===');
for (const o of okay) console.log('PASS', o);
if (fail.length) {
  for (const f of fail) console.log('FAIL', f);
  console.log('SMOKE_OUTCOME=fail');
  process.exit(1);
}
console.log('SMOKE_OUTCOME=pass');
