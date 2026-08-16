import type { SmartwareConfig } from '../config.js';
import { checkGrant, isOwner } from '../auth/grants.js';
import { isEffectiveCurrent } from '../layer1/effective_current.js';
import type { Claim, EpistemicTag } from '../layer1/types.js';
import { epistemicToTag } from '../layer1/types.js';
import type { ClaimStore } from '../layer1/store.js';

export interface AuthorizedClaimPolicy {
  actorId: string;
  scope: string;
  minConfidence?: number;
  epistemic?: string[];
  epistemicTags?: EpistemicTag[];
  entityType?: string;
  includeSensitive?: boolean;
  includeStale?: boolean;
  includeSuperseded?: boolean;
  includeForgotten?: boolean;
}

export interface AuthorizedClaimSnapshot {
  authorized: boolean;
  claims: Claim[];
  claimsById: ReadonlyMap<string, Claim>;
  claimsBySubject: ReadonlyMap<string, Claim[]>;
  allClaimsBySubject: ReadonlyMap<string, Claim[]>;
  filteredClaims: number;
}

function groupBySubject(claims: Claim[]): Map<string, Claim[]> {
  const grouped = new Map<string, Claim[]>();
  for (const claim of claims) {
    const existing = grouped.get(claim.subject_id) ?? [];
    existing.push(claim);
    grouped.set(claim.subject_id, existing);
  }
  return grouped;
}

/**
 * Build the one authorized, lifecycle-aware claim snapshot used by every
 * retrieval channel. Ranking and result limits must only operate on this set.
 */
export function buildAuthorizedClaimSnapshot(
  policy: AuthorizedClaimPolicy,
  store: ClaimStore,
  config: SmartwareConfig,
): AuthorizedClaimSnapshot {
  const authorized = isOwner(policy.actorId, config)
    || checkGrant(policy.actorId, 'query', policy.scope, config);
  if (!authorized) {
    return {
      authorized: false,
      claims: [],
      claimsById: new Map(),
      claimsBySubject: new Map(),
      allClaimsBySubject: new Map(),
      filteredClaims: 0,
    };
  }

  const allClaims = store.getAllClaims(policy.scope);
  const entities = new Map(
    store.getAllEntities(policy.scope).map(entity => [entity.id, entity]),
  );
  const epistemic = new Set(policy.epistemic ?? []);
  const epistemicTags = new Set(policy.epistemicTags ?? []);
  const owner = isOwner(policy.actorId, config);
  const db = store.getDB();

  const claims = allClaims.filter(claim => {
    const forgotten = claim.state === 'forgotten' || claim.status === 'retracted';
    if (forgotten && !policy.includeForgotten) return false;
    if (claim.status === 'superseded' && !policy.includeSuperseded) return false;
    if (claim.status === 'stale' && !policy.includeStale) return false;
    if (!policy.includeSuperseded && db && !isEffectiveCurrent(claim.id, db)) return false;
    if (claim.sensitive && (!policy.includeSensitive || !owner)) return false;
    if (policy.minConfidence !== undefined && claim.confidence < policy.minConfidence) return false;
    if (epistemic.size > 0 && !epistemic.has(claim.epistemic)) return false;
    if (epistemicTags.size > 0
      && !epistemicTags.has(epistemicToTag(claim.epistemic, claim.status))) return false;
    if (policy.entityType && entities.get(claim.subject_id)?.type !== policy.entityType) return false;
    return true;
  });

  return {
    authorized: true,
    claims,
    claimsById: new Map(claims.map(claim => [claim.id, claim])),
    claimsBySubject: groupBySubject(claims),
    allClaimsBySubject: groupBySubject(allClaims),
    filteredClaims: allClaims.length - claims.length,
  };
}
