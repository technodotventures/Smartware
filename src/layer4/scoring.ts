// Layer 4 — Multi-signal query scoring

import type { Claim } from '../layer1/types.js';
import type { SearchResult } from '../layer3/search.js';
import type { ScopeRegistry } from '../scopes/registry.js';
import { getScopeProximity } from '../scopes/proximity.js';

export interface ScoredResult {
  entity_id: string;
  entity_name: string;
  scope: string;
  claim?: Claim;
  score: number;
  signals: {
    textRelevance: number;
    recency: number;
    epistemicConf: number;
    scopeProximity: number;
  };
}

/**
 * Score a search result using four signals:
 * - textRelevance (BM25): 0.35 weight
 * - recency: 0.25 weight
 * - epistemicConf: 0.25 weight
 * - scopeProximity: 0.15 weight
 */
export function scoreResult(
  searchResult: SearchResult,
  claim: Claim | undefined,
  queryScope: string,
  registry: ScopeRegistry,
  textRelevance: number,
): ScoredResult {
  const recency = claim ? computeRecency(claim) : 0.5;
  const epistemicConf = claim?.confidence ?? 0.5;
  const scopeProximity = getScopeProximity(queryScope, searchResult.scope, registry);

  const score =
    textRelevance * 0.35 +
    recency * 0.25 +
    epistemicConf * 0.25 +
    scopeProximity * 0.15;

  return {
    entity_id: searchResult.entity_id,
    entity_name: searchResult.entity_name,
    scope: searchResult.scope,
    claim,
    score,
    signals: { textRelevance, recency, epistemicConf, scopeProximity },
  };
}

/**
 * Convert FTS5 BM25 magnitudes into query-local 0-1 relevance.
 *
 * SQLite's hidden FTS5 rank is negative and query/corpus dependent.
 * SearchIndex preserves its magnitude, where larger means a stronger match.
 * Those magnitudes are commonly around 1e-6, so dividing by a global constant
 * erases lexical relevance and lets recency/confidence dominate.
 *
 * This value is intentionally relative to one eligible candidate set. It is a
 * ranking signal, not calibrated confidence, and must not be compared with a
 * semantic cosine score or used as a cross-query threshold.
 */
export function normaliseTextRelevance(ranks: number[]): number[] {
  const finite = ranks.map(rank => Number.isFinite(rank) && rank > 0 ? rank : 0);
  const strongest = Math.max(0, ...finite);
  if (strongest === 0) return finite;
  return finite.map(rank => Math.min(rank / strongest, 1));
}

/** Recency score based on the claim's validity.from timestamp */
function computeRecency(claim: Claim): number {
  const from = claim.validity.from;
  if (!from) return 0.5;

  const ageMs = Date.now() - new Date(from).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // Half-life of 90 days
  return Math.pow(0.5, ageDays / 90);
}

/** Sort scored results descending by composite score */
export function rankResults(results: ScoredResult[]): ScoredResult[] {
  return [...results].sort((a, b) => b.score - a.score);
}
