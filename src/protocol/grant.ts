// Protocol — GRANT handler (owner-only)

import type { Observation, Actor } from '../layer0/types.js';
import { appendObservation } from '../layer0/log.js';
import { assignIntegrity } from '../layer0/integrity.js';
import type { Layer0Index } from '../layer0/index.js';
import type { SmartwareConfig } from '../config.js';
import type { Grant } from '../auth/grants.js';
import { createGrant } from '../auth/grants.js';
import { requireOwner, ProtocolError } from '../auth/middleware.js';
import { SMARTWARE_VERSION } from '../version.js';
import { computePayloadHash } from '../layer0/idempotency.js';

export interface GrantParams {
  actor: Actor;
  grant_actor_id: string;
  grant_actor_type: 'person' | 'agent' | 'system';
  capabilities: Grant['capabilities'];
  trusted?: boolean;
  quarantine?: boolean;
  expires_at?: string | null;
}

export interface GrantResult {
  grant_id: string;
  status: 'granted';
}

export async function handleGrant(
  params: GrantParams,
  evidenceDir: string,
  layer0: Layer0Index,
  config: SmartwareConfig,
  dataDir: string,
): Promise<GrantResult> {
  requireOwner(params.actor.id, config);

  // Create the grant
  const grant = createGrant(dataDir, {
    actor_type: params.grant_actor_type,
    actor_id: params.grant_actor_id,
    capabilities: params.capabilities,
    trusted: params.trusted,
    quarantine: params.quarantine,
    expires_at: params.expires_at,
  });

  // Write consent_change event to Layer 0 for auditability
  const now = new Date().toISOString();
  const seq = layer0.getLastSequence() + 1;
  const prevHash = layer0.getLatestHashForWriter(config.writer_id);

  const consentObs: Observation = {
    id: `obs_${computePayloadHash({
      type: 'consent_change',
      action: 'grant',
      actor_id: params.actor.id,
      grant_id: grant.id,
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
      body: { action: 'grant', grant_id: grant.id, grant_actor_id: params.grant_actor_id },
    },
    provenance: { parent_ids: [], supersedes: [], context: 'grant' },
    policy: { retention: 'forever', retention_duration: null, sensitive: true, pii_detected: false },
    integrity: { hash: '', writer_id: config.writer_id, sequence: seq, previous_hash: prevHash },
  };

  const withIntegrity = assignIntegrity(consentObs, config.writer_id, seq, prevHash);
  appendObservation(evidenceDir, withIntegrity);
  layer0.insertOrSkip(withIntegrity);

  return { grant_id: grant.id, status: 'granted' };
}
