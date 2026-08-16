// Protocol — REVOKE handler (owner-only)

import type { Observation, Actor } from '../layer0/types.js';
import { appendObservation } from '../layer0/log.js';
import { assignIntegrity } from '../layer0/integrity.js';
import type { Layer0Index } from '../layer0/index.js';
import type { SmartwareConfig } from '../config.js';
import { revokeGrant } from '../auth/grants.js';
import { requireOwner, ProtocolError } from '../auth/middleware.js';
import { SMARTWARE_VERSION } from '../version.js';
import { computePayloadHash } from '../layer0/idempotency.js';

export interface RevokeParams {
  actor: Actor;
  grant_id: string;
  reason?: string;
}

export interface RevokeResult {
  grant_id: string;
  status: 'revoked';
}

export async function handleRevoke(
  params: RevokeParams,
  evidenceDir: string,
  layer0: Layer0Index,
  config: SmartwareConfig,
  dataDir: string,
): Promise<RevokeResult> {
  requireOwner(params.actor.id, config);

  const revoked = revokeGrant(dataDir, params.grant_id);
  if (!revoked) {
    throw new ProtocolError('grant_not_found', `Grant '${params.grant_id}' not found`);
  }

  // Write consent_change event to Layer 0 for auditability
  const now = new Date().toISOString();
  const seq = layer0.getLastSequence() + 1;
  const prevHash = layer0.getLatestHashForWriter(config.writer_id);

  const consentObs: Observation = {
    id: `obs_${computePayloadHash({
      type: 'consent_change',
      action: 'revoke',
      actor_id: params.actor.id,
      grant_id: params.grant_id,
      sequence: seq,
      observed_at: now,
    })}`,
    version: SMARTWARE_VERSION,
    type: 'consent_change',
    status: 'accepted',
    source: {
      app: 'smartware',
      app_version: SMARTWARE_VERSION,
      source_id: null,
      actor: params.actor,
      captured_at: now,
      observed_at: now,
    },
    scope: 'personal',
    visibility: 'private',
    content: {
      format: 'application/json',
      body: { action: 'revoke', grant_id: params.grant_id, reason: params.reason ?? '' },
    },
    provenance: { parent_ids: [], supersedes: [], context: 'revoke' },
    policy: { retention: 'forever', retention_duration: null, sensitive: true, pii_detected: false },
    integrity: { hash: '', writer_id: config.writer_id, sequence: seq, previous_hash: prevHash },
  };

  const withIntegrity = assignIntegrity(consentObs, config.writer_id, seq, prevHash);
  appendObservation(evidenceDir, withIntegrity);
  layer0.insertOrSkip(withIntegrity);

  return { grant_id: params.grant_id, status: 'revoked' };
}
