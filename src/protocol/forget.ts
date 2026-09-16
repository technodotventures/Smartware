// Protocol — FORGET handler (typed targets + tombstone/redaction)

import { ulid } from 'ulid';

import type { Observation, Actor } from '../layer0/types.js';
import { appendObservation, readAll } from '../layer0/log.js';
import { assignIntegrity, computeHash } from '../layer0/integrity.js';
import { computePayloadHash } from '../layer0/idempotency.js';
import type { Layer0Index } from '../layer0/index.js';
import type { ClaimStore } from '../layer1/store.js';
import { POD_SELF_SCOPE, type SmartwareConfig } from '../config.js';
import { replayCatchUp } from '../layer1/replay.js';
import { requireGrant, requireRegisteredActor, ProtocolError } from '../auth/middleware.js';
import { TERMINAL_STATES } from '../layer0/types.js';
import {
  readLatestVersion,
  snapshotAt,
  appendClaimVersion,
  carryDemotion,
  readClaimHistory,
  type ActiveClaimVersion,
  type ForgottenClaimVersion,
} from '../layer1/jsonl.js';
import { revalidateOnRevive } from '../layer1/effective_current.js';
import {
  appendOpLogEntry,
  OPERATION_ID_PATTERN,
  persistOperationIntent,
  readAllOpLogEntries,
  readOperationIntent,
  removeOperationIntent,
  runRecovery,
  type CommitContext,
  type ForgetOperationIntent,
  type ReviveOperationIntent,
} from '../ops_log/index.js';
import { SMARTWARE_VERSION } from '../version.js';

export type ForgetMode = 'tombstone' | 'delete_object' | 'redact_if_supported';
export type ForgetTarget =
  | { type: 'observation'; id: string }
  | { type: 'claim'; id: string };

export interface ForgetParams {
  actor: Actor;
  target?: ForgetTarget;
  target_obs_id?: string;
  target_claim_id?: string;
  mode: ForgetMode;
  reason?: string;
  redaction_reason?: 'sensitive' | 'requested_by_user' | 'extraction_error' | 'policy_violation';
  operation_id?: string;
}

export interface ForgetCommitHooks {
  afterIntent?: (intent: ForgetOperationIntent) => void;
  afterAuditObservation?: (observation: Observation) => void;
  afterClaimVersion?: (record: ForgottenClaimVersion) => void;
  afterCommit?: () => void;
}

export interface ForgetResult {
  target_id: string;
  target_kind: ForgetTarget['type'];
  mode: ForgetMode;
  claims_retracted: number;
  claims_reduced: number;
  audit_observation_id: string;
  status: 'forgotten';
}

function normaliseTarget(params: ForgetParams): ForgetTarget {
  if (params.target) return params.target;
  if (params.target_obs_id) return { type: 'observation', id: params.target_obs_id };
  if (params.target_claim_id) return { type: 'claim', id: params.target_claim_id };
  throw new ProtocolError('invalid_target', 'A FORGET target is required');
}

function forgetPayload(params: ForgetParams, target: ForgetTarget): Record<string, unknown> {
  return {
    actor_id: params.actor.id,
    target,
    mode: params.mode,
    reason: params.reason ?? '',
    redaction_reason: params.redaction_reason ?? null,
  };
}

export async function handleForget(
  params: ForgetParams,
  evidenceDir: string,
  layer0: Layer0Index,
  store: ClaimStore,
  config: SmartwareConfig,
  commitCtx?: CommitContext,
  commitHooks?: ForgetCommitHooks,
): Promise<ForgetResult> {
  const target = normaliseTarget(params);
  const actorIsUser = params.actor.id.startsWith('user:') || params.actor.id.startsWith('person_');

  if (params.mode === 'delete_object') {
    throw new ProtocolError('invalid_mode', 'delete_object is not valid for Smartware observations or claims');
  }

  if (params.operation_id && !OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }
  if (params.operation_id && !commitCtx) {
    throw new ProtocolError('invalid_parameter', 'operation_id requires an operations directory');
  }

  const payloadHash = computePayloadHash(forgetPayload(params, target));
  const storeDataDir = store.getDataDir();
  const committedResult = (): ForgetResult | null => {
    if (!params.operation_id || !commitCtx) return null;
    const entries = [...readAllOpLogEntries(commitCtx.opsDir)]
      .filter(entry => entry.operation_id === params.operation_id);
    if (entries.length === 0) return null;
    const exact = entries.find(entry =>
      entry.op === 'forget'
      && entry.actor_id === params.actor.id
      && entry.details?.['payload_hash'] === payloadHash);
    if (!exact) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already used with a different payload`);
    }
    const auditId = exact.details?.['audit_observation_id'];
    const observationHash = exact.details?.['observation_hash'];
    const targetId = exact.details?.['target_id'];
    const targetKind = exact.details?.['target_kind'];
    const mode = exact.details?.['mode'];
    const claimsRetracted = exact.details?.['claims_retracted'];
    const claimsReduced = exact.details?.['claims_reduced'];
    if (typeof auditId !== 'string'
      || typeof observationHash !== 'string'
      || typeof targetId !== 'string'
      || (targetKind !== 'observation' && targetKind !== 'claim')
      || (mode !== 'tombstone' && mode !== 'redact_if_supported')
      || typeof claimsRetracted !== 'number'
      || typeof claimsReduced !== 'number') {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' has no replayable FORGET result`);
    }
    const audits = [...readAll(evidenceDir)]
      .filter(observation => observation.operation_id === params.operation_id);
    if (audits.length !== 1 || audits[0]!.id !== auditId || computeHash(audits[0]!) !== observationHash) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
    }
    const claimRecordHash = exact.details?.['claim_record_hash'];
    if (targetKind === 'claim') {
      if (!storeDataDir || typeof claimRecordHash !== 'string') {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' has no replayable FORGET claim result`);
      }
      const versions = readClaimHistory(storeDataDir, targetId)
        .filter(version => version.operation_id === params.operation_id);
      if (versions.length !== 1 || computePayloadHash(versions[0]) !== claimRecordHash) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
      }
      store.syncFromJsonlVersion(versions[0]!);
    }
    return {
      target_id: targetId,
      target_kind: targetKind,
      mode,
      claims_retracted: claimsRetracted,
      claims_reduced: claimsReduced,
      audit_observation_id: auditId,
      status: 'forgotten',
    };
  };

  const priorCommit = committedResult();
  if (priorCommit) return priorCommit;

  let existingIntent: ForgetOperationIntent | null = null;
  let existingAudit: Observation | null = null;
  if (params.operation_id && commitCtx) {
    const prepared = readOperationIntent(commitCtx.opsDir, params.operation_id);
    if (prepared) {
      if (prepared.op !== 'forget'
        || prepared.actor_id !== params.actor.id
        || prepared.payload_hash !== payloadHash) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already prepared with a different payload`);
      }
      existingIntent = prepared;
      const recovery = runRecovery({
        opsDir: commitCtx.opsDir,
        evidenceDir,
        ...(storeDataDir ? { claimsDir: storeDataDir } : {}),
        quarantineDir: '',
      });
      const recovered = committedResult();
      if (recovered) return recovered;
      if (recovery.requiresManualReview.includes(params.operation_id)) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
      }
      const audits = [...readAll(evidenceDir)]
        .filter(observation => observation.operation_id === params.operation_id);
      existingAudit = audits[0] ?? null;
    }
  }

  let scope: string;
  if (target.type === 'observation') {
    const effectiveStatus = layer0.getEffectiveStatus(target.id);
    if (effectiveStatus === null) {
      throw new ProtocolError('not_found', `Observation '${target.id}' not found`);
    }
    if (TERMINAL_STATES.has(effectiveStatus) && !existingIntent) {
      throw new ProtocolError('terminal_state', `Observation '${target.id}' is already in terminal state '${effectiveStatus}'`);
    }
    const obsRow = layer0.getDB().prepare('SELECT scope FROM observations WHERE id = ?').get(target.id) as { scope: string } | undefined;
    // A missing index row cannot happen on the path above (the effective-status
    // lookup throws `not_found` first, and `observations.scope` is NOT NULL);
    // if it ever did, fall back to the pod's own lane rather than the pre-fix
    // literal `personal` (kanban t_e6fce49a).
    scope = obsRow?.scope ?? POD_SELF_SCOPE;
  } else {
    const claim = store.getClaim(target.id);
    if (!claim) {
      throw new ProtocolError('claim_not_found', `Claim '${target.id}' not found`);
    }
    const dataDir = store.getDataDir();
    const canonical = dataDir ? readLatestVersion(dataDir, target.id) : null;
    const author = canonical?.author ?? claim.author ?? 'agent';
    const epistemicOwner = canonical?.epistemic_owner ?? claim.epistemic_owner ?? author;
    if (!actorIsUser && (author === 'user' || epistemicOwner === 'user')) {
      throw new ProtocolError('protected_claim', 'Only a user may forget a protected claim');
    }
    scope = claim.scope;
  }

  requireGrant(params.actor.id, 'forget', scope, config);

  const impactedClaims = store.getAllClaims().filter(claim =>
    claim.status !== 'retracted'
    && (target.type === 'claim'
      ? claim.id === target.id
      : claim.supporting_evidence.includes(target.id)
        || claim.source_event_id === target.id
        || claim.extraction_event_id === target.id));
  const plannedClaimsRetracted = existingIntent?.result.claims_retracted ?? (
    target.type === 'claim'
      ? (params.mode === 'tombstone' && impactedClaims.length > 0 ? 1 : 0)
      : impactedClaims.filter(claim => claim.supporting_evidence.filter(id => id !== target.id).length === 0).length
  );
  const plannedClaimsReduced = existingIntent?.result.claims_reduced ?? (
    target.type === 'observation'
      ? impactedClaims.filter(claim =>
        claim.supporting_evidence.includes(target.id)
        && claim.supporting_evidence.filter(id => id !== target.id).length > 0).length
      : 0
  );
  const now = existingIntent?.prepared_at ?? new Date().toISOString();
  const seq = existingIntent?.expected.audit.sequence ?? layer0.getLastSequence() + 1;
  const prevHash = layer0.getLatestHashForWriter(config.writer_id);
  const eventType = params.mode === 'redact_if_supported' ? 'redaction' : 'tombstone';

  const mutationObs: Observation = {
    id: existingIntent?.expected.audit.observation_id ?? `obs_${computePayloadHash({
      type: eventType,
      actor_id: params.actor.id,
      target,
      mode: params.mode,
      operation_id: params.operation_id ?? null,
      sequence: seq,
      observed_at: now,
    })}`,
    version: SMARTWARE_VERSION,
    ...(params.operation_id ? { operation_id: params.operation_id, actor_id: params.actor.id } : {}),
    type: eventType,
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
        target_id: target.id,
        target_kind: target.type,
        mode: params.mode,
        reason: params.reason ?? '',
        redaction_reason: params.redaction_reason ?? null,
      },
    },
    provenance: { parent_ids: [target.id], supersedes: [], context: params.mode },
    idempotency: null,
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: config.writer_id, sequence: seq, previous_hash: prevHash },
  };

  const withIntegrity = existingAudit
    ?? assignIntegrity(mutationObs, config.writer_id, seq, prevHash);
  let forgottenVersion: ForgottenClaimVersion | null = null;
  if (target.type === 'claim' && storeDataDir) {
    const latest = readLatestVersion(storeDataDir, target.id);
    if (latest && latest.state === 'active') {
      // Spec §11: the forgotten version carries forward all non-content metadata. A mechanical
      // demotion is non-content metadata about this claim (ADR-0003), so it is carried — the
      // tombstone must not read as an event that lifts a duplicate back into recall.
      forgottenVersion = carryDemotion({
        claim_id: latest.claim_id,
        version: latest.version + 1,
        state: 'forgotten',
        tombstone_id: `tomb_${latest.claim_id.slice(6)}`,
        forgotten_at: now,
        forgotten_by: params.actor.id,
        claim_type: latest.claim_type,
        claim_role: latest.claim_role,
        author: latest.author,
        epistemic_owner: latest.epistemic_owner,
        fingerprint: latest.fingerprint,
        confidence: latest.confidence,
        epistemic_tag: latest.epistemic_tag,
        scope: latest.scope,
        derived_from: latest.derived_from,
        relations: latest.relations,
        created_at: latest.created_at,
        version_at: now,
        operation_id: params.operation_id ?? `op_${ulid()}`,
        actor_id: params.actor.id,
        tags: latest.tags,
        supersedes: latest.version,
        endorsement_source: latest.endorsement_source,
      }, latest);
    }
  }

  let intent: ForgetOperationIntent | null = null;
  if (params.operation_id && commitCtx) {
    const claimRecordHash = forgottenVersion ? computePayloadHash(forgottenVersion) : undefined;
    intent = {
      version: 1,
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      op: 'forget',
      payload_hash: payloadHash,
      prepared_at: now,
      expected: {
        surface: 'forget',
        audit: {
          observation_id: withIntegrity.id,
          observation_hash: withIntegrity.integrity.hash,
          sequence: withIntegrity.integrity.sequence,
        },
        ...(forgottenVersion ? {
          claim_version: {
            claim_id: forgottenVersion.claim_id,
            version: forgottenVersion.version,
            record_hash: claimRecordHash!,
          },
        } : {}),
      },
      result: {
        target_id: target.id,
        target_kind: target.type,
        mode: params.mode,
        claims_retracted: plannedClaimsRetracted,
        claims_reduced: plannedClaimsReduced,
        audit_observation_id: withIntegrity.id,
        status: 'forgotten',
      },
      details: { target_id: target.id, target_kind: target.type, mode: params.mode },
    };
    if (existingIntent && JSON.stringify(existingIntent.expected) !== JSON.stringify(intent.expected)) {
      const surface = JSON.stringify(existingIntent.expected.audit) === JSON.stringify(intent.expected.audit)
        ? 'claim version'
        : 'audit observation';
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' no longer matches its prepared FORGET ${surface}`);
    }
    persistOperationIntent(commitCtx.opsDir, intent, true);
    commitHooks?.afterIntent?.(intent);
  }

  if (!existingAudit) {
    appendObservation(evidenceDir, withIntegrity);
    layer0.insertOrSkip(withIntegrity);
    if (target.type === 'observation') layer0.applyMutationEvent(withIntegrity);
    commitHooks?.afterAuditObservation?.(withIntegrity);
  }
  if (forgottenVersion && storeDataDir) {
    appendClaimVersion(storeDataDir, forgottenVersion);
    store.syncFromJsonlVersion(forgottenVersion);
    commitHooks?.afterClaimVersion?.(forgottenVersion);
  }
  await replayCatchUp(evidenceDir, store, layer0, config);

  if (params.operation_id && commitCtx && intent) {
    appendOpLogEntry(commitCtx.opsDir, {
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      timestamp: now,
      op: 'forget',
      details: {
        payload_hash: payloadHash,
        audit_observation_id: intent.result.audit_observation_id,
        observation_hash: intent.expected.audit.observation_hash,
        claim_record_hash: intent.expected.claim_version?.record_hash,
        target_id: intent.result.target_id,
        target_kind: intent.result.target_kind,
        mode: intent.result.mode,
        claims_retracted: intent.result.claims_retracted,
        claims_reduced: intent.result.claims_reduced,
      },
    });
    commitHooks?.afterCommit?.();
    removeOperationIntent(commitCtx.opsDir, params.operation_id);
  }

  return {
    target_id: target.id,
    target_kind: target.type,
    mode: params.mode,
    claims_retracted: plannedClaimsRetracted,
    claims_reduced: plannedClaimsReduced,
    audit_observation_id: withIntegrity.id,
    status: 'forgotten',
  };
}

export interface ReviveParams {
  actor: Actor;
  tombstone_id: string;
  reason: string;
  operation_id: string;
}

export interface ReviveResult {
  claim_id: string;
  new_version: number;
  operation_id: string;
  invalidated_edges: string[];
  status: 'revived';
}

export interface ReviveCommitHooks {
  afterIntent?: (intent: ReviveOperationIntent) => void;
  afterClaimVersion?: (record: ActiveClaimVersion) => void;
  afterCommit?: () => void;
}

function revivePayload(params: ReviveParams): Record<string, unknown> {
  return {
    actor_id: params.actor.id,
    tombstone_id: params.tombstone_id,
    reason: params.reason,
  };
}

export async function handleRevive(
  params: ReviveParams,
  dataDir: string,
  store: ClaimStore,
  config: SmartwareConfig,
  commitCtx?: CommitContext,
  db?: import('better-sqlite3').Database,
  commitHooks?: ReviveCommitHooks,
): Promise<ReviveResult> {
  const isUser = params.actor.id.startsWith('user:') || params.actor.id.startsWith('person_');
  if (!isUser) {
    throw new ProtocolError('user_required', 'REVIVE is user-only in beta');
  }
  requireRegisteredActor(params.actor.id, config);
  if (!OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }

  const payloadHash = computePayloadHash(revivePayload(params));
  const committedResult = (): ReviveResult | null => {
    if (!commitCtx) return null;
    const entries = [...readAllOpLogEntries(commitCtx.opsDir)]
      .filter(entry => entry.operation_id === params.operation_id);
    if (entries.length === 0) return null;
    const exact = entries.find(entry =>
      entry.op === 'revive'
      && entry.actor_id === params.actor.id
      && entry.details?.['payload_hash'] === payloadHash);
    if (!exact) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already used with a different payload`);
    }
    const claimId = exact.details?.['claim_id'];
    const newVersion = exact.details?.['new_version'];
    const invalidatedEdges = exact.details?.['invalidated_edges'];
    const recordHash = exact.details?.['record_hash'];
    if (typeof claimId !== 'string'
      || typeof newVersion !== 'number'
      || !Array.isArray(invalidatedEdges)
      || !invalidatedEdges.every(relationId => typeof relationId === 'string')
      || typeof recordHash !== 'string') {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' has no replayable REVIVE result`);
    }
    const artifacts = readClaimHistory(dataDir, claimId)
      .filter(version => version.operation_id === params.operation_id);
    if (artifacts.length !== 1
      || artifacts[0]!.version !== newVersion
      || computePayloadHash(artifacts[0]) !== recordHash) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
    }
    store.syncFromJsonlVersion(artifacts[0]!);
    return {
      claim_id: claimId,
      new_version: newVersion,
      operation_id: params.operation_id,
      invalidated_edges: invalidatedEdges,
      status: 'revived',
    };
  };

  const priorCommit = committedResult();
  if (priorCommit) return priorCommit;

  let existingIntent: ReviveOperationIntent | null = null;
  if (commitCtx) {
    const prepared = readOperationIntent(commitCtx.opsDir, params.operation_id);
    if (prepared) {
      if (prepared.op !== 'revive'
        || prepared.actor_id !== params.actor.id
        || prepared.payload_hash !== payloadHash) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already prepared with a different payload`);
      }
      existingIntent = prepared;
      const recovery = runRecovery({
        opsDir: commitCtx.opsDir,
        evidenceDir: '',
        claimsDir: dataDir,
        quarantineDir: '',
      });
      const recovered = committedResult();
      if (recovered) return recovered;
      if (recovery.requiresManualReview.includes(params.operation_id)) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
      }
    }
  }

  const claimId = params.tombstone_id.replace(/^tomb_/, 'claim_');
  const history = readClaimHistory(dataDir, claimId);
  if (history.length === 0) {
    throw new ProtocolError('claim_not_found', `No claim found for tombstone '${params.tombstone_id}'`);
  }

  const latest = history[history.length - 1]!;
  if (latest.state !== 'forgotten') {
    throw new ProtocolError('not_forgotten', `Claim '${claimId}' is not forgotten`);
  }

  const lastActive = [...history].reverse().find(v => v.state === 'active') as ActiveClaimVersion | undefined;
  if (!lastActive) {
    throw new ProtocolError('no_active_snapshot', `No active snapshot found for '${claimId}'`);
  }

  if (lastActive.author === 'user' || lastActive.epistemic_owner === 'user') {
    if (!isUser) {
      throw new ProtocolError('protected_revival', 'Cannot revive a protected claim — user authorization required');
    }
  }

  const newVersion = latest.version + 1;
  const preparedAt = existingIntent?.prepared_at ?? new Date().toISOString();
  let invalidatedEdges: string[] = [];

  if (db) {
    const validation = revalidateOnRevive(claimId, db);
    invalidatedEdges = validation.invalidated;
  }

  const relations = lastActive.relations.map(r => {
    if (invalidatedEdges.includes(r.relation_id)) {
      return { ...r, invalid_at: preparedAt };
    }
    return r;
  });

  const revived: ActiveClaimVersion = carryDemotion({
    claim_id: claimId,
    version: newVersion,
    state: 'active',
    content: lastActive.content,
    claim_type: lastActive.claim_type,
    claim_role: lastActive.claim_role,
    author: lastActive.author,
    epistemic_owner: lastActive.epistemic_owner,
    fingerprint: lastActive.fingerprint,
    confidence: lastActive.confidence,
    epistemic_tag: lastActive.epistemic_tag,
    scope: lastActive.scope,
    derived_from: lastActive.derived_from,
    relations,
    created_at: lastActive.created_at,
    version_at: preparedAt,
    operation_id: params.operation_id,
    actor_id: params.actor.id,
    tags: lastActive.tags,
    supersedes: latest.version,
    revived_via: params.tombstone_id,
    endorsement_source: lastActive.endorsement_source,
    semantic: lastActive.semantic,
  }, lastActive);

  if (commitCtx) {
    const recordHash = computePayloadHash(revived);
    const intent: ReviveOperationIntent = {
      version: 1,
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      op: 'revive',
      payload_hash: payloadHash,
      prepared_at: preparedAt,
      expected: {
        surface: 'l1',
        claim_id: revived.claim_id,
        version: revived.version,
        record_hash: recordHash,
      },
      result: {
        claim_id: revived.claim_id,
        new_version: revived.version,
        operation_id: params.operation_id,
        invalidated_edges: invalidatedEdges,
        status: 'revived',
      },
      details: { claim_id: revived.claim_id, tombstone_id: params.tombstone_id },
    };
    if (existingIntent && existingIntent.expected.record_hash !== recordHash) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' no longer matches its prepared REVIVE artifact`);
    }
    persistOperationIntent(commitCtx.opsDir, intent, true);
    commitHooks?.afterIntent?.(intent);
    appendClaimVersion(dataDir, revived);
    commitHooks?.afterClaimVersion?.(revived);
    appendOpLogEntry(commitCtx.opsDir, {
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      timestamp: preparedAt,
      op: 'revive',
      details: {
        payload_hash: payloadHash,
        claim_id: revived.claim_id,
        new_version: revived.version,
        tombstone_id: params.tombstone_id,
        invalidated_edges: invalidatedEdges,
        record_hash: recordHash,
      },
    });
    commitHooks?.afterCommit?.();
    removeOperationIntent(commitCtx.opsDir, params.operation_id);
  } else {
    appendClaimVersion(dataDir, revived);
  }
  store.syncFromJsonlVersion(revived);

  return {
    claim_id: claimId,
    new_version: newVersion,
    operation_id: params.operation_id,
    invalidated_edges: invalidatedEdges,
    status: 'revived',
  };
}
