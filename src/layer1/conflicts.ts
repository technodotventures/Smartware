// Layer 1 — Conflict detection and classification

import type { Claim, ClaimTimeValue } from './types.js';
import { normaliseValue } from './types.js';
import type { ClaimStore } from './store.js';
import { computeConfidence } from './confidence.js';

export type ConflictType = 'corroboration' | 'semantic_conflict' | 'temporal_supersession' | 'no_conflict';

export interface ConflictResult {
  type: ConflictType;
  existingClaim?: Claim;
}

/**
 * Check a new (unsaved) claim against the existing claim store.
 * Returns the conflict type and the conflicting claim if any.
 */
export function detectConflict(
  newClaim: Claim,
  store: ClaimStore,
): ConflictResult {
  const existing = store.findByCanonicalKey(
    newClaim.subject_id,
    newClaim.predicate,
    newClaim.scope,
    newClaim.validity.from,
  );

  // Only LIVE claims can be corroborated or contested. Without this status
  // guard, a new claim matching the canonical key of a retracted/superseded/
  // contested claim would resurrect it (corroboration) or contest a dead claim.
  if (existing && (existing.status === 'active' || existing.status === 'stale')) {
    const existingNorm = normaliseValue(existing.object);
    const newNorm = normaliseValue(newClaim.object);

    if (existingNorm === newNorm) {
      return { type: 'corroboration', existingClaim: existing };
    } else {
      return { type: 'semantic_conflict', existingClaim: existing };
    }
  }

  // Check temporal supersession: same subject + predicate, different validity.from
  const subjectClaims = store.getClaimsBySubject(newClaim.subject_id, 'active');
  for (const c of subjectClaims) {
    if (
      c.predicate === newClaim.predicate &&
      c.scope === newClaim.scope &&
      c.validity.from < newClaim.validity.from
    ) {
      return { type: 'temporal_supersession', existingClaim: c };
    }
  }

  return { type: 'no_conflict' };
}

/**
 * Apply semantic conflict: mark both claims as contested.
 */
export function applySemanticConflict(
  existingId: string,
  newId: string,
  store: ClaimStore,
): void {
  store.markContested(existingId, newId);

  // Recompute confidence for both
  const existing = store.getClaim(existingId);
  const updated = store.getClaim(newId);
  if (existing) store.updateClaimConfidence(existingId, computeConfidence(existing));
  if (updated) store.updateClaimConfidence(newId, computeConfidence(updated));
}

/**
 * Apply temporal supersession: mark the older claim superseded.
 */
export function applyTemporalSupersession(
  oldClaimId: string,
  newClaimId: string,
  store: ClaimStore,
  invalidatedAt?: ClaimTimeValue,
): void {
  store.updateClaimStatus(oldClaimId, 'superseded', newClaimId, invalidatedAt);
}
