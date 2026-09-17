// P0-2 / P0-4 conformance — contradiction and temporal lifecycle.
//
// The Coffee parity contract freezes the temporal model as "bi-temporal claims
// (event-valid x system-recorded); supersede/contested; current recall excludes
// non-current state, history only on request" (coffee-parity-contract-v1.md).
// This suite proves the *behaviour* when two actors report conflicting facts:
//
//   1. both episodes/evidence are retained; nothing is silently discarded;
//   2. current truth is determined from event-valid AND system-recorded time;
//   3. an unresolved disagreement (same canonical key, different value) is
//      marked contested and stays recallable — never a silent empty result;
//   4. supersession happens only under an explicit deterministic policy, and a
//      superseded fact never satisfies current recall;
//   5. trajectory/as-of/history reads reconstruct what was true and what the
//      system knew at a past instant.
//
// No autonomous LLM truth arbitration: every outcome below is computed from
// claim metadata (values, validity windows, recorded times, statuses). The
// fixture configures no LLM provider at all.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { detectConflict, applySemanticConflict, applyTemporalSupersession, admitClaim } from '../../src/layer1/conflicts.js';
import { computeConfidence } from '../../src/layer1/confidence.js';
import type { Claim } from '../../src/layer1/types.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import { readAll } from '../../src/layer0/log.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const GIGI = { type: 'person' as const, id: 'user:gigi', display_name: 'Gigi' };
const NOAH = { type: 'person' as const, id: 'user:noah', display_name: 'Noah' };
const SCOPE = 'client:acme#1';

const T1 = '2026-01-01T00:00:00.000Z';   // event-valid start, first report
const T1_RECORDED = '2026-01-02T00:00:00.000Z'; // system time the first report landed
const T2 = '2026-06-01T00:00:00.000Z';   // event-valid start, replacement report
const T2_RECORDED = '2026-06-02T00:00:00.000Z';
const WINDOW = '2026-08-01T00:00:00.000Z'; // shared event-valid window for a same-key disagreement

interface Fixture {
  dataDir: string;
  core: SmartwareCore;
  store: ClaimStore;
  searchIndex: SearchIndex;
}

const liveFixtures: Array<{ core: SmartwareCore | null; store?: ClaimStore; searchIndex?: SearchIndex; dataDir: string }> = [];

function acmeConfig(dataDir: string): SmartwareConfig {
  return {
    instance_id: `smartware_${ulid()}`,
    owner_id: 'user:owner',
    writer_id: `writer_local_${ulid()}`,
    version: '0.7.0',
    data_dir: dataDir,
    scopes: [
      { id: 'self', parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: SCOPE, parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [
      {
        id: `grant_${ulid()}`, actor_type: 'person', actor_id: GIGI.id,
        capabilities: { observe: [SCOPE], query: [SCOPE], compile: [], correct: [], forget: [], read: [SCOPE] },
        trusted: false, quarantine: false, created_at: '2026-01-01T00:00:00.000Z', expires_at: null, status: 'active',
      },
      {
        id: `grant_${ulid()}`, actor_type: 'person', actor_id: NOAH.id,
        capabilities: { observe: [SCOPE], query: [SCOPE], compile: [], correct: [], forget: [], read: [SCOPE] },
        trusted: false, quarantine: false, created_at: '2026-01-01T00:00:00.000Z', expires_at: null, status: 'active',
      },
    ],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
}

async function newFixture(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-p0-temporal-'));
  for (const sub of ['wiki/personal', 'wiki/workspace', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  saveConfig(dataDir, acmeConfig(dataDir));
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);
  const fx = { dataDir, core, store, searchIndex };
  liveFixtures.push(fx);
  return fx;
}

afterEach(() => {
  for (const entry of liveFixtures.splice(0)) {
    entry.store?.close();
    entry.searchIndex?.close();
    entry.core?.close();
    fs.rmSync(entry.dataDir, { recursive: true, force: true });
  }
});

/** Record a raw observation from a named actor (the evidence episode). */
async function observe(fx: Fixture, actor: typeof GIGI, body: string, observedAt: string): Promise<string> {
  const result = await fx.core.observe({
    actor, type: 'message', content: { format: 'text/plain', body }, scope: SCOPE, observed_at: observedAt,
  });
  return result.id;
}

/** Build (but do not persist) a structured claim for Acme, as the host extractor would. */
function buildFact(
  fx: Fixture,
  opts: {
    value: string;
    validFrom: string;
    ingestedAt: string;
    evidence: string[];
    predicate?: string;
    status?: Claim['status'];
  },
): Claim {
  const subjectId = `entity_${opts.predicate ?? 'renewal_date'}`;
  if (!fx.store.getEntity(subjectId)) {
    fx.store.insertEntity({
      id: subjectId, canonical_name: 'Acme', aliases: [], type: 'organization',
      scope: SCOPE, created_at: T1,
    });
  }
  const claim: Claim = {
    id: `claim_${ulid()}`,
    subject_id: subjectId,
    subject_name: 'Acme',
    predicate: opts.predicate ?? 'renewal_date',
    object: { type: 'text', value: opts.value },
    scope: SCOPE,
    validity: { from: opts.validFrom, to: null },
    t_ingested: knownTime(opts.ingestedAt),
    t_invalidated: nullTime(),
    t_valid_from: knownTime(opts.validFrom),
    t_valid_to: nullTime(),
    source_event_id: opts.evidence[0] ?? `obs_${ulid()}`,
    extraction_event_id: opts.evidence[0] ?? `obs_${ulid()}`,
    supporting_evidence: [...opts.evidence],
    extraction: {
      method: 'deterministic', model: null, compiler_version: '0.7.0', prompt_hash: null, extracted_at: opts.ingestedAt,
    },
    status: opts.status ?? 'active',
    epistemic: 'observed',
    confidence: 0,
    sensitive: false,
    superseded_by: null,
    contested_by: [],
  };
  claim.confidence = computeConfidence(claim);
  return claim;
}

describe('contradiction and temporal lifecycle (P0-2 / P0-4)', () => {
  it('supersession closes the event-valid window at the replacement start and records system-time invalidation', async () => {
    const fx = await newFixture();
    const first = buildFact(fx, { value: 'active', validFrom: T1, ingestedAt: T1_RECORDED, evidence: [`obs_${ulid()}`], predicate: 'status_is' });
    fx.store.insertClaim(first);

    const replacement = buildFact(fx, { value: 'done', validFrom: T2, ingestedAt: T2_RECORDED, evidence: [`obs_${ulid()}`], predicate: 'status_is' });
    const conflict = detectConflict(replacement, fx.store);
    expect(conflict.type).toBe('temporal_supersession');
    expect(conflict.existingClaim?.id).toBe(first.id);

    fx.store.insertClaim(replacement);
    applyTemporalSupersession(conflict.existingClaim!.id, replacement, fx.store);

    const superseded = fx.store.getClaim(first.id)!;
    expect(superseded.status).toBe('superseded');
    expect(superseded.superseded_by).toBe(replacement.id);
    // Event-valid time: the older fact stopped being true when the newer one started.
    expect(superseded.t_valid_to.value).toBe(T2);
    expect(superseded.validity.to).toBe(T2);
    // System-recorded time: when the system learned the replacement.
    expect(superseded.t_invalidated.value).toBe(T2_RECORDED);
  });

  it('keeps contested claims recallable with conflict markers instead of a silent empty result', async () => {
    const fx = await newFixture();
    // Two actors report conflicting facts for the same event-valid window.
    const gigiObs = await observe(fx, GIGI, 'Acme renewal is 2026-11-02', '2026-08-01T09:00:00.000Z');
    const noahObs = await observe(fx, NOAH, 'Acme renewal is 2026-12-01', '2026-08-01T10:00:00.000Z');

    const fromGigi = buildFact(fx, { value: '2026-11-02', validFrom: WINDOW, ingestedAt: '2026-08-01T09:00:00.000Z', evidence: [gigiObs] });
    fx.store.insertClaim(fromGigi);
    const fromNoah = buildFact(fx, { value: '2026-12-01', validFrom: WINDOW, ingestedAt: '2026-08-01T10:00:00.000Z', evidence: [noahObs] });

    const conflict = detectConflict(fromNoah, fx.store);
    expect(conflict.type).toBe('semantic_conflict');
    fx.store.insertClaim(fromNoah);
    applySemanticConflict(conflict.existingClaim!.id, fromNoah.id, fx.store);

    // Both episodes and both evidence lists survive.
    expect(fx.store.getClaim(fromGigi.id)!.status).toBe('contested');
    expect(fx.store.getClaim(fromNoah.id)!.status).toBe('contested');
    expect(fx.store.getClaim(fromGigi.id)!.supporting_evidence).toEqual([gigiObs]);
    expect(fx.store.getClaim(fromNoah.id)!.supporting_evidence).toEqual([noahObs]);
    const rawEpisodes = [...readAll(path.join(fx.dataDir, 'evidence'))].filter(obs => obs.id === gigiObs || obs.id === noahObs);
    expect(rawEpisodes.map(obs => obs.source.actor.id).sort()).toEqual([GIGI.id, NOAH.id]);

    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);

    const recalled = await fx.core.recall({ actor: OWNER, query: 'Acme renewal', scope: SCOPE });
    const claimHits = recalled.results.flatMap(result => result.claim ? [result.claim] : []);
    expect(claimHits.map(claim => claim.id).sort()).toEqual([fromGigi.id, fromNoah.id].sort());
    for (const claim of claimHits) {
      expect(claim.status).toBe('contested');
      expect(claim.epistemic_tag).toBe('contested');
    }

    // The dedicated conflict lane still reports the unresolved disagreement.
    const snapshot = fx.core.readConflicts({ actor: OWNER, scopes: [SCOPE] });
    expect(snapshot.claims.map(claim => claim.claim_id).sort()).toEqual([fromGigi.id, fromNoah.id].sort());
    expect(snapshot.claims.every(claim => claim.status === 'contested')).toBe(true);
  });

  it('reconstructs the trajectory: current recall excludes superseded history, as-of and history reads reach it', async () => {
    const fx = await newFixture();
    const first = buildFact(fx, { value: 'active', validFrom: T1, ingestedAt: T1_RECORDED, evidence: [`obs_${ulid()}`], predicate: 'status_is' });
    expect(admitClaim(first, fx.store).outcome).toBe('inserted');
    const replacement = buildFact(fx, { value: 'done', validFrom: T2, ingestedAt: T2_RECORDED, evidence: [`obs_${ulid()}`], predicate: 'status_is' });
    // A later event-valid window replaces the active claim, deterministically.
    const admitted = admitClaim(replacement, fx.store);
    expect(admitted.outcome).toBe('superseded');
    expect(admitted.superseded_claim_id).toBe(first.id);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);

    // 1. Current recall: the superseded fact never satisfies it.
    const current = await fx.core.recall({ actor: OWNER, query: 'Acme status', scope: SCOPE });
    expect(current.results.map(result => result.claim?.id)).toEqual([replacement.id]);

    // 2. History on request: both episodes, each with its lifecycle marker.
    const history = await fx.core.recall({ actor: OWNER, query: 'Acme status', scope: SCOPE, include_superseded: true });
    const historyById = new Map(history.results.flatMap(result => result.claim ? [[result.claim.id, result.claim]] : []));
    expect(new Set(historyById.keys())).toEqual(new Set([first.id, replacement.id]));
    expect(historyById.get(first.id)?.status).toBe('superseded');
    expect(historyById.get(replacement.id)?.status).toBe('active');

    // 3. Event-valid as-of: what was true then — the superseded fact for its own window.
    const asOfMarch = await fx.core.recall({
      actor: OWNER, query: 'Acme status', scope: SCOPE,
      temporal: { mode: 'as_of', axis: 'valid_time', at: '2026-03-01T00:00:00.000Z' },
    });
    expect(asOfMarch.results.map(result => result.claim?.id)).toEqual([first.id]);

    // 4. Event-valid as-of after the replacement: only the replacement was true.
    const asOfJuly = await fx.core.recall({
      actor: OWNER, query: 'Acme status', scope: SCOPE,
      temporal: { mode: 'as_of', axis: 'valid_time', at: '2026-07-01T00:00:00.000Z' },
    });
    expect(asOfJuly.results.map(result => result.claim?.id)).toEqual([replacement.id]);

    // 5. System-recorded as-of: what the brain knew in March — before the update was recorded.
    const asRecordedMarch = await fx.core.recall({
      actor: OWNER, query: 'Acme status', scope: SCOPE,
      temporal: { mode: 'as_of', axis: 'transaction_time', at: '2026-03-01T00:00:00.000Z' },
    });
    expect(asRecordedMarch.results.map(result => result.claim?.id)).toEqual([first.id]);

    // 6. System-recorded as-of after the update: the replacement is now what it knows.
    const asRecordedJuly = await fx.core.recall({
      actor: OWNER, query: 'Acme status', scope: SCOPE,
      temporal: { mode: 'as_of', axis: 'transaction_time', at: '2026-07-01T00:00:00.000Z' },
    });
    expect(asRecordedJuly.results.map(result => result.claim?.id)).toEqual([replacement.id]);
  });

  it('a stale fact never satisfies current recall, and history accepts nothing that was never true', async () => {
    const fx = await newFixture();
    const stale = buildFact(fx, { value: 'paused', validFrom: T1, ingestedAt: T1_RECORDED, evidence: [`obs_${ulid()}`], predicate: 'status_is', status: 'stale' });
    fx.store.insertClaim(stale);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);

    const current = await fx.core.recall({ actor: OWNER, query: 'Acme status', scope: SCOPE });
    expect(current.results.map(result => result.claim?.id)).toEqual([]);

    const history = await fx.core.recall({ actor: OWNER, query: 'Acme status', scope: SCOPE, include_stale: true });
    expect(history.results.map(result => result.claim?.id)).toEqual([stale.id]);
  });
});

describe('deterministic claim admission (the host write path)', () => {
  it('corroborates restatements, contests disagreements, and supersedes only on a later event-valid window', async () => {
    const fx = await newFixture();
    const predicate = 'renewal_date';

    // First report: admitted as the single active claim for its canonical key.
    const gigiObs = await observe(fx, GIGI, 'Acme renewal is 2026-11-02', '2026-08-01T09:00:00.000Z');
    const first = buildFact(fx, { value: '2026-11-02', validFrom: WINDOW, ingestedAt: '2026-08-01T09:00:00.000Z', evidence: [gigiObs], predicate });
    const inserted = admitClaim(first, fx.store);
    expect(inserted.outcome).toBe('inserted');
    expect(inserted.claim_id).toBe(first.id);

    // A second actor restates the same fact for the same window: corroboration,
    // never a twin, and the evidence list grows.
    const restateObs = await observe(fx, NOAH, 'Acme confirmed the 2026-11-02 renewal', '2026-08-01T11:00:00.000Z');
    const restated = buildFact(fx, { value: '2026-11-02', validFrom: WINDOW, ingestedAt: '2026-08-01T11:00:00.000Z', evidence: [restateObs], predicate });
    const corroborated = admitClaim(restated, fx.store);
    expect(corroborated.outcome).toBe('corroborated');
    expect(corroborated.claim_id).toBe(first.id);
    const afterCorroboration = fx.store.getClaim(first.id)!;
    expect([...afterCorroboration.supporting_evidence].sort()).toEqual([gigiObs, restateObs].sort());
    expect(afterCorroboration.confidence).toBeGreaterThan(first.confidence);
    expect(fx.store.getClaimsBySubject(first.subject_id).length).toBe(1);

    // A third actor disagrees about the SAME window: contested — both episodes
    // retained, neither silently promoted as current truth.
    const noahObs = await observe(fx, NOAH, 'Acme renewal is 2026-12-01', '2026-08-02T09:00:00.000Z');
    const disagreement = buildFact(fx, { value: '2026-12-01', validFrom: WINDOW, ingestedAt: '2026-08-02T09:00:00.000Z', evidence: [noahObs], predicate });
    const contested = admitClaim(disagreement, fx.store);
    expect(contested.outcome).toBe('contested');
    expect(contested.related_claim_ids.sort()).toEqual([first.id, disagreement.id].sort());
    expect(fx.store.getClaim(first.id)!.status).toBe('contested');
    expect(fx.store.getClaim(disagreement.id)!.status).toBe('contested');
    expect(fx.store.getClaim(first.id)!.contested_by).toEqual([disagreement.id]);
    expect(fx.store.getClaim(disagreement.id)!.contested_by).toEqual([first.id]);

    // A fourth voice joins the same contest rather than becoming a lone current claim.
    const thirdObs = await observe(fx, GIGI, 'Acme renewal is 2026-10-15', '2026-08-03T09:00:00.000Z');
    const third = buildFact(fx, { value: '2026-10-15', validFrom: WINDOW, ingestedAt: '2026-08-03T09:00:00.000Z', evidence: [thirdObs], predicate });
    const joined = admitClaim(third, fx.store);
    expect(joined.outcome).toBe('contested');
    for (const claim of [first, disagreement, third]) {
      expect(fx.store.getClaim(claim.id)!.status).toBe('contested');
    }
    expect(fx.store.getClaim(third.id)!.contested_by.sort()).toEqual([first.id, disagreement.id].sort());
    expect(fx.store.getClaim(first.id)!.contested_by).toContain(third.id);

    // A claim for a LATER event-valid window is not a disagreement about this
    // window: it is admitted as a separate, later assertion. It must NOT resolve
    // the contest by recency — no claim is superseded, and the contested trio
    // stays contested until a warranted action resolves it.
    const laterFrom = '2027-02-01T00:00:00.000Z';
    const laterObs = await observe(fx, NOAH, 'Acme renewed to 2027-02-01', '2027-01-05T09:00:00.000Z');
    const later = buildFact(fx, { value: '2027-02-01', validFrom: laterFrom, ingestedAt: '2027-01-05T09:00:00.000Z', evidence: [laterObs], predicate });
    const outcome = admitClaim(later, fx.store);
    expect(outcome.outcome).toBe('inserted');
    expect(outcome.superseded_claim_id).toBeUndefined();
    for (const claim of [first, disagreement, third]) {
      expect(fx.store.getClaim(claim.id)!.status).toBe('contested');
    }
  });

  it('two actors through the full loop: recall surfaces the contest, and a warranted user action resolves it', async () => {
    const fx = await newFixture();
    const predicate = 'renewal_date';
    const gigiObs = await observe(fx, GIGI, 'Acme renewal is 2026-11-02', '2026-08-01T09:00:00.000Z');
    const noahObs = await observe(fx, NOAH, 'Acme renewal is 2026-12-01', '2026-08-02T09:00:00.000Z');
    const fromGigi = buildFact(fx, { value: '2026-11-02', validFrom: WINDOW, ingestedAt: '2026-08-01T09:00:00.000Z', evidence: [gigiObs], predicate });
    const fromNoah = buildFact(fx, { value: '2026-12-01', validFrom: WINDOW, ingestedAt: '2026-08-02T09:00:00.000Z', evidence: [noahObs], predicate });
    expect(admitClaim(fromGigi, fx.store).outcome).toBe('inserted');
    expect(admitClaim(fromNoah, fx.store).outcome).toBe('contested');
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);

    // Both raw episodes and both claims survive the disagreement.
    const episodes = [...readAll(path.join(fx.dataDir, 'evidence'))].filter(obs => obs.id === gigiObs || obs.id === noahObs);
    expect(episodes.length).toBe(2);
    expect(fx.store.getClaim(fromGigi.id)!.supporting_evidence).toEqual([gigiObs]);
    expect(fx.store.getClaim(fromNoah.id)!.supporting_evidence).toEqual([noahObs]);

    // Recall surfaces the conflict (marked), never silent-empty.
    const recalled = await fx.core.recall({ actor: OWNER, query: 'Acme renewal', scope: SCOPE });
    const hits = recalled.results.flatMap(result => result.claim ? [result.claim] : []);
    expect(hits.map(hit => hit.id).sort()).toEqual([fromGigi.id, fromNoah.id].sort());
    expect(hits.every(hit => hit.status === 'contested' && hit.epistemic_tag === 'contested')).toBe(true);

    // A user resolves it explicitly (warranted REVISE, origin: user): the
    // withdrawn side leaves current recall, and the decision is recorded as an
    // admitted relation — no autonomous arbitration anywhere in the loop.
    const snapshot = fx.core.readConflicts({ actor: OWNER, scopes: [SCOPE] });
    const gigiClaim = snapshot.claims.find(claim => claim.claim_id === fromGigi.id)!;
    const noahClaim = snapshot.claims.find(claim => claim.claim_id === fromNoah.id)!;
    await fx.core.revise({
      actor: OWNER,
      target: fromNoah.id,
      expected_base_version: noahClaim.version,
      add_relations: [{
        kind: 'supersedes',
        target: fromGigi.id,
        valid_at: '2026-08-03T00:00:00.000Z',
        provenance: { origin: 'user', target_claim_version: gigiClaim.version },
      }],
      reason: 'Noah verified the corrected renewal date with the client',
      operation_id: `op_${ulid()}`,
    });

    expect(fx.core.readConflicts({ actor: OWNER, scopes: [SCOPE] }).claims).toEqual([]);
    const afterResolution = await fx.core.recall({ actor: OWNER, query: 'Acme renewal', scope: SCOPE });
    expect(afterResolution.results.map(result => result.claim?.id)).toEqual([fromNoah.id]);
    const asHistory = await fx.core.recall({ actor: OWNER, query: 'Acme renewal', scope: SCOPE, include_superseded: true });
    expect(asHistory.results.flatMap(result => result.claim ? [result.claim.id] : []).sort())
      .toEqual([fromGigi.id, fromNoah.id].sort());
  });
});
