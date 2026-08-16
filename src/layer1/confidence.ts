// Layer 1 — Six-factor confidence scoring

import type { Claim, EpistemicLabel } from './types.js';

const SCOPE_HALF_LIFE_DAYS: Record<string, number> = {
  'personal': 365,
  'default': 90,
};

function getScopeHalfLife(scope: string): number {
  for (const [key, days] of Object.entries(SCOPE_HALF_LIFE_DAYS)) {
    if (scope === key || scope.startsWith(key + '/')) return days;
  }
  if (scope.startsWith('project/')) return 30;
  return SCOPE_HALF_LIFE_DAYS['default'];
}

/** Factor 1: Source reliability by epistemic label and extraction method */
function sourceReliability(claim: Claim): number {
  if (claim.epistemic === 'user_confirmed') return 1.0;
  if (claim.epistemic === 'asserted') return 0.9;
  if (claim.epistemic === 'observed') return 0.8;
  if (claim.epistemic === 'inferred') return 0.6;
  return 0.5; // system_generated
}

/** Factor 2: Recency decay (exponential half-life) */
function recencyScore(claim: Claim, scopeHalfLifeDays: number): number {
  const mostRecent = claim.supporting_evidence.length > 0
    ? claim.validity.from  // Use validity.from as proxy
    : claim.validity.from;

  const ageMs = Date.now() - new Date(mostRecent).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / scopeHalfLifeDays);
}

/** Factor 3: Corroboration (more independent sources = higher confidence) */
function corroborationScore(claim: Claim): number {
  return Math.min(claim.supporting_evidence.length / 3, 1.0);
}

/** Factor 4: Contradiction penalty */
function contradictionPenalty(claim: Claim): number {
  return claim.contested_by.length * -0.15;
}

/** Factor 5: Extraction confidence */
function extractionConfidence(claim: Claim): number {
  if (claim.extraction.method === 'deterministic') return 1.0;
  if (claim.extraction.method === 'user_input') return 1.0;
  return 0.7; // llm
}

/** Compute the full six-factor confidence score */
export function computeConfidence(claim: Claim): number {
  const halfLife = getScopeHalfLife(claim.scope);

  const srcRel = sourceReliability(claim);            // weight 0.20
  const userConf = claim.epistemic === 'user_confirmed' ? 1.0 : 0.0;  // weight 0.25
  const recency = recencyScore(claim, halfLife);       // weight 0.15
  const corroboration = corroborationScore(claim);     // weight 0.15
  const contradiction = Math.max(contradictionPenalty(claim), -0.45); // floor -0.45
  const extractConf = extractionConfidence(claim);     // weight 0.10

  const score =
    srcRel * 0.20 +
    userConf * 0.25 +
    recency * 0.15 +
    corroboration * 0.15 +
    contradiction +
    extractConf * 0.10;

  return Math.max(0, Math.min(1, score));
}

/** Determine if a claim is stale based on confidence and threshold */
export function isStale(claim: Claim, threshold: number = 0.3): boolean {
  return claim.confidence < threshold && claim.status === 'active';
}
