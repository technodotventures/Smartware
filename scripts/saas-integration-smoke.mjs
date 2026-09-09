// Public-API smoke: prove a SaaS can embed Smartware via the published package
// surface (dist/) and run the Coffee tenant shape end to end — provision a
// tenant (owner + client-as-scope + exact-id staff grant), observe a client
// message, hit the sync-raw window, persist+recall a structured claim, render
// attribution, and owner-export the scope. Runs against the built dist.
import { SmartwareCore } from '../dist/core.js';
import { showAttributionByDefault, attributionLine, whySentence } from '../dist/render/provenance.js';
import { createDefaultConfig } from '../dist/config.js';
import { ClaimStore } from '../dist/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../dist/layer3/search.js';
import { knownTime, nullTime } from '../dist/layer1/types.js';
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
cfg.version = '0.6.3';
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
const claimId = 'claim_acme_billing';
store.insertClaim({
  id: claimId, subject_id: subjectId, subject_name: 'Acme',
  predicate: 'prefers_billing', object: { type: 'text', value: 'quarterly' },
  scope: 'client:acme#1', validity: { from: new Date().toISOString(), to: null },
  t_ingested: knownTime(new Date().toISOString()), t_invalidated: nullTime(),
  t_valid_from: knownTime(new Date().toISOString()), t_valid_to: nullTime(),
  source_event_id: obs.id, extraction_event_id: obs.id, supporting_evidence: [obs.id],
  extraction: { method: 'deterministic', model: null, compiler_version: '0.6.3', prompt_hash: null, extracted_at: new Date().toISOString() },
  status: 'active', epistemic: 'observed', confidence: 0.9, sensitive: false,
  superseded_by: null, contested_by: [],
});
const searchIndex = new SearchIndex(dbPath);
syncSearchFromClaims(store, searchIndex, 'client:acme#1');
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
