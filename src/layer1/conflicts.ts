// Layer 1 — Conflict detection, classification, and deterministic admission
//
// The policy is deterministic and metadata-only — no model, no wall clock, no
// dependence on who happens to speak last. It distinguishes three things:
//
//   • corroboration — the same assertion for the same event-valid window
//     (canonical key) is more evidence for one claim, never a twin;
//   • disagreement — a different assertion for the SAME window is unresolved:
//     both claims stay, both are marked contested, and reads surface the
//     conflict instead of silently picking a side;
//   • supersession — a different assertion that starts at a LATER event-valid
//     instant replaces the earlier *active* claim under the explicit policy
//     "a later event-valid start closes the earlier window". The replaced
//     window closes where the replacement starts (event-valid time) and the
//     moment the brain learned the replacement is recorded (system time).
//
// Contested claims are excluded from the supersession policy: recency must
// never resolve a disagreement. Resolving one requires a warranted action
// (a user REVISE admitting a supersedes/corrects edge), which is how the beta
// keeps every epistemic decision attributable.

import type { Claim, ClaimStatus, ClaimTimeValue } from './types.js';
import { knownTime, normaliseValue } from './types.js';
import type { ClaimStore } from './store.js';
import { addCorroborationEvidence } from './corroboration.js';
import { computeConfidence } from './confidence.js';

export type ConflictType = 'corroboration' | 'semantic_conflict' | 'temporal_supersession' | 'no_conflict';

export interface ConflictResult {
  type: ConflictType;
  existingClaim?: Claim;
  /**
   * Every live claim sharing the canonical key (same subject, predicate, scope
   * and validity_from). More than one means an already-unresolved disagreement
   * that a new arrival joins rather than overwrites.
   */
  sameKeyClaims?: Claim[];
}

/** Statuses that can take part in a conflict: unresolved is still live. */
const LIVE_STATUSES: ReadonlySet<ClaimStatus> = new Set(['active', 'stale', 'contested']);

/**
 * Check a new (unsaved) claim against the existing claim store.
 * Returns the conflict type and the conflicting claim if any.
 */
export function detectConflict(
  newClaim: Claim,
  store: ClaimStore,
): ConflictResult {
  const live = store.getClaimsBySubject(newClaim.subject_id)
    .filter(claim => LIVE_STATUSES.has(claim.status));

  const sameKey = live.filter(claim =>
    claim.predicate === newClaim.predicate
    && claim.scope === newClaim.scope
    && claim.validity.from === newClaim.validity.from,
  );

  if (sameKey.length > 0) {
    const newNorm = normaliseValue(newClaim.object);
    const agreeing = sameKey.find(claim => normaliseValue(claim.object) === newNorm);
    return agreeing
      ? { type: 'corroboration', existingClaim: agreeing, sameKeyClaims: sameKey }
      : { type: 'semantic_conflict', existingClaim: sameKey[0], sameKeyClaims: sameKey };
  }

  // Temporal supersession: same subject + predicate + scope, and the new
  // assertion starts at a later event-valid instant than a live ACTIVE claim.
  // (A stale claim is decaying evidence, not current truth; a contested claim
  // is unresolved and must not be resolved by recency.)
  const supersessionTarget = live.find(claim =>
    claim.status === 'active'
    && claim.predicate === newClaim.predicate
    && claim.scope === newClaim.scope
    && claim.validity.from < newClaim.validity.from,
  );
  if (supersessionTarget) {
    return { type: 'temporal_supersession', existingClaim: supersessionTarget, sameKeyClaims: [] };
  }

  return { type: 'no_conflict' };
}

/**
 * Apply semantic conflict: every live claim sharing the canonical key is in
 * unresolved disagreement with the new one. All sides are marked contested —
 * the store keeps them; nobody is promoted by recency or confidence.
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
 * Apply temporal supersession: the replacement claim's event-valid start closes
 * the older claim's window, and the moment the system learned the replacement is
 * recorded as the system-time invalidation.
 *
 * The two times answer different questions and must both be kept: event-valid
 * time says when the old fact stopped being true; system-recorded time says when
 * the brain was told. As-of reads depend on the distinction, so a supersession
 * that only stamped one of them would make one of the axes reconstruct wrongly.
 */
export function applyTemporalSupersession(
  oldClaimId: string,
  replacement: Claim,
  store: ClaimStore,
): void {
  const validTo = replacement.t_valid_from.value !== null
    ? { ...replacement.t_valid_from }
    : (replacement.validity.from ? knownTime(replacement.validity.from) : undefined);
  store.updateClaimStatus(oldClaimId, 'superseded', replacement.id, replacement.t_ingested, validTo);
}

export type ClaimAdmissionOutcome = 'inserted' | 'corroborated' | 'contested' | 'superseded';

export interface ClaimAdmission {
  outcome: ClaimAdmissionOutcome;
  /** The claim carrying the assertion after admission (the existing one when corroborated). */
  claim_id: string;
  /** Every claim involved: both sides of a contest, or old + new for a supersession. */
  related_claim_ids: string[];
  /** For 'superseded': the claim whose event-valid window this admission closed. */
  superseded_claim_id?: string;
}

/**
 * Deterministically admit a claim from a host extractor (route (b): the host
 * owns extraction, Smartware owns memory semantics). Returns what the policy
 * did so the caller can surface it rather than guess:
 *
 *   inserted      — first assertion for its canonical key;
 *   corroborated  — a restatement; evidence is folded into the existing claim;
 *   contested     — a disagreement about the same event-valid window; every
 *                   side is retained and marked contested, nothing resolved;
 *   superseded    — a later event-valid window replaces an active claim, whose
 *                   window is closed at the replacement's start.
 *
 * The outcome is a pure function of (subject, predicate, scope, validity_from,
 * value, event/system times, statuses) — no LLM, no caller identity, no clock.
 */
export function admitClaim(claim: Claim, store: ClaimStore): ClaimAdmission {
  const conflict = detectConflict(claim, store);

  if (conflict.type === 'corroboration' && conflict.existingClaim) {
    const existing = conflict.existingClaim;
    for (const observationId of claim.supporting_evidence) {
      addCorroborationEvidence(existing.id, observationId, store);
    }
    return { outcome: 'corroborated', claim_id: existing.id, related_claim_ids: [existing.id] };
  }

  if (conflict.type === 'semantic_conflict' && conflict.existingClaim) {
    claim.confidence = computeConfidence(claim);
    store.insertClaim(claim);
    const others = (conflict.sameKeyClaims ?? [conflict.existingClaim])
      .filter(existing => existing.id !== claim.id);
    for (const existing of others) {
      applySemanticConflict(existing.id, claim.id, store);
    }
    return {
      outcome: 'contested',
      claim_id: claim.id,
      related_claim_ids: [claim.id, ...others.map(existing => existing.id)],
    };
  }

  if (conflict.type === 'temporal_supersession' && conflict.existingClaim) {
    claim.confidence = computeConfidence(claim);
    store.insertClaim(claim);
    applyTemporalSupersession(conflict.existingClaim.id, claim, store);
    return {
      outcome: 'superseded',
      claim_id: claim.id,
      related_claim_ids: [conflict.existingClaim.id, claim.id],
      superseded_claim_id: conflict.existingClaim.id,
    };
  }

  claim.confidence = computeConfidence(claim);
  store.insertClaim(claim);
  return { outcome: 'inserted', claim_id: claim.id, related_claim_ids: [claim.id] };
}
