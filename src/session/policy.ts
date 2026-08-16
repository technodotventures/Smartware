// Session — Trust resolution and policy matrix
//
// Maps declared trust levels to effective policy. The server may downgrade
// the declared trust level if evidence doesn't support it (e.g., no grant,
// unknown client).

import type { TrustLevel, EffectivePolicy, ClientCapabilities } from './types.js';
import type { SmartwareConfig, Grant } from '../config.js';
import { getGrantForActor, isOwner } from '../auth/grants.js';

/** Default session duration by trust level (in hours) */
const SESSION_DURATION_HOURS: Record<TrustLevel, number> = {
  verified: 24,
  user_facing: 12,
  background_agent: 4,
  untrusted: 1,
};

/** Policy matrix: effective policy per trust level */
const POLICY_MATRIX: Record<TrustLevel, EffectivePolicy> = {
  verified: {
    write_mode: 'auto',
    read_mode: 'always',
    sensitive_handling: 'allowed',
    default_scope_routing: {},
    write_async: false,
  },
  user_facing: {
    write_mode: 'durable_summary',
    read_mode: 'on_demand',
    sensitive_handling: 'confirm_via_client',
    default_scope_routing: {},
    write_async: false,
  },
  background_agent: {
    write_mode: 'explicit_only',
    read_mode: 'on_demand',
    sensitive_handling: 'server_redact',
    default_scope_routing: {},
    write_async: true,
  },
  untrusted: {
    write_mode: 'off',
    read_mode: 'off',
    sensitive_handling: 'never',
    default_scope_routing: {},
    write_async: true,
  },
};

export interface TrustResolution {
  effective_trust_level: TrustLevel;
  effective_policy: EffectivePolicy;
  actor_id: string;
  capabilities_granted: string[];
  expires_at: string;
  downgrade_reason?: string;
}

/**
 * Resolve the effective trust level and policy for a session start request.
 *
 * Rules:
 * 1. Owner with declared "verified" → verified (full access)
 * 2. Actor with trusted grant + declared "verified"/"user_facing" → honour declaration
 * 3. Actor with grant but not trusted → cap at "user_facing"
 * 4. Actor with no grant → downgrade to "untrusted"
 * 5. Unknown actor claiming "verified" without proof → "untrusted"
 */
export function resolveTrust(
  clientId: string,
  declaredTrust: TrustLevel,
  declaredCapabilities: ClientCapabilities,
  actorId: string,
  requestedScopes: string[],
  config: SmartwareConfig,
): TrustResolution {
  const now = new Date();

  // Owner always gets what they declare (minimum: verified)
  if (isOwner(actorId, config)) {
    const effectiveLevel = declaredTrust;
    const durationHours = SESSION_DURATION_HOURS[effectiveLevel];
    const expiresAt = new Date(now.getTime() + durationHours * 3600_000).toISOString();

    return {
      effective_trust_level: effectiveLevel,
      effective_policy: { ...POLICY_MATRIX[effectiveLevel] },
      actor_id: actorId,
      capabilities_granted: ['observe', 'query', 'read', 'compile', 'correct', 'forget'],
      expires_at: expiresAt,
    };
  }

  // Look up the actor's grant
  const grant = getGrantForActor(actorId, config);

  if (!grant) {
    // No grant → untrusted, regardless of what they claim
    const durationHours = SESSION_DURATION_HOURS['untrusted'];
    const expiresAt = new Date(now.getTime() + durationHours * 3600_000).toISOString();

    return {
      effective_trust_level: 'untrusted',
      effective_policy: { ...POLICY_MATRIX['untrusted'] },
      actor_id: actorId,
      capabilities_granted: [],
      expires_at: expiresAt,
      downgrade_reason: `No active grant for actor '${actorId}'`,
    };
  }

  // Has grant — resolve effective level
  let effectiveLevel = declaredTrust;
  let downgradeReason: string | undefined;

  if (grant.trusted) {
    // Trusted grant: honour declared level (verified or user_facing)
    // but background_agent stays background_agent
  } else {
    // Non-trusted grant: cap at user_facing
    if (effectiveLevel === 'verified') {
      effectiveLevel = 'user_facing';
      downgradeReason = `Grant for '${actorId}' is not marked trusted — capped at user_facing`;
    }
  }

  // If grant has quarantine flag, cap at background_agent
  if (grant.quarantine && (effectiveLevel === 'verified' || effectiveLevel === 'user_facing')) {
    effectiveLevel = 'background_agent';
    downgradeReason = `Grant for '${actorId}' has quarantine=true — capped at background_agent`;
  }

  // Compute capabilities from grant
  const caps = resolveCapabilities(grant, requestedScopes);

  const durationHours = SESSION_DURATION_HOURS[effectiveLevel];
  const expiresAt = new Date(now.getTime() + durationHours * 3600_000).toISOString();

  return {
    effective_trust_level: effectiveLevel,
    effective_policy: { ...POLICY_MATRIX[effectiveLevel] },
    actor_id: actorId,
    capabilities_granted: caps,
    expires_at: expiresAt,
    downgrade_reason: downgradeReason,
  };
}

/** Compute which capabilities are available for the requested scopes */
function resolveCapabilities(grant: Grant, requestedScopes: string[]): string[] {
  const ops: (keyof Grant['capabilities'])[] = ['observe', 'query', 'read', 'compile', 'correct', 'forget'];
  const granted: string[] = [];

  for (const op of ops) {
    const allowedScopes = grant.capabilities[op] ?? [];
    // If any requested scope is covered, grant this capability
    if (allowedScopes.includes('*') || requestedScopes.some(rs => allowedScopes.some(as => scopeCovers(as, rs)))) {
      granted.push(op);
    }
  }

  return granted;
}

function scopeCovers(pattern: string, target: string): boolean {
  if (pattern === '*') return true;
  if (pattern === target) return true;
  if (pattern.endsWith('/*') && target.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

export function getSessionDurationHours(level: TrustLevel): number {
  return SESSION_DURATION_HOURS[level];
}
