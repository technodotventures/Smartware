// Layer 1 — Supporting evidence management for corroboration

import type { ClaimStore } from './store.js';
import type { ClaimTimeValue } from './types.js';
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
 * Remove a supporting observation ID from all claims that reference it.
 * After removal:
 * - If supporting_evidence is now empty AND source or extraction provenance depended on it → retract
 * - If supporting_evidence is non-empty → recalculate confidence only
 *
 * `touchedScopes`, when given, collects the scope of every claim whose row this
 * call writes — the caller (replay) reports it so the claim-FTS lane can be
 * re-synced for exactly those scopes (kanban t_a6bf30a8).
 */
export function removeEvidenceFromClaims(
  removedObsId: string,
  store: ClaimStore,
  invalidatedAt?: ClaimTimeValue,
  touchedScopes?: Set<string>,
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

    touchedScopes?.add(claim.scope);
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
