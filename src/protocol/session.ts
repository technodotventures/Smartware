// Protocol — SESSION handlers (start, describe, end)
//
// Server-anchored sessions replace client-supplied actor_id.
// Clients declare trust level; server resolves effective policy.

import { ulid } from 'ulid';
import type { Actor } from '../layer0/types.js';
import type { SmartwareConfig } from '../config.js';
import type { SessionStore } from '../session/store.js';
import type { TrustLevel, ClientCapabilities, Session } from '../session/types.js';
import { resolveTrust } from '../session/policy.js';
import { ProtocolError } from '../auth/middleware.js';
import { isOwner } from '../auth/grants.js';
import { appendOpLogEntry } from '../ops_log/log.js';
import { OPERATION_ID_PATTERN } from '../ops_log/types.js';
import { SMARTWARE_VERSION } from '../version.js';

const POLICY_VERSION = SMARTWARE_VERSION;

// ── session_start ──────────────────────────────────────────────────────────

export interface SessionStartParams {
  actor: Actor;
  client_id: string;
  client_version: string;
  declared_trust_level: TrustLevel;
  declared_capabilities: ClientCapabilities;
  requested_scopes?: string[];
  opsDir?: string;
}

export interface SessionStartResult {
  session_id: string;
  actor_id: string;
  effective_trust_level: TrustLevel;
  effective_policy: Session['effective_policy'];
  capabilities_granted: string[];
  policy_version: string;
  expires_at: string;
  downgrade_reason?: string;
  snapshot_frozen_at?: string;
}

export async function handleSessionStart(
  params: SessionStartParams,
  sessionStore: SessionStore,
  config: SmartwareConfig,
): Promise<SessionStartResult> {
  if (!params.client_id?.trim()) {
    throw new ProtocolError('invalid_params', 'client_id is required');
  }

  const requestedScopes = params.requested_scopes ?? config.scopes.map(s => s.id);

  // Resolve trust and effective policy
  const resolution = resolveTrust(
    params.client_id,
    params.declared_trust_level,
    params.declared_capabilities,
    params.actor.id,
    requestedScopes,
    config,
  );

  const now = new Date().toISOString();
  const session: Session = {
    id: `session_${ulid()}`,
    client_id: params.client_id,
    client_version: params.client_version,
    actor_id: resolution.actor_id,
    declared_trust_level: params.declared_trust_level,
    effective_trust_level: resolution.effective_trust_level,
    declared_capabilities: params.declared_capabilities,
    effective_policy: resolution.effective_policy,
    requested_scopes: requestedScopes,
    capabilities_granted: resolution.capabilities_granted,
    policy_version: POLICY_VERSION,
    created_at: now,
    expires_at: resolution.expires_at,
    ended_at: null,
    status: 'active',
  };

  sessionStore.insert(session);

  if (params.opsDir) {
    const opId = `op_${ulid()}`;
    try {
      appendOpLogEntry(params.opsDir, {
        operation_id: opId,
        actor_id: session.actor_id,
        timestamp: now,
        op: 'session.start',
        details: { session_id: session.id, trust_level: session.effective_trust_level },
      });
    } catch { /* best-effort */ }
  }

  return {
    session_id: session.id,
    actor_id: session.actor_id,
    effective_trust_level: session.effective_trust_level,
    effective_policy: session.effective_policy,
    capabilities_granted: session.capabilities_granted,
    policy_version: session.policy_version,
    expires_at: session.expires_at,
    downgrade_reason: resolution.downgrade_reason,
    snapshot_frozen_at: now,
  };
}

// ── session_describe ───────────────────────────────────────────────────────

export interface SessionDescribeParams {
  session_id: string;
  actor_id: string;
}

export interface SessionDescribeResult {
  session_id: string;
  client_id: string;
  actor_id: string;
  effective_trust_level: TrustLevel;
  effective_policy: Session['effective_policy'];
  capabilities_granted: string[];
  status: Session['status'];
  created_at: string;
  expires_at: string;
  ended_at: string | null;
}

export async function handleSessionDescribe(
  params: SessionDescribeParams,
  sessionStore: SessionStore,
  config: SmartwareConfig,
): Promise<SessionDescribeResult> {
  const session = sessionStore.get(params.session_id);
  if (!session) {
    throw new ProtocolError('session_not_found', `Session '${params.session_id}' not found`);
  }
  requireSessionOwner(params.actor_id, session, config);

  return {
    session_id: session.id,
    client_id: session.client_id,
    actor_id: session.actor_id,
    effective_trust_level: session.effective_trust_level,
    effective_policy: session.effective_policy,
    capabilities_granted: session.capabilities_granted,
    status: session.status,
    created_at: session.created_at,
    expires_at: session.expires_at,
    ended_at: session.ended_at,
  };
}

// ── session_end ────────────────────────────────────────────────────────────

export interface SessionEndParams {
  session_id: string;
  actor_id: string;
  opsDir?: string;
  onSummarize?: (scope: string, actorId: string) => Promise<number>;
}

export interface SessionEndResult {
  session_id: string;
  status: 'ended';
  summary?: {
    write_mode: string;
    durability: 'not_requested' | 'not_configured' | 'persisted' | 'failed';
    claims_persisted?: number;
    sensitive_filtered: boolean;
  };
}

export async function handleSessionEnd(
  params: SessionEndParams,
  sessionStore: SessionStore,
  config: SmartwareConfig,
): Promise<SessionEndResult> {
  const session = sessionStore.get(params.session_id);
  if (!session) {
    throw new ProtocolError('session_not_found', `Session '${params.session_id}' not found`);
  }
  requireSessionOwner(params.actor_id, session, config);

  if (session.status !== 'active') {
    throw new ProtocolError('session_inactive', `Session '${params.session_id}' is already ${session.status}`);
  }

  const writeMode = session.effective_policy.write_mode;
  const sensitiveHandling = session.effective_policy.sensitive_handling;
  let claimsPersisted = 0;
  let durability: NonNullable<SessionEndResult['summary']>['durability'] = 'not_requested';
  let sensitiveFiltered = false;

  if (writeMode === 'off') {
    // No persistence
  } else if (writeMode === 'explicit_only') {
    // Only explicitly-marked claims persisted — caller is responsible
  } else if (writeMode === 'durable_summary' || writeMode === 'auto') {
    if (params.onSummarize) {
      try {
        const scope = session.requested_scopes[0] ?? 'personal';
        claimsPersisted = await params.onSummarize(scope, session.actor_id);
        durability = 'persisted';
      } catch {
        // Summarization failure is non-fatal
        durability = 'failed';
      }
    } else {
      durability = 'not_configured';
    }
  }

  if (sensitiveHandling === 'server_redact') {
    sensitiveFiltered = true;
  } else if (sensitiveHandling === 'never') {
    sensitiveFiltered = true;
  }

  sessionStore.end(params.session_id);

  if (params.opsDir) {
    const opId = `op_${ulid()}`;
    try {
      appendOpLogEntry(params.opsDir, {
        operation_id: opId,
        actor_id: session.actor_id,
        timestamp: new Date().toISOString(),
        op: 'session.end',
        details: { session_id: params.session_id },
      });
    } catch { /* best-effort */ }
  }

  return {
    session_id: params.session_id,
    status: 'ended',
    summary: {
      write_mode: writeMode,
      durability,
      ...(durability === 'persisted' ? { claims_persisted: claimsPersisted } : {}),
      sensitive_filtered: sensitiveFiltered,
    },
  };
}

// ── Session resolution helper ──────────────────────────────────────────────

/**
 * Resolve actor from session_id. Used by observe/query/read handlers
 * to look up server-resolved identity instead of trusting client-supplied actor_id.
 *
 * Returns null if session_id not provided (backward compat with actor_id flow).
 */
export function resolveActorFromSession(
  sessionId: string | undefined,
  sessionStore: SessionStore,
): {
  actor_id: string;
  effective_policy: Session['effective_policy'];
  requested_scopes: string[];
  capabilities_granted: string[];
} | null {
  if (!sessionId) return null;

  const session = sessionStore.getActive(sessionId);
  if (!session) {
    throw new ProtocolError('session_expired', `Session '${sessionId}' is not active or has expired`);
  }

  return {
    actor_id: session.actor_id,
    effective_policy: session.effective_policy,
    requested_scopes: [...session.requested_scopes],
    capabilities_granted: [...session.capabilities_granted],
  };
}

/**
 * Enforce the capability and scope constraints frozen into a server-anchored
 * session. Normal grant checks still run afterwards against current policy.
 */
export function requireSessionCapability(
  resolved: NonNullable<ReturnType<typeof resolveActorFromSession>>,
  capability: 'observe' | 'query' | 'read',
  scope: string,
): void {
  if (!resolved.capabilities_granted.includes(capability)) {
    throw new ProtocolError(
      'forbidden',
      `Session does not grant the '${capability}' capability`,
    );
  }
  if (!resolved.requested_scopes.some(requested => scopeCovers(requested, scope))) {
    throw new ProtocolError(
      'forbidden',
      `Scope '${scope}' was not requested for this session`,
    );
  }
}

function requireSessionOwner(
  actorId: string,
  session: Session,
  config: SmartwareConfig,
): void {
  if (actorId !== session.actor_id && !isOwner(actorId, config)) {
    throw new ProtocolError(
      'forbidden',
      `Actor '${actorId}' cannot manage session '${session.id}'`,
    );
  }
}

function scopeCovers(pattern: string, target: string): boolean {
  if (pattern === '*' || pattern === target) return true;
  return pattern.endsWith('/*') && target.startsWith(pattern.slice(0, -1));
}
