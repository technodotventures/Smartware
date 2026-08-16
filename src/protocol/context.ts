// Protocol — CONTEXT handler (§8)
//
// Returns an authenticated 1-hop bundle. Every claim and relation endpoint is
// resolved from the same authorized claim snapshot used by RECALL, and pinned
// relation versions are read from canonical L1 JSONL when available.

import type { SmartwareConfig } from '../config.js';
import type { Layer0Index } from '../layer0/index.js';
import { readAll } from '../layer0/log.js';
import type { ClaimStore } from '../layer1/store.js';
import type {
  Claim,
  ClaimAuthor,
  ClaimRelation,
  ClaimState,
  ClaimType,
  ClaimRole,
  ConfidenceBucket,
  EpistemicTag,
} from '../layer1/types.js';
import { confidenceToBucket, epistemicToTag, statusToState } from '../layer1/types.js';
import { snapshotAt, type ClaimVersionRecord } from '../layer1/jsonl.js';
import type { SearchIndex } from '../layer3/search.js';
import type { ScopeRegistry } from '../scopes/registry.js';
import { buildAuthorizedClaimSnapshot } from '../layer4/authorized-claims.js';
import { assembleContext } from '../layer4/assembly.js';

export interface ContextParams {
  query: string;
  scope: string;
  actor_id: string;
  include_superseded?: boolean;
  include_forgotten?: boolean;
  limit?: number;
}

export interface ContextClaimSummary {
  claim_id: string;
  version: number;
  state: ClaimState;
  content: string;
  confidence: ConfidenceBucket;
  epistemic_tag: EpistemicTag;
  author: ClaimAuthor;
  epistemic_owner: ClaimAuthor;
  scope: string;
  claim_type: ClaimType;
  claim_role: ClaimRole;
  version_at: string;
}

interface ContextCurrentVersion {
  version: number;
  state: ClaimState;
  version_at: string;
}

export interface ContextOutboundRelation {
  relation_id: string;
  seed: string;
  kind: string;
  target: string;
  valid_at: string;
  invalid_at: string | null;
  provenance: ClaimRelation['provenance'];
  target_claim: ContextClaimSummary;
  target_current?: ContextCurrentVersion;
}

export interface ContextInboundRelation {
  relation_id: string;
  source: string;
  kind: string;
  seed: string;
  valid_at: string;
  invalid_at: string | null;
  provenance: ClaimRelation['provenance'];
  source_claim: ContextClaimSummary;
  source_current?: ContextCurrentVersion;
}

export interface ContextObservationSummary {
  observation_id: string;
  source: string;
  content: unknown;
  timestamp: string;
}

export interface ContextBundle {
  seeds: ContextClaimSummary[];
  outbound_relations: ContextOutboundRelation[];
  inbound_relations: ContextInboundRelation[];
  provenance: ContextObservationSummary[];
}

function summaryFromVersion(version: ClaimVersionRecord): ContextClaimSummary {
  return {
    claim_id: version.claim_id,
    version: version.version,
    state: version.state,
    content: version.state === 'active' ? version.content : '[forgotten]',
    confidence: version.confidence,
    epistemic_tag: version.epistemic_tag,
    author: version.author,
    epistemic_owner: version.epistemic_owner,
    scope: version.scope,
    claim_type: version.claim_type,
    claim_role: version.claim_role,
    version_at: version.version_at,
  };
}

function summaryFromClaim(claim: Claim): ContextClaimSummary {
  return {
    claim_id: claim.id,
    version: 1,
    state: claim.state ?? statusToState(claim.status),
    content: typeof claim.object.value === 'string'
      ? claim.object.value
      : JSON.stringify(claim.object.value),
    confidence: confidenceToBucket(claim.confidence),
    epistemic_tag: epistemicToTag(claim.epistemic, claim.status),
    author: claim.author ?? 'agent',
    epistemic_owner: claim.epistemic_owner ?? claim.author ?? 'agent',
    scope: claim.scope,
    claim_type: claim.claim_type ?? 'finding',
    claim_role: claim.claim_role ?? 'memory',
    version_at: claim.version_at ?? claim.extraction.extracted_at,
  };
}

function claimSummary(
  dataDir: string | null,
  claim: Claim,
  version?: number,
): ContextClaimSummary {
  const canonical = dataDir ? snapshotAt(dataDir, claim.id, version) : null;
  return canonical ? summaryFromVersion(canonical) : summaryFromClaim(claim);
}

function currentVersion(summary: ContextClaimSummary): ContextCurrentVersion {
  return {
    version: summary.version,
    state: summary.state,
    version_at: summary.version_at,
  };
}

export async function handleContext(
  params: ContextParams,
  store: ClaimStore,
  searchIndex: SearchIndex,
  config: SmartwareConfig,
  registry: ScopeRegistry,
  evidenceDir?: string,
  layer0?: Layer0Index,
): Promise<ContextBundle> {
  const assembled = assembleContext(
    params.query,
    params.scope,
    params.actor_id,
    searchIndex,
    store,
    config,
    registry,
    {
      limit: params.limit ?? 10,
      includeSensitive: false,
      includeStale: false,
      includeSuperseded: params.include_superseded ?? false,
      includeForgotten: params.include_forgotten ?? false,
    },
  );
  const snapshot = buildAuthorizedClaimSnapshot({
    actorId: params.actor_id,
    scope: params.scope,
    includeSensitive: false,
    includeStale: false,
    includeSuperseded: params.include_superseded,
    includeForgotten: params.include_forgotten,
  }, store, config);
  const dataDir = store.getDataDir();

  const seeds = assembled.results.flatMap(result => {
    if (!result.claim) return [];
    const claim = snapshot.claimsById.get(result.claim.id);
    return claim ? [claimSummary(dataDir, claim)] : [];
  });
  const outbound_relations: ContextOutboundRelation[] = [];
  const inbound_relations: ContextInboundRelation[] = [];
  const provenanceIds = new Set<string>();

  for (const seed of seeds) {
    const seedClaim = snapshot.claimsById.get(seed.claim_id);
    for (const observationId of seedClaim?.supporting_evidence ?? []) {
      provenanceIds.add(observationId);
    }

    for (const relation of store.getOutboundRelations(seed.claim_id)) {
      if (relation.invalid_at && !params.include_superseded) continue;
      const target = snapshot.claimsById.get(relation.target);
      if (!target) continue;

      const pinnedVersion = 'target_claim_version' in relation.provenance
        ? relation.provenance.target_claim_version
        : undefined;
      const targetClaim = claimSummary(dataDir, target, pinnedVersion);
      const targetLatest = claimSummary(dataDir, target);
      for (const observationId of target.supporting_evidence) provenanceIds.add(observationId);
      if ('observation_ids' in relation.provenance) {
        for (const observationId of relation.provenance.observation_ids) {
          provenanceIds.add(observationId);
        }
      }
      outbound_relations.push({
        relation_id: relation.relation_id,
        seed: seed.claim_id,
        kind: relation.kind,
        target: relation.target,
        valid_at: relation.valid_at,
        invalid_at: relation.invalid_at,
        provenance: relation.provenance,
        target_claim: targetClaim,
        ...(targetClaim.version === targetLatest.version
          ? {}
          : { target_current: currentVersion(targetLatest) }),
      });
    }

    for (const relation of store.getInboundRelations(seed.claim_id)) {
      if (relation.invalid_at && !params.include_superseded) continue;
      const source = snapshot.claimsById.get(relation.source);
      if (!source) continue;

      const pinnedVersion = 'asserted_in_source_version' in relation.provenance
        ? relation.provenance.asserted_in_source_version
        : undefined;
      const sourceClaim = claimSummary(dataDir, source, pinnedVersion);
      const sourceLatest = claimSummary(dataDir, source);
      for (const observationId of source.supporting_evidence) provenanceIds.add(observationId);
      if ('observation_ids' in relation.provenance) {
        for (const observationId of relation.provenance.observation_ids) {
          provenanceIds.add(observationId);
        }
      }
      inbound_relations.push({
        relation_id: relation.relation_id,
        source: relation.source,
        kind: relation.kind,
        seed: seed.claim_id,
        valid_at: relation.valid_at,
        invalid_at: relation.invalid_at,
        provenance: relation.provenance,
        source_claim: sourceClaim,
        ...(sourceClaim.version === sourceLatest.version
          ? {}
          : { source_current: currentVersion(sourceLatest) }),
      });
    }
  }

  const provenance = evidenceDir
    ? [...readAll(evidenceDir)].flatMap(observation => {
      if (!provenanceIds.has(observation.id)) return [];
      if (observation.policy.sensitive) return [];
      if (layer0 && layer0.getEffectiveStatus(observation.id) !== 'accepted') return [];
      return [{
        observation_id: observation.id,
        source: observation.source.source_id
          ? `${observation.source.app}:${observation.source.source_id}`
          : observation.source.app,
        content: observation.content.body,
        timestamp: observation.source.observed_at,
      }];
    })
    : [];

  return { seeds, outbound_relations, inbound_relations, provenance };
}
