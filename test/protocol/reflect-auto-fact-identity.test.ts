// Tests: Protocol — reflect.auto consults fact identity before creating (ADR-0005 D7 / F1)
//
// Why these exist. The both-surfaces collision was measured end to end on
// `step2-both-surfaces-experiment.mjs` (kanban `t_15bb0cd0`, evidence/22): a host writes a claim
// for fact F with `claim_type` unset (store default `'finding'`), the autonomous path restates the
// SAME assertion from an observation (`reflect.auto` defaults `'hypothesis'`), and because the
// structured fingerprint includes `claim_type` the two creation keys differ — so `reflect.auto`
// minted a SECOND active claim for one fact and recall answered twice.
//
// ADR-0005 decided the relationship: fact identity is Rule A —
// `(subject_id, predicate, scope, normaliseValue(object), validity.to === null)` — and
// `claim_type` is NOT part of it; the structured fingerprint is only the autonomous-creation
// idempotency key. F1 (this change) is the creation-side fix: before creating a bounded claim,
// `reflect.auto` also asks fact identity, and when an active claim already asserts the fact it
// attaches corroboration (extends `derived_from` — spec §238's rule for unprotected claims)
// instead of minting a duplicate. A protected claim (`epistemic_owner: 'user'`) is neither
// corroborated nor duplicated: the autonomous path writes nothing for that fact (spec §9/§11).
//
// These fixtures reproduce case 3 of the harness and its control on the in-repo surfaces
// (Layer0/ClaimStore/SearchIndex + handleObserve/handleCompile/handleQuery), so the interop
// consequence the ADR recorded is pinned as a repository test — which the ADR explicitly
// reserved for F1.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex } from '../../src/layer3/search.js';
import { ScopeRegistry } from '../../src/scopes/registry.js';
import { handleObserve } from '../../src/protocol/observe.js';
import { handleCompile } from '../../src/protocol/reflect.js';
import { handleQuery } from '../../src/protocol/query.js';
import { resolveFactMatches } from '../../src/layer1/corroboration.js';
import { computeConfidence } from '../../src/layer1/confidence.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import type { Claim } from '../../src/layer1/types.js';
import { iterAllClaimVersions } from '../../src/layer1/jsonl.js';
import { readAllOpLogEntries } from '../../src/ops_log/index.js';
import { saveConfig, type SmartwareConfig } from '../../src/config.js';

const SCOPE = 'client:acme#1';
// reflect.auto's deterministic path derives its subject name from the scope
// (`obs.scope.split('/').pop() ?? obs.scope`), and the measured both-surfaces case has the host
// writing that same subject name. This is the collision under test, not a contrivance: it is
// what both surfaces produce when the scope has no nesting.
const SUBJECT_NAME = SCOPE;
const ENTITY_ID = 'entity_acme_scope';
const PREDICATE = 'deadline_is';
const OBJECT = { type: 'date' as const, value: '2026-09-01' };
const OWNER = { type: 'person', id: 'person_owner', display_name: 'Owner' };

let tmpDir: string;
let evidenceDir: string;
let wikiDir: string;
let opsDir: string;
let layer0: Layer0Index;
let store: ClaimStore;
let search: SearchIndex;
let config: SmartwareConfig;
let registry: ScopeRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-reflect-fact-'));
  evidenceDir = path.join(tmpDir, 'evidence');
  wikiDir = path.join(tmpDir, 'wiki');
  opsDir = path.join(tmpDir, 'operations');
  fs.mkdirSync(evidenceDir);
  fs.mkdirSync(opsDir);
  for (const category of ['concepts', 'entities', 'decisions', 'synthesis', 'tombstones', 'profiles']) {
    fs.mkdirSync(path.join(wikiDir, category), { recursive: true });
  }

  config = {
    instance_id: `smartware_${ulid()}`,
    owner_id: OWNER.id,
    writer_id: `writer_${ulid()}`,
    version: '0.7.0',
    data_dir: tmpDir,
    scopes: [
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: SCOPE, parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
  saveConfig(tmpDir, config);

  const dbPath = path.join(tmpDir, 'test.db');
  layer0 = new Layer0Index(dbPath);
  store = new ClaimStore(dbPath);
  store.setDataDir(tmpDir);
  search = new SearchIndex(dbPath);
  registry = new ScopeRegistry(config);
});

afterEach(() => {
  layer0.close();
  store.close();
  search.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function observe(body: string): Promise<string> {
  const result = await handleObserve(
    { actor: OWNER, type: 'message', content: { format: 'text/markdown', body }, scope: SCOPE },
    evidenceDir,
    layer0,
    config,
  );
  return result.id;
}

function compile() {
  return handleCompile(
    { actor: OWNER, scope: SCOPE, use_llm: false },
    evidenceDir,
    wikiDir,
    layer0,
    store,
    search,
    config,
    tmpDir,
    { opsDir },
  );
}

/** The `reflect.auto` terminal receipt for one observation, from the operations log. */
function receiptFor(observationId: string) {
  return [...readAllOpLogEntries(opsDir)]
    .filter(entry => entry.op === 'reflect.auto')
    .map(entry => entry.details as Record<string, unknown>)
    .filter(details => details['observation_id'] === observationId)[0];
}

function recall(query: string) {
  return handleQuery({ actor: OWNER, query, scope: SCOPE }, store, search, config, registry);
}

/** Active claims for the fact under test, as the store holds them. */
function factRows(): Claim[] {
  return store.getAllClaims(SCOPE)
    .filter(claim => claim.predicate === PREDICATE && claim.scope === SCOPE)
    .filter(claim => claim.status === 'active');
}

/** Versions of one claim on the canonical L1 surface, in file order. */
function versionsOf(claimId: string) {
  return [...iterAllClaimVersions(tmpDir)].filter(version => version.claim_id === claimId);
}

/**
 * The claim a host writes through the structured path: confidence derived by the library,
 * `claim_type` UNSET (the store default applies) — exactly what the Coffee-shaped pilot's
 * `buildClaim` produced, and the shape the measured case collided on.
 */
function buildHostClaim(observationId: string, overrides: Partial<Claim> = {}): Claim {
  const now = new Date().toISOString();
  const claim: Claim = {
    id: `claim_${ulid()}`,
    subject_id: ENTITY_ID,
    subject_name: SUBJECT_NAME,
    predicate: PREDICATE,
    object: OBJECT,
    scope: SCOPE,
    validity: { from: now, to: null },
    t_ingested: knownTime(now),
    t_invalidated: nullTime(),
    t_valid_from: knownTime(now),
    t_valid_to: nullTime(),
    source_event_id: observationId,
    extraction_event_id: observationId,
    supporting_evidence: [observationId],
    extraction: {
      method: 'deterministic', model: null, compiler_version: '0.7.0',
      prompt_hash: null, extracted_at: now,
    },
    status: 'active',
    epistemic: 'observed',
    confidence: 0,
    sensitive: false,
    superseded_by: null,
    contested_by: [],
    ...overrides,
  };
  claim.confidence = computeConfidence(claim);
  return claim;
}

function seedEntity(): void {
  store.insertEntity({
    id: ENTITY_ID, canonical_name: SUBJECT_NAME, aliases: [], type: 'concept',
    scope: SCOPE, created_at: new Date().toISOString(),
  });
}

describe('reflect.auto consults fact identity before creating (ADR-0005 D7 / F1)', () => {
  it('attaches corroboration instead of minting a duplicate for a host-held fact under another classification', async () => {
    seedEntity();
    const hostObs = await observe('Kickoff call with Acme went well.');
    const host = buildHostClaim(hostObs);
    store.insertClaim(host);
    // The store default for a host that leaves `claim_type` unset — the measured collision.
    expect(store.getClaim(host.id)!.claim_type).toBe('finding');

    const restatementObs = await observe('Deadline: 2026-09-01.');
    const compiled = await compile();

    // The autonomous path did not mint a second claim for the fact...
    expect(compiled.claims_created).toBe(0);
    expect(factRows().map(claim => claim.id)).toEqual([host.id]);

    // ...the restatement landed as corroboration on the host's claim, extending its provenance...
    const survivor = store.getClaim(host.id)!;
    expect(survivor.supporting_evidence).toContain(restatementObs);
    expect(survivor.status).toBe('active');
    // ...and the host's classification stands (variant 1 — see ADR-0005 D7 amendment).
    expect(survivor.claim_type).toBe('finding');

    // Rule A agrees with the decision: one match, and it is the host's claim.
    expect(store.findActiveFactMatches(ENTITY_ID, { predicate: PREDICATE, scope: SCOPE, object: OBJECT })
      .map(claim => claim.id)).toEqual([host.id]);

    // The real recall surface answers once for the fact.
    const hits = await recall('deadline');
    expect(hits.results.filter(result => result.claim?.predicate === PREDICATE)).toHaveLength(1);

    // Canonical surface: two versions of ONE claim; the extension carries both observations.
    const versions = versionsOf(host.id);
    expect(versions.map(version => version.version)).toEqual([1, 2]);
    expect(versions[1]!.derived_from).toEqual([hostObs, restatementObs]);
    expect(versions[1]!.supersedes).toBe(1);

    // The decision is auditable, not silent: the terminal receipt names the corroborated claim
    // and the classification the extraction would have used (variant 1: recorded, not applied).
    expect(receiptFor(restatementObs)?.['fact_identity_matches']).toEqual([
      { claim_id: host.id, decision: 'corroborated', extraction_claim_type: 'hypothesis' },
    ]);
  });

  it('writes nothing when the fact is held by a user-owned claim (protection outranks corroboration)', async () => {
    seedEntity();
    const hostObs = await observe('Kickoff call with Acme went well.');
    const protectedClaim = buildHostClaim(hostObs, { author: 'user', epistemic_owner: 'user' });
    store.insertClaim(protectedClaim);

    const restatementObs = await observe('Deadline: 2026-09-01.');
    const compiled = await compile();

    // No new claim for the fact, and no new version of the protected claim — not even an
    // extended `derived_from` (spec §11: protected claims are fully agent-immutable).
    expect(compiled.claims_created).toBe(0);
    expect(factRows().map(claim => claim.id)).toEqual([protectedClaim.id]);
    expect(versionsOf(protectedClaim.id)).toHaveLength(1);
    expect(store.getClaim(protectedClaim.id)!.supporting_evidence).not.toContain(restatementObs);

    // The observation is still terminal (it was considered and deliberately not written):
    // the fact answers once, from the protected claim.
    const hits = await recall('deadline');
    expect(hits.results.filter(result => result.claim?.predicate === PREDICATE)).toHaveLength(1);

    // ...and the skip is on the record, with its reason.
    expect(receiptFor(restatementObs)?.['fact_identity_matches']).toEqual([
      { claim_id: protectedClaim.id, decision: 'skipped', reason: 'protected' },
    ]);
  });

  it('control: a matching classification converges through the fingerprint key (unchanged behaviour)', async () => {
    seedEntity();
    const hostObs = await observe('Kickoff call with Acme went well.');
    const host = buildHostClaim(hostObs, { claim_type: 'hypothesis' });
    store.insertClaim(host);

    const restatementObs = await observe('Deadline: 2026-09-01.');
    const compiled = await compile();

    expect(compiled.claims_created).toBe(0);
    expect(factRows().map(claim => claim.id)).toEqual([host.id]);
    expect(store.getClaim(host.id)!.supporting_evidence).toContain(restatementObs);
  });

  it('still creates the bounded hypothesis when no claim holds the fact (invariants unchanged)', async () => {
    await observe('Deadline: 2026-09-01.');
    const compiled = await compile();

    expect(compiled.claims_created).toBe(1);
    const rows = factRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.claim_type).toBe('hypothesis');

    const created = versionsOf(rows[0]!.id).filter(version => version.version === 1)[0]!;
    expect(created.author).toBe('agent');
    expect(created.epistemic_owner).toBe('agent');
    expect(created.epistemic_tag).toBe('inference');
    expect(created.confidence).toBe('low');
    expect(created.derived_from.length).toBeGreaterThan(0);
  });

  it('a fingerprint match on a demoted duplicate does not receive the observation: corroboration routes to the surviving claim (F1b)', async () => {
    seedEntity();
    // The pre-F1 duplicate shape a deployment that ran before F1 already holds: two active
    // claims for one fact — the host's (`claim_type` unset -> store default 'finding', and the
    // §1e survivor by mint order) and the autonomous twin ('hypothesis').
    const hostObs = await observe('Kickoff call with Acme went well.');
    const host = buildHostClaim(hostObs, { id: 'claim_0001HOSTHOSTHOSTHOSTHOSTHOST' });
    store.insertClaim(host);
    const twinObs = await observe('Round 0 host note: kickoff call with Acme went well.');
    const twin = buildHostClaim(twinObs, {
      id: 'claim_0002AUTOAAAAUTOAUTOAUTOAUTO',
      claim_type: 'hypothesis',
    });
    store.insertClaim(twin);

    // The host converges the pair through guide §1e: the twin's evidence is unioned into the
    // survivor, the twin is demoted — carried by the twin's own canonical record (F2).
    const resolution = resolveFactMatches({
      store,
      matches: store.findActiveFactMatches(ENTITY_ID, { predicate: PREDICATE, scope: SCOPE, object: OBJECT }),
      observationId: hostObs,
    });
    expect(resolution.superseded_claims).toEqual([twin.id]);
    const twinVersionsAfterDemotion = versionsOf(twin.id);
    const twinDemotionRecord = twinVersionsAfterDemotion[twinVersionsAfterDemotion.length - 1]!;
    expect(twinDemotionRecord.superseded_by).toBe(host.id);
    // F2: the demotion does not change the record's `state` — `superseded_by` is the carrier.
    expect(twinDemotionRecord.state).toBe('active');

    // The autonomous restatement whose extraction classification ('hypothesis') is exactly the
    // DEMOTED twin's, so the fingerprint key matches the hidden duplicate. Measured on kanban
    // t_6c39a895: the observation used to land on the demoted claim.
    const restatementObs = await observe('Deadline: 2026-09-01.');
    const compiled = await compile();

    // Still no duplicate creation...
    expect(compiled.claims_created).toBe(0);
    // ...but the demoted duplicate gained nothing: no new version, no new evidence...
    expect(versionsOf(twin.id)).toHaveLength(twinVersionsAfterDemotion.length);
    expect(store.getClaim(twin.id)!.supporting_evidence).not.toContain(restatementObs);
    // ...the observation extended the fact's surviving claim, where recall shows it...
    const survivor = store.getClaim(host.id)!;
    expect(survivor.supporting_evidence).toContain(restatementObs);
    expect(versionsOf(host.id)[versionsOf(host.id).length - 1]!.derived_from).toContain(restatementObs);
    // ...the demotion is untouched...
    expect(store.getClaim(twin.id)!.status).toBe('superseded');
    // ...and the fact still answers once.
    const hits = await recall('deadline');
    expect(hits.results.filter(result => result.claim?.predicate === PREDICATE)).toHaveLength(1);

    // The routing is auditable: the receipt names the survivor, the classification the
    // extraction would have used, and the demoted fingerprint match it was routed away from.
    expect(receiptFor(restatementObs)?.['fact_identity_matches']).toEqual([{
      claim_id: host.id,
      decision: 'corroborated',
      extraction_claim_type: 'hypothesis',
      fingerprint_matched_demoted: twin.id,
    }]);
  });
});
