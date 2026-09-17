// Protocol — REFLECT handler (spec verb; formerly COMPILE)
//
// Two modes per spec §9:
//   - reflect.auto: autonomous background compilation. Creates bounded
//     L1 claims (author:agent, epistemic_owner:agent, confidence:low,
//     epistemic_tag:inference). Compiles L2 pages. Proposes candidates.
//     Does NOT admit epistemic relations or elevate confidence/tag.
//   - Explicit review/commit: rides REVISE in beta (§9).

import { dirname } from 'node:path';

import type { Layer0Index } from '../layer0/index.js';
import type { ClaimStore } from '../layer1/store.js';
import type { SearchIndex } from '../layer3/search.js';
import { substrateActorId, type SmartwareConfig } from '../config.js';
import type { Actor, PreExtractedClaim } from '../layer0/types.js';
import type { ClaimRole, ClaimType, EpistemicLabel } from '../layer1/types.js';
import { compile, isContextOnlyObservation, type CompileResult, type CompileOptions } from '../layer2/compiler.js';
import { syncSearchFromClaims } from '../layer3/search.js';
import type { CompileTelemetry } from '../layer2/types.js';
import { writeManifest, countWikiPages } from '../layer2/manifest.js';
import { requireGrant, ProtocolError } from '../auth/middleware.js';
import { isOwner } from '../auth/grants.js';
import {
  appendClaimVersions,
  readLatestVersion,
  iterAllClaimVersions,
  type ActiveClaimVersion,
} from '../layer1/jsonl.js';
import { computeStructuredClaimFingerprint } from '../layer1/fingerprint.js';
import { readAll } from '../layer0/log.js';
import { extractDeterministic } from '../extraction/deterministic.js';
import { extractClaimsLLM } from '../extraction/llm.js';
import { computePayloadHash } from '../layer0/idempotency.js';
import {
  appendOpLogEntries,
  appendOpLogEntry,
  defaultOpsIndexPath,
  openOpsIndex,
  OPERATION_ID_PATTERN,
  readAllOpLogEntries,
  type CommitContext,
  type OpLogEntry,
  type OpsIndex,
} from '../ops_log/index.js';
import {
  defaultFingerprintIndexPath,
  openFingerprintIndex,
  type FingerprintIndex,
} from '../compile_queue/fingerprint.js';
import { nextClaimId, nextOperationId } from '../compile_queue/ids.js';
import {
  isSessionCheckpointContent,
  renderSessionCheckpoint,
  validateSessionCheckpoint,
} from '../session/checkpoint.js';

export interface CompileParams {
  actor: Actor;
  scope?: string;
  entity_id?: string;
  use_llm?: boolean;
  operation_id?: string;
  /**
   * §11.2b re-scope: defer L2 wiki synthesis out of the synchronous handler.
   * When true, handleCompile runs claim production + L1/L3/freshness +
   * manifest and returns pages_compiled: 0 with telemetry.synthesis_deferred:
   * true; the L2 synthesis stage is run separately (compile queue worker).
   */
  defer_synthesis?: boolean;
}

export interface CompileHandlerResult {
  pages_compiled: number;
  claims_created: number;
  git_sha?: string;
  audit: CompileResult['audit'];
  telemetry: CompileTelemetry;
}

export interface ReflectCommitHooks {
  afterIntent?: (intent: import('../ops_log/intent.js').ReflectClaimOperationIntent) => void;
  afterClaimVersion?: (record: ActiveClaimVersion) => void;
  afterCommit?: () => void;
}

interface ReflectAutoStats {
  claimsCreated: number;
  llmAttempted: number;
  llmFailed: number;
  llmSkippedSensitive: number;
}

interface ReflectionCandidate extends PreExtractedClaim {
  claim_type?: ClaimType;
  claim_role?: ClaimRole;
  rendered_content?: string;
}

export type ReflectAutoTerminalOutcome =
  | 'ignored_context_only'
  | 'ignored_short_content'
  | 'no_claims'
  | 'claims_processed';

function extractedEpistemic(value: string): EpistemicLabel {
  if (value === 'observed'
    || value === 'asserted'
    || value === 'inferred'
    || value === 'user_confirmed'
    || value === 'system_generated') {
    return value;
  }
  return 'inferred';
}

function materializeSemantic(
  claim: PreExtractedClaim,
  subjectType: string,
  extractedAt: string,
  sensitive: boolean,
): NonNullable<ActiveClaimVersion['semantic']> {
  const tValidFrom = claim.t_valid_from ?? {
    value: claim.validity?.from ?? extractedAt,
    state: claim.validity?.from ? 'known' as const : 'inferred' as const,
    ...(claim.validity?.from ? {} : { basis: 'reflection_time' }),
  };
  const tValidTo = claim.t_valid_to ?? (
    claim.validity?.to
      ? { value: claim.validity.to, state: 'known' as const }
      : { value: null, state: 'null' as const }
  );
  return {
    subject_name: claim.subject_name,
    subject_type: subjectType,
    predicate: claim.predicate,
    object: claim.object,
    t_valid_from: tValidFrom,
    t_valid_to: tValidTo,
    extracted_epistemic: extractedEpistemic(claim.epistemic),
    extracted_confidence: Math.max(0, Math.min(1, claim.confidence)),
    sensitive,
    extraction: {
      ...claim.extraction,
      extracted_at: extractedAt,
    },
  };
}

/** Content-free replay checkpoint for one observation considered by REFLECT. */
export interface ReflectAutoTerminalReceipt extends Record<string, unknown> {
  observation_id: string;
  scope: string;
  reflection_complete: true;
  outcome: ReflectAutoTerminalOutcome;
  candidates_found?: number;
  claim_versions_written?: number;
}

export function isReflectAutoTerminalReceipt(
  entry: OpLogEntry,
): entry is OpLogEntry & { details: ReflectAutoTerminalReceipt } {
  const details = entry.details;
  return entry.op === 'reflect.auto'
    && details?.['reflection_complete'] === true
    && typeof details['observation_id'] === 'string'
    && typeof details['scope'] === 'string'
    && (
      details['outcome'] === 'ignored_context_only'
      || details['outcome'] === 'ignored_short_content'
      || details['outcome'] === 'no_claims'
      || details['outcome'] === 'claims_processed'
    );
}

// ── Batched claim commit (spec §11.2 binding) ────────────────────────────────
//
// The old path committed each claim version with its own intent file, L1
// append, and ops append — four fsyncs per claim, which scaled to
// 9,468,298ms @50k (189ms/claim, O(N²) with the scan-based dedup). The
// compile path now:
//   1. dedups through the derived fingerprint index (O(1) per claim);
//   2. flushes all L1 version appends in one fsync per month file;
//   3. flushes all ops entries in one fsync per UTC day file.
// Crash durability is carried by the durable compile queue (a job left
// 'running' after a crash is reset and re-processed; the fingerprint dedup
// makes re-processing idempotent) and by recovery's existing stance for
// reflect.auto: an unprepared claim with no artifact is safe to recompute
// (recovery.ts aborts such intents). Per-claim reflect intents are therefore
// not written on this path; the per-claim ops entry (payload_hash + claim_id
// + record_hash + fingerprint) is preserved for provenance consumers.

/** Per-claim ops-log entry for one committed reflect.auto version. */
export function buildReflectClaimOpEntry(record: ActiveClaimVersion): OpLogEntry {
  const recordHash = computePayloadHash(record);
  const payloadHash = computePayloadHash({
    claim_id: record.claim_id,
    version: record.version,
    fingerprint: record.fingerprint,
    derived_from: record.derived_from,
  });
  return {
    operation_id: record.operation_id,
    actor_id: record.actor_id,
    timestamp: record.version_at,
    op: 'reflect.auto',
    details: {
      payload_hash: payloadHash,
      claim_id: record.claim_id,
      version: record.version,
      fingerprint: record.fingerprint,
      record_hash: recordHash,
    },
  };
}

/**
 * Commit a batch of claim versions with one filesystem append per month file
 * (L1) and per UTC day file (ops) — the batched-appends binding of §11.2.
 * `opEntries` runs before the receipt entries in canonical order.
 */
export function commitReflectClaimBatch(
  dataDir: string,
  records: ActiveClaimVersion[],
  opEntries: OpLogEntry[],
  commitCtx: CommitContext | undefined,
  hooks?: ReflectCommitHooks,
): void {
  if (records.length > 0) appendClaimVersions(dataDir, records);
  if (commitCtx && opEntries.length > 0) appendOpLogEntries(commitCtx.opsDir, opEntries);
  for (const record of records) hooks?.afterClaimVersion?.(record);
  if (records.length > 0 || opEntries.length > 0) hooks?.afterCommit?.();
}

/** One record produced for an observation, flagged new vs. extension. */
export interface ProducedClaim {
  record: ActiveClaimVersion;
  isNew: boolean;
}

/** Result of producing claim versions for a single raw observation. */
export interface ObservationProduction {
  outcome: ReflectAutoTerminalOutcome;
  candidates_found: number;
  records: ProducedClaim[];
  llm_tried: boolean;
  llm_failed: boolean;
  llm_skippedsensitive: boolean;
}

/** Shared extraction context for one observation (single commit timestamp). */
export interface ProduceObservationContext {
  dataDir: string;
  store: ClaimStore;
  config: SmartwareConfig;
  useLLM: boolean;
  podActorId: string;
  /** One timestamp per run — the A0 single-commit-timestamp discipline. */
  commitTs: string;
  entityHints?: Map<string, { name: string; type: string; predicate?: string; sensitive?: boolean }>;
  /** O(1) fingerprint dedup (spec §11.2). Falls back to JSONL/store scans. */
  fingerprintIndex?: FingerprintIndex;
}

/**
 * Extract claim versions from one raw observation without committing them.
 * Shared by the synchronous REFLECT handler and the background compile queue
 * so both paths produce identical claim records, receipts, and dedup
 * decisions. Returns records in commit order; new claims carry `isNew: true`.
 * Never throws on per-observation extraction issues — outcome 'no_claims'
 * or LLM degradation is recorded, not raised.
 */
export async function produceObservationClaims(
  obs: import('../layer0/types.js').Observation,
  bodyText: string,
  ctx: ProduceObservationContext,
): Promise<ObservationProduction> {
  const subjectName = obs.scope.split('/').pop() ?? obs.scope;
  let detClaims: ReflectionCandidate[];
  let extractedEntities: Array<{ name: string; type: string }>;
  if (isSessionCheckpointContent(obs.content.body)) {
    try {
      const checkpoint = validateSessionCheckpoint(obs.content.body);
      if (checkpoint.scope !== obs.scope) {
        throw new Error('checkpoint scope does not match observation scope');
      }
      detClaims = [{
        subject_name: checkpoint.session_id,
        subject_type: 'session',
        predicate: `checkpoint:${checkpoint.trigger}`,
        object: { type: 'any', value: checkpoint },
        scope: checkpoint.scope,
        t_valid_from: { value: obs.source.observed_at, state: 'known' },
        t_valid_to: { value: null, state: 'null' },
        epistemic: 'system_generated',
        confidence: 0.5,
        sensitive: obs.policy.sensitive,
        extraction: {
          method: 'deterministic',
          model: null,
          compiler_version: 'session-checkpoint-v1',
          prompt_hash: null,
        },
        claim_type: 'checkpoint',
        claim_role: 'checkpoint',
        rendered_content: renderSessionCheckpoint(checkpoint),
      }];
      extractedEntities = [{ name: checkpoint.session_id, type: 'session' }];
    } catch {
      return { outcome: 'no_claims', candidates_found: 0, records: [], llm_tried: false, llm_failed: false, llm_skippedsensitive: false };
    }
  } else {
    const extracted = extractDeterministic(
      bodyText, obs.scope, subjectName, obs.source.observed_at,
    );
    detClaims = extracted.claims;
    extractedEntities = extracted.entities;
  }

  let llmClaims: ReflectionCandidate[] = [];
  let llm_tried = false;
  let llm_failed = false;
  let llm_skippedsensitive = false;
  if (!isSessionCheckpointContent(obs.content.body) && ctx.useLLM && ctx.config.llm.provider !== 'none') {
    if (obs.policy.sensitive) {
      llm_skippedsensitive = true;
    } else {
      llm_tried = true;
      try {
        const llmResult = await extractClaimsLLM(
          bodyText, obs.scope, obs.source.observed_at,
          ctx.store.getAllEntities(obs.scope), ctx.config,
        );
        llmClaims = llmResult.claims;
      } catch {
        llm_failed = true;
        // Deterministic extraction remains available; telemetry records degradation.
      }
    }
  }

  const allClaims = [...detClaims, ...llmClaims];
  const records: ProducedClaim[] = [];

  for (const claim of allClaims) {
    const content = claim.rendered_content ?? (typeof claim.object.value === 'string'
      ? claim.object.value
      : JSON.stringify(claim.object.value));
    const claimType = claim.claim_type ?? 'hypothesis';
    const claimRole = claim.claim_role ?? 'memory';
    const fp = computeStructuredClaimFingerprint(
      claim.subject_name,
      claim.predicate,
      claim.object,
      obs.scope,
      claimType,
    );
    const extractedEntity = extractedEntities.find(e => e.name === claim.subject_name);
    const entityInfo = {
      name: claim.subject_name,
      type: claim.subject_type ?? extractedEntity?.type ?? 'concept',
    };
    const sensitive = obs.policy.sensitive || claim.sensitive;

    const existingByFp = ctx.fingerprintIndex
      ? ctx.fingerprintIndex.activeByFingerprint(fp)
      : findByFingerprint(ctx.dataDir, fp)
        ?? findSemanticMatch(ctx.dataDir, ctx.store, fp);
    if (existingByFp) {
      if (existingByFp.epistemic_owner === 'user') continue;
      const existingClaim = ctx.store.getClaim(existingByFp.claim_id);
      const existingEntity = existingClaim ? ctx.store.getEntity(existingClaim.subject_id) : undefined;
      const existingHint = ctx.entityHints?.get(existingByFp.claim_id);
      ctx.entityHints?.set(existingByFp.claim_id, {
        name: existingClaim?.subject_name ?? existingHint?.name ?? entityInfo.name,
        type: existingEntity?.type ?? existingHint?.type ?? entityInfo.type,
        predicate: existingClaim?.predicate ?? existingHint?.predicate ?? claim.predicate,
        sensitive: sensitive || existingClaim?.sensitive === true || existingHint?.sensitive === true,
      });
      if (!existingByFp.derived_from.includes(obs.id)) {
        // The spread carries the substrate's demotion fields (ADR-0003): folding a restatement into
        // an existing claim must not release a duplicate resolution.
        const extended: ActiveClaimVersion = {
          ...existingByFp,
          version: existingByFp.version + 1,
          derived_from: [...existingByFp.derived_from, obs.id],
          version_at: ctx.commitTs,
          operation_id: nextOperationId(),
          actor_id: ctx.podActorId,
          supersedes: existingByFp.version,
        };
        ctx.fingerprintIndex?.upsertVersion(extended);
        records.push({ record: extended, isNew: false });
      }
      continue;
    }

    const record: ActiveClaimVersion = {
      claim_id: nextClaimId(),
      version: 1,
      state: 'active',
      content,
      claim_type: claimType,
      claim_role: claimRole,
      author: 'agent',
      epistemic_owner: 'agent',
      fingerprint: fp,
      confidence: 'low',
      epistemic_tag: 'inference',
      scope: obs.scope,
      derived_from: [obs.id],
      relations: [],
      created_at: ctx.commitTs,
      version_at: ctx.commitTs,
      operation_id: nextOperationId(),
      actor_id: ctx.podActorId,
      tags: [],
      semantic: materializeSemantic(claim, entityInfo.type, ctx.commitTs, sensitive),
    };
    ctx.fingerprintIndex?.upsertVersion(record);
    records.push({ record, isNew: true });
    ctx.entityHints?.set(record.claim_id, {
      name: entityInfo.name,
      type: entityInfo.type,
      predicate: claim.predicate,
      sensitive,
    });
  }

  return {
    outcome: allClaims.length === 0 ? 'no_claims' : 'claims_processed',
    candidates_found: allClaims.length,
    records,
    llm_tried,
    llm_failed,
    llm_skippedsensitive,
  };
}

/**
 * The prior result of a REFLECT, reconstructed from the committed
 * `reflect.explicit` entry that recorded it — protocol v0.5.0, "Idempotency
 * and commit identity": the same OperationId plus an identical canonical
 * payload returns the PRIOR RESULT. The entry is appended only after the
 * compile has finished, so it is the durable record of a run that committed;
 * its counts are that run's counts.
 *
 * Every count this returns comes from the entry, so the result is
 * self-consistent — never a recorded count next to a freshly measured one
 * (the mixed `claims_created` / `pages_compiled` result this replaces,
 * `t_efa8d5a8`). Every telemetry count is 0 because THIS call produced
 * nothing, and `freshness` is omitted rather than filled with a current-state
 * read, for the same reason. `synthesis_deferred` is carried over when the
 * recorded run deferred L2 synthesis, because that is what its prior result
 * carried. The audit list and `git_sha` are not part of the entry, so a
 * replayed result carries neither; the durable audit trail of the operation
 * is the operations-log entry itself.
 *
 * Both counts have been recorded on every `reflect.explicit` entry written by
 * every build in this tree (measured: the writer has emitted them since the
 * initial commit `d8a2126`), so the guard below is fail-closed rather than a
 * live path: an entry carrying no counts must not be reported as a 0/0 run.
 */
function replayedReflectResult(entry: OpLogEntry): CompileHandlerResult {
  const claimsCreated = entry.details?.['claims_created'];
  const pagesCompiled = entry.details?.['pages_compiled'];
  if (typeof claimsCreated !== 'number' || typeof pagesCompiled !== 'number') {
    throw new ProtocolError('conflict', `operation_id '${entry.operation_id}' has no replayable REFLECT result`);
  }
  const telemetry: CompileHandlerResult['telemetry'] = {
    observations_processed: 0,
    claims_extracted_per_observation: {},
    observations_with_zero_claims: [],
    entity_merges: [],
    entities_created_new: [],
    layer3_indexed_count: 0,
    duration_ms: 0,
    timed_out: false,
    stage_durations_ms: {},
    llm_extraction_attempted: 0,
    llm_extraction_failed: 0,
    llm_extraction_skipped_sensitive: 0,
    llm_synthesis_attempted: 0,
    llm_synthesis_failed: 0,
    llm_synthesis_skipped_sensitive: 0,
    replayed: true,
  };
  if (entry.details?.['synthesis_deferred'] === true) telemetry.synthesis_deferred = true;
  return {
    pages_compiled: pagesCompiled,
    claims_created: claimsCreated,
    audit: [],
    telemetry,
  };
}

export async function handleCompile(
  params: CompileParams,
  evidenceDir: string,
  wikiDir: string,
  layer0: Layer0Index,
  store: ClaimStore,
  searchIndex: SearchIndex,
  config: SmartwareConfig,
  dataDir?: string,
  commitCtx?: CommitContext,
  commitHooks?: ReflectCommitHooks,
): Promise<CompileHandlerResult> {
  // Omitting scope compiles ALL scopes; only the owner may do that. A non-owner
  // must name a scope they're granted, else a grant check on one lane would
  // authorise a compile across every scope.
  if (!params.scope && !isOwner(params.actor.id, config)) {
    throw new ProtocolError('invalid_scope', 'A scope is required to compile; only the owner may compile all scopes.');
  }
  // `undefined` IS the "every scope" spelling — the same absence the rest of
  // this handler and its callees already read (CompileOptions.scope, the
  // compiler's `if (options.scope && …)` gather guard, reflectAutoCreateClaims'
  // scope filter, syncSearchFromClaims). Never a lane literal: filtering claim
  // production by an unregistered lane and then naming that lane in the
  // operations log is a scope the caller never asked for. An unnamed compile is
  // owner-gated above, so the grant check applies only to a named lane.
  const targetScope = params.scope;
  if (targetScope) requireGrant(params.actor.id, 'compile', targetScope, config);

  if (params.operation_id && !OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }
  if (params.operation_id && !commitCtx) {
    throw new ProtocolError('invalid_parameter', 'operation_id requires an operations directory');
  }
  const parentPayloadHash = computePayloadHash({
    actor_id: params.actor.id,
    scope: params.scope ?? null,
    entity_id: params.entity_id ?? null,
    use_llm: params.use_llm ?? false,
  });
  // Intent matching via the derived SQLite ops index (spec §7 landmine):
  // resolve the parent entry by PK instead of a full JSONL scan per compile.
  // Falls back to the canonical scan only when the index cannot be opened.
  let opsIndex: OpsIndex | null = null;
  if (commitCtx) {
    try {
      opsIndex = openOpsIndex(
        commitCtx.opsDir,
        defaultOpsIndexPath(dataDir ?? dirname(commitCtx.opsDir)),
      );
    } catch {
      // Derived index unavailable (e.g. read-only pod) — slow path, still correct.
      opsIndex = null;
    }
  }
  const parentEntry = params.operation_id && commitCtx
    ? (opsIndex
      ? opsIndex.getByOperationId(params.operation_id) ?? undefined
      : [...readAllOpLogEntries(commitCtx.opsDir)]
        .find(entry => entry.operation_id === params.operation_id))
    : undefined;
  if (parentEntry && (parentEntry.op !== 'reflect.explicit'
    || parentEntry.actor_id !== params.actor.id
    || parentEntry.details?.['payload_hash'] !== parentPayloadHash)) {
    throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already used with a different payload`);
  }
  // A matched operation_id IS the prior result (protocol v0.5.0, "Idempotency
  // and commit identity"), so the replay stops here. Continuing into the
  // compile below re-ran claim production, L2 synthesis, L3 indexing and
  // `reflect.auto` receipts while returning the entry's recorded
  // `claims_created` next to a freshly measured `pages_compiled` — a result
  // that described two different runs at once, and writes a retry did not ask
  // for (`t_efa8d5a8`). Crash recovery is unaffected: this entry is appended
  // only AFTER the compile returns, so an interrupted run has no entry to
  // match and its retry compiles legitimately (fresh behaviour needs a fresh
  // operation_id — see `docs/adr/0018-reflect-replay-returns-the-recorded-result.md`).
  if (parentEntry) {
    opsIndex?.close();
    return replayedReflectResult(parentEntry);
  }

  let reflectionStats: ReflectAutoStats = {
    claimsCreated: 0,
    llmAttempted: 0,
    llmFailed: 0,
    llmSkippedSensitive: 0,
  };
  const entityHints = new Map<string, { name: string; type: string; predicate?: string; sensitive?: boolean }>();
  /** One evidence parse for the whole pipeline (§11.2b re-scope) — set when
   *  dataDir is present; compile/replay reuse it instead of re-reading. */
  let observations: import('../layer0/types.js').Observation[] | undefined;

  if (dataDir) {
    // O(1) fingerprint dedup (spec §11.2): the derived index replaces the
    // per-claim JSONL/store scans that made compile O(N²). Regenerable from
    // the canonical L1 JSONL, so open-failure degrades to the scan path.
    let fingerprintIndex: FingerprintIndex | null = null;
    try {
      fingerprintIndex = openFingerprintIndex(dataDir, defaultFingerprintIndexPath(dataDir));
    } catch {
      fingerprintIndex = null;
    }
    // One evidence parse for the whole pipeline (spec §11.2b re-scope):
    // reflect production, L2 gather and reconcile each used to re-read the
    // full JSONL — ~8% of the timed pipeline at 50k.
    observations = [...readAll(evidenceDir)];
    try {
      reflectionStats = await reflectAutoCreateClaims(
        evidenceDir,
        dataDir,
        layer0,
        store,
        targetScope,
        config,
        params.use_llm === true,
        commitCtx,
        entityHints,
        commitHooks,
        opsIndex ?? undefined,
        fingerprintIndex ?? undefined,
        observations,
      );
      // Sync only what this run committed into the L1 JSONL — the store is a
      // latest-active view, so pre-existing versions were already synced.
      // (§11.2b) One transaction + chunked multi-row INSERT + entity memo:
      // the per-row path measured ~20% of the 50k pipeline.
      const reflectResult = reflectionStats as ReflectAutoCreateResult;
      store.syncFromJsonlVersionsBatch(
        reflectResult.committed_records,
        reflectResult.committed_new_ids,
        entityHints,
      );
      // Sync-path freshness (spec §10a): observations that reached a terminal
      // outcome are EXTRACTED — claims now rank above the retained raw
      // evidence. Per-observation failures never occur here (outcomes are
      // recorded); a hard failure surfaces as an error while observations
      // stay 'unverified' (raw-searchable, not silently dropped). Batched —
      // this loop was the measured compile bottleneck at 50k (§11.2 re-run).
      searchIndex.updateObservationsFreshness(
        (reflectionStats as ReflectAutoCreateResult).processed_observation_ids,
        'EXTRACTED',
      );
    } finally {
      opsIndex?.close();
      fingerprintIndex?.close();
    }
  } else {
    opsIndex?.close();
  }

  const options: CompileOptions = {
    scope: targetScope,
    entityId: params.entity_id,
    useLLM: params.use_llm ?? false,
    observations: dataDir ? observations : undefined,
  };

  const statusCounts = layer0.countByStatus();

  // §11.2b re-scope: deferred wiki synthesis. The L2 stage (gather + page
  // synthesis + git commit) is the synchronous handler's largest residual
  // cost; the compile queue worker produces claims per-observation without
  // it. Claim production + L1/L3 + freshness remain the handler's contract;
  // pages are compiled separately afterwards and the manifest below
  // reflects the pre-synthesis page count until that runs.
  if (params.defer_synthesis === true) {
    // L3 claim window is part of the deferred handler's contract ("claim
    // production + L1/L3 + freshness"): without this, claims produced by the
    // handler would not be searchable until the deferred L2 step runs.
    const l3Synced = syncSearchFromClaims(store, searchIndex, targetScope);
    writeManifest(wikiDir, config, {
      layer0: {
        total: layer0.totalCount(),
        accepted: statusCounts['accepted'] ?? 0,
        quarantined: statusCounts['quarantined'] ?? 0,
        tombstoned: statusCounts['tombstoned'] ?? 0,
      },
      layer1: { claims: store.claimCount(), entities: store.entityCount() },
      layer2: { pages: countWikiPages(wikiDir) },
    });

    const handlerResult: CompileHandlerResult = {
      pages_compiled: 0,
      claims_created: reflectionStats.claimsCreated,
      audit: [],
      telemetry: {
        observations_processed: 0,
        claims_extracted_per_observation: {},
        observations_with_zero_claims: [],
        entity_merges: [],
        entities_created_new: [],
        layer3_indexed_count: l3Synced,
        duration_ms: 0,
        timed_out: false,
        stage_durations_ms: {},
        llm_extraction_attempted: reflectionStats.llmAttempted,
        llm_extraction_failed: reflectionStats.llmFailed,
        llm_extraction_skipped_sensitive: reflectionStats.llmSkippedSensitive,
        llm_synthesis_attempted: 0,
        llm_synthesis_failed: 0,
        llm_synthesis_skipped_sensitive: 0,
        freshness: searchIndex.countObservationsByFreshness(),
        synthesis_deferred: true,
      },
    };
    if (params.operation_id && commitCtx) {
      appendOpLogEntry(commitCtx.opsDir, {
        operation_id: params.operation_id,
        actor_id: params.actor.id,
        timestamp: new Date().toISOString(),
        op: 'reflect.explicit',
        details: {
          payload_hash: parentPayloadHash,
          // The lane the caller named, or null for an unscoped run — never a
          // lane literal. `null` is the same spelling `payload_hash` above is
          // computed over, so the entry stays self-consistent, and it is
          // distinguishable from a key the writer forgot to emit.
          scope: targetScope ?? null,
          claims_created: reflectionStats.claimsCreated,
          pages_compiled: 0,
          synthesis_deferred: true,
        },
      });
    }
    return handlerResult;
  }

  const compiled = await compile(evidenceDir, wikiDir, layer0, store, config, options, searchIndex);

  for (const page of compiled.pages) {
    searchIndex.indexPage(page);
  }

  writeManifest(wikiDir, config, {
    layer0: {
      total: layer0.totalCount(),
      accepted: statusCounts['accepted'] ?? 0,
      quarantined: statusCounts['quarantined'] ?? 0,
      tombstoned: statusCounts['tombstoned'] ?? 0,
    },
    layer1: { claims: store.claimCount(), entities: store.entityCount() },
    layer2: { pages: countWikiPages(wikiDir) },
  });

  const telemetry: CompileHandlerResult['telemetry'] = {
    ...compiled.telemetry,
    // State-based freshness payload contract (spec §10a): literal
    // unverified / EXTRACTED / FAILED counts on the compile result so
    // clients assert compile state instead of inferring it from search.
    freshness: searchIndex.countObservationsByFreshness(),
    llm_extraction_attempted: reflectionStats.llmAttempted,
    llm_extraction_failed: reflectionStats.llmFailed,
    llm_extraction_skipped_sensitive: reflectionStats.llmSkippedSensitive,
  };
  if (params.operation_id && commitCtx) {
    appendOpLogEntry(commitCtx.opsDir, {
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      timestamp: new Date().toISOString(),
      op: 'reflect.explicit',
      details: {
        payload_hash: parentPayloadHash,
        scope: targetScope ?? null,
        claims_created: reflectionStats.claimsCreated,
        pages_compiled: compiled.pages.length,
      },
    });
  }

  const handlerResult: CompileHandlerResult = {
    pages_compiled: compiled.pages.length,
    claims_created: reflectionStats.claimsCreated,
    git_sha: compiled.gitSha,
    audit: compiled.audit,
    telemetry,
  };
  return handlerResult;
}

export interface ReflectAutoCreateResult extends ReflectAutoStats {
  /** Observation IDs that reached a terminal outcome during this run. */
  processed_observation_ids: string[];
  /** Claim versions committed during this run (new + extended). */
  committed_records: ActiveClaimVersion[];
  /** Fresh claim ids created by this run (never existed in the store). */
  committed_new_ids: Set<string>;
}

async function reflectAutoCreateClaims(
  evidenceDir: string,
  dataDir: string,
  layer0: Layer0Index,
  store: ClaimStore,
  /** The lane to compile, or `undefined` for every scope (owner-gated by the
   *  caller) — the filter below treats absence as "no scope filter". */
  scope: string | undefined,
  config: SmartwareConfig,
  useLLM: boolean,
  commitCtx?: CommitContext,
  entityHints?: Map<string, { name: string; type: string; predicate?: string; sensitive?: boolean }>,
  commitHooks?: ReflectCommitHooks,
  opsIndex?: OpsIndex,
  fingerprintIndex?: FingerprintIndex,
  observations?: import('../layer0/types.js').Observation[],
): Promise<ReflectAutoCreateResult> {
  const podActorId = substrateActorId(config);
  let created = 0;
  let llmAttempted = 0;
  let llmFailed = 0;
  let llmSkippedSensitive = 0;

  const processedObsIds = new Set<string>();
  if (commitCtx) {
    const entries = opsIndex
      ? opsIndex.entriesByOp('reflect.auto')
      : [...readAllOpLogEntries(commitCtx.opsDir)];
    for (const entry of entries) {
      if (isReflectAutoTerminalReceipt(entry)) {
        processedObsIds.add(entry.details['observation_id']);
      }
    }
  } else {
    for (const v of iterAllClaimVersions(dataDir)) {
      for (const obsId of v.derived_from) processedObsIds.add(obsId);
    }
  }
  const contextClaimIds = new Set(
    store.getActiveClaims(scope)
      .filter((claim) => claim.status === 'active')
      .map((claim) => claim.id),
  );

  // Batched commit surface (spec §11.2): claim versions and ops entries
  // accumulate for the whole run and flush with one fsync per month/day file.
  const pendingRecords: ActiveClaimVersion[] = [];
  const pendingOpEntries: OpLogEntry[] = [];
  const processedObservationIds: string[] = [];
  /** Claim ids created fresh by this run — known-new (no store lookups). */
  const committedNewIds = new Set<string>();

  const markComplete = (
    observationId: string,
    observationScope: string,
    outcome: ReflectAutoTerminalOutcome,
    details: Record<string, unknown> = {},
  ): void => {
    if (commitCtx) {
      const receipt: ReflectAutoTerminalReceipt = {
        ...details,
        observation_id: observationId,
        scope: observationScope,
        reflection_complete: true,
        outcome,
      };
      pendingOpEntries.push({
        operation_id: nextOperationId(),
        actor_id: podActorId,
        timestamp: new Date().toISOString(),
        op: 'reflect.auto',
        details: receipt,
      });
    }
    processedObsIds.add(observationId);
    processedObservationIds.push(observationId);
  };

  // One evidence parse for the whole pipeline (spec §11.2b re-scope): the
  // gather/reconcile stages re-read the same JSONL — at 50k obs that was
  // ~8% of the timed pipeline. Callers that already parsed evidence pass it.
  const allObservations = observations ?? [...readAll(evidenceDir)];

  // Fingerprint upserts in one transaction: 50k autocommits measured ~13%.
  if (fingerprintIndex) fingerprintIndex.beginBatch();
  try {
    for (const obs of allObservations) {
      if (obs.status !== 'accepted') continue;
      if (obs.type === 'claim_extracted' || obs.type === 'correction' || obs.type === 'tombstone') continue;
      if (scope && obs.scope !== scope && !obs.scope.endsWith('/' + scope) && !obs.scope.startsWith(scope + '/')) continue;
      if (processedObsIds.has(obs.id)) continue;
      if (isContextOnlyObservation(obs, contextClaimIds)) {
        markComplete(obs.id, obs.scope, 'ignored_context_only');
        continue;
      }

      let bodyText: string;
      if (typeof obs.content.body === 'string') {
        bodyText = obs.content.body;
      } else if (obs.content.body && typeof obs.content.body === 'object' && 'body' in obs.content.body) {
        const inner = (obs.content.body as { body: unknown }).body;
        bodyText = typeof inner === 'string' ? inner : JSON.stringify(inner);
      } else {
        bodyText = JSON.stringify(obs.content.body);
      }

      if (!bodyText || bodyText.length < 10) {
        markComplete(obs.id, obs.scope, 'ignored_short_content');
        continue;
      }

      // Shared per-observation production — identical records, dedup decisions,
      // and receipts on the synchronous reflect path and the compile queue.
      const production = await produceObservationClaims(obs, bodyText, {
        dataDir,
        store,
        config,
        useLLM,
        podActorId,
        commitTs: new Date().toISOString(),
        entityHints,
        fingerprintIndex,
      });
      for (const { record, isNew } of production.records) {
        pendingRecords.push(record);
        pendingOpEntries.push(buildReflectClaimOpEntry(record));
        if (isNew) {
          created++;
          committedNewIds.add(record.claim_id);
        }
      }
      if (production.llm_tried) llmAttempted++;
      if (production.llm_failed) llmFailed++;
      if (production.llm_skippedsensitive) llmSkippedSensitive++;

      markComplete(
        obs.id,
        obs.scope,
        production.outcome,
        {
          candidates_found: production.candidates_found,
          claim_versions_written: production.records.length,
        },
      );
    }

    // One flush per run: L1 version appends batched per month file, ops entries
    // batched per UTC day file (spec §11.2: one fsync per N).
    commitReflectClaimBatch(dataDir, pendingRecords, pendingOpEntries, commitCtx, commitHooks);
    fingerprintIndex?.flushBatch();
  } catch (error) {
    // Never leave a partial overlay: nothing was committed — the derived
    // index must not claim versions the L1 JSONL doesn't hold.
    fingerprintIndex?.discardBatch();
    throw error;
  }

  return {
    claimsCreated: created,
    llmAttempted,
    llmFailed,
    llmSkippedSensitive,
    processed_observation_ids: processedObservationIds,
    committed_records: pendingRecords,
    committed_new_ids: committedNewIds,
  };
}

function findByFingerprint(dataDir: string, fp: string): ActiveClaimVersion | null {
  const latest = new Map<string, { version: number; active: ActiveClaimVersion | null }>();
  for (const v of iterAllClaimVersions(dataDir)) {
    if (v.fingerprint !== fp) continue;
    const existing = latest.get(v.claim_id);
    if (existing && existing.version >= v.version) continue;
    latest.set(v.claim_id, {
      version: v.version,
      active: v.state === 'active' ? v as ActiveClaimVersion : null,
    });
  }
  for (const entry of latest.values()) {
    if (entry.active) return entry.active;
  }
  return null;
}

function findSemanticMatch(
  dataDir: string,
  store: ClaimStore,
  structuredFingerprint: string,
): ActiveClaimVersion | null {
  for (const claim of store.getActiveClaims()) {
    const candidate = computeStructuredClaimFingerprint(
      claim.subject_name,
      claim.predicate,
      claim.object,
      claim.scope,
      (claim.claim_type ?? 'hypothesis'),
    );
    if (candidate !== structuredFingerprint) continue;
    const latest = readLatestVersion(dataDir, claim.id);
    if (latest?.state === 'active') return latest;
  }
  return null;
}

export { handleCompile as handleReflect };
export type { CompileParams as ReflectParams, CompileHandlerResult as ReflectResult };
