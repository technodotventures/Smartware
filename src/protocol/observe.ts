// Protocol — OBSERVE handler (nine-step state machine)

import type { Observation, Actor } from '../layer0/types.js';
import { appendObservation, readAll } from '../layer0/log.js';
import { assignIntegrity } from '../layer0/integrity.js';
import { checkIdempotency, checkLegacySourceDedup, computePayloadHash } from '../layer0/idempotency.js';
import { detectSecrets } from '../layer0/secrets.js';
import type { Layer0Index } from '../layer0/index.js';
import type { SmartwareConfig } from '../config.js';
import { resolveRetention, toRetentionDurationString } from '../config.js';
import { requireGrant, ProtocolError } from '../auth/middleware.js';
import { quarantineForGrants } from '../auth/trust.js';
import { isOwner, getAuthorizingGrants } from '../auth/grants.js';
import type { SessionStore } from '../session/store.js';
import { requireSessionCapability, resolveActorFromSession } from './session.js';
import {
  appendOpLogEntry,
  OPERATION_ID_PATTERN,
  readAllOpLogEntries,
  readOperationIntent,
  persistOperationIntent,
  removeOperationIntent,
  runRecovery,
  type ObservationOperationIntent,
} from '../ops_log/index.js';
import { checkAttachmentSafety } from '../layer0/attachment_safety.js';
import { SMARTWARE_VERSION } from '../version.js';

export interface ObserveParams {
  actor: Actor;
  type: Observation['type'];
  content: Observation['content'];
  scope: string;
  visibility?: Observation['visibility'];
  source_id?: string | null;
  app?: string;
  app_version?: string;
  observed_at?: string;
  parent_ids?: string[];
  informed_by?: string[];
  sensitive?: boolean;
  pii_detected?: boolean;
  retention?: Observation['policy']['retention'];
  /** ISO 8601 duration (e.g. "P90D"). When omitted, derived from scope retention policy. */
  retention_duration?: string | null;
  /** @deprecated Rejected in v1.6.16. OBSERVE writes L0 only; claim extraction is reflect.auto's job. */
  claims?: Observation['claims'];
  idempotency_key?: string;
  /** If provided, actor_id is resolved from the session (server-enforced identity) */
  session_id?: string;
  /**
   * Spec-conformant OperationId per Protocol Contract v0.4.1 (PR-21).
   * When supplied AND opsDir is configured on handleObserve, an ops-log
   * entry is appended after the L0 write — the durable commit signal
   * per A0 atomicity strategy.
   */
  operation_id?: string;
}

export interface ObserveResult {
  id: string;
  status: 'accepted' | 'quarantined' | 'duplicate' | 'rejected';
  existing_id?: string;
  sequence: number;
}

/** Synchronous fault hooks used by crash-boundary conformance tests. */
export interface ObserveCommitHooks {
  afterIntent?: (intent: ObservationOperationIntent) => void;
  afterObservation?: (observation: Observation) => void;
  afterCommit?: () => void;
}

function observePayload(
  params: ObserveParams,
  retention: Observation['policy']['retention'],
  retentionDuration: string | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    actor_id: params.actor.id,
    type: params.type,
    scope: params.scope,
    visibility: params.visibility ?? 'scope',
    source_id: params.source_id ?? null,
    app: params.app ?? 'mcp-client',
    app_version: params.app_version ?? SMARTWARE_VERSION,
    observed_at: params.observed_at ?? null,
    parent_ids: params.parent_ids ?? [],
    informed_by: params.informed_by ?? [],
    sensitive: params.sensitive ?? false,
    pii_detected: params.pii_detected ?? false,
    retention,
    idempotency_key: params.idempotency_key ?? null,
    content: params.content,
    claims: params.claims ?? [],
  };
  // Only emit retention_duration when non-null so the default `forever` payload
  // (and thus its observation id) is byte-identical to pre-retention builds.
  if (retentionDuration != null) payload['retention_duration'] = retentionDuration;
  return payload;
}

export async function handleObserve(
  params: ObserveParams,
  evidenceDir: string,
  layer0: Layer0Index,
  config: SmartwareConfig,
  sessionStore?: SessionStore,
  opsDir?: string,
  commitHooks?: ObserveCommitHooks,
): Promise<ObserveResult> {
  const now = new Date().toISOString();

  if (params.session_id && sessionStore) {
    const resolved = resolveActorFromSession(params.session_id, sessionStore);
    if (resolved) {
      params.actor = { ...params.actor, id: resolved.actor_id };
      if (resolved.effective_policy.write_mode === 'off') {
        throw new ProtocolError('write_disabled', 'Session policy does not allow writes');
      }
      requireSessionCapability(resolved, 'observe', params.scope);
    }
  }

  if (params.claims && params.claims.length > 0) {
    throw new ProtocolError('invalid_parameter', 'OBSERVE writes L0 only. Pre-extracted claims are not accepted; use reflect.auto for claim synthesis.');
  }

  if (!params.content?.body) {
    throw new ProtocolError('invalid_content', 'Observation content body is required');
  }
  if (!params.scope) {
    throw new ProtocolError('invalid_scope', 'Scope is required');
  }

  if (params.type === 'file' || (params.content.format as string) === 'application/octet-stream') {
    const filename = (typeof params.content.body === 'object' && params.content.body !== null && 'filename' in params.content.body)
      ? String((params.content.body as Record<string, unknown>).filename)
      : 'unknown';
    const size = (typeof params.content.body === 'object' && params.content.body !== null && 'size' in params.content.body)
      ? Number((params.content.body as Record<string, unknown>).size)
      : 0;
    const check = checkAttachmentSafety(filename, size);
    if (!check.allowed) {
      throw new ProtocolError('attachment_rejected', check.reason ?? 'Attachment rejected by safety check');
    }
  }

  const bodyText = typeof params.content.body === 'string'
    ? params.content.body
    : JSON.stringify(params.content.body);

  const secretCheck = detectSecrets(bodyText);
  if (secretCheck.detected) {
    throw new ProtocolError(
      'secret_detected',
      `Observation rejected: secret detected (${secretCheck.type}) at ${secretCheck.location}. Remove credentials before storing.`,
    );
  }

  requireGrant(params.actor.id, 'observe', params.scope, config);

  // Resolve retention once, before the payload hash, so the derived policy +
  // duration are part of the canonical observation (id + idempotency) exactly as
  // written. Explicit param wins; otherwise scope override → default → `forever`.
  const retentionSetting = resolveRetention(config, params.scope);
  const retention: Observation['policy']['retention'] = params.retention ?? retentionSetting.policy;
  const retentionDuration: string | null = params.retention_duration !== undefined
    ? params.retention_duration
    : (retention === 'duration' ? toRetentionDurationString(retentionSetting) : null);

  const payloadHash = computePayloadHash(observePayload(params, retention, retentionDuration));
  if (params.operation_id && !OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }
  if (params.operation_id && !opsDir) {
    throw new ProtocolError('invalid_parameter', 'operation_id requires an operations directory');
  }
  const operationId = params.operation_id;
  const operationActorId = params.actor.id.startsWith('user:')
    || params.actor.id.startsWith('agent:')
    || params.actor.id.startsWith('sidecar:')
    || params.actor.id.startsWith('substrate:')
    ? params.actor.id
    : `agent:${params.actor.id}`;

  const committedResult = (): ObserveResult | null => {
    if (!operationId || !opsDir) return null;
    const entries = [...readAllOpLogEntries(opsDir)]
      .filter(entry => entry.operation_id === operationId);
    if (entries.length === 0) return null;
    const exact = entries.find(entry =>
      entry.op === 'observe'
      && entry.actor_id === operationActorId
      && entry.details?.['payload_hash'] === payloadHash);
    if (!exact) {
      throw new ProtocolError('conflict', `operation_id '${operationId}' was already used with a different payload`);
    }
    const id = exact.details?.['observation_id'];
    const status = exact.details?.['status'];
    const sequence = exact.details?.['sequence'];
    if (typeof id !== 'string'
      || (status !== 'accepted' && status !== 'quarantined')
      || typeof sequence !== 'number') {
      throw new ProtocolError('conflict', `operation_id '${operationId}' has no replayable OBSERVE result`);
    }
    return { id, status, sequence };
  };

  const priorCommit = committedResult();
  if (priorCommit) return priorCommit;

  if (operationId && opsDir) {
    const existingIntent = readOperationIntent(opsDir, operationId);
    if (existingIntent) {
      if (existingIntent.op !== 'observe'
        || existingIntent.actor_id !== operationActorId
        || existingIntent.payload_hash !== payloadHash) {
        throw new ProtocolError('conflict', `operation_id '${operationId}' was already prepared with a different payload`);
      }
      runRecovery({
        opsDir,
        evidenceDir,
        quarantineDir: '',
      });
      const recoveredCommit = committedResult();
      if (recoveredCommit) return recoveredCommit;
      const artifacts = [...readAll(evidenceDir)].filter(observation => observation.operation_id === operationId);
      if (artifacts.length > 0) {
        throw new ProtocolError('conflict', `operation_id '${operationId}' requires manual recovery review`);
      }
    }
  }

  const idempotency = checkIdempotency(layer0, params.actor.id, params.idempotency_key, payloadHash);
  if (idempotency.kind === 'duplicate') {
    return { id: idempotency.existingId, status: 'duplicate', existing_id: idempotency.existingId, sequence: 0 };
  }
  if (idempotency.kind === 'conflict') {
    throw new ProtocolError('idempotency_conflict', `Idempotency key '${params.idempotency_key}' was already used with a different payload`);
  }

  const app = params.app ?? 'mcp-client';
  if (!params.idempotency_key && params.source_id) {
    const dedup = checkLegacySourceDedup(layer0, app, params.source_id);
    if (dedup.isDuplicate && dedup.existingId) {
      return { id: dedup.existingId, status: 'duplicate', existing_id: dedup.existingId, sequence: 0 };
    }
  }

  // Trust/quarantine is decided from the grant(s) that authorise THIS observe
  // on THIS scope — not an arbitrary first grant that might trust a different scope.
  const authGrants = getAuthorizingGrants(params.actor.id, 'observe', params.scope, config);
  const quarantine = isOwner(params.actor.id, config) ? false : quarantineForGrants(authGrants);
  const observationId = `obs_${payloadHash}`;
  if (layer0.getEffectiveStatus(observationId) !== null) {
    const existing = layer0.getDB().prepare(
      'SELECT sequence FROM observations WHERE id = ?',
    ).get(observationId) as { sequence: number } | undefined;
    return {
      id: observationId,
      status: 'duplicate',
      existing_id: observationId,
      sequence: existing?.sequence ?? 0,
    };
  }

  const seq = layer0.getLastSequence() + 1;
  const prevHash = layer0.getLatestHashForWriter(config.writer_id);

  const obs: Observation = {
    id: observationId,
    version: SMARTWARE_VERSION,
    ...(operationId ? { operation_id: operationId, actor_id: operationActorId } : {}),
    type: params.type,
    status: quarantine ? 'quarantined' : 'accepted',
    source: {
      app,
      app_version: params.app_version ?? SMARTWARE_VERSION,
      source_id: params.source_id ?? null,
      actor: params.actor,
      captured_at: now,
      observed_at: params.observed_at ?? now,
    },
    scope: params.scope,
    visibility: params.visibility ?? 'scope',
    content: params.content,
    claims: params.claims,
    provenance: {
      parent_ids: params.parent_ids ?? [],
      informed_by: params.informed_by ?? [],
      supersedes: [],
      context: '',
    },
    idempotency: params.idempotency_key
      ? {
          actor_id: params.actor.id,
          key: params.idempotency_key,
          payload_hash: payloadHash,
        }
      : null,
    policy: {
      retention,
      retention_duration: retentionDuration,
      sensitive: params.sensitive ?? false,
      pii_detected: params.pii_detected ?? false,
    },
    integrity: {
      hash: '',
      writer_id: config.writer_id,
      sequence: seq,
      previous_hash: prevHash,
    },
  };

  const withIntegrity = assignIntegrity(obs, config.writer_id, seq, prevHash);
  const intent: ObservationOperationIntent | null = operationId && opsDir
    ? {
        version: 1,
        operation_id: operationId,
        actor_id: operationActorId,
        op: 'observe',
        payload_hash: payloadHash,
        prepared_at: now,
        expected: {
          surface: 'l0',
          observation_id: withIntegrity.id,
          observation_hash: withIntegrity.integrity.hash,
          sequence: withIntegrity.integrity.sequence,
        },
        result: {
          id: withIntegrity.id,
          status: withIntegrity.status,
          sequence: withIntegrity.integrity.sequence,
        },
        details: {
          scope: params.scope,
          source: params.app ?? 'mcp-client',
        },
      }
    : null;
  if (intent && opsDir) {
    persistOperationIntent(opsDir, intent, true);
    commitHooks?.afterIntent?.(intent);
  }
  appendObservation(evidenceDir, withIntegrity);
  layer0.insertOrSkip(withIntegrity);
  commitHooks?.afterObservation?.(withIntegrity);

  // The ops-log entry is the durable commit signal. A process interruption
  // after L0 can be finalized only when the persisted intent matches the
  // artifact identity, payload hash, integrity hash, and chain position.
  if (opsDir && operationId) {
    appendOpLogEntry(opsDir, {
      operation_id: operationId,
      actor_id: operationActorId,
      timestamp: now,
      op: 'observe',
      details: {
        payload_hash: payloadHash,
        observation_id: withIntegrity.id,
        scope: params.scope,
        source: params.app ?? 'mcp-client',
        status: withIntegrity.status,
        sequence: withIntegrity.integrity.sequence,
      },
    });
    commitHooks?.afterCommit?.();
    removeOperationIntent(opsDir, operationId);
  }

  return {
    id: withIntegrity.id,
    status: withIntegrity.status,
    sequence: withIntegrity.integrity.sequence,
  };
}
