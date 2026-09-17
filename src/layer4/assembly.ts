// Layer 4 — Context assembly with policy filtering

import type { ClaimStore } from '../layer1/store.js';
import type { Claim, EpistemicTag } from '../layer1/types.js';
import {
  searchQueryTerms,
  type ClaimSearchResult,
  type SearchResult,
} from '../layer3/search.js';
import type { SearchIndex } from '../layer3/search.js';
import type { SmartwareConfig } from '../config.js';
import type { ScopeRegistry } from '../scopes/registry.js';
import { buildAuthorizedClaimSnapshot } from './authorized-claims.js';
import {
  normaliseTextRelevance,
  scoreResult,
  rankResults,
  type ScoredResult,
} from './scoring.js';
import { claimToSemanticDocument } from '../layer3/semantic.js';
import {
  matchesTemporalConstraint,
  type TemporalConstraint,
} from '../layer3/temporal.js';

export interface QueryFilters {
  minConfidence?: number;
  epistemic?: string[];
  epistemicTags?: EpistemicTag[];
  entityType?: string;
  includeSensitive?: boolean;
  includeStale?: boolean;
  includeSuperseded?: boolean;
  includeForgotten?: boolean;
  temporal?: TemporalConstraint;
  limit?: number;
}

export interface AssembledContext {
  results: ScoredResult[];
  total_found: number;
  filtered_out: number;
  query_scope: string;
}

/**
 * Apply all five policy filters from the spec:
 * 1. Capability grants
 * 2. Visibility flags
 * 3. Scope exports
 * 4. Sensitivity (exclude by default)
 * 5. Claim status (exclude stale/retracted by default)
 */
export function assembleContext(
  query: string,
  queryScope: string,
  actorId: string,
  searchIndex: SearchIndex,
  store: ClaimStore,
  config: SmartwareConfig,
  registry: ScopeRegistry,
  filters: QueryFilters = {},
): AssembledContext {
  // History requests. Two different reconstructions, two different relaxations:
  //   • transaction-time reads rebuild what the brain had recorded at an
  //     instant — superseded AND forgotten claims are candidates;
  //   • valid-time reads rebuild what was true in the window — a claim that was
  //     true then is eligible even if a later fact has since superseded it
  //     (forgotten/retracted material was never true and stays excluded).
  const transactionHistory = filters.temporal?.axis === 'transaction_time'
    && filters.temporal.mode !== 'current';
  const validTimeHistory = filters.temporal?.axis === 'valid_time'
    && filters.temporal.mode !== 'current';
  const temporalHistory = transactionHistory || validTimeHistory;
  const snapshot = buildAuthorizedClaimSnapshot({
    actorId,
    scope: queryScope,
    minConfidence: filters.minConfidence,
    epistemic: filters.epistemic,
    epistemicTags: filters.epistemicTags,
    entityType: filters.entityType,
    includeSensitive: filters.includeSensitive,
    includeStale: filters.includeStale,
    includeSuperseded: temporalHistory || filters.includeSuperseded,
    includeForgotten: transactionHistory || filters.includeForgotten,
  }, store, config);
  if (!snapshot.authorized) {
    return { results: [], total_found: 0, filtered_out: 0, query_scope: queryScope };
  }

  // Search individual claims first. Retain entity/page results only for
  // entities with no matching claim so legacy/manual L2 pages remain readable.
  const historyRequested = temporalHistory
    || filters.includeSuperseded === true
    || filters.includeForgotten === true;
  const claimResults: ClaimSearchResult[] = query.trim()
    ? historyRequested
      ? historicalClaimSearch(snapshot.claims, query, queryScope)
      : searchIndex.searchClaims(query, queryScope)
    : filters.temporal
      ? snapshot.claims.map(claim => ({
          claim_id: claim.id,
          entity_id: claim.subject_id,
          entity_name: claim.subject_name,
          scope: claim.scope,
          rank: 1,
        }))
      : [];
  const claimEntityIds = new Set(claimResults.map(result => result.entity_id));
  const pageResults: SearchResult[] = (query.trim() ? searchIndex.search(query, queryScope) : [])
    .filter(result => !claimEntityIds.has(result.entity_id));
  const rawResults: Array<SearchResult | ClaimSearchResult> = [...claimResults, ...pageResults];
  const total_found = rawResults.length;
  let filtered_out = 0;

  // Load claims and apply all filters before normalising lexical relevance.
  // Ineligible material must not influence the visible candidate score scale.
  const eligible: Array<{
    searchResult: SearchResult | ClaimSearchResult;
    claim: Claim | undefined;
  }> = [];

  for (const sr of rawResults) {
    // A claim hit is evaluated against that exact claim. Page/entity fallback
    // retains the prior representative-claim behavior for projection-only rows.
    const claimId = 'claim_id' in sr ? sr.claim_id : undefined;
    const matchingClaim = claimId ? snapshot.claimsById.get(claimId) : undefined;
    if (claimId && !matchingClaim) {
      filtered_out++;
      continue;
    }
    let entityClaims = matchingClaim
      ? [matchingClaim]
      : snapshot.claimsBySubject.get(sr.entity_id) ?? [];
    const allEntityClaims = claimId
      ? [store.getClaim(claimId)].filter(claim => claim !== undefined)
      : snapshot.allClaimsBySubject.get(sr.entity_id) ?? [];

    // A legacy/manual L2 page with no claims remains readable. A page backed by
    // claims cannot bypass claim eligibility when every backing claim is denied.
    if (!claimId && allEntityClaims.length > 0 && entityClaims.length === 0) {
      filtered_out++;
      continue;
    }

    // Temporal intent is evaluated against claim valid/transaction time, not
    // page compilation or artifact edit time. Projection-only rows without a
    // claim cannot establish temporal truth and are excluded.
    if (filters.temporal) {
      entityClaims = entityClaims.filter(claim =>
        matchesTemporalConstraint(claimToSemanticDocument(claim), filters.temporal!));
      if (entityClaims.length === 0) {
        filtered_out++;
        continue;
      }
    }
    if (!claimId && filters.entityType
      && store.getEntity(sr.entity_id)?.type !== filters.entityType) {
      filtered_out++;
      continue;
    }

    // Pick the highest-confidence claim as representative (may be undefined)
    const bestClaim = [...entityClaims].sort((a, b) => b.confidence - a.confidence)[0];

    eligible.push({ searchResult: sr, claim: bestClaim });
  }

  const textRelevance = normaliseTextRelevance(
    eligible.map(candidate => candidate.searchResult.rank),
  );
  const scored: ScoredResult[] = eligible.map((candidate, index) =>
    scoreResult(
      candidate.searchResult,
      candidate.claim,
      queryScope,
      registry,
      textRelevance[index] ?? 0,
    ));
  const ranked = rankResults(scored);
  const limit = filters.limit ?? 20;

  return {
    results: ranked.slice(0, limit),
    total_found,
    filtered_out,
    query_scope: queryScope,
  };
}

function historicalClaimSearch(
  claims: Claim[],
  query: string,
  scope: string,
): ClaimSearchResult[] {
  const terms = searchQueryTerms(query);
  if (terms.length === 0) return [];
  return claims
    .filter(claim => claim.scope === scope)
    .flatMap(claim => {
      const object = typeof claim.object.value === 'string'
        ? claim.object.value
        : JSON.stringify(claim.object.value);
      const text = `${claim.subject_name} ${claim.predicate} ${object}`.toLowerCase();
      const matches = terms.filter(term => text.includes(term)).length;
      if (matches === 0) return [];
      return [{
        claim_id: claim.id,
        entity_id: claim.subject_id,
        entity_name: claim.subject_name,
        scope: claim.scope,
        rank: matches,
      }];
    })
    .sort((left, right) => right.rank - left.rank || left.claim_id.localeCompare(right.claim_id))
    .slice(0, 200);
}
