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
import { SearchIndex, syncSearchFromClaims } from './layer3/search.js';
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
    return handleObserve(params, this.evidenceDir, this.layer0, this.getConfig(), this.sessionStore, this.opsDir);
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

    const ranked = await rankHybridDocuments(
      params.query,
      canonical.results.flatMap(result => result.claim ? [result.claim.id] : []),
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
    } = {},
  ): SmartwareObservationSearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0 && !options.temporalRange) return [];
    const limit = options.limit ?? 10;
    const results: SmartwareObservationSearchResult[] = [];

    for (const obs of readAll(this.evidenceDir)) {
      if (obs.scope !== scope || obs.status !== 'accepted') continue;
      if (obs.policy.sensitive && !options.includeSensitive) continue;
      if (options.temporalRange
        && (obs.source.observed_at < options.temporalRange.from
          || obs.source.observed_at >= options.temporalRange.to)) continue;
      const body = typeof obs.content.body === 'string' ? obs.content.body : JSON.stringify(obs.content.body);
      const lower = body.toLowerCase();
      if (!terms.every(term => lower.includes(term))) continue;
      results.push({
        id: obs.id,
        type: obs.type,
        scope: obs.scope,
        actor_id: obs.source.actor.id,
        observed_at: obs.source.observed_at,
        captured_at: obs.source.captured_at,
        snippet: makeSnippet(body, terms[0]),
        source_app: obs.source.app,
        source_id: obs.source.source_id,
      });
    }

    return results
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at))
      .slice(0, limit);
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
    return handleForget(
      params,
      this.evidenceDir,
      this.layer0,
      this.store,
      this.getConfig(),
      { opsDir: this.opsDir },
    );
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
    return handleQuarantineReview(
      params,
      this.evidenceDir,
      this.layer0,
      this.store,
      this.getConfig(),
    );
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
export * from './protocol/session.js';
export * from './protocol/status.js';
export * from './session/types.js';
export * from './session/checkpoint.js';

function makeSnippet(text: string, term: string): string {
  const index = text.toLowerCase().indexOf(term);
  if (index < 0) return text.slice(0, 240);
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + term.length + 160);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}
