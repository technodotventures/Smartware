// Tests: Layer 1 — fact identity and duplicate-claim resolution
//
// Why these exist: `getClaimsBySubject` has no ORDER BY, so a host that resolves a restatement with
// `.find(...)` picks whichever row SQLite happens to return first. When a store already holds two
// active claims for one fact (the shape an extractor leaves behind when it mints a claim per
// observation), that pick decides the survivor by row order and reports nothing. Duplicate active
// claims are what make recall answer the same question several times — measured end to end: a brain
// seeded with two active claims for one fact returned 2 recall results for 1 fact, 1 after the
// duplicate was resolved.
//
// The contracts pinned here (identity = the FACT, not the canonical key; survivor = earliest-minted
// claim id; losers demoted, never deleted; provenance unioned; every choice reported) are the ones
// the host-side pilot reference implementation implemented, so these fixtures use the pilot's ids,
// insertion orders and assertions as the cross-check.
//
// The pilot's own deterministic suite is 6 tests; tests 4-9 below are that suite reproduced 1:1
// against the shipped helper (see the header of each).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ClaimStore } from '../../src/layer1/store.js';
import { computeConfidence } from '../../src/layer1/confidence.js';
import { resolveFactMatches } from '../../src/layer1/corroboration.js';
import { canonicalKey } from '../../src/layer1/types.js';
import type { Claim } from '../../src/layer1/types.js';
import type { TypedValue } from '../../src/layer0/types.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';

let tmpDir: string;
let store: ClaimStore;

// ── The pilot's fixture, verbatim ────────────────────────────────────────────────────────────────
// Lexicographically ASCENDING ids: `claim_0001A…` sorts before `claim_0002B…`, so the first-minted
// claim is the smaller id. Claim ids are ULIDs (time-ordered), which is what makes "smallest id"
// mean "earliest minted" in production.
const SURVIVOR = 'claim_0001AAAAAAAAAAAAAAAAAAAAAAAA';
const DUPLICATE = 'claim_0002BBBBBBBBBBBBBBBBBBBBBBBB';
const ENTITY_ID = 'entity_acme';
const FACT = {
  scope: 'client:acme#1',
  subjectName: 'Acme',
  predicate: 'prefers_billing',
  object: { type: 'text', value: 'quarterly' } as TypedValue,
};

// Confidence is not bit-stable: the formula includes recency decay measured as (now - validity.from),
// so re-evaluating milliseconds after the write moves the trailing digits. "Formula-consistent"
// means the stored value matches the formula, not that it matches bitwise.
const CONFIDENCE_TOLERANCE = 1e-6;

function assertFormulaConsistent(stored: number, claim: Claim): void {
  const recomputed = computeConfidence(claim);
  expect(Math.abs(stored - recomputed)).toBeLessThanOrEqual(CONFIDENCE_TOLERANCE);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-fact-identity-'));
  store = new ClaimStore(path.join(tmpDir, 'test.db'));
  store.insertEntity({
    id: ENTITY_ID, canonical_name: FACT.subjectName, aliases: [], type: 'organization',
    scope: FACT.scope, created_at: new Date().toISOString(),
  });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The claim row a host writes: confidence derived by the library, never hand-set. */
function buildClaim(
  claimId: string,
  observationId: string,
  overrides: Partial<Claim> = {},
  validityFrom = new Date().toISOString(),
): Claim {
  const now = new Date().toISOString();
  const claim: Claim = {
    id: claimId, subject_id: ENTITY_ID, subject_name: FACT.subjectName,
    predicate: FACT.predicate, object: FACT.object, scope: FACT.scope,
    validity: { from: validityFrom, to: null },
    t_ingested: knownTime(now), t_invalidated: nullTime(),
    t_valid_from: knownTime(validityFrom), t_valid_to: nullTime(),
    source_event_id: observationId, extraction_event_id: observationId,
    supporting_evidence: [observationId],
    extraction: {
      method: 'deterministic', model: 'pilot-rule-extractor', compiler_version: '0.7.0',
      prompt_hash: null, extracted_at: now,
    },
    status: 'active', epistemic: 'observed', confidence: 0, sensitive: false,
    superseded_by: null, contested_by: [], state: 'active',
    ...overrides,
  };
  claim.confidence = computeConfidence(claim);
  return claim;
}

/**
 * Reproduce the store state a pre-fix write path leaves behind: one active claim per observation.
 * Each claim carries its own `validity_from` — the shape a host that stamps `now()` on every write
 * produces — so the canonical keys of two rows for the SAME fact never collide.
 */
function seedActiveClaim(
  claimId: string,
  observationId: string,
  overrides: Partial<Claim> = {},
  validityFrom?: string,
): Claim {
  const claim = buildClaim(claimId, observationId, overrides, validityFrom);
  store.insertClaim(claim);
  return claim;
}

const findMatches = (fact: { predicate?: string; scope?: string; object?: TypedValue } = {}) =>
  store.findActiveFactMatches(ENTITY_ID, { ...FACT, ...fact });

describe('ClaimStore.findActiveFactMatches', () => {
  it('returns every active claim for the fact, not the first', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');
    seedActiveClaim(DUPLICATE, 'obs_b');

    expect(findMatches().map((c) => c.id)).toEqual([SURVIVOR, DUPLICATE]);
  });

  it('returns matches in survivor order whatever order they were inserted in', () => {
    seedActiveClaim(DUPLICATE, 'obs_b');
    seedActiveClaim(SURVIVOR, 'obs_a');

    // Sorted by id, so `matches[0]` is the survivor even for a caller that ignores the rest.
    expect(findMatches().map((c) => c.id)).toEqual([SURVIVOR, DUPLICATE]);
  });

  it('matches the fact even though the two rows have different canonical keys', () => {
    // Each write stamps its own validity_from, which is what a host that does not derive it from
    // the fact's own validity start produces.
    const first = seedActiveClaim(SURVIVOR, 'obs_a', {}, '2026-06-01T09:00:00.000Z');
    const second = seedActiveClaim(DUPLICATE, 'obs_b', {}, '2026-06-01T09:00:07.412Z');

    // canonicalKey keys on validity_from, which a host stamping now() on every write can never
    // reproduce — which is exactly why identity has to be the fact itself, not the key.
    expect(first.validity.from).not.toBe(second.validity.from);
    expect(canonicalKey(ENTITY_ID, FACT.predicate, FACT.scope, first.validity.from))
      .not.toBe(canonicalKey(ENTITY_ID, FACT.predicate, FACT.scope, second.validity.from));
    expect(store.findByCanonicalKey(ENTITY_ID, FACT.predicate, FACT.scope, first.validity.from)?.id)
      .toBe(SURVIVOR);
    expect(store.findByCanonicalKey(ENTITY_ID, FACT.predicate, FACT.scope, second.validity.from)?.id)
      .toBe(DUPLICATE);
    expect(findMatches()).toHaveLength(2);
  });

  it('returns a single match when there is no duplicate', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');

    expect(findMatches().map((c) => c.id)).toEqual([SURVIVOR]);
  });

  it('excludes a demoted duplicate — a superseded claim is not re-matched', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');
    seedActiveClaim(DUPLICATE, 'obs_b');
    store.updateClaimStatus(DUPLICATE, 'superseded', SURVIVOR, knownTime(new Date().toISOString()));

    expect(findMatches().map((c) => c.id)).toEqual([SURVIVOR]);
  });

  it('excludes a claim whose validity has closed', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');
    const closed = buildClaim(DUPLICATE, 'obs_b');
    closed.t_valid_to = knownTime('2026-06-01T00:00:00.000Z');
    closed.validity = { from: closed.validity.from, to: '2026-06-01T00:00:00.000Z' };
    store.insertClaim(closed);

    expect(findMatches().map((c) => c.id)).toEqual([SURVIVOR]);
  });

  it('is scoped to subject, predicate, scope and object value', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');

    expect(findMatches({ predicate: 'prefers_contact' })).toHaveLength(0);
    expect(findMatches({ scope: 'client:bcau#1' })).toHaveLength(0);
    expect(findMatches({ object: { type: 'text', value: 'monthly' } })).toHaveLength(0);
    expect(store.findActiveFactMatches('entity_bcau', { ...FACT })).toHaveLength(0);
  });

  it('compares object values with the library\'s own value equality', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');

    expect(findMatches({ object: { type: 'text', value: '  quarterly  ' } })).toHaveLength(1);
    expect(findMatches({ object: { type: 'text', value: 'Quarterly' } })).toHaveLength(0);
  });
});

describe('resolveFactMatches', () => {
  // Pilot test 1 (adapted to the shipped report shape): a duplicate is reported, not silently picked.
  it('resolves two duplicates to a single survivor and reports the choice', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');
    seedActiveClaim(DUPLICATE, 'obs_b');

    const res = resolveFactMatches({ store, matches: findMatches(), observationId: 'obs_c' });

    expect(res.claimId).toBe(SURVIVOR);
    expect(res.ambiguous_matches).toBe(2);
    expect(res.ambiguity_resolved).toBe(true);
    expect(res.superseded_claims).toEqual([DUPLICATE]);
  });

  // Pilot test 4: the survivor is the earliest-minted claim regardless of store row order.
  it('picks the same survivor from both insertion orders', () => {
    const forwards = new ClaimStore(path.join(tmpDir, 'forwards.db'));
    const backwards = new ClaimStore(path.join(tmpDir, 'backwards.db'));
    for (const s of [forwards, backwards]) {
      s.insertEntity({
        id: ENTITY_ID, canonical_name: FACT.subjectName, aliases: [], type: 'organization',
        scope: FACT.scope, created_at: new Date().toISOString(),
      });
    }
    try {
      forwards.insertClaim(buildClaim(SURVIVOR, 'obs_a'));
      forwards.insertClaim(buildClaim(DUPLICATE, 'obs_b'));
      // The smaller id inserted SECOND: an unordered `getClaimsBySubject` returns the wrong row
      // first here, which is precisely the shape the docs recipe used to teach.
      backwards.insertClaim(buildClaim(DUPLICATE, 'obs_b'));
      backwards.insertClaim(buildClaim(SURVIVOR, 'obs_a'));

      const a = resolveFactMatches({
        store: forwards, matches: forwards.findActiveFactMatches(ENTITY_ID, { ...FACT }), observationId: 'obs_c',
      });
      const b = resolveFactMatches({
        store: backwards, matches: backwards.findActiveFactMatches(ENTITY_ID, { ...FACT }), observationId: 'obs_c',
      });

      expect(a.claimId).toBe(SURVIVOR);
      expect(b.claimId).toBe(a.claimId);
      expect(b.superseded_claims).toEqual([DUPLICATE]);
    } finally {
      forwards.close();
      backwards.close();
    }
  });

  // Pilot test 2: the demoted duplicate is superseded by the survivor and stays auditable.
  it('demotes the duplicate instead of deleting it, leaving it auditable', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');
    seedActiveClaim(DUPLICATE, 'obs_b');

    resolveFactMatches({ store, matches: findMatches(), observationId: 'obs_c' });

    const loser = store.getClaim(DUPLICATE)!;
    expect(loser.status).toBe('superseded');
    expect(loser.superseded_by).toBe(SURVIVOR);
    expect(loser.supporting_evidence).toContain('obs_b'); // provenance survives the demotion
    expect(loser.t_invalidated.state).toBe('known');      // and the demotion is timestamped
    const active = store.getActiveClaims(FACT.scope).filter((c) => c.validity.to === null);
    expect(active.map((c) => c.id)).toEqual([SURVIVOR]);
  });

  // Pilot test 3: observations recorded against a demoted duplicate survive on the survivor.
  it('unions the losers\' evidence into the survivor before demoting', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');
    seedActiveClaim(DUPLICATE, 'obs_b');

    const res = resolveFactMatches({ store, matches: findMatches(), observationId: 'obs_c' });

    const survivor = store.getClaim(res.claimId)!;
    expect([...survivor.supporting_evidence].sort()).toEqual(['obs_a', 'obs_b', 'obs_c']);
    expect(res.supporting_evidence).toBe(3);
    assertFormulaConsistent(res.confidence, survivor);
    assertFormulaConsistent(survivor.confidence, survivor);
  });

  // Pilot test 5: a single existing match is corroboration, not ambiguity.
  it('corroborates a single match and reports no ambiguity', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');

    const res = resolveFactMatches({ store, matches: findMatches(), observationId: 'obs_b' });

    expect(res.claimId).toBe(SURVIVOR);
    expect(res.ambiguous_matches).toBe(1);
    expect(res.ambiguity_resolved).toBe(false);
    expect(res.superseded_claims).toEqual([]);
    expect(res.supporting_evidence).toBe(2);
  });

  // Pilot test 6: five paraphrases of one fact become one active claim with five evidence refs.
  // (The pilot's `persistClaim` mints the first claim when nothing matches; here the first claim is
  // seeded and the remaining four restatements are resolved against it.)
  it('converges five restatements of one fact onto one active claim and five evidence refs', () => {
    seedActiveClaim(SURVIVOR, 'obs_1');
    const resolved = ['obs_2', 'obs_3', 'obs_4', 'obs_5'].map((observationId) =>
      resolveFactMatches({ store, matches: findMatches(), observationId }));

    expect(new Set(resolved.map((r) => r.claimId))).toEqual(new Set([SURVIVOR]));
    const active = store.getActiveClaims(FACT.scope).filter((c) => c.validity.to === null);
    expect(active).toHaveLength(1);
    expect([...active[0].supporting_evidence].sort()).toEqual(['obs_1', 'obs_2', 'obs_3', 'obs_4', 'obs_5']);
    expect(findMatches()).toHaveLength(1);
  });

  it('does not duplicate evidence that is already on the survivor', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');

    resolveFactMatches({ store, matches: findMatches(), observationId: 'obs_a' });

    expect(store.getClaim(SURVIVOR)!.supporting_evidence).toEqual(['obs_a']);
  });

  it('refuses an empty match list instead of failing obscurely', () => {
    expect(() => resolveFactMatches({ store, matches: [], observationId: 'obs_a' }))
      .toThrow(/no matches/i);
  });

  // A store that accumulated duplicates before this rule existed must be repairable without
  // inventing an observation: a sweep resolves the duplicates and adds no new provenance.
  it('sweeps pre-existing duplicates without a new observation and fabricates no evidence', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');
    seedActiveClaim(DUPLICATE, 'obs_b');

    const res = resolveFactMatches({ store, matches: findMatches() });

    expect(res.claimId).toBe(SURVIVOR);
    expect(res.ambiguous_matches).toBe(2);
    expect(res.superseded_claims).toEqual([DUPLICATE]);
    expect([...store.getClaim(SURVIVOR)!.supporting_evidence].sort()).toEqual(['obs_a', 'obs_b']);
    expect(store.getClaim(DUPLICATE)!.status).toBe('superseded');
  });

  it('is a no-op on a single match when there is no new observation', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');

    const res = resolveFactMatches({ store, matches: findMatches() });

    expect(res.ambiguity_resolved).toBe(false);
    expect(store.getClaim(SURVIVOR)!.supporting_evidence).toEqual(['obs_a']);
  });

  it('leaves the rest of the store alone', () => {
    seedActiveClaim(SURVIVOR, 'obs_a');
    seedActiveClaim('claim_0003CCCCCCCCCCCCCCCCCCCCCCCC', 'obs_d', {
      predicate: 'prefers_contact', object: { type: 'text', value: 'email' },
    });

    resolveFactMatches({ store, matches: findMatches(), observationId: 'obs_c' });

    const other = store.getClaim('claim_0003CCCCCCCCCCCCCCCCCCCCCCCC')!;
    expect({
      status: other.status, predicate: other.predicate, object: other.object,
      supporting_evidence: other.supporting_evidence, superseded_by: other.superseded_by,
    }).toEqual({
      status: 'active', predicate: 'prefers_contact', object: { type: 'text', value: 'email' },
      supporting_evidence: ['obs_d'], superseded_by: null,
    });
    expect(findMatches({ predicate: 'prefers_contact', object: { type: 'text', value: 'email' } }))
      .toHaveLength(1);
  });
});
