#!/usr/bin/env node
// Smartware — MCP Server Entry Point

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { ulid } from 'ulid';

import { loadConfig, POD_SELF_SCOPE, saveConfig, getDataDir, type SmartwareConfig } from './config.js';
import { SMARTWARE_VERSION } from './version.js';
import { Layer0Index } from './layer0/index.js';
import { ClaimStore } from './layer1/store.js';
import { SearchIndex } from './layer3/search.js';
import { ScopeRegistry } from './scopes/registry.js';

import { handleObserve } from './protocol/observe.js';
import { handleQuery } from './protocol/query.js';
import { handleCompile } from './protocol/compile.js';
import { handleCorrect } from './protocol/correct.js';
import { handleForget } from './protocol/forget.js';
import { handleForgetScope } from './protocol/forget_scope.js';
import { handleExportScope } from './protocol/export_scope.js';
import { handleQuarantineReview } from './protocol/quarantine_review.js';
import { handleGrant } from './protocol/grant.js';
import { handleRevoke } from './protocol/revoke.js';
import { handleContext } from './protocol/context.js';
import { handleRead } from './protocol/read.js';
import { handleExplain } from './protocol/explain.js';
import { handleSessionStart, handleSessionDescribe, handleSessionEnd } from './protocol/session.js';
import { handleStatus } from './protocol/status.js';
import { SessionStore } from './session/store.js';

import { writeManifest } from './layer2/manifest.js';
import { ensureGitRepo } from './layer2/git.js';
import { replayCatchUp } from './layer1/replay.js';
import { ProtocolError } from './auth/middleware.js';
import { syncSearchFromClaims, syncObservationsFromEvidence, observationToIndexRow } from './layer3/search.js';
import { runRecovery } from './ops_log/recovery.js';
import { ensurePrivateDirectory } from './storage/private-fs.js';
import { openCompileQueue, runCompileBatch, startCompileWorker } from './compile_queue/index.js';

// ── Initialisation ───────────────────────────────────────────────────────────

async function initialize(dataDir: string): Promise<SmartwareConfig> {
  ensurePrivateDirectory(dataDir);
  ensurePrivateDirectory(path.join(dataDir, 'evidence'));
  ensurePrivateDirectory(path.join(dataDir, 'wiki', 'personal'));
  ensurePrivateDirectory(path.join(dataDir, 'wiki', 'workspace'));
  ensurePrivateDirectory(path.join(dataDir, 'wiki', 'project'));

  const config: SmartwareConfig = {
    instance_id: `smartware_${ulid()}`,
    owner_id: `user:${ulid().toLowerCase()}`,
    writer_id: `writer_local_${ulid()}`,
    version: SMARTWARE_VERSION,
    data_dir: dataDir,
    scopes: [
      { id: POD_SELF_SCOPE, parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: 'project:default', parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: { self: 365, 'project:*': 30 }, stale_threshold: 0.3 },
  };

  saveConfig(dataDir, config);

  // Create database
  const db = path.join(dataDir, 'smartware.db');
  const layer0 = new Layer0Index(db);
  layer0.close();
  const store = new ClaimStore(db);
  store.close();
  const si = new SearchIndex(db);
  si.close();

  // Write manifest
  const wikiDir = path.join(dataDir, 'wiki');
  writeManifest(wikiDir, config, {
    layer0: { total: 0, accepted: 0, quarantined: 0, tombstoned: 0 },
    layer1: { claims: 0, entities: 0 },
    layer2: { pages: 0 },
  });

  await ensureGitRepo(wikiDir);

  console.error(`Smartware initialised at ${dataDir}`);
  console.error(`Instance ID: ${config.instance_id}`);
  console.error(`Owner ID:    ${config.owner_id}  ← save this!`);
  return config;
}

// ── Start ────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  const dataDir = getDataDir();
  let config: SmartwareConfig;

  const configPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error(`No config found at ${dataDir} — initialising…`);
    config = await initialize(dataDir);
  } else {
    config = loadConfig(dataDir);
  }

  const dbPath = path.join(dataDir, 'smartware.db');
  const evidenceDir = path.join(dataDir, 'evidence');
  const wikiDir = path.join(dataDir, 'wiki');
  const opsDir = path.join(dataDir, 'operations');

  // Open database connections
  const layer0 = new Layer0Index(dbPath);
  const store = new ClaimStore(dbPath);
  const searchIndex = new SearchIndex(dbPath);
  const sessionStore = new SessionStore(dbPath);

  const recovery = runRecovery({
    opsDir,
    evidenceDir,
    claimsDir: dataDir,
    wikiDir,
    quarantineDir: path.join(dataDir, 'quarantine', 'operations'),
  });

  // Catch up Layer 0 derived index
  layer0.catchUp(evidenceDir);

  // Catch up Layer 1 claim store
  if (recovery.pendingOperations.length === 0) {
    await replayCatchUp(evidenceDir, store, layer0, config);
  }

  // Sync Layer 3 search index from Layer 1 claims (decoupled from Layer 2)
  const l3Count = syncSearchFromClaims(store, searchIndex);
  console.error(`Layer 3 search index synced: ${l3Count} entities indexed from claims`);

  // Sync the raw-observation FTS window (spec §10a): derived, regenerable —
  // wipe-and-rebuild from the canonical JSONL, terminal states excluded.
  const obsCount = syncObservationsFromEvidence(evidenceDir, layer0, searchIndex);
  console.error(`Raw observation search index synced: ${obsCount} observations indexed`);

  // Durable compile queue (spec §9.1): ledger + O(1) fingerprint index,
  // reconciled with evidence + ops receipts, freshness labels re-applied.
  const compileQueueState = await openCompileQueue({
    evidenceDir, dataDir, layer0, searchIndex, opsDir,
  });
  if (compileQueueState) {
    console.error(`Compile queue ready: ${JSON.stringify(compileQueueState.queue.stats())}`);
  } else {
    console.error('Compile queue unavailable — async compile disabled for this pod');
  }

  const registry = new ScopeRegistry(config);

  // ── MCP Server ─────────────────────────────────────────────────────────────

  const server = new McpServer({
    name: 'smartware',
    version: SMARTWARE_VERSION,
  });

  // Helper: wrap handlers to return MCP content format with a global timeout
  const HANDLER_TIMEOUT_MS = 60_000;
  type MCPContent = { content: [{ type: 'text'; text: string }] };

  // Keep the raw-observation FTS row in step with Layer-0 effective status:
  // terminal states leave the index, quarantined/accepted rows only flip the
  // status column (mirrors wipe-and-rebuild semantics of the derived index).
  function reconcileObservationIndexRow(
    idx: SearchIndex,
    l0: Layer0Index,
    obsId: string,
  ): void {
    const effective = l0.getEffectiveStatus(obsId);
    if (effective === null || effective === 'accepted' || effective === 'quarantined') {
      if (effective) idx.updateObservationStatus(obsId, effective);
      return;
    }
    idx.removeObservation(obsId);
  }
  function wrap<T>(fn: () => Promise<T>, label?: string): Promise<MCPContent> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Handler '${label ?? 'unknown'}' timed out after ${HANDLER_TIMEOUT_MS / 1000}s`)), HANDLER_TIMEOUT_MS);
    });
    return Promise.race([fn(), timeout])
      .then(result => ({
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] as [{ type: 'text'; text: string }],
      }))
      .catch((err: unknown): MCPContent => {
        if (err instanceof ProtocolError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: err.code, message: err.message }) }] as [{ type: 'text'; text: string }],
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[smartware] Handler error (${label ?? 'unknown'}): ${msg}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'internal_error', message: msg }) }] as [{ type: 'text'; text: string }],
        };
      });
  }

  // ── Tool: smartware_context ────────────────────────────────────────────────
  server.tool(
    'smartware_context',
    'Assemble an authenticated one-hop Smartware context bundle',
    {
      actor_id: z.string(),
      query: z.string().min(1),
      scope: z.string(),
      include_forgotten: z.boolean().default(false),
      include_superseded: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(10),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      return handleContext(
        {
          actor_id: args.actor_id,
          query: args.query,
          scope: args.scope,
          include_forgotten: args.include_forgotten,
          include_superseded: args.include_superseded,
          limit: args.limit,
        },
        store,
        searchIndex,
        freshConfig,
        new ScopeRegistry(freshConfig),
        evidenceDir,
        layer0,
      );
    }, 'context'),
  );

  // ── Tool: smartware_observe ────────────────────────────────────────────────
  server.tool(
    'smartware_observe',
    'Record an observation into the evidence log',
    {
      actor_id: z.string().optional().describe('Actor ID (or use session_id for server-resolved identity)'),
      actor_type: z.enum(['person', 'agent', 'system']).default('agent'),
      actor_display_name: z.string().default('Agent'),
      type: z.enum(['message', 'file', 'meeting', 'preference', 'decision', 'tool_output', 'feedback', 'system']).default('message'),
      content_format: z.enum(['text/markdown', 'text/plain', 'application/json']).default('text/plain'),
      content_body: z.string().describe('Observation content'),
      scope: z.string().describe('Scope identifier (e.g. personal, project/foo)'),
      visibility: z.enum(['private', 'scope', 'workspace', 'public']).default('scope'),
      source_id: z.string().optional(),
      observed_at: z.string().optional(),
      informed_by: z.array(z.string()).optional(),
      sensitive: z.boolean().default(false),
      session_id: z.string().optional().describe('Session ID for server-resolved identity (alternative to actor_id)'),
      operation_id: z.string().optional().describe('Client-supplied OperationId for crash-safe OBSERVE'),
    },
    async (args) => wrap(async () => {
      if (!args.actor_id && !args.session_id) {
        throw new ProtocolError('invalid_parameter', 'Either actor_id or session_id is required');
      }
      const freshConfig = loadConfig(dataDir);
      return handleObserve(
        {
          actor: {
            type: args.actor_type,
            id: args.actor_id ?? 'agent:session',
            display_name: args.actor_display_name,
          },
          type: args.type,
          content: { format: args.content_format, body: args.content_body },
          scope: args.scope,
          visibility: args.visibility,
          source_id: args.source_id,
          informed_by: args.informed_by,
          sensitive: args.sensitive,
          observed_at: args.observed_at,
          session_id: args.session_id,
          operation_id: args.operation_id,
        },
        evidenceDir,
        layer0,
        freshConfig,
        sessionStore,
        opsDir,
        {
          // Sync-raw freshness: index the raw observation at commit time so
          // it is searchable before any compile job resolves, and enqueue it
          // on the durable compile queue (async compile — never the LLM on
          // the write path, never silent omission of the raw window).
          afterObservation: (obs) => {
            searchIndex.indexObservation(observationToIndexRow(obs));
            if (obs.status === 'accepted') {
              compileQueueState?.queue.enqueue(obs.id, obs.scope);
            }
          },
        },
      );
    }, 'observe'),
  );

  // ── Tool: smartware_recall (canonical protocol verb) ─────────────────────
  server.tool(
    'smartware_recall',
    'Recall authorized, current Smartware claims',
    {
      actor_id: z.string().optional(),
      session_id: z.string().optional().describe('Session ID for server-resolved identity'),
      query: z.string().min(1),
      scope: z.string(),
      resolution: z.enum(['oneline', 'paragraph', 'full']).default('paragraph'),
      limit: z.number().int().min(1).max(100).default(10),
      include_stale: z.boolean().default(false),
      include_forgotten: z.boolean().default(false),
      include_superseded: z.boolean().default(false),
      include_sensitive: z.boolean().default(false),
      min_confidence: z.enum(['low', 'medium', 'high']).default('low'),
      epistemic_tags: z.array(
        z.enum(['fact', 'inference', 'opinion', 'stale', 'contested']),
      ).optional(),
      entity_type: z.string().optional(),
      delivery_mode: z.enum(['inline', 'file_reference', 'context_bundle']).default('inline'),
      as_of: z.string().optional(),
    },
    async (args) => wrap(async () => {
      if (!args.actor_id && !args.session_id) {
        throw new ProtocolError('invalid_parameter', 'Either actor_id or session_id is required');
      }
      const freshConfig = loadConfig(dataDir);
      return handleQuery(
        {
          actor: {
            type: 'agent',
            id: args.actor_id ?? 'agent:session',
            display_name: args.actor_id ?? 'Session actor',
          },
          session_id: args.session_id,
          query: args.query,
          scope: args.scope,
          resolution: args.resolution,
          limit: args.limit,
          include_stale: args.include_stale,
          include_forgotten: args.include_forgotten,
          include_superseded: args.include_superseded,
          include_sensitive: args.include_sensitive,
          min_confidence: args.min_confidence,
          epistemic_tags: args.epistemic_tags,
          entity_type: args.entity_type,
          delivery_mode: args.delivery_mode,
          as_of: args.as_of,
        },
        store,
        searchIndex,
        freshConfig,
        new ScopeRegistry(freshConfig),
        sessionStore,
      );
    }, 'recall'),
  );

  // ── Tool: smartware_query ──────────────────────────────────────────────────
  server.tool(
    'smartware_query',
    'Query the knowledge base using full-text search',
    {
      actor_id: z.string().optional(),
      session_id: z.string().optional().describe('Session ID for server-resolved identity'),
      query: z.string().describe('Search query'),
      scope: z.string().describe('Scope to query'),
      min_confidence: z.number().min(0).max(1).optional(),
      epistemic: z.array(z.string()).optional(),
      include_sensitive: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) => wrap(async () => {
      if (!args.actor_id && !args.session_id) {
        throw new ProtocolError('invalid_parameter', 'Either actor_id or session_id is required');
      }
      const freshConfig = loadConfig(dataDir);
      return handleQuery(
        {
          actor: {
            type: 'agent',
            id: args.actor_id ?? 'agent:session',
            display_name: args.actor_id ?? 'Session actor',
          },
          session_id: args.session_id,
          query: args.query,
          scope: args.scope,
          min_confidence: args.min_confidence,
          epistemic: args.epistemic,
          include_sensitive: args.include_sensitive,
          limit: args.limit,
        },
        store,
        searchIndex,
        freshConfig,
        registry,
        sessionStore,
      );
    }, 'query'),
  );

  // ── Tool: smartware_reflect (canonical protocol verb) ────────────────────
  server.tool(
    'smartware_reflect',
    'Reflect accepted evidence into derived claims and projections',
    {
      actor_id: z.string(),
      scope: z.string().optional(),
      entity_id: z.string().optional(),
      use_llm: z.boolean().default(false),
      operation_id: z.string(),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      return handleCompile(
        {
          actor: { type: 'agent', id: args.actor_id, display_name: args.actor_id },
          scope: args.scope,
          entity_id: args.entity_id,
          use_llm: args.use_llm,
          operation_id: args.operation_id,
        },
        evidenceDir,
        wikiDir,
        layer0,
        store,
        searchIndex,
        freshConfig,
        dataDir,
        { opsDir },
      );
    }, 'reflect'),
  );

  // ── Tool: smartware_compile ────────────────────────────────────────────────
  server.tool(
    'smartware_compile',
    'Compile knowledge into markdown wiki pages',
    {
      actor_id: z.string(),
      scope: z.string().optional(),
      entity_id: z.string().optional(),
      use_llm: z.boolean().default(false),
      operation_id: z.string(),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      return handleCompile(
        {
          actor: { type: 'agent', id: args.actor_id, display_name: args.actor_id },
          scope: args.scope,
          entity_id: args.entity_id,
          use_llm: args.use_llm,
          operation_id: args.operation_id,
        },
        evidenceDir,
        wikiDir,
        layer0,
        store,
        searchIndex,
        freshConfig,
        dataDir,
        { opsDir },
      );
    }, 'compile'),
  );

  // ── Tool: smartware_read ───────────────────────────────────────────────────
  server.tool(
    'smartware_read',
    'Read a compiled wiki page for an entity, or browse all entities in a scope',
    {
      actor_id: z.string().optional(),
      session_id: z.string().optional().describe('Session ID for server-resolved identity'),
      entity_id: z.string().optional().describe('Read a specific entity by ID'),
      entity_name: z.string().optional().describe('Look up entity by name (alternative to entity_id)'),
      scope: z.string().optional().describe('Scope to browse. If no entity_id/entity_name, lists all entities in scope'),
      resolution: z.enum(['oneliner', 'paragraph', 'full']).default('full'),
      include_sensitive: z.boolean().default(false).describe('Required to read sensitive pages, even for the owner'),
    },
    async (args) => wrap(async () => {
      if (!args.actor_id && !args.session_id) {
        throw new ProtocolError('invalid_parameter', 'Either actor_id or session_id is required');
      }
      const freshConfig = loadConfig(dataDir);
      return handleRead(
        {
          actor: {
            type: 'agent',
            id: args.actor_id ?? 'agent:session',
            display_name: args.actor_id ?? 'Session actor',
          },
          session_id: args.session_id,
          entity_id: args.entity_id,
          entity_name: args.entity_name,
          scope: args.scope,
          resolution: args.resolution,
          include_sensitive: args.include_sensitive,
        },
        wikiDir,
        freshConfig,
        store,
        sessionStore,
      );
    }, 'read'),
  );

  // ── Tool: smartware_explain ──────────────────────────────────────────────
  server.tool(
    'smartware_explain',
    'Trace provenance of a claim or entity — shows source observations, extraction chain, and lifecycle',
    {
      actor_id: z.string(),
      claim_id: z.string().optional().describe('Trace a specific claim back to its source'),
      entity_id: z.string().optional().describe('Explain an entity — all claims, sources, and provenance'),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      return handleExplain(
        {
          actor: { type: 'agent', id: args.actor_id, display_name: args.actor_id },
          claim_id: args.claim_id,
          entity_id: args.entity_id,
        },
        evidenceDir,
        layer0,
        store,
        freshConfig,
      );
    }, 'explain'),
  );

  // ── Tool: smartware_correct ────────────────────────────────────────────────
  server.tool(
    'smartware_correct',
    'Correct an existing claim (creates user_confirmed replacement)',
    {
      actor_id: z.string(),
      target_claim_id: z.string(),
      corrected_predicate: z.string().optional(),
      corrected_object_type: z.string().optional(),
      corrected_object_value: z.string().optional(),
      reason: z.enum(['changed', 'wrong', 'extraction_error', 'duplicate']).default('changed'),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      const correctedObject = args.corrected_object_type && args.corrected_object_value
        ? { type: args.corrected_object_type, value: args.corrected_object_value }
        : undefined;
      return handleCorrect(
        {
          actor: { type: 'person', id: args.actor_id, display_name: args.actor_id },
          target_claim_id: args.target_claim_id,
          corrected_predicate: args.corrected_predicate,
          corrected_object: correctedObject as { type: string; value: unknown } | undefined,
          reason: args.reason,
        },
        evidenceDir,
        layer0,
        store,
        freshConfig,
      );
    }, 'correct'),
  );

  // ── Tool: smartware_revise (spec §9 admission payload) ─────────────────────
  server.tool(
    'smartware_revise',
    'Revise a claim: admit relations, set confidence/epistemic_tag, adopt body, invalidate relations, or re-pick which duplicate of a fact survives (user-only in beta)',
    {
      actor_id: z.string(),
      target: z.string(),
      expected_base_version: z.number(),
      set_confidence: z.enum(['high', 'medium', 'low']).optional(),
      set_epistemic_tag: z.enum(['fact', 'inference', 'opinion', 'stale', 'contested']).optional(),
      adopt_body: z.boolean().optional(),
      repick_survivor: z.boolean().optional(),
      reason: z.string(),
      operation_id: z.string(),
    },
    async (args) => wrap(async () => {
      const { handleRevise: doRevise } = await import('./protocol/revise.js');
      const freshConfig = loadConfig(dataDir);
      return doRevise(
        {
          actor: { type: 'person', id: args.actor_id, display_name: args.actor_id },
          target: args.target,
          expected_base_version: args.expected_base_version,
          set_confidence: args.set_confidence,
          set_epistemic_tag: args.set_epistemic_tag,
          adopt_body: args.adopt_body,
          repick_survivor: args.repick_survivor,
          reason: args.reason,
          operation_id: args.operation_id,
        },
        dataDir,
        store,
        freshConfig,
        { opsDir },
      );
    }, 'revise'),
  );

  // ── Tool: smartware_forget ─────────────────────────────────────────────────
  server.tool(
    'smartware_forget',
    'Tombstone or redact an observation',
    {
      actor_id: z.string(),
      target_obs_id: z.string(),
      mode: z.enum(['tombstone', 'redact_if_supported']).default('tombstone'),
      reason: z.string().optional(),
      operation_id: z.string(),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      const result = await handleForget(
        {
          actor: { type: 'person', id: args.actor_id, display_name: args.actor_id },
          target: { type: 'observation', id: args.target_obs_id },
          mode: args.mode,
          reason: args.reason,
          operation_id: args.operation_id,
        },
        evidenceDir,
        layer0,
        store,
        freshConfig,
        { opsDir },
      );
      reconcileObservationIndexRow(searchIndex, layer0, args.target_obs_id);
      return result;
    }, 'forget'),
  );

  // ── Tool: smartware_forget_scope ──────────────────────────────────────────
  server.tool(
    'smartware_forget_scope',
    'Erase or offboard an entire client scope (owner only; protocol v0.5.0). reason=erasure purges content in every lane; reason=offboarding tombstones + revokes grants (reversible).',
    {
      actor_id: z.string().describe('Owner actor ID'),
      scope: z.string().describe('Scope id, e.g. client:acme#1 (non-reusable marker)'),
      reason: z.enum(['erasure', 'offboarding']),
      operation_id: z.string(),
      owner_pointer: z.string().optional().describe('Owner-approved non-PII pointer (offboarding only; carried into #2)'),
      export_id: z.string().optional().describe('Optional export package id (exp_<ulid>) produced by smartware_export_scope before erasure; surfaced in the ops entry (details.export_id) for auditability'),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      const result = await handleForgetScope(
        {
          actor: { type: 'person', id: args.actor_id, display_name: args.actor_id },
          scope: args.scope,
          reason: args.reason,
          operation_id: args.operation_id,
          owner_pointer: args.owner_pointer,
          export_id: args.export_id,
        },
        {
          evidenceDir,
          dataDir,
          layer0,
          store,
          searchIndex,
          config: freshConfig,
          commitCtx: { opsDir },
          semanticStore: null,
          compileQueue: compileQueueState?.queue ?? null,
          fingerprintIndex: compileQueueState?.fingerprintIndex ?? null,
        },
      );
      return result;
    }, 'forget_scope'),
  );

  // ── Tool: smartware_export_scope ─────────────────────────────────────────
  server.tool(
    'smartware_export_scope',
    'Export every canonical record for exactly one scope (owner only; spec §10c.4). Package: <data_dir>/exports/<export_id>/ with observations/claims/evidence/operations/entities .jsonl + manifest.json; derived indexes excluded. Idempotent per operation_id. Read-only to pod data.',
    {
      actor_id: z.string().describe('Owner actor ID'),
      scope: z.string().describe('Scope id, e.g. client:acme#1'),
      operation_id: z.string().optional().describe('Idempotency key — retry returns the same export_id'),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      return handleExportScope(
        {
          actor: { type: 'person', id: args.actor_id, display_name: args.actor_id },
          scope: args.scope,
          operation_id: args.operation_id,
        },
        {
          evidenceDir,
          dataDir,
          opsDir,
          store,
          config: freshConfig,
        },
      );
    }, 'export_scope'),
  );

  // ── Tool: smartware_quarantine_review ──────────────────────────────────────
  server.tool(
    'smartware_quarantine_review',
    'Approve or reject a quarantined observation (owner only)',
    {
      actor_id: z.string().describe('Owner actor ID'),
      target_obs_id: z.string(),
      action: z.enum(['approve', 'reject']),
      reason: z.string().optional(),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      const result = await handleQuarantineReview(
        {
          actor: { type: 'person', id: args.actor_id, display_name: args.actor_id },
          target_obs_id: args.target_obs_id,
          action: args.action,
          reason: args.reason,
        },
        evidenceDir,
        layer0,
        store,
        freshConfig,
      );
      reconcileObservationIndexRow(searchIndex, layer0, args.target_obs_id);
      return result;
    }, 'quarantine_review'),
  );

  // ── Tool: smartware_grant ──────────────────────────────────────────────────
  server.tool(
    'smartware_grant',
    'Grant capabilities to an actor (owner only)',
    {
      actor_id: z.string().describe('Owner actor ID'),
      grant_actor_id: z.string(),
      grant_actor_type: z.enum(['person', 'agent', 'system']).default('agent'),
      observe_scopes: z.array(z.string()).default([]),
      query_scopes: z.array(z.string()).default([]),
      compile_scopes: z.array(z.string()).default([]),
      correct_scopes: z.array(z.string()).default([]),
      forget_scopes: z.array(z.string()).default([]),
      read_scopes: z.array(z.string()).default([]),
      trusted: z.boolean().default(false),
      expires_at: z.string().optional(),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      return handleGrant(
        {
          actor: { type: 'person', id: args.actor_id, display_name: args.actor_id },
          grant_actor_id: args.grant_actor_id,
          grant_actor_type: args.grant_actor_type,
          capabilities: {
            observe: args.observe_scopes,
            query: args.query_scopes,
            compile: args.compile_scopes,
            correct: args.correct_scopes,
            forget: args.forget_scopes,
            read: args.read_scopes,
          },
          trusted: args.trusted,
          expires_at: args.expires_at,
        },
        evidenceDir,
        layer0,
        freshConfig,
        dataDir,
      );
    }, 'grant'),
  );

  // ── Tool: smartware_revoke ─────────────────────────────────────────────────
  server.tool(
    'smartware_revoke',
    'Revoke a grant (owner only)',
    {
      actor_id: z.string().describe('Owner actor ID'),
      grant_id: z.string(),
      reason: z.string().optional(),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      return handleRevoke(
        {
          actor: { type: 'person', id: args.actor_id, display_name: args.actor_id },
          grant_id: args.grant_id,
          reason: args.reason,
        },
        evidenceDir,
        layer0,
        freshConfig,
        dataDir,
      );
    }, 'revoke'),
  );

  // ── Tool: smartware_session_start ──────────────────────────────────────────
  server.tool(
    'smartware_session_start',
    'Start a server-anchored session — declares trust level, receives effective policy',
    {
      actor_id: z.string().describe('Actor ID to bind to this session'),
      client_id: z.string().describe('Client identifier (e.g. claude-desktop, openclaw-agent-7)'),
      client_version: z.string().describe('Client version string'),
      declared_trust_level: z.enum(['verified', 'user_facing', 'background_agent', 'untrusted']).default('user_facing'),
      can_tag_sensitivity: z.boolean().default(false),
      can_provide_intent: z.boolean().default(false),
      can_request_user_confirmation: z.boolean().default(false),
      requested_scopes: z.array(z.string()).optional(),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      return handleSessionStart(
        {
          actor: { type: 'agent', id: args.actor_id, display_name: args.actor_id },
          client_id: args.client_id,
          client_version: args.client_version,
          declared_trust_level: args.declared_trust_level,
          declared_capabilities: {
            can_tag_sensitivity: args.can_tag_sensitivity,
            can_provide_intent: args.can_provide_intent,
            can_request_user_confirmation: args.can_request_user_confirmation,
          },
          requested_scopes: args.requested_scopes,
          opsDir,
        },
        sessionStore,
        freshConfig,
      );
    }, 'session_start'),
  );

  // ── Tool: smartware_session_describe ──────────────────────────────────────
  server.tool(
    'smartware_session_describe',
    'Describe an active session — returns effective policy and status',
    {
      actor_id: z.string().describe('Session actor ID, or owner ID for administrative access'),
      session_id: z.string().describe('Session ID from session_start'),
    },
    async (args) => wrap(async () => {
      return handleSessionDescribe(
        { actor_id: args.actor_id, session_id: args.session_id },
        sessionStore,
        loadConfig(dataDir),
      );
    }, 'session_describe'),
  );

  // ── Tool: smartware_session_end ──────────────────────────────────────────
  server.tool(
    'smartware_session_end',
    'End an active session',
    {
      actor_id: z.string().describe('Session actor ID, or owner ID for administrative access'),
      session_id: z.string().describe('Session ID to end'),
    },
    async (args) => wrap(async () => {
      return handleSessionEnd(
        { actor_id: args.actor_id, session_id: args.session_id, opsDir },
        sessionStore,
        loadConfig(dataDir),
      );
    }, 'session_end'),
  );

  // ── Tool: smartware_status ─────────────────────────────────────────────────
  server.tool(
    'smartware_status',
    'Get system status (owner only)',
    {
      actor_id: z.string().describe('Owner actor ID'),
    },
    async (args) => wrap(async () => {
      const freshConfig = loadConfig(dataDir);
      return handleStatus(
        { actor: { type: 'person', id: args.actor_id, display_name: args.actor_id } },
        layer0,
        store,
        searchIndex,
        wikiDir,
        freshConfig,
      );
    }, 'status'),
  );

  // ── Start server ──────────────────────────────────────────────────────────
  // Background compile loop: drain the durable queue on an interval so raw
  // observations compound into claims without blocking the write path. The
  // timer is unref'd — it never holds the stdio server open by itself.
  const compileWorker = compileQueueState
    ? startCompileWorker({
        evidenceDir,
        dataDir,
        layer0,
        store,
        searchIndex,
        config,
        opsDir,
        queue: compileQueueState.queue,
        fingerprintIndex: compileQueueState.fingerprintIndex,
      }, { intervalMs: 1000 })
    : null;

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Smartware MCP server started');

  // Graceful shutdown
  process.on('SIGINT', () => {
    compileWorker?.stop();
    compileQueueState?.queue.close();
    compileQueueState?.fingerprintIndex.close();
    layer0.close();
    store.close();
    searchIndex.close();
    sessionStore.close();
    process.exit(0);
  });
}

start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
