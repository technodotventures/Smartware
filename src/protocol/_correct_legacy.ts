// Protocol — REVISE handler (spec verb; formerly CORRECT)

import type { Observation, Actor, ClaimTimeValue } from '../layer0/types.js';
import { appendObservation } from '../layer0/log.js';
import { assignIntegrity } from '../layer0/integrity.js';
import type { Layer0Index } from '../layer0/index.js';
import type { ClaimStore } from '../layer1/store.js';
import { replayCatchUp } from '../layer1/replay.js';
import { resyncCatchUpScopes, type SearchIndex } from '../layer3/search.js';
import { inferredTime, nullTime } from '../layer1/types.js';
import type { SmartwareConfig } from '../config.js';
import { requireGrant, ProtocolError } from '../auth/middleware.js';
import { SMARTWARE_VERSION } from '../version.js';
import { computePayloadHash } from '../layer0/idempotency.js';

export type CorrectReason = 'changed' | 'wrong' | 'extraction_error' | 'duplicate';

export interface CorrectParams {
  actor: Actor;
  target_claim_id: string;
  corrected_predicate?: string;
  corrected_object?: { type: string; value: unknown };
  corrected_validity?: { from: string; to: string | null };
  corrected_t_valid_from?: ClaimTimeValue;
  corrected_t_valid_to?: ClaimTimeValue;
  merge_into_claim_id?: string;
  change_time?: string;
  reason: CorrectReason | string;
}

export interface CorrectResult {
  original_claim_id: string;
  new_claim_id: string | null;
  merged_into_claim_id?: string | null;
  audit_observation_id: string;
  reason: CorrectReason;
  status: 'corrected';
}

function normaliseReason(reason: CorrectReason | string): CorrectReason {
  return reason === 'changed' || reason === 'wrong' || reason === 'extraction_error' || reason === 'duplicate'
    ? reason
    : 'changed';
}

export async function handleCorrect(
  params: CorrectParams,
  evidenceDir: string,
  layer0: Layer0Index,
  store: ClaimStore,
  config: SmartwareConfig,
  /**
   * The caller's claim-FTS lane, when it owns one. The correction ends with a
   * `replayCatchUp`, which materialises claim rows for events this process had
   * not replayed yet (a legacy/host-written `claim_extracted`, or a `correction`
   * from another writer — in ANY scope, since the catch-up replays the whole log
   * tail) and writes no index. Passing the lane re-syncs exactly the scopes that
   * catch-up touched; the corrected claim's own scope is covered by the same set
   * (kanban t_a6bf30a8).
   */
  searchIndex?: SearchIndex,
): Promise<CorrectResult> {
  const original = store.getClaim(params.target_claim_id);
  if (!original) {
    throw new ProtocolError('claim_not_found', `Claim '${params.target_claim_id}' not found`);
  }

  requireGrant(params.actor.id, 'correct', original.scope, config);

  const normalizedReason = normaliseReason(params.reason);

  if (normalizedReason === 'duplicate') {
    if (!params.merge_into_claim_id) {
      throw new ProtocolError('invalid_duplicate_merge', 'duplicate corrections require merge_into_claim_id');
    }
    const mergeTarget = store.getClaim(params.merge_into_claim_id);
    if (!mergeTarget) {
      throw new ProtocolError('claim_not_found', `Canonical claim '${params.merge_into_claim_id}' not found`);
    }
  }

  const now = new Date().toISOString();
  const seq = layer0.getLastSequence() + 1;
  const prevHash = layer0.getLatestHashForWriter(config.writer_id);

  const correctedTemporalFrom = params.corrected_t_valid_from
    ?? (params.corrected_validity?.from ? inferredTime(params.corrected_validity.from, 'corrected_validity.from') : undefined);
  const correctedTemporalTo = params.corrected_t_valid_to
    ?? (params.corrected_validity?.to ? inferredTime(params.corrected_validity.to, 'corrected_validity.to') : nullTime());

  const correctedClaim = normalizedReason === 'duplicate'
    ? undefined
    : {
        predicate: params.corrected_predicate ?? original.predicate,
        object: params.corrected_object ?? original.object,
        validity: params.corrected_validity ?? original.validity,
        t_valid_from: correctedTemporalFrom,
        t_valid_to: correctedTemporalTo,
      };

  const correctionObs: Observation = {
    id: `obs_${computePayloadHash({
      type: 'correction',
      actor_id: params.actor.id,
      target_claim_id: params.target_claim_id,
      reason: normalizedReason,
      sequence: seq,
      observed_at: now,
    })}`,
    version: SMARTWARE_VERSION,
    type: 'correction',
    status: 'accepted',
    source: {
      app: 'mcp-client',
      app_version: SMARTWARE_VERSION,
      source_id: null,
      actor: params.actor,
      captured_at: now,
      observed_at: now,
    },
    scope: original.scope,
    visibility: 'private',
    content: {
      format: 'application/json',
      body: {
        target_claim_id: params.target_claim_id,
        corrected_claim: correctedClaim,
        merge_into_claim_id: params.merge_into_claim_id ?? null,
        reason: normalizedReason,
        change_time: params.change_time ?? now,
      },
    },
    provenance: { parent_ids: [original.source_event_id], supersedes: [params.target_claim_id], context: 'correction' },
    idempotency: null,
    policy: { retention: 'forever', retention_duration: null, sensitive: original.sensitive, pii_detected: false },
    integrity: { hash: '', writer_id: config.writer_id, sequence: seq, previous_hash: prevHash },
  };

  const withIntegrity = assignIntegrity(correctionObs, config.writer_id, seq, prevHash);
  appendObservation(evidenceDir, withIntegrity);
  layer0.insertOrSkip(withIntegrity);

  const caughtUp = await replayCatchUp(evidenceDir, store, layer0, config);
  resyncCatchUpScopes(searchIndex, store, caughtUp.touchedScopes);

  const spawnedClaim = store.getAllClaims().find(claim => claim.source_event_id === withIntegrity.id && claim.id !== original.id) ?? null;

  return {
    original_claim_id: params.target_claim_id,
    new_claim_id: spawnedClaim?.id ?? null,
    merged_into_claim_id: params.merge_into_claim_id ?? null,
    audit_observation_id: withIntegrity.id,
    reason: normalizedReason,
    status: 'corrected',
  };
}

export { handleCorrect as handleRevise };
export type { CorrectParams as ReviseParams, CorrectResult as ReviseResult };
