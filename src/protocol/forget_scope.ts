// Protocol — FORGET.SCOPE handler (protocol v0.5.0, spec §10)
//
// FORGET.SCOPE { scope, reason: erasure | offboarding } is the substrate
// erasure boundary for the Coffee tenant model: one audited operation for a
// client that left, disputed, or requested erasure.
//
// Binding semantics (spec §10, §10a, §10b.3):
//   - ONE ops-log entry carrying exact claims_retracted / observations_retracted
//     counts (counting happens before any mutation, from the live derived
//     stores + canonical logs);
//   - grant revocation happens in the same commit (config.scopes + grants are
//     mutated and saved before the ops-log entry is appended);
//   - reason DETERMINES behavior:
//       erasure    → physical content purge — Layer1 rows + L1 JSONL records,
//                    claim FTS + entity-page FTS + observation FTS rows,
//                    vector/embedding records, and derived L2 summaries are
//                    removed/flagged for re-derivation; the scope entry is
//                    removed from config (retired `client:<id>#1` marker);
//                    observations in scope get effective status `erased` via
//                    the scope-level marker, so zero results hold in EVERY
//                    lane (vector, BM25, graph) AND against a rebuilt index;
//       offboarding → tombstone + grant revoke, auditably reversible: claims
//                    get forgotten versions, observations get the same
//                    scope-level tombstone marker as a per-observation forget
//                    (terminal), grants are revoked (reversible: re-activate /
//                    re-grant), and the scope entry REMAINS so a `#2` can be
//                    minted later with an explicit owner-approved pointer.
//
// Non-reusable marker: scope ids are versioned (client:<id>#1, #2, …). This
// handler never re-uses a scope id — `#1` permanently retired on erasure
// (config entry removed). A new `#n` scope inherits nothing.
//
// Ordering (crash-atomicity): the L0 audit marker is written LAST — after
// every physical purge/mutation and config save. All mutations are
// idempotent, so a crash before the marker leaves the intent in the WAL
// (runRecovery reports pending; the retry re-runs the purge and completes);
// a crash after the marker means the purge already happened, and recovery
// finalizes the ops-log entry. The marker is the completion proof — never
// before the work it records.

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';

import type { Observation, Actor } from '../layer0/types.js';
import { appendObservation, readAll } from '../layer0/log.js';
import { assignIntegrity, computeHash } from '../layer0/integrity.js';
import { computePayloadHash } from '../layer0/idempotency.js';
import type { Layer0Index } from '../layer0/index.js';
import type { ClaimStore } from '../layer1/store.js';
import type { SearchIndex } from '../layer3/search.js';
import { observationToIndexRow } from '../layer3/search.js';
import type { SmartwareConfig } from '../config.js';
import { loadConfig, saveConfig, isScopeHeld } from '../config.js';
import {
  appendClaimVersions,
  carryDemotion,
  iterAllClaimVersions,
  purgeClaimVersionsByScope,
  readLatestVersion,
  type ForgottenClaimVersion,
} from '../layer1/jsonl.js';
import {
  appendCommittedOpLogEntry,
  OPERATION_ID_PATTERN,
  persistOperationIntent,
  readAllOpLogEntries,
  readOperationIntent,
  removeOperationIntent,
  runRecovery,
  type CommitContext,
  type ForgetScopeOperationIntent,
} from '../ops_log/index.js';
import { requireOwner, ProtocolError } from '../auth/middleware.js';
import { EXPORT_ID_PATTERN } from './export_scope.js';
import { SMARTWARE_VERSION } from '../version.js';
import type { SemanticRecordStore } from '../layer3/semantic-store.js';

export type ForgetScopeReason = 'erasure' | 'offboarding';

export interface ForgetScopeParams {
  actor: Actor;
  /** The scope id, e.g. `client:acme#1`. Non-reusable by construction. */
  scope: string;
  reason: ForgetScopeReason;
  operation_id?: string;
  /** Owner-approved non-PII pointer (offboarding only) — carried into `#2`. */
  owner_pointer?: string;
  /**
   * Owner attestation for an erasure that ends a dispute/legal hold (§10c.3):
   * the Coffee flow requires the owner to state why erasure may run now
   * ("no pending dispute / verified request / hold released"), and the substrate
   * records it in the ops entry. Erasure-lane only; additive (a DSR erasure
   * without a hold needs no attestation and stays byte-identical to v0.5.0).
   */
  attestation?: string | null;
  /**
   * Export-before-erasure binding (§10c.4): the export package produced by
   * smartware_export_scope for this scope. Erasure-lane only; surfaced in
   * the ops-entry details (details.export_id) so export-before-erasure is
   * auditable. Additive: null default; never changes existing result shapes.
   */
  export_id?: string | null;
}

export interface ForgetScopeResult {
  scope: string;
  reason: ForgetScopeReason;
  claims_retracted: number;
  observations_retracted: number;
  grants_revoked: string[];
  scope_entry_removed: boolean;
  /** L2 derived summaries removed/flagged for re-derivation (erasure). */
  derived_summaries_flagged: number;
  /** Vector/embedding records removed (erasure; 0 when no store supplied). */
  vector_entries_removed: number;
  audit_observation_id: string;
  status: 'forgotten';
}

export interface ForgetScopeCommitHooks {
  afterIntent?: (intent: ForgetScopeOperationIntent) => void;
  afterAuditObservation?: (observation: Observation) => void;
  afterCommit?: () => void;
}

export interface ForgetScopeDeps {
  evidenceDir: string;
  /** Pod data directory — contains config.json, claims/ (L1 JSONL), wiki/. */
  dataDir: string;
  layer0: Layer0Index;
  store: ClaimStore;
  searchIndex: SearchIndex;
  config: SmartwareConfig;
  commitCtx?: CommitContext;
  /** Optional vector/embedding store — erased per scope when provided. */
  semanticStore?: SemanticRecordStore | null;
  /** Optional derive-compile artifacts — purged per scope when provided. */
  compileQueue?: { removeByScope(scope: string): number } | null;
  fingerprintIndex?: { removeByClaimIds(claimIds: string[]): number } | null;
  commitHooks?: ForgetScopeCommitHooks;
}

function scopePayload(params: ForgetScopeParams): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    actor_id: params.actor.id,
    scope: params.scope,
    reason: params.reason,
    owner_pointer: params.owner_pointer ?? null,
  };
  // Additive-only: the payload stays byte-identical for v0.5.0 calls without
  // export_id / attestation (idempotent retry of an existing operation must
  // keep matching).
  if (params.export_id) payload.export_id = params.export_id;
  if (params.attestation) payload.attestation = params.attestation;
  return payload;
}

/** Grants referencing the scope (any capability array contains the exact id). */
function grantsReferencingScope(config: SmartwareConfig, scope: string): string[] {
  const seen = new Set<string>();
  for (const grant of config.grants) {
    if (grant.status !== 'active') continue;
    const capabilities = [
      grant.capabilities.observe,
      grant.capabilities.query,
      grant.capabilities.compile,
      grant.capabilities.correct,
      grant.capabilities.forget,
      grant.capabilities.read,
    ];
    if (capabilities.some(list => list.includes(scope))) seen.add(grant.id);
  }
  return [...seen].sort();
}

/** Pod scope for the audit marker — never inside the erased scope. */
function auditMarkerScope(config: SmartwareConfig): string {
  const ids = config.scopes.map(entry => entry.id);
  if (ids.includes('self')) return 'self';
  if (ids.includes('personal')) return 'personal';
  return ids[0] ?? 'self';
}

/**
 * FORGET.SCOPE. Owner-only (erasure/offboarding is an owner decision, spec
 * §10b.2 — staff never invoke it). Intent-backed (operation_id + opsDir);
 * all mutating surfaces are written before the single ops-log entry, so the
 * audit trail and mutation are one commit as far as the protocol is concerned.
 */
export async function handleForgetScope(
  params: ForgetScopeParams,
  deps: ForgetScopeDeps,
): Promise<ForgetScopeResult> {
  const {
    evidenceDir,
    dataDir,
    layer0,
    store,
    searchIndex,
    config: passedConfig,
    commitCtx,
    commitHooks,
  } = deps;

  if (!params.scope) {
    throw new ProtocolError('invalid_parameter', 'A scope is required');
  }
  if (params.scope === 'self' || params.scope === 'workspace') {
    // Pod-internal scopes are NOT client erasure boundaries (§10b.1): erasing
    // the pod's own scope would destroy the audit surface (the marker itself
    // lives in `self`) and is never a Coffee client operation.
    throw new ProtocolError(
      'invalid_parameter',
      `FORGET.SCOPE targets client scopes only; '${params.scope}' is pod-internal`,
    );
  }
  if (params.reason !== 'erasure' && params.reason !== 'offboarding') {
    throw new ProtocolError('invalid_parameter', `Invalid reason '${String(params.reason)}'`);
  }
  if (params.reason === 'erasure' && params.owner_pointer) {
    throw new ProtocolError('invalid_parameter', 'owner_pointer is only valid for reason=offboarding');
  }
  if (params.export_id) {
    // Export-before-erasure binding (§10c.4): the erasure lane links the F1
    // snapshot; offboarding never does (DSR-vs-hold lanes, §10c.3).
    if (params.reason !== 'erasure') {
      throw new ProtocolError('invalid_parameter', 'export_id is only valid for reason=erasure');
    }
    if (!EXPORT_ID_PATTERN.test(params.export_id)) {
      throw new ProtocolError('invalid_parameter', `Invalid export_id '${params.export_id}'`);
    }
  }
  if (params.attestation != null) {
    // Hold-release attestation (§10c.3): erasure-lane only, and it must SAY
    // something — an empty string is not an attestation, it is a bug.
    if (params.reason !== 'erasure') {
      throw new ProtocolError('invalid_parameter', 'attestation is only valid for reason=erasure');
    }
    if (typeof params.attestation !== 'string' || params.attestation.trim().length === 0) {
      throw new ProtocolError('invalid_parameter', 'attestation must be a non-empty string');
    }
  }
  if (params.operation_id && !OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }
  if (params.operation_id && !commitCtx) {
    throw new ProtocolError('invalid_parameter', 'operation_id requires an operations directory');
  }

  requireOwner(params.actor.id, passedConfig);

  const payloadHash = computePayloadHash(scopePayload(params));

  // ── Idempotent replay: an already-committed FORGET.SCOPE re-executes into
  //    the recorded result only if the exact audit marker still exists.
  const committedResult = (): ForgetScopeResult | null => {
    if (!params.operation_id || !commitCtx) return null;
    const entries = [...readAllOpLogEntries(commitCtx.opsDir)]
      .filter(entry => entry.operation_id === params.operation_id);
    if (entries.length === 0) return null;
    const exact = entries.find(entry =>
      entry.op === 'forget.scope'
      && entry.actor_id === params.actor.id
      && entry.details?.['payload_hash'] === payloadHash);
    if (!exact) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already used with a different payload`);
    }
    const scope = exact.details?.['scope'];
    const reason = exact.details?.['reason'];
    const claimsRetracted = exact.details?.['claims_retracted'];
    const observationsRetracted = exact.details?.['observations_retracted'];
    const grantsRevoked = exact.details?.['grants_revoked'];
    const scopeEntryRemoved = exact.details?.['scope_entry_removed'];
    const auditId = exact.details?.['audit_observation_id'];
    const observationHash = exact.details?.['observation_hash'];
    const derivedFlagged = exact.details?.['derived_summaries_flagged'];
    const vectorRemoved = exact.details?.['vector_entries_removed'];
    if (typeof scope !== 'string'
      || (reason !== 'erasure' && reason !== 'offboarding')
      || typeof claimsRetracted !== 'number'
      || typeof observationsRetracted !== 'number'
      || !Array.isArray(grantsRevoked)
      || typeof scopeEntryRemoved !== 'boolean'
      || typeof auditId !== 'string'
      || typeof observationHash !== 'string') {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' has no replayable FORGET.SCOPE result`);
    }
    const audits = [...readAll(evidenceDir)]
      .filter(observation => observation.operation_id === params.operation_id);
    if (audits.length !== 1 || audits[0]!.id !== auditId || computeHash(audits[0]!) !== observationHash) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
    }
    return {
      scope,
      reason,
      claims_retracted: claimsRetracted,
      observations_retracted: observationsRetracted,
      grants_revoked: [...grantsRevoked],
      scope_entry_removed: scopeEntryRemoved,
      derived_summaries_flagged: typeof derivedFlagged === 'number' ? derivedFlagged : 0,
      vector_entries_removed: typeof vectorRemoved === 'number' ? vectorRemoved : 0,
      audit_observation_id: auditId,
      status: 'forgotten',
    };
  };

  const priorCommit = committedResult();
  if (priorCommit) return priorCommit;

  let existingIntent: ForgetScopeOperationIntent | null = null;
  if (params.operation_id && commitCtx) {
    const prepared = readOperationIntent(commitCtx.opsDir, params.operation_id);
    if (prepared) {
      if (prepared.op !== 'forget.scope'
        || prepared.actor_id !== params.actor.id
        || prepared.payload_hash !== payloadHash) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already prepared with a different payload`);
      }
      existingIntent = prepared;
      const recovery = runRecovery({
        opsDir: commitCtx.opsDir,
        evidenceDir,
        claimsDir: dataDir,
        quarantineDir: '',
        fence: commitCtx.fence ?? undefined,
      });
      const recovered = committedResult();
      if (recovered) return recovered;
      if (recovery.requiresManualReview.includes(params.operation_id)) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
      }
    }
  }

  // ── Legal hold (ADR-0009): erasure does not run while the scope is held.
  //    Checked AFTER idempotent replay + intent recovery (a committed erasure
  //    still replays; an interrupted intent is never abandoned mid-purge) and
  //    BEFORE planning, so a refusal mutates nothing and leaves the
  //    operation_id unconsumed — retryable once the hold is released.
  if (params.reason === 'erasure' && isScopeHeld(loadConfig(dataDir), params.scope)) {
    throw new ProtocolError(
      'legal_hold_open',
      `Scope '${params.scope}' has an open legal hold (ADR-0009) — release it (hold.release) before erasure`,
    );
  }

  // ── Plan: count everything BEFORE any mutation (counts fidelity, §10).
  //    The derived store is authoritative for the live surface; the JSONL is
  //    the canonical replay source. max() guards against a store that is not
  //    yet caught up with the canonical log at the moment of erasure.
  //    Counts are LATEST-STATE based: a claim with a forgotten latest version
  //    is already retracted and is not retracted again by this operation.
  const claimsInStore = store.getAllClaims(params.scope);
  const latestByClaim = new Map<string, import('../layer1/jsonl.js').ClaimVersionRecord>();
  for (const version of iterAllClaimVersions(dataDir)) {
    if (version.scope !== params.scope) continue;
    const latest = latestByClaim.get(version.claim_id);
    if (!latest || version.version > latest.version) latestByClaim.set(version.claim_id, version);
  }
  const activeJsonlClaims = new Set<string>();
  for (const latest of latestByClaim.values()) {
    if (latest.state === 'active') activeJsonlClaims.add(latest.claim_id);
  }
  // Crash-recovery fidelity: if an intent was prepared, the mutation may
  // ALREADY have happened (the retry re-runs the idempotent purge). The
  // durable intent carries the pre-mutation plans — recomputing from a
  // partly-purged state would under-report. The intent's recorded counts
  // win; the live-derived numbers are used when no intent exists.
  const plannedResult = existingIntent?.result;
  const claimsRetracted = existingIntent
    ? plannedResult?.claims_retracted ?? 0
    : Math.max(
        claimsInStore.filter(claim => claim.state !== 'forgotten').length,
        activeJsonlClaims.size,
      );
  const observationsRetracted = existingIntent
    ? plannedResult?.observations_retracted ?? 0
    : layer0.countByScope(params.scope);
  const grantsRevoked = existingIntent
    ? [...(plannedResult?.grants_revoked ?? [])]
    : grantsReferencingScope(passedConfig, params.scope);
  // Every claim id in the scope (any state) — the fingerprint index rows
  // and any derived state for it must not survive erasure either.
  const scopeClaimIds = [...new Set([
    ...latestByClaim.keys(),
    ...claimsInStore.map(claim => claim.id),
  ])];

  // ── Prepared marker observation (scope-level mutation, single audit row).
  const now = existingIntent?.prepared_at ?? new Date().toISOString();
  const seq = layer0.getLastSequence() + 1;
  const prevHash = layer0.getLatestHashForWriter(passedConfig.writer_id);
  const markerId = existingIntent?.expected.audit.observation_id ?? `obs_${computePayloadHash({
    type: 'erasure',
    actor_id: params.actor.id,
    scope: params.scope,
    reason: params.reason,
    operation_id: params.operation_id ?? null,
    sequence: seq,
    observed_at: now,
  })}`;

  const markerObs: Observation = {
    id: markerId,
    version: SMARTWARE_VERSION,
    ...(params.operation_id ? { operation_id: params.operation_id, actor_id: params.actor.id } : {}),
    type: 'erasure',
    status: 'accepted',
    source: {
      app: 'mcp-client',
      app_version: SMARTWARE_VERSION,
      source_id: null,
      actor: params.actor,
      captured_at: now,
      observed_at: now,
    },
    // The marker itself lives in the POD scope (self) — never inside the
    // erased scope, where it would be erased by its own mutation.
    scope: auditMarkerScope(passedConfig),
    visibility: 'private',
    content: {
      format: 'application/json',
      body: {
        target_kind: 'scope',
        scope: params.scope,
        reason: params.reason,
        owner_pointer: params.owner_pointer ?? null,
        claims_retracted: claimsRetracted,
        observations_retracted: observationsRetracted,
        grants_revoked: grantsRevoked,
      },
    },
    provenance: { parent_ids: [], supersedes: [], context: 'forget.scope' },
    idempotency: null,
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: passedConfig.writer_id, sequence: seq, previous_hash: prevHash },
  };
  const withIntegrity = assignIntegrity(markerObs, passedConfig.writer_id, seq, prevHash);

  // ── Intent (durable WAL) BEFORE any mutation, matching handleForget.
  let intent: ForgetScopeOperationIntent | null = null;
  if (params.operation_id && commitCtx) {
    const fenceStamp = commitCtx.fence?.stamp() ?? null;
    intent = {
      version: 1,
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      op: 'forget.scope',
      payload_hash: payloadHash,
      prepared_at: now,
      ...(fenceStamp ? { fence: fenceStamp } : {}),
      expected: {
        surface: 'forget.scope',
        audit: {
          observation_id: withIntegrity.id,
          observation_hash: withIntegrity.integrity.hash,
          sequence: withIntegrity.integrity.sequence,
        },
        scope: params.scope,
        reason: params.reason,
      },
      result: {
        scope: params.scope,
        reason: params.reason,
        claims_retracted: claimsRetracted,
        observations_retracted: observationsRetracted,
        grants_revoked: grantsRevoked,
        scope_entry_removed: params.reason === 'erasure',
        audit_observation_id: withIntegrity.id,
        status: 'forgotten',
      },
      details: {
        scope: params.scope,
        reason: params.reason,
        export_id: params.export_id ?? undefined,
      },
    };
    if (existingIntent
      && JSON.stringify(existingIntent.expected.audit) !== JSON.stringify(intent.expected.audit)) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' no longer matches its prepared FORGET.SCOPE audit`);
    }
    persistOperationIntent(commitCtx.opsDir, intent, true);
    commitHooks?.afterIntent?.(intent);
  }

  // ── Mutations (same commit): reason-specific purge FIRST, then the L0
  //    audit marker LAST. The marker is this operation's completion proof for
  //    runRecovery — writing it before the physical purge would let a crash
  //    between the two declare the op committed with the content still on
  //    disk (the exact ghost spec §10 forbids). Every mutation below is
  //    idempotent, so a crash before the marker re-runs safely.
  let derivedSummariesFlagged = 0;
  let vectorEntriesRemoved = 0;
  if (params.reason === 'erasure') {
    // Layer 1: physical purge of SQLite rows + canonical JSONL records.
    store.purgeByScope(params.scope);
    purgeClaimVersionsByScope(dataDir, params.scope);

    // Layer 2: derived summaries flagged for re-derivation (removed).
    derivedSummariesFlagged = flagDerivedSummariesForReDerivation(dataDir, params.scope);

    // Layer 3: BM25 lanes — entity pages, claim rows, raw observations.
    searchIndex.removePagesByScope(params.scope);
    searchIndex.removeClaimsByScope(params.scope);
    searchIndex.removeObservationsByScope(params.scope);

    // Vector lane: embeddings/summaries are part of the leak surface (§10).
    if (deps.semanticStore) {
      vectorEntriesRemoved = deps.semanticStore.reset({ scope: params.scope });
    }

    // compile queue + fingerprint index (derived): drop rows so the worker
    // never re-derives erased content (rebuild-equivalence, §10a).
    if (deps.compileQueue) deps.compileQueue.removeByScope(params.scope);
    if (deps.fingerprintIndex) deps.fingerprintIndex.removeByClaimIds(scopeClaimIds);
  } else {
    // Offboarding: tombstone every claim in the scope (forgotten versions —
    // reversible via REVIVE). Observations are already scope-level
    // tombstoned by the marker's replay semantics above.
    const versions: ForgottenClaimVersion[] = [];
    for (const claimId of activeJsonlClaims) {
      const latest = readLatestVersion(dataDir, claimId);
      if (!latest || latest.state !== 'active') continue;
      versions.push(carryDemotion({
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
      }, latest));
    }
    if (versions.length > 0) {
      appendClaimVersions(dataDir, versions);
      for (const version of versions) store.syncFromJsonlVersion(version);
    }
    // Observations in the scope are terminal (tombstoned by the marker),
    // so the raw window rows leave immediately — unconditionally, even on a
    // retry after a crash (idempotent DELETE), matching per-observation
    // forget semantics and wipe-and-rebuild (syncObservationsFromEvidence
    // excludes terminal states). Claim FTS rows + entity pages are kept:
    // the authorized snapshot filters forgotten claims at query time, and
    // keeping the rows is what makes REVIVE fully reversible — a revived
    // claim becomes searchable again without waiting for a reindex
    // (handleRevive does not re-index, and rebuild equivalence is
    // maintained by the same snapshot filter, not by row presence).
    searchIndex.removeObservationsByScope(params.scope);
  }

  // ── Config effect: same commit as the mutation (§10b.3).
  //    erasure: grants revoked + scope entry removed (#1 permanently retired).
  //    offboarding: grants revoked (auditably reversible) + scope entry kept.
  const config = loadConfig(dataDir);
  const revokedIds = grantsReferencingScope(config, params.scope);
  for (const grant of config.grants) {
    if (revokedIds.includes(grant.id)) grant.status = 'revoked';
  }
  let scopeEntryRemoved = false;
  if (params.reason === 'erasure') {
    const before = config.scopes.length;
    config.scopes = config.scopes.filter(entry => entry.id !== params.scope);
    scopeEntryRemoved = config.scopes.length < before;
  }
  if (params.reason === 'offboarding') {
    // ── The hold lane IS the hold open (ADR-0009): the same commit that
    //    tombstones the scope records its preservation duty, so a dispute can
    //    never leave erasure unrefused by forgetting to set a flag. Re-running
    //    the lane after a release opens a NEW hold (a new duty); a committed
    //    replay returns early above and never re-mutates.
    const holds = config.holds ?? {};
    holds[params.scope] = {
      scope: params.scope,
      opened_at: now,
      opened_by: params.actor.id,
      operation_id: params.operation_id ?? null,
      released_at: null,
      released_by: null,
      release_operation_id: null,
      release_statement: null,
    };
    config.holds = holds;
  }
  saveConfig(dataDir, config);

  // ── L0 audit marker: written LAST, after every mutation. If the process
  //    dies before this line, the intent remains in the WAL and runRecovery
  //    reports the op pending — the retry re-runs the (idempotent) mutations
  //    and then completes the marker. If it dies after this line, recovery
  //    sees the exact marker and finalizes the ops-log entry — with the
  //    guarantee that the physical purge already happened above.
  appendObservation(evidenceDir, withIntegrity);
  layer0.insertOrSkip(withIntegrity);
  layer0.applyMutationEvent(withIntegrity);
  // The audit marker is an accepted Layer-0 observation in the pod scope, and a
  // rebuilt index holds it — `syncObservationsFromEvidence` indexes every
  // accepted observation. Without this line the live raw-observation lane is
  // missing the marker until the next rebuild, so health's projection check
  // reports drift (and the Coffee-trial SLO breaches) after EVERY FORGET.SCOPE.
  // Index it here, with the marker's effective status, so live == rebuilt.
  const markerEffectiveStatus = layer0.getEffectiveStatus(withIntegrity.id) ?? withIntegrity.status;
  if (markerEffectiveStatus === 'accepted') {
    searchIndex.indexObservation(observationToIndexRow(withIntegrity, { status: markerEffectiveStatus }));
  }
  commitHooks?.afterAuditObservation?.(withIntegrity);

  // ── ONE ops-log entry carrying the exact counts.
  if (params.operation_id && commitCtx && intent) {
    appendCommittedOpLogEntry(commitCtx.opsDir, {
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      timestamp: now,
      op: 'forget.scope',
      details: {
        payload_hash: payloadHash,
        audit_observation_id: intent.result.audit_observation_id,
        observation_hash: intent.expected.audit.observation_hash,
        scope: intent.result.scope,
        reason: intent.result.reason,
        claims_retracted: intent.result.claims_retracted,
        observations_retracted: intent.result.observations_retracted,
        grants_revoked: intent.result.grants_revoked,
        scope_entry_removed: intent.result.scope_entry_removed,
        derived_summaries_flagged: derivedSummariesFlagged,
        vector_entries_removed: vectorEntriesRemoved,
        export_id: params.export_id ?? null,
        attestation: params.attestation ?? null,
        hold_opened: params.reason === 'offboarding',
      },
    }, commitCtx.fence);
    commitHooks?.afterCommit?.();
    removeOperationIntent(commitCtx.opsDir, params.operation_id);
  }

  return {
    scope: params.scope,
    reason: params.reason,
    claims_retracted: claimsRetracted,
    observations_retracted: observationsRetracted,
    grants_revoked: revokedIds,
    scope_entry_removed: scopeEntryRemoved,
    derived_summaries_flagged: derivedSummariesFlagged,
    vector_entries_removed: vectorEntriesRemoved,
    audit_observation_id: withIntegrity.id,
    status: 'forgotten',
  };
}

/**
 * Flag derived L2 summaries for re-derivation after a scope erasure: wiki
 * pages are derived artifacts of the purged claims, so they are removed from
 * the derived tree (they would otherwise surface purged content to human
 * readers). Re-derivation regenerates from claims; after erasure there are
 * none, so absence IS the derived state. Returns the number of pages removed.
 */
export function flagDerivedSummariesForReDerivation(dataDir: string, scope: string): number {
  const wikiDir = join(dataDir, 'wiki');
  if (!existsSync(wikiDir)) return 0;
  let removed = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')
        || entry.name === '_index.md'
        || entry.name === 'smartware.md') continue;
      try {
        const raw = readFileSync(full, 'utf8');
        const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
        if (!fm) continue;
        const scopeLine = fm.split('\n').find(line => line.startsWith('scope:'));
        if (scopeLine && (scopeLine.slice(6).trim().replace(/^"|"$/g, '') === scope)) {
          unlinkSync(full);
          removed++;
        }
      } catch {
        // An unreadable page is not an erasure risk by itself; keep walking.
      }
    }
  };
  walk(wikiDir);
  return removed;
}
