// Smartware embedded core API
//
// This module lets host runtimes such as Coffee Pod use Smartware as an
// in-process protocol engine instead of talking to the stdio MCP server.

import fs from 'fs';
import path from 'path';
import { ulid } from 'ulid';

import { loadConfig, saveConfig, type Grant, type ScopeEntry, type SmartwareConfig } from './config.js';
import { SMARTWARE_VERSION } from './version.js';
import { Layer0Index } from './layer0/index.js';
import { ClaimStore } from './layer1/store.js';
import { isEffectiveCurrent } from './layer1/effective_current.js';
import { backfillTombstones } from './layer1/tombstone-backfill.js';
import { writeRegistryMarkdown } from './auth/registry-md.js';
import { ensureDefaultAliases } from './auth/alias-map.js';
import { CascadePreviewStore } from './preview_store/index.js';
import {
  SearchIndex,
  syncSearchFromClaims,
  syncObservationsFromEvidence,
  observationToIndexRow,
  searchObservationQueryTerms,
  makeObservationSnippet,
} from './layer3/search.js';
import type {
  ObservationFreshness,
  ObservationSearchResult as IndexedObservationSearchResult,
} from './layer3/search.js';
import {
  claimToSemanticDocument,
  semanticDocumentSetHash,
  type EmbeddingAdapter,
  type SemanticDocument,
  type SemanticEmbeddingRecord,
} from './layer3/semantic.js';
import type { TemporalConstraint } from './layer3/temporal.js';
import {
  syncPersistedSemanticRecords,
  type PersistedSemanticSyncResult,
  type SemanticRecordLoadStatus,
  type SemanticRecordStore,
} from './layer3/semantic-store.js';
import {
  rankHybridDocuments,
  type HybridMatch,
  type SemanticChannelStatus,
} from './layer3/hybrid.js';
import { buildAuthorizedClaimSnapshot } from './layer4/authorized-claims.js';
import { ScopeRegistry } from './scopes/registry.js';
import { writeManifest, countWikiPages } from './layer2/manifest.js';
import { ensureGitRepo } from './layer2/git.js';
import { replayCatchUp } from './layer1/replay.js';
import { iterAllClaimVersions, type ClaimVersionRecord } from './layer1/jsonl.js';
import { readAll } from './layer0/log.js';
import type { Actor } from './layer0/types.js';
import type { ClaimRelation, EpistemicTag } from './layer1/types.js';
import { epistemicToTag } from './layer1/types.js';
import { runDefaultDream, type DreamResult } from './dream/phases.js';
import { runRecovery } from './ops_log/recovery.js';
import { ensurePrivateDirectory } from './storage/private-fs.js';

import { handleObserve, type ObserveParams, type ObserveResult } from './protocol/observe.js';
import {
  handleQuery,
  recallMinimumConfidence,
  type QueryParams,
  type QueryResult,
} from './protocol/query.js';
import { handleCompile, type CompileParams, type CompileHandlerResult } from './protocol/compile.js';
import { handleRead, type ReadParams, type ReadResult, type ScopeBrowseResult } from './protocol/read.js';
import { handleExplain, type ExplainParams, type ExplainResult } from './protocol/explain.js';
import { handleCorrect, type CorrectParams, type CorrectResult } from './protocol/correct.js';
import { handleRevise as handleReviseSpec, type ReviseParams, type ReviseResult } from './protocol/revise.js';
import { handleForget, handleRevive, type ForgetParams, type ForgetResult, type ReviveParams, type ReviveResult } from './protocol/forget.js';
import { handleExpireRetention, type ExpireRetentionParams, type ExpireRetentionResult } from './protocol/retention.js';
import {
  handleForgetScope,
  type ForgetScopeParams,
  type ForgetScopeResult,
} from './protocol/forget_scope.js';
import {
  handleExportScope,
  type ExportScopeParams,
  type ExportScopeResult,
} from './protocol/export_scope.js';
import { handleEndorse, type EndorseParams, type EndorseResult } from './protocol/endorse.js';
import {
  handleQuarantineReview,
  type QuarantineReviewParams,
  type QuarantineReviewResult,
} from './protocol/quarantine_review.js';
import { handleGrant, type GrantParams, type GrantResult } from './protocol/grant.js';
import { handleRevoke, type RevokeParams, type RevokeResult } from './protocol/revoke.js';
import {
  handleSessionStart, handleSessionDescribe, handleSessionEnd,
  requireSessionCapability, resolveActorFromSession,
  type SessionStartParams, type SessionStartResult,
  type SessionDescribeResult, type SessionEndResult,
} from './protocol/session.js';
import { handleStatus, type StatusResult } from './protocol/status.js';
import { handleContext, type ContextParams, type ContextBundle } from './protocol/context.js';
import { SessionStore } from './session/store.js';
import { createGrant, getGrantForActor, isOwner } from './auth/grants.js';
import { ProtocolError, requireGrant } from './auth/middleware.js';
import {
  openCompileQueue,
  runCompileBatch,
  type CompileBatchResult,
  type CompileJobStatus,
  type CompileQueue,
  type CompileWorkerContext,
  type FingerprintIndex,
} from './compile_queue/index.js';

export interface SmartwareCoreOptions {
  dataDir: string;
  ownerId?: string;
}

export interface SmartwareDreamParams {
  actor: Actor;
  scope: string;
}

export interface SmartwareSemanticDocumentsParams {
  actor: Actor;
  /** Server-anchored identity overrides actor.id when supplied. */
  session_id?: string;
  scope: string;
  min_confidence?: number;
  epistemic?: string[];
  epistemic_tags?: EpistemicTag[];
  entity_type?: string;
  include_sensitive?: boolean;
  include_stale?: boolean;
}

export interface SmartwareSemanticIndexOptions {
  adapter: EmbeddingAdapter;
  store: SemanticRecordStore;
  batch_size?: number;
  max_documents?: number;
  timeout_ms?: number;
}

export interface SmartwareHybridRecallOptions {
  adapter: EmbeddingAdapter | null;
  store: SemanticRecordStore | null;
  min_similarity: number;
  limit?: number;
  candidate_limit?: number;
  rrf_k?: number;
  lexical_weight?: number;
  semantic_weight?: number;
  semantic_timeout_ms?: number;
  temporal?: TemporalConstraint;
}

export interface SmartwareHybridRecallMatch extends HybridMatch {
  claim_id: string;
  entity_id: string;
  entity_name: string;
  predicate: string;
  object: unknown;
  epistemic: string;
  confidence: number;
  status: string;
  observation_ids: string[];
}

export interface SmartwareHybridRecallResult {
  canonical: QueryResult;
  hybrid_results: SmartwareHybridRecallMatch[];
  selected_channel: 'canonical' | 'hybrid';
  semantic_status: SemanticChannelStatus;
  semantic_index_status: SemanticRecordLoadStatus | 'not_configured';
  semantic_error?: string;
  semantic_index_error?: string;
}

export interface SmartwareActivityEvent {
  id: string;
  type: string;
  scope: string;
  actor_id: string;
  actor_type: string;
  actor_display_name: string;
  observed_at: string;
  captured_at: string;
  content: string | object;
  source_id: string | null;
  sensitive: boolean;
}

export interface SmartwareObservationSearchResult {
  id: string;
  type: string;
  scope: string;
  actor_id: string;
  observed_at: string;
  captured_at: string;
  snippet: string;
  source_app: string;
  source_id: string | null;
  /** Effective status (accepted / quarantined / tombstoned / redacted / rejected). */
  status: string;
  /** State-based raw-freshness label: unverified | EXTRACTED | FAILED (spec §10a). */
  freshness: ObservationFreshness;
}

export interface SmartwareObservationEvidence extends SmartwareActivityEvent {
  status: string;
  source_app: string;
}

export interface SmartwareKnowledgeGraphSnapshot {
  entities: Array<{
    entity_id: string;
    entity_name: string;
    type: string;
    scope: string;
    created_at: string;
  }>;
  claims: Array<{
    claim_id: string;
    subject_id: string;
    subject_name: string;
    predicate: string;
    object: { type: string; value: unknown };
    scope: string;
    epistemic_tag: EpistemicTag;
    confidence: number;
    created_at: string;
    valid_at: string;
    invalid_at: string | null;
    recorded_at: string | null;
    invalidated_at: string | null;
    provenance: {
      origin: 'deterministic' | 'model' | 'user';
      observation_ids: string[];
      model_id?: string;
    };
    relations: ClaimRelation[];
  }>;
}

export interface SmartwareConflictSnapshot {
  claims: Array<{
    claim_id: string;
    subject_id: string;
    subject_name: string;
    predicate: string;
    object: { type: string; value: unknown };
    scope: string;
    status: 'contested';
    contested_by: string[];
    epistemic_tag: EpistemicTag;
    confidence: number;
    version: number;
    created_at: string;
    valid_at: string;
    invalid_at: string | null;
    provenance: {
      origin: 'deterministic' | 'model' | 'user';
      observation_ids: string[];
      model_id?: string;
    };
  }>;
}

export interface SmartwarePodProfile {
  pod_id: string;
  name: string;
  owner_id: string;
  scopes: {
    personal: string;
    workspace: string;
  };
  memory_policy: {
    read_policy: 'task_start';
    write_policy: 'durable_summary';
    sensitive_policy: 'confirm';
    raw_transcript_policy: 'off';
  };
}

export class SmartwareCore {
  readonly dataDir: string;
  readonly evidenceDir: string;
  readonly wikiDir: string;
  /** Operations log canonical surface — see ops_log/ and docs/atomicity.md. */
  readonly opsDir: string;
  /** Cascade preview store for REVISE two-phase endorsement (PR-7 / A6). */
  readonly previewStore: CascadePreviewStore;

  private layer0: Layer0Index;
  private store: ClaimStore;
  private searchIndex: SearchIndex;
  private sessionStore: SessionStore;
  private previewGcInterval: NodeJS.Timeout | null = null;
  /** Durable compile queue + fingerprint index (async-compile path, §9.1). */
  private compileQueue: CompileQueue | null = null;
  private fingerprintIndex: FingerprintIndex | null = null;

  private constructor(dataDir: string, layer0: Layer0Index, store: ClaimStore, searchIndex: SearchIndex, sessionStore: SessionStore) {
    this.dataDir = dataDir;
    this.evidenceDir = path.join(dataDir, 'evidence');
    this.wikiDir = path.join(dataDir, 'wiki');
    this.opsDir = path.join(dataDir, 'operations');
    this.layer0 = layer0;
    this.store = store;
    this.searchIndex = searchIndex;
    this.sessionStore = sessionStore;
    this.previewStore = new CascadePreviewStore(path.join(dataDir, 'indices', 'previews.db'));
  }

  static async open(options: SmartwareCoreOptions): Promise<SmartwareCore> {
    ensurePrivateDirectory(options.dataDir);
    if (!fs.existsSync(path.join(options.dataDir, 'config.json'))) {
      await initialiseDataDir(options.dataDir, options.ownerId);
    }

    const dbPath = path.join(options.dataDir, 'smartware.db');
    const layer0 = new Layer0Index(dbPath);
    const store = new ClaimStore(dbPath);
    const searchIndex = new SearchIndex(dbPath);
    const sessionStore = new SessionStore(dbPath);

    const core = new SmartwareCore(options.dataDir, layer0, store, searchIndex, sessionStore);
    // PR-14: tell the ClaimStore where the L1 JSONL canonical lives. Every
    // subsequent insertClaim will also append a versioned record.
    store.setDataDir(options.dataDir);
    // Finalize only exact intent-backed canonical artifacts before derived
    // indices catch up. Ambiguous operations remain untouched for Dream/manual
    // review; startup never invents a completion decision.
    const recovery = runRecovery({
      opsDir: core.opsDir,
      evidenceDir: core.evidenceDir,
      claimsDir: core.dataDir,
      wikiDir: core.wikiDir,
      quarantineDir: path.join(core.dataDir, 'quarantine', 'operations'),
    });
    layer0.catchUp(core.evidenceDir);
    if (recovery.pendingOperations.length === 0) {
      await replayCatchUp(core.evidenceDir, store, layer0);
    }
    // Backfill derived search structures on upgrade/open. Older databases do
    // not have the claim-granular FTS table until this version creates it.
    syncSearchFromClaims(store, searchIndex);
    // Backfill the raw-observation FTS window (spec §10a). Regenerable from
    // the evidence JSONL; terminal-state observations are excluded here so a
    // wipe-and-rebuild equals the live index (rebuild-equivalence contract).
    syncObservationsFromEvidence(core.evidenceDir, layer0, searchIndex);

    // Durable compile queue (spec §9.1): open the derived ledger + O(1)
    // fingerprint index, reconcile running/pending jobs with the evidence
    // log and ops receipts, and re-apply EXTRACTED/FAILED labels after a
    // rebuild. Derived state — a wiped indices/ dir regenerates at open.
    const openedQueue = await openCompileQueue({
      evidenceDir: core.evidenceDir,
      dataDir: core.dataDir,
      layer0,
      searchIndex,
      opsDir: core.opsDir,
    });
    if (openedQueue) {
      core.compileQueue = openedQueue.queue;
      core.fingerprintIndex = openedQueue.fingerprintIndex;
    }

    // PR-4 (A3): backfill tombstones for legacy `retracted` claims. Idempotent.
    // Do not synthesize lifecycle artifacts while an intent-backed mutation
    // is incomplete; its retry must remain the sole writer of those records.
    if (recovery.pendingOperations.length === 0) {
      backfillTombstones(store, core.wikiDir);
    }

    // PR-5 (A4): write the markdown projection of the agent registry to
    // pod_data/agents/registry.md. Read-only for humans today; becomes the
    // canonical source in a later PR.
    writeRegistryMarkdown(core.dataDir, loadConfig(core.dataDir));

    // PR-9 (A4 alias map): seed Coffee Pod's default forward-only actor
    // renames into pod_data/agents/aliases.jsonl. Idempotent on re-open.
    ensureDefaultAliases(core.dataDir);

    // PR-7 (A6): start the cascade preview store GC timer. Sweeps the
    // SQLite-backed previews table for expired and consumed rows.
    core.startPreviewGc();
    // GC once on open so a long-stopped Pod doesn't accumulate stale rows.
    core.previewStore.gc();

    return core;
  }

  getConfig(): SmartwareConfig {
    return loadConfig(this.dataDir);
  }

  getRegistry(): ScopeRegistry {
    return new ScopeRegistry(this.getConfig());
  }

  /**
   * Ensure an application-defined set of scopes exists.
   *
   * Smartware owns scope enforcement and hierarchy, not product taxonomy.
   * Consumers may register app, project, or domain spaces without adding
   * those concepts to Smartware's profile contract.
   */
  ensureScopes(entries: ScopeEntry[]): void {
    const config = this.getConfig();
    const existing = new Set(config.scopes.map(scope => scope.id));
    const additions = entries.filter(entry => !existing.has(entry.id));
    if (additions.length === 0) return;
    config.scopes.push(...additions);
    saveConfig(this.dataDir, config);
  }

  createPodProfile(podId: string, name = 'Pod'): SmartwarePodProfile {
    const config = this.getConfig();
    const scope = (suffix: string) => `pod/${podId}/${suffix}`;
    const scopes = {
      personal: scope('personal'),
      workspace: scope('workspace'),
    };

    this.ensureScopes([
      { id: scopes.personal, parent: null, visibility_default: 'private' as const },
      { id: scopes.workspace, parent: null, visibility_default: 'workspace' as const },
    ]);

    return {
      pod_id: podId,
      name,
      owner_id: config.owner_id,
      scopes,
      memory_policy: {
        read_policy: 'task_start',
        write_policy: 'durable_summary',
        sensitive_policy: 'confirm',
        raw_transcript_policy: 'off',
      },
    };
  }

  ensureTrustedClientGrant(actorId: string, actorType: 'agent' | 'person' | 'system', scopes: string[]): Grant {
    const existing = getGrantForActor(actorId, this.getConfig());
    if (existing) {
      const config = this.getConfig();
      const stored = config.grants.find(grant => grant.id === existing.id)!;
      const capabilities = {
        observe: [...scopes],
        query: [...scopes],
        compile: [...scopes],
        correct: [...scopes],
        forget: [] as string[],
        read: [...scopes],
      };
      Object.assign(stored, { actor_type: actorType, capabilities, trusted: true, quarantine: false });
      saveConfig(this.dataDir, config);
      writeRegistryMarkdown(this.dataDir, config);
      return stored;
    }
    const grant = createGrant(this.dataDir, {
      actor_type: actorType,
      actor_id: actorId,
      capabilities: {
        observe: scopes,
        query: scopes,
        compile: scopes,
        correct: scopes,
        forget: [],
        read: scopes,
      },
      trusted: true,
      quarantine: false,
    });
    // PR-5 (A4): keep the markdown projection in sync on every grant mutation.
    writeRegistryMarkdown(this.dataDir, this.getConfig());
    return grant;
  }

  async observe(params: ObserveParams): Promise<ObserveResult> {
    return handleObserve(
      params,
      this.evidenceDir,
      this.layer0,
      this.getConfig(),
      this.sessionStore,
      this.opsDir,
      {
        // Sync-raw freshness (spec §10a): index the raw observation at commit
        // time so the raw window is searchable before any compile job runs.
        // Status at this moment is the observation's own (accepted or
        // quarantined); the search query filters status='accepted'.
        afterObservation: (obs) => {
          this.searchIndex.indexObservation(observationToIndexRow(obs));
          // Async-compile (spec §9.1): enqueue accepted observations on the
          // durable queue — the write path never runs the LLM, never blocks
          // on extraction, and never silently omits the raw window.
          if (obs.status === 'accepted') {
            this.compileQueue?.enqueue(obs.id, obs.scope);
          }
        },
      },
    );
  }

  async query(params: QueryParams): Promise<QueryResult> {
    return handleQuery(params, this.store, this.searchIndex, this.getConfig(), this.getRegistry(), this.sessionStore);
  }

  async recall(params: QueryParams): Promise<QueryResult> {
    return this.query(params);
  }

  async context(params: ContextParams): Promise<ContextBundle> {
    return handleContext(
      params,
      this.store,
      this.searchIndex,
      this.getConfig(),
      this.getRegistry(),
      this.evidenceDir,
      this.layer0,
    );
  }

  /**
   * Produce claim-level semantic documents through Smartware's canonical
   * authorization, sensitivity, lifecycle, and effective-current boundary.
   *
   * This is an embedded-core extension, not a change to the frozen RECALL wire
   * contract. Hosts may persist embeddings for these rebuildable documents but
   * must pass the same returned set to semantic ranking.
   */
  prepareSemanticDocuments(
    params: SmartwareSemanticDocumentsParams,
  ): SemanticDocument[] {
    const config = this.getConfig();
    let actorId = params.actor.id;
    if (params.session_id) {
      const resolved = resolveActorFromSession(params.session_id, this.sessionStore);
      if (!resolved) {
        throw new ProtocolError(
          'session_not_found',
          `Session '${params.session_id}' not found`,
        );
      }
      if (resolved.effective_policy.read_mode === 'off') {
        throw new ProtocolError('read_disabled', 'Session policy does not allow reads');
      }
      requireSessionCapability(resolved, 'query', params.scope);
      actorId = resolved.actor_id;
    }
    requireGrant(actorId, 'query', params.scope, config);
    const snapshot = buildAuthorizedClaimSnapshot({
      actorId,
      scope: params.scope,
      minConfidence: params.min_confidence,
      epistemic: params.epistemic,
      epistemicTags: params.epistemic_tags,
      entityType: params.entity_type,
      includeSensitive: params.include_sensitive,
      includeStale: params.include_stale,
      includeSuperseded: false,
      includeForgotten: false,
    }, this.store, config);

    return snapshot.claims
      .map(claimToSemanticDocument)
      .sort((left, right) =>
        right.version.localeCompare(left.version)
        || left.id.localeCompare(right.id));
  }

  /**
   * Refresh one disposable semantic-index scope through Smartware's canonical
   * query eligibility boundary. This is an explicit maintenance operation and
   * never runs as an implicit side effect of RECALL.
   */
  async syncSemanticIndex(
    params: SmartwareSemanticDocumentsParams,
    options: SmartwareSemanticIndexOptions,
  ): Promise<PersistedSemanticSyncResult> {
    if (options.max_documents !== undefined
      && (!Number.isInteger(options.max_documents) || options.max_documents < 1)) {
      throw new Error('Semantic index max documents must be a positive integer');
    }
    const sourceDocuments = this.prepareSemanticDocuments(params);
    const documents = sourceDocuments.slice(0, options.max_documents);
    return syncPersistedSemanticRecords(
      options.store,
      params.scope,
      documents,
      options.adapter,
      options.batch_size,
      {
        source_documents: sourceDocuments,
        coverage: documents.length === sourceDocuments.length ? 'complete' : 'partial',
        timeout_ms: options.timeout_ms,
      },
    );
  }

  /**
   * Evaluate opt-in hybrid retrieval without changing canonical RECALL.
   *
   * The canonical result is returned byte-for-byte from the existing path.
   * Hybrid candidates become selectable only after a complete local index and
   * successful semantic query. Missing/corrupt indices and provider failures
   * select the canonical result instead.
   */
  async recallHybrid(
    params: QueryParams,
    options: SmartwareHybridRecallOptions,
  ): Promise<SmartwareHybridRecallResult> {
    const temporalHistory = params.temporal?.axis === 'transaction_time'
      && params.temporal.mode !== 'current';
    if (params.include_superseded || params.include_forgotten || temporalHistory) {
      throw new ProtocolError(
        'unsupported_hybrid_history',
        'Hybrid recall does not support superseded or forgotten history',
      );
    }

    const canonical = await this.recall(params);
    const documents = this.prepareSemanticDocuments({
      actor: params.actor,
      session_id: params.session_id,
      scope: params.scope,
      min_confidence: recallMinimumConfidence(params.min_confidence),
      epistemic: params.epistemic,
      epistemic_tags: params.epistemic_tags,
      entity_type: params.entity_type,
      include_sensitive: params.include_sensitive,
      include_stale: params.include_stale,
    });
    let semanticIndexStatus: SmartwareHybridRecallResult['semantic_index_status']
      = 'not_configured';
    let semanticIndexError: string | undefined;
    let records: SemanticEmbeddingRecord[] = [];
    if (options.adapter && options.store) {
      const loaded = options.store.load(
        options.adapter,
        params.scope,
        undefined,
        {
          source_document_count: documents.length,
          document_set_hash: semanticDocumentSetHash(documents),
          require_complete: true,
        },
      );
      semanticIndexStatus = loaded.status;
      semanticIndexError = loaded.error;
      if (loaded.status === 'ready') records = loaded.records;
    }

    // Spec §11.1 D1 (BINDING): the RRF lexical channel must be claim-level
    // FTS ranks (searchClaims), not the canonical RECALL order. Canonical
    // order is entity-aggregated: an exact entity-name match ("Project
    // Aster") outranks a claim-level text match ("owns: Project Aster"),
    // which pushed `c_aster_schedule` ahead of `c_deliverable_aster` on q03.
    // Claim-level FTS ranks the correct claim #1 (9.70 vs 6.66, measured).
    // Claims the claim FTS missed keep a canonical-order tail so an empty
    // claim index degrades to the pre-fix feed instead of dropping lexical
    // coverage entirely.
    const ftsClaimIds = params.query.trim()
      ? this.searchIndex.searchClaims(params.query, params.scope).map(result => result.claim_id)
      : [];
    const canonicalClaimIds = canonical.results.flatMap(result => result.claim ? [result.claim.id] : []);
    const lexicalClaimIds = [
      ...ftsClaimIds,
      ...canonicalClaimIds.filter(id => !ftsClaimIds.includes(id)),
    ];
    const ranked = await rankHybridDocuments(
      params.query,
      lexicalClaimIds,
      documents,
      records,
      options.adapter,
      {
        min_similarity: options.min_similarity,
        limit: options.limit ?? params.limit ?? 20,
        candidate_limit: options.candidate_limit,
        rrf_k: options.rrf_k,
        lexical_weight: options.lexical_weight,
        semantic_weight: options.semantic_weight,
        semantic_timeout_ms: options.semantic_timeout_ms,
        temporal: options.temporal ?? params.temporal,
      },
    );
    const hybridResults = ranked.matches.flatMap(match => {
      const claim = this.store.getClaim(match.id);
      if (!claim) return [];
      return [{
        ...match,
        claim_id: claim.id,
        entity_id: claim.subject_id,
        entity_name: claim.subject_name,
        predicate: claim.predicate,
        object: claim.object,
        epistemic: claim.epistemic,
        confidence: claim.confidence,
        status: claim.status,
        observation_ids: [...claim.supporting_evidence],
      }];
    });
    const selectedChannel = ranked.semantic_status === 'ok' && hybridResults.length > 0
      ? 'hybrid'
      : 'canonical';

    return {
      canonical,
      hybrid_results: hybridResults,
      selected_channel: selectedChannel,
      semantic_status: ranked.semantic_status,
      semantic_index_status: semanticIndexStatus,
      ...(ranked.semantic_error === undefined
        ? {}
        : { semantic_error: ranked.semantic_error }),
      ...(semanticIndexError === undefined
        ? {}
        : { semantic_index_error: semanticIndexError }),
    };
  }

  listActivity(options: { scope?: string; types?: string[]; actorId?: string; limit?: number; includeSensitive?: boolean } = {}): SmartwareActivityEvent[] {
    const limit = options.limit ?? 50;
    const types = new Set(options.types ?? []);
    const events: SmartwareActivityEvent[] = [];

    for (const obs of readAll(this.evidenceDir)) {
      if (obs.status !== 'accepted') continue;
      if (options.scope && obs.scope !== options.scope) continue;
      if (types.size > 0 && !types.has(obs.type)) continue;
      if (options.actorId && obs.source.actor.id !== options.actorId) continue;
      if (obs.policy.sensitive && !options.includeSensitive) continue;
      events.push({
        id: obs.id,
        type: obs.type,
        scope: obs.scope,
        actor_id: obs.source.actor.id,
        actor_type: obs.source.actor.type,
        actor_display_name: obs.source.actor.display_name,
        observed_at: obs.source.observed_at,
        captured_at: obs.source.captured_at,
        content: obs.content.body,
        source_id: obs.source.source_id,
        sensitive: obs.policy.sensitive,
      });
    }

    return events
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at))
      .slice(0, limit);
  }

  searchObservations(
    query: string,
    scope: string,
    options: {
      limit?: number;
      includeSensitive?: boolean;
      temporalRange?: { from: string; to: string };
      /** Restrict to these state-based freshness labels (spec §10a). */
      freshness?: ObservationFreshness[];
    } = {},
  ): SmartwareObservationSearchResult[] {
    const terms = searchObservationQueryTerms(query);
    // The legacy substring matcher returned [] for a blank query with no
    // temporal anchor; keep that contract (the FTS fallback would otherwise
    // scan the whole scope).
    if (terms.length === 0 && !options.temporalRange) return [];

    // Time bound vs. state bound: the FTS window is state-based — the
    // freshness label, never a timestamp. Layer 0 is the authoritative
    // effective-status source, so hits are re-checked live: a mutation that
    // landed after indexing (tombstone/redaction/reject/approve) drops the
    // row immediately rather than after the next rebuild.
    const hits: IndexedObservationSearchResult[] = this.searchIndex.searchObservations(
      query,
      scope,
      {
        limit: options.limit,
        includeSensitive: options.includeSensitive,
        temporalRange: options.temporalRange,
        freshness: options.freshness,
      },
    );

    const results: SmartwareObservationSearchResult[] = [];
    for (const hit of hits) {
      const effectiveStatus = this.layer0.getEffectiveStatus(hit.obs_id);
      if (effectiveStatus !== null && effectiveStatus !== 'accepted') continue;
      results.push({
        id: hit.obs_id,
        type: hit.type,
        scope: hit.scope,
        actor_id: hit.actor_id,
        observed_at: hit.observed_at,
        captured_at: hit.captured_at,
        snippet: makeObservationSnippet(hit.content, terms),
        source_app: hit.source_app,
        source_id: hit.source_id,
        status: hit.status,
        freshness: hit.freshness,
      });
    }

    return results
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at))
      .slice(0, options.limit ?? 10);
  }

  /**
   * Mark the state-based freshness label of one indexed observation.
   * Compile-queue callers transition unverified → EXTRACTED / FAILED as jobs
   * resolve (spec §10a — never time-based).
   */
  markObservationFreshness(obsId: string, freshness: ObservationFreshness): void {
    this.searchIndex.updateObservationFreshness(obsId, freshness);
  }

  /** Current state-based freshness label of an indexed observation (or null). */
  getObservationFreshness(obsId: string): ObservationFreshness | null {
    return this.searchIndex.getObservationFreshness(obsId);
  }

  readObservationEvidence(params: {
    actor: Actor;
    observation_id: string;
    include_sensitive?: boolean;
  }): SmartwareObservationEvidence | null {
    const observation = [...readAll(this.evidenceDir)].find(item => item.id === params.observation_id);
    if (!observation) return null;
    const config = this.getConfig();
    requireGrant(params.actor.id, 'read', observation.scope, config);
    if (observation.policy.sensitive && !(params.include_sensitive && isOwner(params.actor.id, config))) {
      return null;
    }
    return {
      id: observation.id,
      type: observation.type,
      status: this.layer0.getEffectiveStatus(observation.id) ?? observation.status,
      scope: observation.scope,
      actor_id: observation.source.actor.id,
      actor_type: observation.source.actor.type,
      actor_display_name: observation.source.actor.display_name,
      observed_at: observation.source.observed_at,
      captured_at: observation.source.captured_at,
      content: observation.content.body,
      source_app: observation.source.app,
      source_id: observation.source.source_id,
      sensitive: observation.policy.sensitive,
    };
  }

  async compile(params: CompileParams): Promise<CompileHandlerResult> {
    return handleCompile(
      params,
      this.evidenceDir,
      this.wikiDir,
      this.layer0,
      this.store,
      this.searchIndex,
      this.getConfig(),
      this.dataDir,
      { opsDir: this.opsDir },
    );
  }

  async reflect(params: CompileParams): Promise<CompileHandlerResult> {
    return this.compile(params);
  }

  /**
   * Drain one batch of the durable compile queue (async-compile, spec §9.1).
   * The host decides when this runs — the MCP server starts a background
   * loop; embedded hosts may call this on an interval of their own. Returns
   * null when the compile queue is unavailable (derived-DB failure).
   */
  async drainCompileQueue(
    opts: { limit?: number; useLLM?: boolean } = {},
  ): Promise<CompileBatchResult | null> {
    if (!this.compileQueue || !this.fingerprintIndex) return null;
    const ctx: CompileWorkerContext = {
      evidenceDir: this.evidenceDir,
      dataDir: this.dataDir,
      layer0: this.layer0,
      store: this.store,
      searchIndex: this.searchIndex,
      config: this.getConfig(),
      opsDir: this.opsDir,
      queue: this.compileQueue,
      fingerprintIndex: this.fingerprintIndex,
    };
    return runCompileBatch(ctx, opts);
  }

  /** Queue ledger + freshness surface for the compile payload contract. */
  compileQueueStats(): {
    statuses: Record<CompileJobStatus, number>;
    pending_count: number;
    freshness: { unverified: number; extracted: number; failed: number };
  } | null {
    if (!this.compileQueue) return null;
    return {
      statuses: this.compileQueue.stats(),
      pending_count: this.compileQueue.countPending(),
      freshness: this.searchIndex.countObservationsByFreshness(),
    };
  }

  /**
   * Run one owner-authorized Dream inspection pass.
   *
   * This is intentionally manual and derived-only: it does not install a
   * scheduler and does not pass a canonical L2 recompile callback.
   */
  dream(params: SmartwareDreamParams): DreamResult {
    const config = this.getConfig();
    if (!isOwner(params.actor.id, config)) {
      throw new ProtocolError('owner_required', 'Dream is an owner-only operator command');
    }
    const substrateId = `substrate:${config.instance_id.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
    return runDefaultDream(
      { opsDir: this.opsDir },
      substrateId,
      params.scope,
      {
        evidenceDir: this.evidenceDir,
        claimsDir: this.dataDir,
        wikiDir: this.wikiDir,
        quarantineDir: path.join(this.dataDir, 'quarantine', 'operations'),
        reportDir: path.join(this.dataDir, 'derived', 'dream'),
      },
    );
  }

  async read(params: ReadParams): Promise<ReadResult | ScopeBrowseResult> {
    return handleRead(params, this.wikiDir, this.getConfig(), this.store, this.sessionStore);
  }

  /**
   * Authorization-aware view of unresolved contested claims. Conflict status
   * is intentionally separate from ordinary RECALL because contested claims
   * are not eligible current context.
   */
  readConflicts(params: {
    actor: Actor;
    scopes: string[];
    include_sensitive?: boolean;
  }): SmartwareConflictSnapshot {
    const config = this.getConfig();
    const scopes = [...new Set(params.scopes)];
    for (const scope of scopes) requireGrant(params.actor.id, 'read', scope, config);

    const allowedScopes = new Set(scopes);
    const canReadSensitive = params.include_sensitive === true && isOwner(params.actor.id, config);
    const latestVersions = new Map<string, ClaimVersionRecord>();
    for (const version of iterAllClaimVersions(this.dataDir)) {
      const previous = latestVersions.get(version.claim_id);
      if (!previous || version.version > previous.version) latestVersions.set(version.claim_id, version);
    }

    const db = this.store.getDB();
    const unresolved = this.store.getAllClaims()
        .filter(claim => claim.status === 'contested')
        .filter(claim => allowedScopes.has(claim.scope))
        .filter(claim => canReadSensitive || !claim.sensitive)
        .filter(claim => latestVersions.get(claim.id)?.state !== 'forgotten')
        .filter(claim => !db || isEffectiveCurrent(claim.id, db));
    const unresolvedIds = new Set(unresolved.map(claim => claim.id));

    return {
      claims: unresolved
        .map(claim => ({
          claim,
          contestedBy: claim.contested_by.filter(claimId => unresolvedIds.has(claimId)),
        }))
        .filter(({ contestedBy }) => contestedBy.length > 0)
        .map(({ claim, contestedBy }) => ({
          version: latestVersions.get(claim.id)?.version ?? 1,
          claim_id: claim.id,
          subject_id: claim.subject_id,
          subject_name: claim.subject_name,
          predicate: claim.predicate,
          object: claim.object,
          scope: claim.scope,
          status: 'contested' as const,
          contested_by: contestedBy,
          epistemic_tag: 'contested' as const,
          confidence: claim.confidence,
          created_at: claim.created_at ?? claim.extraction.extracted_at,
          valid_at: claim.validity.from,
          invalid_at: claim.validity.to,
          provenance: {
            origin: claim.extraction.method === 'llm'
              ? 'model' as const
              : claim.extraction.method === 'user_input'
                ? 'user' as const
                : 'deterministic' as const,
            observation_ids: [...claim.supporting_evidence],
            ...(claim.extraction.model ? { model_id: claim.extraction.model } : {}),
          },
        }))
        .sort((left, right) => left.claim_id.localeCompare(right.claim_id)),
    };
  }

  /**
   * Bulk, authorization-aware L1 snapshot for host knowledge-graph projections.
   * This is deliberately narrower than exposing ClaimStore: grants are checked
   * before a single bulk entity/claim read, and sensitive claims never cross
   * this seam unless the caller explicitly opts in.
   */
  readKnowledgeGraph(params: {
    actor: Actor;
    scopes: string[];
    include_sensitive?: boolean;
  }): SmartwareKnowledgeGraphSnapshot {
    const config = this.getConfig();
    const scopes = [...new Set(params.scopes)];
    for (const scope of scopes) requireGrant(params.actor.id, 'read', scope, config);

    const allowedScopes = new Set(scopes);
    const canReadSensitive = params.include_sensitive === true && isOwner(params.actor.id, config);
    const latestVersions = new Map<string, ClaimVersionRecord>();
    for (const version of iterAllClaimVersions(this.dataDir)) {
      const previous = latestVersions.get(version.claim_id);
      if (!previous || version.version > previous.version) latestVersions.set(version.claim_id, version);
    }
    const claims = this.store.getActiveClaims()
      .filter((claim) => allowedScopes.has(claim.scope))
      .filter((claim) => canReadSensitive || !claim.sensitive)
      .filter((claim) => latestVersions.get(claim.id)?.state !== 'forgotten');
    const claimById = new Map(claims.map((claim) => [claim.id, claim]));
    const scopedEntities = this.store.getAllEntities()
      .filter((entity) => allowedScopes.has(entity.scope));
    const entityById = new Map(scopedEntities.map((entity) => [entity.id, entity]));
    const entityByScopedName = new Map(scopedEntities.map((entity) => [`${entity.scope}\u0000${entity.canonical_name}`, entity]));
    const visibleEntityIds = new Set(claims.map((claim) => claim.subject_id));
    for (const claim of claims) {
      if (claim.object.type !== 'entity_ref' || typeof claim.object.value !== 'string') continue;
      const target = entityById.get(claim.object.value)
        ?? entityByScopedName.get(`${claim.scope}\u0000${claim.object.value}`);
      if (target) visibleEntityIds.add(target.id);
    }
    const entities = scopedEntities
      .filter((entity) => visibleEntityIds.has(entity.id))
      .map((entity) => ({
        entity_id: entity.id,
        entity_name: entity.canonical_name,
        type: entity.type,
        scope: entity.scope,
        created_at: entity.created_at,
      }));

    return {
      entities,
      claims: claims.map((claim) => ({
        claim_id: claim.id,
        subject_id: claim.subject_id,
        subject_name: claim.subject_name,
        predicate: claim.predicate,
        object: claim.object,
        scope: claim.scope,
        epistemic_tag: latestVersions.get(claim.id)?.epistemic_tag ?? epistemicToTag(claim.epistemic, claim.status),
        confidence: claim.confidence,
        created_at: claim.created_at ?? claim.extraction.extracted_at,
        valid_at: claim.validity.from,
        invalid_at: claim.validity.to,
        recorded_at: claim.t_ingested.value,
        invalidated_at: claim.t_invalidated.value,
        provenance: {
          origin: claim.extraction.method === 'llm'
            ? 'model'
            : claim.extraction.method === 'user_input'
              ? 'user'
              : 'deterministic',
          observation_ids: claim.supporting_evidence,
          ...(claim.extraction.model ? { model_id: claim.extraction.model } : {}),
        },
        relations: (latestVersions.get(claim.id)?.relations ?? claim.relations ?? [])
          .filter((relation) => claimById.has(relation.target)),
      })),
    };
  }

  async explain(params: ExplainParams): Promise<ExplainResult> {
    return handleExplain(params, this.evidenceDir, this.layer0, this.store, this.getConfig(), this.dataDir);
  }

  async correct(params: CorrectParams): Promise<CorrectResult> {
    return handleCorrect(params, this.evidenceDir, this.layer0, this.store, this.getConfig());
  }

  async revise(params: ReviseParams): Promise<ReviseResult> {
    return handleReviseSpec(
      params,
      this.dataDir,
      this.store,
      this.getConfig(),
      { opsDir: this.opsDir },
    );
  }

  async forget(params: ForgetParams): Promise<ForgetResult> {
    const result = await handleForget(
      params,
      this.evidenceDir,
      this.layer0,
      this.store,
      this.getConfig(),
      { opsDir: this.opsDir },
    );
    // Keep the raw-search window truthful after mutations: a terminal
    // observation (tombstone/redaction → tombstoned/redacted) must leave the
    // raw window immediately, not after the next rebuild.
    const targetId = params.target?.type === 'observation'
      ? params.target.id
      : params.target_obs_id;
    if (targetId) this.reconcileObservationIndexRow(targetId);
    return result;
  }

  /**
   * FORGET.SCOPE (protocol v0.5.0, spec §10): erasure or offboarding of a
   * whole scope. Owner-only. `semanticStore` is optional — when the host owns
   * a persisted vector index, pass the store so erasure removes the
   * embeddings too (they are part of the leak surface, §10).
   */
  async forgetScope(
    params: ForgetScopeParams,
    options: { semanticStore?: SemanticRecordStore | null } = {},
  ): Promise<ForgetScopeResult> {
    const config = this.getConfig();
    return handleForgetScope(params, {
      evidenceDir: this.evidenceDir,
      dataDir: this.dataDir,
      layer0: this.layer0,
      store: this.store,
      searchIndex: this.searchIndex,
      config,
      commitCtx: { opsDir: this.opsDir },
      semanticStore: options.semanticStore ?? null,
      compileQueue: this.compileQueue,
      fingerprintIndex: this.fingerprintIndex,
    });
  }

  /**
   * EXPORT.SCOPE (spec §10c.4, G3.1): one consumer's exact-scope canonical
   * record package under `<data_dir>/exports/<export_id>/`. Owner-only,
   * read-only to pod data; derived indexes are excluded (regenerable).
   * `operation_id` makes the export idempotent (retry ⇒ same export_id).
   */
  async exportScope(params: ExportScopeParams): Promise<ExportScopeResult> {
    const config = this.getConfig();
    return handleExportScope(params, {
      evidenceDir: this.evidenceDir,
      dataDir: this.dataDir,
      opsDir: this.opsDir,
      store: this.store,
      config,
    });
  }

  /**
   * Retention expiry sweep (ADR-0001). Tombstones elapsed `duration`-policy
   * observations in one scope and retracts their sole-evidence claims, with a
   * single `retention.expire` ops entry. Naturally idempotent: re-running finds
   * no new expired records. Host-triggered, like `drainCompileQueue`.
   */
  async expireRetention(params: ExpireRetentionParams): Promise<ExpireRetentionResult> {
    const config = this.getConfig();
    return handleExpireRetention(params, {
      evidenceDir: this.evidenceDir,
      dataDir: this.dataDir,
      layer0: this.layer0,
      store: this.store,
      config,
      opsDir: this.opsDir,
    });
  }

  /**
   * Reconcile one observation's raw-index row with its Layer-0 effective
   * status. Terminal states leave the index (matching wipe-and-rebuild
   * semantics); accepted/quarantined rows only update the status column.
   */
  private reconcileObservationIndexRow(obsId: string): void {
    const effective = this.layer0.getEffectiveStatus(obsId);
    if (effective === null || effective === 'accepted' || effective === 'quarantined') {
      if (effective) this.searchIndex.updateObservationStatus(obsId, effective);
      return;
    }
    this.searchIndex.removeObservation(obsId);
  }

  async revive(params: ReviveParams): Promise<ReviveResult> {
    return handleRevive(
      params,
      this.dataDir,
      this.store,
      this.getConfig(),
      { opsDir: this.opsDir },
      this.store.getDB(),
    );
  }

  async endorse(params: EndorseParams): Promise<EndorseResult> {
    return handleEndorse(
      params,
      this.dataDir,
      this.store,
      this.previewStore,
      this.getConfig(),
      { opsDir: this.opsDir },
    );
  }

  async quarantineReview(
    params: QuarantineReviewParams,
  ): Promise<QuarantineReviewResult> {
    const result = await handleQuarantineReview(
      params,
      this.evidenceDir,
      this.layer0,
      this.store,
      this.getConfig(),
    );
    // Quarantine approval flips quarantined → accepted: the row must move
    // into the raw-search window; rejection removes it.
    this.reconcileObservationIndexRow(params.target_obs_id);
    return result;
  }

  async grant(params: GrantParams): Promise<GrantResult> {
    return handleGrant(
      params,
      this.evidenceDir,
      this.layer0,
      this.getConfig(),
      this.dataDir,
    );
  }

  async revoke(params: RevokeParams): Promise<RevokeResult> {
    return handleRevoke(
      params,
      this.evidenceDir,
      this.layer0,
      this.getConfig(),
      this.dataDir,
    );
  }

  async sessionStart(params: SessionStartParams): Promise<SessionStartResult> {
    return handleSessionStart({ ...params, opsDir: params.opsDir ?? this.opsDir }, this.sessionStore, this.getConfig());
  }

  async sessionDescribe(actorId: string, sessionId: string): Promise<SessionDescribeResult> {
    return handleSessionDescribe(
      { actor_id: actorId, session_id: sessionId },
      this.sessionStore,
      this.getConfig(),
    );
  }

  async sessionEnd(actorId: string, sessionId: string): Promise<SessionEndResult> {
    return handleSessionEnd(
      { actor_id: actorId, session_id: sessionId, opsDir: this.opsDir },
      this.sessionStore,
      this.getConfig(),
    );
  }

  async status(ownerActorId?: string): Promise<StatusResult> {
    const config = this.getConfig();
    return handleStatus(
      { actor: { type: 'person', id: ownerActorId ?? config.owner_id, display_name: ownerActorId ?? config.owner_id } },
      this.layer0,
      this.store,
      this.searchIndex,
      this.wikiDir,
      config,
    );
  }

  findObservationBySource(app: string, sourceId: string): string | null {
    return this.layer0.checkDedup(app, sourceId);
  }

  close(): void {
    if (this.previewGcInterval) {
      clearInterval(this.previewGcInterval);
      this.previewGcInterval = null;
    }
    this.compileQueue?.close();
    this.fingerprintIndex?.close();
    this.layer0.close();
    this.store.close();
    this.searchIndex.close();
    this.sessionStore.close();
    this.previewStore.close();
  }

  /**
   * Start the cascade preview store's GC timer. Run-once on open. Idempotent
   * — calling twice is a no-op. Tests can skip by setting interval = 0.
   */
  startPreviewGc(intervalMs: number = 60_000): void {
    if (this.previewGcInterval || intervalMs <= 0) return;
    this.previewGcInterval = setInterval(() => {
      try {
        this.previewStore.gc();
      } catch {
        // GC errors are non-fatal; preview-store callers also handle
        // expired/not-found gracefully.
      }
    }, intervalMs);
    // Don't keep the event loop alive just for GC.
    if (typeof this.previewGcInterval.unref === 'function') {
      this.previewGcInterval.unref();
    }
  }
}

async function initialiseDataDir(dataDir: string, ownerId?: string): Promise<SmartwareConfig> {
  ensurePrivateDirectory(dataDir);
  ensurePrivateDirectory(path.join(dataDir, 'evidence'));
  ensurePrivateDirectory(path.join(dataDir, 'wiki', 'personal'));
  ensurePrivateDirectory(path.join(dataDir, 'wiki', 'workspace'));
  ensurePrivateDirectory(path.join(dataDir, 'wiki', 'project'));

  const config: SmartwareConfig = {
    instance_id: `smartware_${ulid()}`,
    owner_id: ownerId ?? `user:${ulid().toLowerCase()}`,
    writer_id: `writer_local_${ulid()}`,
    version: SMARTWARE_VERSION,
    data_dir: dataDir,
    scopes: [
      { id: 'self', parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: 'project:default', parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: { self: 365, 'project:*': 30 }, stale_threshold: 0.3 },
  };

  saveConfig(dataDir, config);

  const dbPath = path.join(dataDir, 'smartware.db');
  new Layer0Index(dbPath).close();
  new ClaimStore(dbPath).close();
  new SearchIndex(dbPath).close();

  writeManifest(path.join(dataDir, 'wiki'), config, {
    layer0: { total: 0, accepted: 0, quarantined: 0, tombstoned: 0 },
    layer1: { claims: 0, entities: 0 },
    layer2: { pages: countWikiPages(path.join(dataDir, 'wiki')) },
  });
  await ensureGitRepo(path.join(dataDir, 'wiki'));
  return config;
}

export * from './config.js';
export * from './layer0/types.js';
// Selective re-export of layer1 types to avoid the ClaimTimeState /
// ClaimTimeValue naming collision with layer0.
export type {
  Claim,
  Entity,
  ClaimStatus,
  ClaimState,
  ClaimType,
  ClaimRole,
  ClaimAuthor,
  ClaimRelation,
  ConfidenceBucket,
  EpistemicTag,
  EpistemicLabel,
  RelationKind,
} from './layer1/types.js';
export {
  statusToState,
  epistemicToTag,
  confidenceToBucket,
} from './layer1/types.js';
export * from './layer3/semantic.js';
export * from './layer3/semantic-store.js';
export * from './layer3/temporal.js';
export * from './layer3/hybrid.js';
export * from './evaluation/retrieval.js';
export * from './ops_log/index.js';
export {
  appendClaimVersion,
  claimsJsonlPath,
  iterAllClaimVersions,
  nextVersion as nextClaimVersion,
  readClaimHistory,
  readLatestVersion as readLatestClaimVersion,
  snapshotAt as snapshotClaimAt,
} from './layer1/jsonl.js';
export type { ClaimVersionRecord } from './layer1/jsonl.js';
export {
  ACTOR_ID_PATTERN,
  isSpecConformantActorId,
} from './auth/grants.js';
export {
  evaluateAccess,
} from './auth/middleware.js';
export type { AccessDecision, AccessOperation } from './auth/middleware.js';
export { renderRegistryMarkdown, writeRegistryMarkdown } from './auth/registry-md.js';
export {
  appendAlias,
  ensureDefaultAliases,
  loadAliasMap,
  resolveActorId,
  COFFEE_POD_DEFAULT_ALIASES,
} from './auth/alias-map.js';
export type { AliasEntry } from './auth/alias-map.js';
export {
  CascadePreviewStore,
  DEFAULT_TTL_SECONDS as CASCADE_PREVIEW_TTL_SECONDS,
  PREVIEW_ID_PATTERN,
  isValidCascadePreviewId,
} from './preview_store/index.js';
export type { CascadePreviewPayload, PreviewLookup } from './preview_store/index.js';
export * from './layer4/context-planning.js';
export * from './protocol/observe.js';
export * from './protocol/query.js';
export * from './protocol/compile.js';
export * from './protocol/read.js';
export * from './protocol/explain.js';
export * from './protocol/correct.js';
export * from './protocol/revise.js';
export * from './protocol/endorse.js';
export * from './protocol/forget.js';
export * from './protocol/retention.js';
export * from './protocol/session.js';
export * from './protocol/status.js';
export * from './session/types.js';
export * from './session/checkpoint.js';
