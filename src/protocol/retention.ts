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
import { ulid } from 'ulid';
import { appendObservation, readAll } from '../layer0/log.js';
import { assignIntegrity } from '../layer0/integrity.js';
import { computePayloadHash } from '../layer0/idempotency.js';
import type { Layer0Index } from '../layer0/index.js';
import type { ClaimStore } from '../layer1/store.js';
import type { SmartwareConfig } from '../config.js';
import { replayCatchUp } from '../layer1/replay.js';
import { requireGrant, ProtocolError } from '../auth/middleware.js';
import { readLatestVersion, appendClaimVersion, carryDemotion, type ForgottenClaimVersion } from '../layer1/jsonl.js';
import { appendOpLogEntry, OPERATION_ID_PATTERN, readAllOpLogEntries, type OpLogEntry } from '../ops_log/index.js';
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
}

export interface RetentionDeps {
  evidenceDir: string;
  dataDir: string;
  layer0: Layer0Index;
  store: ClaimStore;
  config: SmartwareConfig;
  opsDir: string;
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

/**
 * Canonical payload identity of a sweep call.
 *
 * Only caller-supplied fields participate. `as_of` enters as the *supplied* value (`null` when
 * omitted): the defaulted instant is a resolution of "now", not part of the payload, so a host that
 * retries the identical call without `as_of` replays instead of colliding with whatever instant its
 * first call happened to resolve. `actor_id` enters as the same normalized value the ops entry
 * records (`observe`/`forget` hash their raw actor; this surface already normalizes for the entry,
 * so the hash and the entry agree).
 */
function sweepPayloadHash(params: ExpireRetentionParams, operationActorId: string): string {
  return computePayloadHash({
    actor_id: operationActorId,
    scope: params.scope,
    as_of: params.as_of ?? null,
  });
}

/**
 * Does a recorded `retention.expire` entry describe the same payload as this call?
 *
 * Entries written before payload identity was recorded carry no `payload_hash`; for those the
 * identity falls back to what they do carry — the recorded `scope` (always written) and the
 * recorded `as_of` instant when the caller supplies one. The supplied-versus-defaulted distinction
 * is only decidable from `payload_hash`, so a legacy entry still replays for a call that omits
 * `as_of` rather than turning a valid retry into a false `conflict`.
 */
function sweepPayloadMatches(
  entry: OpLogEntry,
  params: ExpireRetentionParams,
  asOf: Date,
  payloadHash: string,
): boolean {
  const recorded = entry.details?.['payload_hash'];
  if (typeof recorded === 'string') return recorded === payloadHash;
  if (entry.details?.['scope'] !== params.scope) return false;
  return params.as_of === undefined || entry.details?.['as_of'] === asOf.toISOString();
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

  // Idempotency (spec v1.6.16 §Integrity invariants; protocol v0.5.0 *Idempotency and commit
  // identity*): the same OperationId with the same payload returns the prior result, the same
  // OperationId with a different payload is a `conflict`. The payload — not the id alone — is the
  // key: keyed on the id alone, a host reusing one id across scopes (or retrying with a corrected
  // `as_of`) was handed the *other* sweep's counts under the requested scope's name while the
  // requested scope was never swept, and nothing in the result said so.
  const payloadHash = sweepPayloadHash(params, operationActorId);
  if (params.operation_id) {
    const priorEntries = [...readAllOpLogEntries(deps.opsDir)]
      .filter(entry => entry.operation_id === params.operation_id && entry.op === 'retention.expire');
    if (priorEntries.length > 0) {
      const exact = priorEntries.find(entry => sweepPayloadMatches(entry, params, asOf, payloadHash));
      if (!exact) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already used with a different payload`);
      }
      return {
        scope: params.scope,
        observations_expired: Number(exact.details?.['observations_expired'] ?? 0),
        claims_retracted: Number(exact.details?.['claims_retracted'] ?? 0),
        operation_id: params.operation_id,
      };
    }
  }

  const expired: Observation[] = [];
  for (const obs of readAll(deps.evidenceDir)) {
    if (obs.scope !== params.scope) continue;
    if (deps.layer0.getEffectiveStatus(obs.id) !== 'accepted') continue;
    if (!isRetentionExpired(obs, asOf)) continue;
    expired.push(obs);
  }

  const now = new Date().toISOString();
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
      // The forgotten record carries an OperationId the published contract accepts:
      // `schemas/v0.5.0/claim.schema.json` requires it for every version (active and forgotten),
      // typed by `common.schema.json#/$defs/OperationId` — `^op_[0-9A-HJKMNP-TV-Z]{26}$`, Crockford
      // base32 (no I/L/O/U). When the caller supplies none, mint one the way the sibling forget
      // writers do (`forget.ts`, `forget_scope.ts`, `session.ts`, `dream/phases.ts`): a fresh
      // `op_<ulid>` per record, valid by construction.
      //
      // Deliberately not the payload hash. This line's pre-fix fallback was
      // `op_${computePayloadHash(...)}` — 67 chars of sha256 hex, which that pattern rejects
      // (measured on kanban t_0177d9c3: a sweep with no operation_id wrote a forgotten line whose
      // ONLY schema error was `/operation_id`). A hash buys no idempotency here anyway: the sweep's
      // replay path is the ops-log lookup gated on `params.operation_id`, and a retry without one is
      // already idempotent by effect (an already-tombstoned observation is skipped, and a claim whose
      // latest version is `forgotten` is skipped), so this id has to identify the write, not replay it.
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
        operation_id: params.operation_id ?? `op_${ulid()}`,
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
    appendOpLogEntry(deps.opsDir, {
      operation_id: params.operation_id,
      actor_id: operationActorId,
      timestamp: now,
      op: 'retention.expire',
      details: {
        scope: params.scope,
        observations_expired: expired.length,
        claims_retracted: claimsRetracted,
        as_of: asOf.toISOString(),
        // The payload identity a retry is matched against (see `sweepPayloadMatches`). Additive:
        // `details` is free-form in the published ops-entry schema, so no wire contract changes.
        payload_hash: payloadHash,
      },
    });
  }

  return {
    scope: params.scope,
    observations_expired: expired.length,
    claims_retracted: claimsRetracted,
    operation_id: params.operation_id,
  };
}
