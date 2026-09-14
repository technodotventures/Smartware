// MCP Adapter — exposes SmartwareCore without owning protocol state.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ProtocolError } from './auth/middleware.js';
import { SmartwareCore } from './core.js';
import type { Actor } from './layer0/types.js';
import { SMARTWARE_VERSION } from './version.js';

export interface SmartwareMcpServerOptions {
  handler_timeout_ms?: number;
  on_error?: (message: string) => void;
}

type McpContent = {
  content: [{ type: 'text'; text: string }];
  isError?: boolean;
};

function actor(
  id: string,
  type: Actor['type'] = 'agent',
  displayName = id,
): Actor {
  return { type, id, display_name: displayName };
}

function requireIdentity(actorId?: string, sessionId?: string): string {
  if (!actorId && !sessionId) {
    throw new ProtocolError(
      'invalid_parameter',
      'Either actor_id or session_id is required',
    );
  }
  return actorId ?? 'agent:session';
}

/**
 * Build the MCP transport Adapter over a caller-owned SmartwareCore.
 *
 * The Core remains the single protocol Implementation and lifecycle owner;
 * importing this Module has no filesystem or transport side effects.
 */
export function createSmartwareMcpServer(
  core: SmartwareCore,
  options: SmartwareMcpServerOptions = {},
): McpServer {
  const timeoutMs = options.handler_timeout_ms ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('MCP handler timeout must be a positive number');
  }
  const reportError = options.on_error ?? (message => console.error(message));
  const server = new McpServer({ name: 'smartware', version: SMARTWARE_VERSION });

  async function wrap<T>(fn: () => Promise<T>, label: string): Promise<McpContent> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Handler '${label}' timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: error.code,
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            }),
          }],
          isError: true,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      reportError(`[smartware] Handler error (${label}): ${message}`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'internal_error', message }),
        }],
        isError: true,
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

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
    async args => wrap(() => core.context({
      actor_id: args.actor_id,
      query: args.query,
      scope: args.scope,
      include_forgotten: args.include_forgotten,
      include_superseded: args.include_superseded,
      limit: args.limit,
    }), 'context'),
  );

  server.tool(
    'smartware_observe',
    'Record an observation into the evidence log',
    {
      actor_id: z.string().optional()
        .describe('Actor ID (or use session_id for server-resolved identity)'),
      actor_type: z.enum(['person', 'agent', 'system']).default('agent'),
      actor_display_name: z.string().default('Agent'),
      type: z.enum([
        'message',
        'file',
        'meeting',
        'preference',
        'decision',
        'tool_output',
        'feedback',
        'system',
      ]).default('message'),
      content_format: z.enum([
        'text/markdown',
        'text/plain',
        'application/json',
      ]).default('text/plain'),
      content_body: z.string(),
      scope: z.string(),
      visibility: z.enum(['private', 'scope', 'workspace', 'public']).default('scope'),
      source_id: z.string().optional(),
      source_ref: z.string().optional()
        .describe('Registered source id (provenance origin). Unknown/inactive sources are denied.'),
      observed_at: z.string().optional(),
      informed_by: z.array(z.string()).optional(),
      sensitive: z.boolean().default(false),
      session_id: z.string().optional(),
      operation_id: z.string().optional(),
    },
    async args => wrap(() => {
      const actorId = requireIdentity(args.actor_id, args.session_id);
      return core.observe({
        actor: actor(actorId, args.actor_type, args.actor_display_name),
        type: args.type,
        content: { format: args.content_format, body: args.content_body },
        scope: args.scope,
        visibility: args.visibility,
        source_id: args.source_id,
        source_ref: args.source_ref,
        observed_at: args.observed_at,
        informed_by: args.informed_by,
        sensitive: args.sensitive,
        session_id: args.session_id,
        operation_id: args.operation_id,
      });
    }, 'observe'),
  );

  server.tool(
    'smartware_recall',
    'Recall authorized, current Smartware claims',
    {
      actor_id: z.string().optional(),
      session_id: z.string().optional(),
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
      delivery_mode: z.enum([
        'inline',
        'file_reference',
        'context_bundle',
      ]).default('inline'),
      as_of: z.string().optional(),
    },
    async args => wrap(() => {
      const actorId = requireIdentity(args.actor_id, args.session_id);
      return core.recall({
        actor: actor(actorId),
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
      });
    }, 'recall'),
  );

  server.tool(
    'smartware_query',
    'Query the knowledge base using full-text search',
    {
      actor_id: z.string().optional(),
      session_id: z.string().optional(),
      query: z.string(),
      scope: z.string(),
      min_confidence: z.number().min(0).max(1).optional(),
      epistemic: z.array(z.string()).optional(),
      include_sensitive: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async args => wrap(() => {
      const actorId = requireIdentity(args.actor_id, args.session_id);
      return core.query({
        actor: actor(actorId),
        session_id: args.session_id,
        query: args.query,
        scope: args.scope,
        min_confidence: args.min_confidence,
        epistemic: args.epistemic,
        include_sensitive: args.include_sensitive,
        limit: args.limit,
      });
    }, 'query'),
  );

  const compilationShape = {
    actor_id: z.string(),
    scope: z.string().optional(),
    entity_id: z.string().optional(),
    use_llm: z.boolean().default(false),
    operation_id: z.string(),
  };
  const compile = (args: {
    actor_id: string;
    scope?: string;
    entity_id?: string;
    use_llm: boolean;
    operation_id: string;
  }) => core.compile({
    actor: actor(args.actor_id),
    scope: args.scope,
    entity_id: args.entity_id,
    use_llm: args.use_llm,
    operation_id: args.operation_id,
  });
  server.tool(
    'smartware_reflect',
    'Reflect accepted evidence into derived claims and projections',
    compilationShape,
    async args => wrap(() => compile(args), 'reflect'),
  );
  server.tool(
    'smartware_compile',
    'Compile knowledge into markdown wiki pages',
    compilationShape,
    async args => wrap(() => compile(args), 'compile'),
  );

  server.tool(
    'smartware_read',
    'Read a compiled wiki page for an entity, or browse a scope',
    {
      actor_id: z.string().optional(),
      session_id: z.string().optional(),
      entity_id: z.string().optional(),
      entity_name: z.string().optional(),
      scope: z.string().optional(),
      resolution: z.enum(['oneliner', 'paragraph', 'full']).default('full'),
      include_sensitive: z.boolean().default(false),
    },
    async args => wrap(() => {
      const actorId = requireIdentity(args.actor_id, args.session_id);
      return core.read({
        actor: actor(actorId),
        session_id: args.session_id,
        entity_id: args.entity_id,
        entity_name: args.entity_name,
        scope: args.scope,
        resolution: args.resolution,
        include_sensitive: args.include_sensitive,
      });
    }, 'read'),
  );

  server.tool(
    'smartware_explain',
    'Trace claim or entity provenance',
    {
      actor_id: z.string(),
      claim_id: z.string().optional(),
      entity_id: z.string().optional(),
    },
    async args => wrap(() => core.explain({
      actor: actor(args.actor_id),
      claim_id: args.claim_id,
      entity_id: args.entity_id,
    }), 'explain'),
  );

  server.tool(
    'smartware_correct',
    'Correct an existing claim',
    {
      actor_id: z.string(),
      target_claim_id: z.string(),
      corrected_predicate: z.string().optional(),
      corrected_object_type: z.string().optional(),
      corrected_object_value: z.string().optional(),
      reason: z.enum([
        'changed',
        'wrong',
        'extraction_error',
        'duplicate',
      ]).default('changed'),
    },
    async args => wrap(() => core.correct({
      actor: actor(args.actor_id, 'person'),
      target_claim_id: args.target_claim_id,
      corrected_predicate: args.corrected_predicate,
      corrected_object: args.corrected_object_type && args.corrected_object_value
        ? { type: args.corrected_object_type, value: args.corrected_object_value }
        : undefined,
      reason: args.reason,
    }), 'correct'),
  );

  server.tool(
    'smartware_revise',
    'Revise claim admission metadata and relations',
    {
      actor_id: z.string(),
      target: z.string(),
      expected_base_version: z.number(),
      set_confidence: z.enum(['high', 'medium', 'low']).optional(),
      set_epistemic_tag: z.enum([
        'fact',
        'inference',
        'opinion',
        'stale',
        'contested',
      ]).optional(),
      adopt_body: z.boolean().optional(),
      reason: z.string(),
      operation_id: z.string(),
    },
    async args => wrap(() => core.revise({
      actor: actor(args.actor_id, 'person'),
      target: args.target,
      expected_base_version: args.expected_base_version,
      set_confidence: args.set_confidence,
      set_epistemic_tag: args.set_epistemic_tag,
      adopt_body: args.adopt_body,
      reason: args.reason,
      operation_id: args.operation_id,
    }), 'revise'),
  );

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
    async args => wrap(() => core.forget({
      actor: actor(args.actor_id, 'person'),
      target: { type: 'observation', id: args.target_obs_id },
      mode: args.mode,
      reason: args.reason,
      operation_id: args.operation_id,
    }), 'forget'),
  );

  server.tool(
    'smartware_forget_scope',
    'Erase or offboard an entire client scope (owner only; protocol v0.5.0). reason=erasure purges content in every lane; reason=offboarding tombstones + revokes grants (reversible).',
    {
      actor_id: z.string(),
      scope: z.string().describe('Scope id, e.g. client:acme#1 (non-reusable marker)'),
      reason: z.enum(['erasure', 'offboarding']),
      operation_id: z.string(),
      owner_pointer: z.string().optional(),
      export_id: z.string().optional().describe('Optional export package id (exp_<ulid>) produced by smartware_export_scope before erasure; surfaced in the ops entry (details.export_id) for auditability'),
    },
    async args => wrap(() => core.forgetScope({
      actor: actor(args.actor_id, 'person'),
      scope: args.scope,
      reason: args.reason,
      operation_id: args.operation_id,
      owner_pointer: args.owner_pointer,
      export_id: args.export_id,
    }), 'forget_scope'),
  );

  server.tool(
    'smartware_export_scope',
    'Export every canonical record for exactly one scope (owner only; spec §10c.4). Package: <data_dir>/exports/<export_id>/ with observations/claims/evidence/operations/entities .jsonl + manifest.json; derived indexes excluded. Idempotent per operation_id. Read-only to pod data.',
    {
      actor_id: z.string(),
      scope: z.string().describe('Scope id, e.g. client:acme#1'),
      operation_id: z.string().optional().describe('Idempotency key — retry returns the same export_id'),
    },
    async args => wrap(() => core.exportScope({
      actor: actor(args.actor_id, 'person'),
      scope: args.scope,
      operation_id: args.operation_id,
    }), 'export_scope'),
  );

  server.tool(
    'smartware_restore_scope',
    'Restore an EXPORT.SCOPE package into this brain (owner only) — the return path for a package. Verifies the manifest checksums, refuses a non-empty target scope (restore, never merge) and refuses a package that crosses its scope boundary. Idempotent per package; derived indexes rebuild from the restored canonical records.',
    {
      actor_id: z.string(),
      package_dir: z.string().describe('Directory of an EXPORT.SCOPE package (contains manifest.json)'),
      operation_id: z.string().optional().describe('Idempotency key for this restore operation'),
    },
    async args => wrap(() => core.restoreScope({
      actor: actor(args.actor_id, 'person'),
      package_dir: args.package_dir,
      operation_id: args.operation_id,
    }), 'restore_scope'),
  );

  server.tool(
    'smartware_expire_retention',
    'Retention expiry sweep (ADR-0001). Tombstones elapsed duration-policy observations in one scope and retracts their sole-evidence claims. Idempotent; host-triggered like compile. Requires a forget grant on the scope (or owner).',
    {
      actor_id: z.string(),
      scope: z.string().describe('Scope id to sweep'),
      operation_id: z.string().optional().describe('Idempotency key — retry returns the same counts'),
      as_of: z.string().optional().describe('ISO 8601 instant to evaluate expiry against (default: now)'),
    },
    async args => wrap(() => core.expireRetention({
      actor: actor(args.actor_id, 'person'),
      scope: args.scope,
      operation_id: args.operation_id,
      as_of: args.as_of,
    }), 'expire_retention'),
  );

  server.tool(
    'smartware_consolidate',
    'Consolidate 2+ active claims into one reviewed current-understanding claim (ADR-0002). Preserves evidence lineage; tombstones inputs. User-only.',
    {
      actor_id: z.string(),
      claim_ids: z.array(z.string()).min(2).describe('2+ active claim ids to consolidate'),
      summary: z.string().describe('Human/LLM-authored, human-reviewed consolidated text'),
      subject_name: z.string(),
      predicate: z.string(),
      scope: z.string(),
      reason: z.string().optional(),
      operation_id: z.string(),
    },
    async args => wrap(() => core.consolidate({
      actor: actor(args.actor_id, 'person'),
      claim_ids: args.claim_ids,
      summary: args.summary,
      subject_name: args.subject_name,
      predicate: args.predicate,
      scope: args.scope,
      reason: args.reason,
      operation_id: args.operation_id,
    }), 'consolidate'),
  );

  server.tool(
    'smartware_quarantine_review',
    'Approve or reject quarantined evidence',
    {
      actor_id: z.string(),
      target_obs_id: z.string(),
      action: z.enum(['approve', 'reject']),
      reason: z.string().optional(),
    },
    async args => wrap(() => core.quarantineReview({
      actor: actor(args.actor_id, 'person'),
      target_obs_id: args.target_obs_id,
      action: args.action,
      reason: args.reason,
    }), 'quarantine_review'),
  );

  server.tool(
    'smartware_grant',
    'Grant actor capabilities',
    {
      actor_id: z.string(),
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
    async args => wrap(() => core.grant({
      actor: actor(args.actor_id, 'person'),
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
    }), 'grant'),
  );

  server.tool(
    'smartware_revoke',
    'Revoke a grant',
    {
      actor_id: z.string(),
      grant_id: z.string(),
      reason: z.string().optional(),
    },
    async args => wrap(() => core.revoke({
      actor: actor(args.actor_id, 'person'),
      grant_id: args.grant_id,
      reason: args.reason,
    }), 'revoke'),
  );

  server.tool(
    'smartware_session_start',
    'Start a server-anchored session',
    {
      actor_id: z.string(),
      client_id: z.string(),
      client_version: z.string(),
      declared_trust_level: z.enum([
        'verified',
        'user_facing',
        'background_agent',
        'untrusted',
      ]).default('user_facing'),
      can_tag_sensitivity: z.boolean().default(false),
      can_provide_intent: z.boolean().default(false),
      can_request_user_confirmation: z.boolean().default(false),
      requested_scopes: z.array(z.string()).optional(),
    },
    async args => wrap(() => core.sessionStart({
      actor: actor(args.actor_id),
      client_id: args.client_id,
      client_version: args.client_version,
      declared_trust_level: args.declared_trust_level,
      declared_capabilities: {
        can_tag_sensitivity: args.can_tag_sensitivity,
        can_provide_intent: args.can_provide_intent,
        can_request_user_confirmation: args.can_request_user_confirmation,
      },
      requested_scopes: args.requested_scopes,
    }), 'session_start'),
  );

  server.tool(
    'smartware_session_describe',
    'Describe a session',
    {
      actor_id: z.string(),
      session_id: z.string(),
    },
    async args => wrap(
      () => core.sessionDescribe(args.actor_id, args.session_id),
      'session_describe',
    ),
  );

  server.tool(
    'smartware_session_end',
    'End an active session',
    {
      actor_id: z.string(),
      session_id: z.string(),
    },
    async args => wrap(
      () => core.sessionEnd(args.actor_id, args.session_id),
      'session_end',
    ),
  );

  server.tool(
    'smartware_status',
    'Get system status',
    { actor_id: z.string() },
    async args => wrap(() => core.status(args.actor_id), 'status'),
  );

  // ── Source registry, ingestion and federation (P0 shared-workspace contract) ──

  server.tool(
    'smartware_register_source',
    'Register or update a provenance source (owner only). Sources label where evidence came from: connector, meeting, note, agent, manual, system. Re-registering an id updates the entry; status=paused/revoked refuses new writes while keeping recorded history.',
    {
      actor_id: z.string().describe('Owner actor id'),
      source_id: z.string().describe('Stable host-chosen id, e.g. src_gmail_ava'),
      kind: z.enum(['connector', 'meeting', 'note', 'agent', 'manual', 'system']),
      display_name: z.string(),
      status: z.enum(['active', 'paused', 'revoked']).default('active'),
      actor_ids: z.array(z.string()).optional()
        .describe('Optional allow-list: only these actors may write under this source'),
      external_ref: z.string().optional()
        .describe('Opaque host-side handle (mailbox / account / calendar id)'),
    },
    async args => wrap(async () => core.registerSource({
      actor: actor(args.actor_id, 'person'),
      id: args.source_id,
      kind: args.kind,
      display_name: args.display_name,
      status: args.status,
      actor_ids: args.actor_ids,
      external_ref: args.external_ref,
    }), 'register_source'),
  );

  server.tool(
    'smartware_list_sources',
    'List the registered provenance sources of this brain (owner only)',
    { actor_id: z.string() },
    async args => wrap(async () => core.listSources({ actor: actor(args.actor_id, 'person') }), 'list_sources'),
  );

  server.tool(
    'smartware_ingest',
    'Ingest one batch of source-native items (connector polling loop). The actor must hold an observe grant on the scope and the source must be registered and active. Items dedup by (source, external_id, scope); replaying an operation_id returns the recorded receipt. Item-level failures are reported per item and never wedge the batch.',
    {
      actor_id: z.string(),
      actor_type: z.enum(['person', 'agent', 'system']).default('agent'),
      actor_display_name: z.string().default('Connector'),
      source_id: z.string().describe('Registered source id'),
      scope: z.string(),
      cursor: z.string().describe('Opaque stream checkpoint AFTER this batch (stored verbatim)'),
      operation_id: z.string().describe('ULID idempotency key for this batch'),
      app: z.string().optional().describe('Observation app override (default: the source id)'),
      items: z.array(z.object({
        external_id: z.string().describe('Source-native item id (dedup key)'),
        type: z.enum([
          'message', 'file', 'meeting', 'preference', 'decision', 'tool_output', 'feedback', 'system',
        ]).default('message'),
        content_format: z.enum(['text/markdown', 'text/plain', 'application/json']).default('text/plain'),
        content_body: z.string(),
        observed_at: z.string().optional(),
        visibility: z.enum(['private', 'scope', 'workspace', 'public']).optional(),
        sensitive: z.boolean().default(false),
      })).max(500),
    },
    async args => wrap(() => core.ingest({
      actor: actor(args.actor_id, args.actor_type, args.actor_display_name),
      source_id: args.source_id,
      scope: args.scope,
      cursor: args.cursor,
      operation_id: args.operation_id,
      app: args.app,
      items: args.items.map(item => ({
        external_id: item.external_id,
        type: item.type,
        content: { format: item.content_format, body: item.content_body },
        observed_at: item.observed_at,
        visibility: item.visibility,
        sensitive: item.sensitive,
      })),
    }), 'ingest'),
  );

  server.tool(
    'smartware_sync_status',
    'Per-source, per-scope sync status: stream cursor, last sync, and batch outcome counts (owner only)',
    {
      actor_id: z.string(),
      source_id: z.string().optional().describe('Limit to one registered source'),
    },
    async args => wrap(
      async () => core.sourceSyncStatus({ actor: actor(args.actor_id, 'person'), source_id: args.source_id }),
      'sync_status',
    ),
  );

  server.tool(
    'smartware_recall_federated',
    'Recall across multiple scopes in one call. Named scopes must all be readable by the actor or the whole read denies; omitted scopes federate over exactly the actor\'s readable scopes. Results are scope-tagged.',
    {
      actor_id: z.string().optional(),
      session_id: z.string().optional(),
      query: z.string().min(1),
      scopes: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      include_stale: z.boolean().default(false),
      include_forgotten: z.boolean().default(false),
      include_superseded: z.boolean().default(false),
      include_sensitive: z.boolean().default(false),
    },
    async args => wrap(() => {
      const actorId = requireIdentity(args.actor_id, args.session_id);
      return core.recallFederated({
        actor: actor(actorId),
        query: args.query,
        scopes: args.scopes,
        limit: args.limit,
        include_stale: args.include_stale,
        include_forgotten: args.include_forgotten,
        include_superseded: args.include_superseded,
        include_sensitive: args.include_sensitive,
      });
    }, 'recall_federated'),
  );

  return server;
}
