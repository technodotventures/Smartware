// Public-API smoke: prove a SaaS can embed Smartware via the published package
// surface — these imports are the ones a CONSUMER can actually make. Self-reference
// resolves through package.json "exports", so this file fails to run if any of these
// paths stop being public. (It previously imported ../dist/... deep paths, which
// "exports" enforcement blocks for consumers: the example could not be reproduced.)
import { SmartwareCore, createDefaultConfig, knownTime, nullTime, canonicalKey } from 'smartware';
import { showAttributionByDefault, attributionLine, whySentence } from 'smartware/render';
import { ClaimStore } from 'smartware/layer1';
import { addCorroborationEvidence } from 'smartware/layer1/corroboration';
import { computeConfidence } from 'smartware/layer1/confidence';
import { SearchIndex, syncSearchFromClaims } from 'smartware/layer3';
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
const rawHits = memory.searchObservations('billing', 'client:acme#1', { limit: 10 });
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
