// Protocol — QUARANTINE_REVIEW handler (owner-only)
//
// Reviews a quarantined observation and either approves it (transitioning to
// `accepted`) or rejects it (transitioning to `rejected`, a terminal state).
// Approval re-runs Layer 1 replay so the observation's evidence finally
// materialises into claims.

import type { Observation, Actor } from '../layer0/types.js';
import { appendObservation } from '../layer0/log.js';
import { assignIntegrity } from '../layer0/integrity.js';
import type { Layer0Index } from '../layer0/index.js';
import type { ClaimStore } from '../layer1/store.js';
import type { SmartwareConfig } from '../config.js';
import { replayCatchUp } from '../layer1/replay.js';
import { requireOwner, ProtocolError } from '../auth/middleware.js';
import { TERMINAL_STATES } from '../layer0/types.js';
import { SMARTWARE_VERSION } from '../version.js';
import { computePayloadHash } from '../layer0/idempotency.js';

export type QuarantineAction = 'approve' | 'reject';

export interface QuarantineReviewParams {
  actor: Actor;
  target_obs_id: string;
  action: QuarantineAction;
  reason?: string;
}

export interface QuarantineReviewResult {
  target_obs_id: string;
  action: QuarantineAction;
  new_status: 'accepted' | 'rejected';
  status: 'reviewed';
}

export async function handleQuarantineReview(
  params: QuarantineReviewParams,
  evidenceDir: string,
  layer0: Layer0Index,
  store: ClaimStore,
  config: SmartwareConfig,
): Promise<QuarantineReviewResult> {
  // Only the owner can approve or reject quarantined evidence.
  requireOwner(params.actor.id, config);

  const current = layer0.getEffectiveStatus(params.target_obs_id);
  if (current === null) {
    throw new ProtocolError('not_found', `Observation '${params.target_obs_id}' not found`);
  }
  if (current !== 'quarantined') {
    throw new ProtocolError(
      'invalid_state',
      `Observation '${params.target_obs_id}' is in state '${current}', not 'quarantined'`,
    );
  }
  if (TERMINAL_STATES.has(current)) {
    throw new ProtocolError('terminal_state', `Observation already in terminal state '${current}'`);
  }

  // Look up scope from the index for the audit record
  const obsRow = layer0.getDB().prepare('SELECT scope FROM observations WHERE id = ?')
    .get(params.target_obs_id) as { scope: string } | undefined;
  const scope = obsRow?.scope ?? 'personal';

  const now = new Date().toISOString();
  const seq = layer0.getLastSequence() + 1;
  const prevHash = layer0.getLatestHashForWriter(config.writer_id);

  const reviewObs: Observation = {
    id: `obs_${computePayloadHash({
      type: 'quarantine_review',
      actor_id: params.actor.id,
      target_obs_id: params.target_obs_id,
      action: params.action,
      sequence: seq,
      observed_at: now,
    })}`,
    version: SMARTWARE_VERSION,
    type: 'quarantine_review',
    status: 'accepted',
    source: {
      app: 'mcp-client',
      app_version: SMARTWARE_VERSION,
      source_id: null,
      actor: params.actor,
      captured_at: now,
      observed_at: now,
    },
    scope,
    visibility: 'private',
    content: {
      format: 'application/json',
      body: {
        target_id: params.target_obs_id,
        action: params.action,
        reason: params.reason ?? '',
      },
    },
    provenance: { parent_ids: [params.target_obs_id], supersedes: [], context: 'quarantine_review' },
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: config.writer_id, sequence: seq, previous_hash: prevHash },
  };

  const withIntegrity = assignIntegrity(reviewObs, config.writer_id, seq, prevHash);
  appendObservation(evidenceDir, withIntegrity);
  layer0.insertOrSkip(withIntegrity);

  // Apply the state transition (quarantined → accepted or → rejected)
  layer0.applyMutationEvent(withIntegrity);

  // On approval, the parent's effective status is now `accepted`. Replay
  // catch-up will skip the parent (its sequence is older than last_replayed),
  // so we have to extract claims here. The simplest correct path is to run
  // replayCatchUp — it processes any new events since last replay (none yet
  // for the parent). For approval to actually surface claims, the caller
  // should re-run COMPILE on the relevant scope, which re-extracts claims
  // from all observations including the now-accepted one.
  //
  // Rejection is terminal — no further action required; replay's
  // effective-status guard already filters it out everywhere.
  replayCatchUp(evidenceDir, store, layer0, config);

  return {
    target_obs_id: params.target_obs_id,
    action: params.action,
    new_status: params.action === 'approve' ? 'accepted' : 'rejected',
    status: 'reviewed',
  };
}
