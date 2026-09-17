// Protocol — Retention lifecycle: expiry sweep (ADR-0001).
//
// The sweep is a host-triggered, naturally idempotent lifecycle operation: it
// tombstones observations whose retention duration has elapsed and retracts the
// claims derived solely from them. Recall/context already exclude terminal
// observations and forgotten claims, so no derived-index purge is required for
// correct exclusion — the indexes are regenerable projections.
//
// This is deliberately NOT a new protocol verb: it composes the existing
// tombstone + forget semantics with a `retention_expiry` reason, exactly like
// `drainCompileQueue` is a host concern over the existing compile primitives.

import type { Observation, Actor } from '../layer0/types.js';
import { appendObservation, readAll } from '../layer0/log.js';
import { assignIntegrity } from '../layer0/integrity.js';
import { computePayloadHash } from '../layer0/idempotency.js';
import type { Layer0Index } from '../layer0/index.js';
import type { ClaimStore } from '../layer1/store.js';
import type { SmartwareConfig } from '../config.js';
import { isScopeHeld, loadConfig } from '../config.js';
import { replayCatchUp } from '../layer1/replay.js';
import { requireGrant, ProtocolError } from '../auth/middleware.js';
import { readLatestVersion, appendClaimVersion, carryDemotion, type ForgottenClaimVersion } from '../layer1/jsonl.js';
import { appendCommittedOpLogEntry, appendOpLogEntry, OPERATION_ID_PATTERN, readAllOpLogEntries, type MutationFence } from '../ops_log/index.js';
import { SMARTWARE_VERSION } from '../version.js';

/** Parse the ISO 8601 "PnD" duration emitted by `toRetentionDurationString`. */
export function parseDurationDays(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const m = /^P(\d+)D$/.exec(duration);
  if (!m) return null;
  const days = Number.parseInt(m[1]!, 10);
  return Number.isFinite(days) && days > 0 ? days : null;
}

/** True when a `duration`-policy observation has elapsed relative to `asOf`. */
export function isRetentionExpired(obs: Observation, asOf: Date): boolean {
  if (obs.policy.retention !== 'duration') return false;
  const days = parseDurationDays(obs.policy.retention_duration);
  if (days == null) return false;
  const observedAt = new Date(obs.source.observed_at).getTime();
  if (Number.isNaN(observedAt)) return false;
  return observedAt + days * 86_400_000 <= asOf.getTime();
}

export interface ExpireRetentionParams {
  actor: Actor;
  scope: string;
  operation_id?: string;
  /** ISO 8601 instant to evaluate expiry against (default: now). */
  as_of?: string;
}

export interface ExpireRetentionResult {
  scope: string;
  observations_expired: number;
  claims_retracted: number;
  operation_id?: string;
  /** Set when the sweep was skipped by an open legal hold (ADR-0009). */
  skipped_reason?: 'legal_hold';
}

export interface RetentionDeps {
  evidenceDir: string;
  dataDir: string;
  layer0: Layer0Index;
  store: ClaimStore;
  config: SmartwareConfig;
  opsDir: string;
  /** Storage-level fencing (ADR-0010); absent = unfenced caller. */
  fence?: MutationFence | null;
}

function buildTombstoneMutation(
  target: Observation,
  params: ExpireRetentionParams,
  operationActorId: string,
  seq: number,
  prevHash: string | null,
  observedAt: string,
): Observation {
  const targetId = target.id;
  return {
    id: `obs_${computePayloadHash({
      type: 'tombstone',
      actor_id: operationActorId,
      target: { type: 'observation', id: targetId },
      mode: 'tombstone',
      reason: 'retention_expiry',
      operation_id: params.operation_id ?? null,
      sequence: seq,
      observed_at: observedAt,
    })}`,
    version: SMARTWARE_VERSION,
    ...(params.operation_id ? { operation_id: params.operation_id, actor_id: operationActorId } : {}),
    type: 'tombstone',
    status: 'accepted',
    source: {
      app: 'mcp-client',
      app_version: SMARTWARE_VERSION,
      source_id: null,
      actor: params.actor,
      captured_at: observedAt,
      observed_at: observedAt,
    },
    scope: params.scope,
    visibility: 'private',
    content: {
      format: 'application/json',
      body: {
        target_id: targetId,
        target_kind: 'observation',
        mode: 'tombstone',
        reason: 'retention_expiry',
        retention_duration: target.policy.retention_duration,
      },
    },
    provenance: { parent_ids: [targetId], supersedes: [], context: 'retention_expiry' },
    idempotency: null,
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: '', sequence: seq, previous_hash: prevHash },
  };
}

/** Expire elapsed observations in one scope: tombstone + retract sole-evidence claims. */
export async function handleExpireRetention(
  params: ExpireRetentionParams,
  deps: RetentionDeps,
): Promise<ExpireRetentionResult> {
  requireGrant(params.actor.id, 'forget', params.scope, deps.config);

  if (params.operation_id && !OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }

  const operationActorId = params.actor.id.startsWith('user:')
    || params.actor.id.startsWith('agent:')
    || params.actor.id.startsWith('sidecar:')
    || params.actor.id.startsWith('substrate:')
    ? params.actor.id
    : `agent:${params.actor.id}`;

  const asOf = params.as_of ? new Date(params.as_of) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    throw new ProtocolError('invalid_parameter', `Invalid as_of '${params.as_of}'`);
  }

  // Idempotency: a prior sweep with this operation_id is already recorded.
  if (params.operation_id) {
    const prior = [...readAllOpLogEntries(deps.opsDir)]
      .find(entry => entry.operation_id === params.operation_id && entry.op === 'retention.expire');
    if (prior) {
      return {
        scope: params.scope,
        observations_expired: Number(prior.details?.['observations_expired'] ?? 0),
        claims_retracted: Number(prior.details?.['claims_retracted'] ?? 0),
        operation_id: params.operation_id,
        ...(prior.details?.['skipped'] === 'legal_hold' ? { skipped_reason: 'legal_hold' as const } : {}),
      };
    }
  }

  const now = new Date().toISOString();

  // ── Legal hold (ADR-0009): expiry never fires under a hold. The skip is
  //    explicit and receipted — nothing is tombstoned, including evidence
  //    written into the scope after the hold opened. The hold state is read
  //    from disk (the hold lane writes config directly), and it is consulted
  //    after the operation_id replay above so a sweep that already committed
  //    still replays its recorded result.
  if (isScopeHeld(loadConfig(deps.dataDir), params.scope)) {
    if (params.operation_id) {
      appendCommittedOpLogEntry(deps.opsDir, {
        operation_id: params.operation_id,
        actor_id: operationActorId,
        timestamp: now,
        op: 'retention.expire',
        details: {
          scope: params.scope,
          observations_expired: 0,
          claims_retracted: 0,
          as_of: asOf.toISOString(),
          skipped: 'legal_hold',
        },
      });
    }
    return {
      scope: params.scope,
      observations_expired: 0,
      claims_retracted: 0,
      operation_id: params.operation_id,
      skipped_reason: 'legal_hold',
    };
  }

  const expired: Observation[] = [];
  for (const obs of readAll(deps.evidenceDir)) {
    if (obs.scope !== params.scope) continue;
    if (deps.layer0.getEffectiveStatus(obs.id) !== 'accepted') continue;
    if (!isRetentionExpired(obs, asOf)) continue;
    expired.push(obs);
  }

  let seq = deps.layer0.getLastSequence();
  let prevHash = deps.layer0.getLatestHashForWriter(deps.config.writer_id);
  let claimsRetracted = 0;

  for (const target of expired) {
    const impactedClaims = deps.store.getAllClaims().filter(claim =>
      claim.status !== 'retracted'
      && (claim.supporting_evidence.includes(target.id)
        || claim.source_event_id === target.id
        || claim.extraction_event_id === target.id));

    // Tombstone the observation (drives effective_status → tombstoned).
    seq += 1;
    const mutation = buildTombstoneMutation(target, params, operationActorId, seq, prevHash, now);
    const withIntegrity = assignIntegrity(mutation, deps.config.writer_id, seq, prevHash);
    appendObservation(deps.evidenceDir, withIntegrity);
    deps.layer0.insertOrSkip(withIntegrity);
    deps.layer0.applyMutationEvent(withIntegrity);
    prevHash = withIntegrity.integrity.hash;

    // Retract claims whose SOLE evidence is this observation (mirror forget.ts).
    for (const claim of impactedClaims) {
      const otherEvidence = claim.supporting_evidence.filter(id => id !== target.id);
      if (otherEvidence.length > 0) continue;
      const latest = deps.dataDir ? readLatestVersion(deps.dataDir, claim.id) : null;
      if (!latest || latest.state !== 'active') continue;
      const forgotten: ForgottenClaimVersion = carryDemotion({
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
        operation_id: params.operation_id ?? `op_${computePayloadHash({ sweep: 'expire', claim: claim.id, seq })}`,
        actor_id: params.actor.id,
        tags: latest.tags,
        supersedes: latest.version,
        endorsement_source: latest.endorsement_source,
      }, latest);
      appendClaimVersion(deps.dataDir, forgotten);
      deps.store.syncFromJsonlVersion(forgotten);
      claimsRetracted += 1;
    }
  }

  if (expired.length > 0) {
    await replayCatchUp(deps.evidenceDir, deps.store, deps.layer0, deps.config);
  }

  if (params.operation_id) {
    appendCommittedOpLogEntry(deps.opsDir, {
      operation_id: params.operation_id,
      actor_id: operationActorId,
      timestamp: now,
      op: 'retention.expire',
      details: {
        scope: params.scope,
        observations_expired: expired.length,
        claims_retracted: claimsRetracted,
        as_of: asOf.toISOString(),
      },
    }, deps.fence);
  }

  return {
    scope: params.scope,
    observations_expired: expired.length,
    claims_retracted: claimsRetracted,
    operation_id: params.operation_id,
  };
}
