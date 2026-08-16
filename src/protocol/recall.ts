// Protocol — RECALL handler (spec verb; formerly QUERY)

import type { ClaimStore } from '../layer1/store.js';
import type { SearchIndex } from '../layer3/search.js';
import type { SmartwareConfig } from '../config.js';
import type { ScopeRegistry } from '../scopes/registry.js';
import type { Actor } from '../layer0/types.js';
import type { ConfidenceBucket, EpistemicTag } from '../layer1/types.js';
import { assembleContext, type QueryFilters, type AssembledContext } from '../layer4/assembly.js';
import type { ScoredResult } from '../layer4/scoring.js';
import type { TemporalConstraint } from '../layer3/temporal.js';
import { ProtocolError } from '../auth/middleware.js';
import type { SessionStore } from '../session/store.js';
import { requireSessionCapability, resolveActorFromSession } from './session.js';

export interface QueryParams {
  actor: Actor;
  /** When supplied, server-resolved session identity overrides actor.id. */
  session_id?: string;
  query: string;
  scope: string;
  min_confidence?: number | ConfidenceBucket;
  epistemic?: string[];
  epistemic_tags?: EpistemicTag[];
  entity_type?: string;
  include_sensitive?: boolean;
  include_stale?: boolean;
  include_superseded?: boolean;
  include_forgotten?: boolean;
  /** Embedded retrieval constraint. The frozen RECALL HTTP/MCP schema may
   * expose this separately; the core applies it before ranking and limits. */
  temporal?: TemporalConstraint;
  limit?: number;
  resolution?: 'oneline' | 'oneliner' | 'paragraph' | 'full';
  delivery_mode?: 'inline' | 'file_reference' | 'context_bundle';
  /** Reserved post-beta by the frozen v0.4.2 wire contract. */
  as_of?: string;
}

export interface QueryResult {
  results: Array<{
    entity_id: string;
    entity_name: string;
    scope: string;
    score: number;
    signals: ScoredResult['signals'];
    claim?: {
      id: string;
      predicate: string;
      object: unknown;
      epistemic: string;
      confidence: number;
      status: string;
      observation_ids: string[];
      valid_at: string | null;
      invalid_at: string | null;
      recorded_at: string | null;
      invalidated_at: string | null;
    };
  }>;
  total_found: number;
  filtered_out: number;
  query_scope: string;
}

export function recallMinimumConfidence(
  value: QueryParams['min_confidence'],
): number | undefined {
  if (typeof value === 'number') return value;
  if (value === 'high') return 0.7;
  if (value === 'medium') return 0.4;
  if (value === 'low') return 0;
  return undefined;
}

export async function handleQuery(
  params: QueryParams,
  store: ClaimStore,
  searchIndex: SearchIndex,
  config: SmartwareConfig,
  registry: ScopeRegistry,
  sessionStore?: SessionStore,
): Promise<QueryResult> {
  if (!params.query?.trim() && !params.temporal) {
    throw new ProtocolError('invalid_query', 'Query string is required');
  }
  if (!params.scope) {
    throw new ProtocolError('invalid_scope', 'Scope is required');
  }
  if (params.as_of !== undefined) {
    throw new ProtocolError(
      'invalid_payload',
      'as_of is reserved for post-beta temporal recall',
    );
  }
  const minConfidence = recallMinimumConfidence(params.min_confidence);
  let actorId = params.actor.id;
  if (params.session_id) {
    if (!sessionStore) {
      throw new ProtocolError('internal_error', 'SessionStore required for session-authenticated recall');
    }
    const resolved = resolveActorFromSession(params.session_id, sessionStore);
    if (!resolved) {
      throw new ProtocolError('session_not_found', `Session '${params.session_id}' not found`);
    }
    if (resolved.effective_policy.read_mode === 'off') {
      throw new ProtocolError('read_disabled', 'Session policy does not allow reads');
    }
    requireSessionCapability(resolved, 'query', params.scope);
    actorId = resolved.actor_id;
  }

  const filters: QueryFilters = {
    minConfidence,
    epistemic: params.epistemic,
    epistemicTags: params.epistemic_tags,
    entityType: params.entity_type,
    includeSensitive: params.include_sensitive ?? false,
    includeStale: params.include_stale ?? false,
    includeSuperseded: params.include_superseded ?? false,
    includeForgotten: params.include_forgotten ?? false,
    temporal: params.temporal,
    limit: params.limit ?? 20,
  };

  const assembled: AssembledContext = assembleContext(
    params.query,
    params.scope,
    actorId,
    searchIndex,
    store,
    config,
    registry,
    filters,
  );

  const results = assembled.results.map(r => ({
    entity_id: r.entity_id,
    entity_name: r.entity_name,
    scope: r.scope,
    score: r.score,
    signals: r.signals,
    claim: r.claim
      ? {
          id: r.claim.id,
          predicate: r.claim.predicate,
          object: r.claim.object,
          epistemic: r.claim.epistemic,
          confidence: r.claim.confidence,
          status: r.claim.status,
          observation_ids: [...r.claim.supporting_evidence],
          valid_at: r.claim.t_valid_from.value,
          invalid_at: r.claim.t_valid_to.value,
          recorded_at: r.claim.t_ingested.value,
          invalidated_at: r.claim.t_invalidated.value,
        }
      : undefined,
  }));

  return {
    results,
    total_found: assembled.total_found,
    filtered_out: assembled.filtered_out,
    query_scope: assembled.query_scope,
  };
}

export { handleQuery as handleRecall };
export type { QueryParams as RecallParams, QueryResult as RecallResult };
