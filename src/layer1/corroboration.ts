// Layer 1 — Supporting evidence management for corroboration

import type { ClaimStore } from './store.js';
import type { Claim, ClaimTimeValue } from './types.js';
import { knownTime } from './types.js';
import { computeConfidence } from './confidence.js';

/**
 * Add a new supporting observation ID to an existing claim.
 * Recomputes confidence after adding evidence.
 */
export function addCorroborationEvidence(
  existingClaimId: string,
  newObsId: string,
  store: ClaimStore,
): void {
  const existing = store.getClaim(existingClaimId);
  if (!existing) return;

  const updated = [...new Set([...existing.supporting_evidence, newObsId])];
  store.updateClaimSupportingEvidence(existingClaimId, updated);

  const refreshed = store.getClaim(existingClaimId);
  if (refreshed) {
    store.updateClaimConfidence(existingClaimId, computeConfidence(refreshed));
  }
}

/**
 * What a write that resolved a fact did, reported to the caller.
 *
 * Nothing here is decided silently: `ambiguous_matches` says how many active claims asserted the
 * fact before the write, and `superseded_claims` names every claim that was demoted because of it.
 */
export interface FactMatchResolution {
  /** The claim the fact now lives on — the survivor, or a lone match that was corroborated. */
  claimId: string;
  /** Active claims that asserted this fact before the write (1 = no duplicate to resolve). */
  ambiguous_matches: number;
  /** True when duplicates were found and demoted. */
  ambiguity_resolved: boolean;
  /** Ids demoted to `superseded` (oldest-first claim ids, losers only). Empty when there were none. */
  superseded_claims: string[];
  /** The survivor's evidence count after the write. */
  supporting_evidence: number;
  /** The survivor's confidence after the write — recomputed by the formula, not carried over. */
  confidence: number;
}

/**
 * Fold every match for one fact into a single survivor, and report the decision.
 *
 * `matches` is the result of `ClaimStore.findActiveFactMatches(subjectId, { predicate, scope,
 * object })` — the fact itself, not `canonicalKey`, which keys on `validity_from` and therefore
 * never matches for a host that stamps `now()` on every write.
 *
 * One match is corroboration: the new observation is more evidence for the claim that already
 * asserts this fact. Several matches is ambiguity, and it is resolved — never picked:
 *
 * - the survivor is the lexicographically smallest claim id, and claim ids are ULIDs (time-ordered),
 *   so the earliest-minted claim wins no matter what row order the store returns;
 * - the losers' `supporting_evidence` is UNIONED into the survivor first — a duplicate is the same
 *   fact observed again, so dropping its provenance loses evidence the brain actually has;
 * - the losers are demoted (`status: 'superseded'`, `superseded_by: <survivor>`, timestamped), never
 *   deleted: a restatement stays auditable, and the demotion takes it out of the recall-eligible set;
 * - the survivor's confidence is recomputed with the library's formula after the union.
 *
 * This is the same rule the host-side reference implementation applies, so a host that switches to
 * this helper keeps its existing behaviour.
 */
export function resolveFactMatches(args: {
  store: ClaimStore;
  matches: Claim[];
  /**
   * The observation this write was derived from, added to the survivor's evidence.
   * Omit it when resolving duplicates that already exist (a sweep for a store built before this
   * rule existed) — nothing is added, and no id is fabricated to stand in for evidence.
   */
  observationId?: string;
  /** Invalidation timestamp for demoted claims. Defaults to now. */
  now?: string;
}): FactMatchResolution {
  const { store, matches, observationId } = args;
  if (matches.length === 0) {
    throw new Error(
      'resolveFactMatches: no matches to resolve — pass ClaimStore.findActiveFactMatches(...) and '
      + 'insert a new claim when it returns an empty list',
    );
  }

  const now = args.now ?? new Date().toISOString();
  const ordered = [...matches].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const [survivor, ...losers] = ordered;

  if (losers.length === 0) {
    if (observationId) addCorroborationEvidence(survivor.id, observationId, store);
    const corroborated = store.getClaim(survivor.id);
    return {
      claimId: survivor.id,
      ambiguous_matches: 1,
      ambiguity_resolved: false,
      superseded_claims: [],
      supporting_evidence: corroborated?.supporting_evidence.length ?? 0,
      confidence: corroborated?.confidence ?? survivor.confidence,
    };
  }

  const merged = [...new Set([
    ...survivor.supporting_evidence,
    ...losers.flatMap(loser => loser.supporting_evidence),
    ...(observationId ? [observationId] : []),
  ])];
  store.updateClaimSupportingEvidence(survivor.id, merged);
  const withEvidence = store.getClaim(survivor.id);
  if (withEvidence) {
    store.updateClaimConfidence(survivor.id, computeConfidence(withEvidence));
  }

  for (const loser of losers) {
    // updateClaimStatus writes the loser back through insertClaim: a demotion, not a delete.
    store.updateClaimStatus(loser.id, 'superseded', survivor.id, knownTime(now));
  }

  const after = store.getClaim(survivor.id);
  return {
    claimId: survivor.id,
    ambiguous_matches: matches.length,
    ambiguity_resolved: true,
    superseded_claims: losers.map(loser => loser.id),
    supporting_evidence: after?.supporting_evidence.length ?? merged.length,
    confidence: after?.confidence ?? 0,
  };
}

/**
 * Remove a supporting observation ID from all claims that reference it.
 * After removal:
 * - If supporting_evidence is now empty AND source or extraction provenance depended on it → retract
 * - If supporting_evidence is non-empty → recalculate confidence only
 */
export function removeEvidenceFromClaims(
  removedObsId: string,
  store: ClaimStore,
  invalidatedAt?: ClaimTimeValue,
): string[] {
  const retracted: string[] = [];
  const allClaims = store.getActiveClaims();

  for (const claim of allClaims) {
    if (
      !claim.supporting_evidence.includes(removedObsId)
      && claim.source_event_id !== removedObsId
      && claim.extraction_event_id !== removedObsId
    ) {
      continue;
    }

    const remaining = claim.supporting_evidence.filter(id => id !== removedObsId);
    store.updateClaimSupportingEvidence(claim.id, remaining);

    if (remaining.length === 0) {
      store.updateClaimStatus(claim.id, 'retracted', undefined, invalidatedAt);
      retracted.push(claim.id);
      continue;
    }

    const refreshed = store.getClaim(claim.id);
    if (refreshed) {
      store.updateClaimConfidence(claim.id, computeConfidence(refreshed));
    }
  }

  return retracted;
}
