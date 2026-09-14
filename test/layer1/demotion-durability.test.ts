// Tests: Layer 1 — the demotion of a resolved duplicate is durable in canonical state
//
// Why these exist: `resolveFactMatches` demotes a duplicate by writing the derived SQLite row
// (`status: 'superseded'`, `superseded_by`, `t_invalidated`) through `updateClaimStatus`. The
// canonical L1 version record that the same call appends carried no supersession field at all,
// so two things followed:
//
//   1. the compile path re-materialises the row from the canonical record
//      (`syncFromJsonlVersionsBatch` / `syncFromJsonlVersion`) and derives `status` from
//      `state` alone — the demoted duplicate returns to the recall-eligible set; and
//   2. a canonical replay into a fresh projection loses the demotion entirely.
//
// Measured in `t_15bb0cd0` (evidence/23-demotion-durability.txt): after the §1e sweep converged
// recall to one result, one further write put the same row back in the recall-eligible set, and
// nothing in the L1 JSONL said `superseded` anywhere.
//
// The repo's contract is that canonical state is primary and every view over it is regenerable
// (`AGENTS.md`; rebuild-equivalence). A demotion that survives only as a projection write is not
// rebuild-equivalent, so the demotion must be recorded in the canonical record and the row must
// be derived from it on every materialisation. These tests pin exactly that:
//
//   - the demotion appears in the demoted claim's own latest canonical version;
//   - a compile-path sync of that version keeps the row out of the recall-eligible set;
//   - a full canonical replay into a fresh projection does the same;
//   - `status` and `superseded_by` never contradict each other in any row produced along the way;
//   - live and replayed projections agree on the recall-eligible set.
//
// The frozen §1e contract (survivor = earliest-minted ULID, evidence unioned before demotion,
// demote-never-delete, `ambiguous_matches`/`superseded_claims` reported) is asserted by
// `fact-identity.test.ts`; these tests only add durability on top of it and do not restate it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ClaimStore } from '../../src/layer1/store.js';
import { computeConfidence } from '../../src/layer1/confidence.js';
import { resolveFactMatches } from '../../src/layer1/corroboration.js';
import { iterAllClaimVersions, readLatestVersion } from '../../src/layer1/jsonl.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import type { Claim, ClaimStatus } from '../../src/layer1/types.js';
import type { TypedValue } from '../../src/layer0/types.js';

let dataDir: string;
let store: ClaimStore;

// Claim ids are ULIDs in production (time-ordered): the smaller id is the earliest-minted claim,
// so `claim_0001…` is the §1e survivor and `claim_0002…` the duplicate it demotes.
const SURVIVOR = 'claim_0001HOSTHOSTHOSTHOSTHOSTHOST';
const DUPLICATE = 'claim_0002AUTOAAAAUTOAUTOAUTOAUTO';
const ENTITY_ID = 'entity_acme_scope';
const FACT = {
  scope: 'client:acme#1',
  subjectName: 'Acme',
  predicate: 'deadline_is',
  object: { type: 'date', value: '2026-09-01' } as TypedValue,
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-durability-'));
  store = new ClaimStore(path.join(dataDir, 'smartware.db'));
  store.setDataDir(dataDir);
  store.insertEntity({
    id: ENTITY_ID, canonical_name: FACT.subjectName, aliases: [], type: 'organization',
    scope: FACT.scope, created_at: new Date().toISOString(),
  });
});

afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** The claim row a host writes: confidence derived by the library, never hand-set. */
function buildClaim(claimId: string, observationId: string, from: string): Claim {
  const claim: Claim = {
    id: claimId, subject_id: ENTITY_ID, subject_name: FACT.subjectName,
    predicate: FACT.predicate, object: FACT.object, scope: FACT.scope,
    validity: { from, to: null },
    t_ingested: knownTime(from), t_invalidated: nullTime(),
    t_valid_from: knownTime(from), t_valid_to: nullTime(),
    source_event_id: observationId, extraction_event_id: observationId,
    supporting_evidence: [observationId],
    extraction: {
      method: 'deterministic', model: null, compiler_version: '0.7.0',
      prompt_hash: null, extracted_at: from,
    },
    status: 'active', epistemic: 'observed', confidence: 0, sensitive: false,
    superseded_by: null, contested_by: [], state: 'active',
  };
  claim.confidence = computeConfidence(claim);
  return claim;
}

/** Seed the two-active-claims-for-one-fact shape and run the §1e sweep on it. */
function seedAndSweep(): void {
  const t0 = new Date().toISOString();
  store.insertClaim(buildClaim(SURVIVOR, 'obs_host', t0));
  store.insertClaim(buildClaim(DUPLICATE, 'obs_auto', new Date(Date.now() + 1).toISOString()));
  const matches = store.findActiveFactMatches(ENTITY_ID, {
    predicate: FACT.predicate, scope: FACT.scope, object: FACT.object,
  });
  const resolution = resolveFactMatches({ store, matches, observationId: 'obs_sweep' });
  expect(resolution.superseded_claims).toEqual([DUPLICATE]);
}

/**
 * The recall-eligible set for this fact, as the substrate defines it: `status === 'active'`
 * rows with an open validity window. Deliberately scope+predicate based, not subject-id based —
 * a fresh replay resolves entities from the records, so the replayed rows carry their own
 * entity ids and the check must not depend on the live store's id.
 */
function recallEligible(claimStore: ClaimStore): string[] {
  return claimStore.getAllClaims(FACT.scope)
    .filter(claim =>
      claim.predicate === FACT.predicate
      && claim.validity.to === null
      && claim.status === 'active')
    .map(claim => claim.id)
    .sort();
}

/** `status` and `superseded_by` must never contradict each other in any row. */
function assertConsistent(claim: Claim, label: string): void {
  const status: ClaimStatus = claim.status;
  expect(
    status === 'active' && claim.superseded_by !== null,
    `${label}: status='active' with superseded_by='${claim.superseded_by}'`,
  ).toBe(false);
  expect(
    status === 'superseded' && claim.superseded_by === null,
    `${label}: status='superseded' with no superseded_by`,
  ).toBe(false);
}

/** Replay every L1 version of this pod into a fresh projection. */
function replayIntoFreshStore(replayDbPath: string): ClaimStore {
  const replay = new ClaimStore(replayDbPath);
  for (const version of iterAllClaimVersions(dataDir)) replay.syncFromJsonlVersion(version);
  return replay;
}

describe('demotion durability · the demotion is recorded in the canonical record', () => {
  it('the demoted claim\'s own canonical version carries superseded_by and superseded_at', () => {
    seedAndSweep();

    const latest = readLatestVersion(dataDir, DUPLICATE);
    expect(latest).not.toBeNull();
    // The demotion is a fact about this claim; a replay that reads only this record must be
    // able to reconstruct it. These fields are the canonical home of what the row carries.
    expect(latest!.superseded_by).toBe(SURVIVOR);
    expect(typeof latest!.superseded_at).toBe('string');
    expect(Number.isNaN(Date.parse(latest!.superseded_at!))).toBe(false);
    // The demotion does not change `state` (spec §6: supersession is not a state).
    expect(latest!.state).toBe('active');
  });

  it('a later canonical version of the demoted claim carries the demotion forward', () => {
    seedAndSweep();

    // What a restatement/corroboration write against the demoted claim produces: another
    // version appended through `insertClaim`. The demotion must not evaporate with it.
    const loser = store.getClaim(DUPLICATE)!;
    store.updateClaimSupportingEvidence(DUPLICATE, [...loser.supporting_evidence, 'obs_restated']);

    const latest = readLatestVersion(dataDir, DUPLICATE);
    expect(latest!.version).toBeGreaterThan(1);
    expect(latest!.superseded_by).toBe(SURVIVOR);
  });
});

describe('demotion durability · re-materialisation keeps the duplicate out of the eligible set', () => {
  it('(a) a compile-path sync of the demoted claim\'s own canonical version keeps it demoted', () => {
    seedAndSweep();
    expect(recallEligible(store)).toEqual([SURVIVOR]);

    // The compile path re-materialises rows from the canonical records a run committed. Feed it
    // the demoted claim's own latest version — nothing else.
    const latest = readLatestVersion(dataDir, DUPLICATE)!;
    store.syncFromJsonlVersionsBatch([latest], new Set(), undefined);

    const loserAfter = store.getClaim(DUPLICATE)!;
    assertConsistent(loserAfter, 'after compile-path sync');
    expect(loserAfter.status).toBe('superseded');
    expect(loserAfter.superseded_by).toBe(SURVIVOR);
    expect(recallEligible(store)).toEqual([SURVIVOR]);
  });

  it('(a) the serial sync path agrees with the batch path', () => {
    seedAndSweep();

    const latest = readLatestVersion(dataDir, DUPLICATE)!;
    store.syncFromJsonlVersion(latest);

    const loserAfter = store.getClaim(DUPLICATE)!;
    assertConsistent(loserAfter, 'after serial sync');
    expect(loserAfter.status).toBe('superseded');
    expect(recallEligible(store)).toEqual([SURVIVOR]);
  });

  it('(b) a full canonical replay into a fresh projection keeps the duplicate out', () => {
    seedAndSweep();

    const replay = replayIntoFreshStore(path.join(dataDir, 'replay.db'));
    try {
      const loserReplayed = replay.getClaim(DUPLICATE)!;
      assertConsistent(loserReplayed, 'replayed row');
      expect(loserReplayed.status).toBe('superseded');
      expect(loserReplayed.superseded_by).toBe(SURVIVOR);
      expect(recallEligible(replay)).toEqual([SURVIVOR]);
    } finally {
      replay.close();
    }
  });

  it('live and replayed projections agree on the recall-eligible set', () => {
    seedAndSweep();

    // One more write against the demoted claim, the shape that used to flip it back.
    const loser = store.getClaim(DUPLICATE)!;
    store.updateClaimSupportingEvidence(DUPLICATE, [...loser.supporting_evidence, 'obs_restated']);

    const replay = replayIntoFreshStore(path.join(dataDir, 'replay.db'));
    try {
      expect(recallEligible(replay)).toEqual(recallEligible(store));
      expect(recallEligible(store)).toEqual([SURVIVOR]);
    } finally {
      replay.close();
    }
  });

  it('the demotion survives the compile-path sync after a later version was appended', () => {
    seedAndSweep();
    const loser = store.getClaim(DUPLICATE)!;
    store.updateClaimSupportingEvidence(DUPLICATE, [...loser.supporting_evidence, 'obs_restated']);

    const latest = readLatestVersion(dataDir, DUPLICATE)!;
    store.syncFromJsonlVersionsBatch([latest], new Set(), undefined);

    const loserAfter = store.getClaim(DUPLICATE)!;
    assertConsistent(loserAfter, 'after sync of the later version');
    expect(loserAfter.status).toBe('superseded');
    expect(recallEligible(store)).toEqual([SURVIVOR]);
  });
});

describe('demotion durability · every row the flow produces is consistent', () => {
  it('rows stay consistent at every step of the sweep → sync → replay sequence', () => {
    seedAndSweep();
    assertConsistent(store.getClaim(SURVIVOR)!, 'survivor, after sweep');
    assertConsistent(store.getClaim(DUPLICATE)!, 'loser, after sweep');

    const latest = readLatestVersion(dataDir, DUPLICATE)!;
    store.syncFromJsonlVersionsBatch([latest], new Set(), undefined);
    assertConsistent(store.getClaim(DUPLICATE)!, 'loser, after compile-path sync');

    const replay = replayIntoFreshStore(path.join(dataDir, 'replay.db'));
    try {
      assertConsistent(replay.getClaim(DUPLICATE)!, 'loser, replayed');
      assertConsistent(replay.getClaim(SURVIVOR)!, 'survivor, replayed');
    } finally {
      replay.close();
    }
  });
});
