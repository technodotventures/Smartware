// Layer 1 — Six-factor confidence scoring

import type { Claim, EpistemicLabel } from './types.js';

/**
 * Half-life (days) per lane, keyed on the **published** `Scope` vocabulary
 * (`schemas/v0.5.0/common.schema.json#/$defs/Scope`:
 * `self | workspace | project:<id> | agent:<id> | client:<id>[#n]`), mirroring
 * the staleness values this implementation declares
 * (`staleness: { default_half_life_days: 90, scope_overrides: { self: 365, 'project:*': 30 } }`).
 *
 * Pre-fix the table was keyed on the pre-rename spellings instead (`personal`,
 * a `project/` prefix), so neither declared override reached the lane the
 * vocabulary names. Measured on identical claims, the implied half-life the
 * shipped function applied was: `personal` 365, `self` 90, `project/foo` 30,
 * `project:foo` 90 (kanban t_574be8cd; the rename is ADR-0015 / t_e6fce49a).
 */
const SCOPE_HALF_LIFE_DAYS: Record<string, number> = {
  self: 365,
  default: 90,
};

/** The config's `project:*` override, applied to the spec's `project:<id>` lanes. */
const PROJECT_SCOPE_HALF_LIFE_DAYS = 30;

function getScopeHalfLife(scope: string): number {
  for (const [key, days] of Object.entries(SCOPE_HALF_LIFE_DAYS)) {
    if (key === 'default') continue;
    if (scope === key || scope.startsWith(key + '/')) return days;
  }
  if (scope.startsWith('project:')) return PROJECT_SCOPE_HALF_LIFE_DAYS;
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
