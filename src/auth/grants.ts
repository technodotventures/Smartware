// Auth — Grant table (CRUD, expiry check)

import { ulid } from 'ulid';
import type { Grant, SmartwareConfig } from '../config.js';
import { loadConfig, saveConfig } from '../config.js';
import type { ActorType } from '../layer0/types.js';

export type { Grant };

/**
 * Spec-conformant ActorId pattern per common.schema.json:
 *   ^(user|agent|sidecar|substrate):[a-z0-9-]+$
 *
 * Pre-PR-5 actor IDs (e.g. `person-local`, `coffee:<client-id>`,
 * `google-drive:connector`) do NOT match. The substrate accepts both
 * shapes during the migration window; PR-A4-alias-map (deferred) will
 * resolve legacy IDs through the alias map.
 */
export const ACTOR_ID_PATTERN = /^(user|agent|sidecar|substrate):[a-z0-9-]+$/;

export function isSpecConformantActorId(actorId: string): boolean {
  return ACTOR_ID_PATTERN.test(actorId);
}

export function isExpired(grant: Grant): boolean {
  if (!grant.expires_at) return false;
  return new Date(grant.expires_at) < new Date();
}

export function getActiveGrants(config: SmartwareConfig): Grant[] {
  return config.grants.filter(g => g.status === 'active' && !isExpired(g));
}

export function checkGrant(
  actorId: string,
  operation: keyof Grant['capabilities'],
  scope: string,
  config: SmartwareConfig,
): boolean {
  const grants = getActiveGrants(config);
  return grants.some(g => {
    if (g.actor_id !== actorId && g.actor_id !== '*') return false;
    const allowed = g.capabilities[operation] ?? [];
    return allowed.some(s => scopeMatches(s, scope));
  });
}

/** Owner can do anything */
export function isOwner(actorId: string, config: SmartwareConfig): boolean {
  return actorId === config.owner_id;
}

/** Check if a scope pattern matches a target scope */
function scopeMatches(pattern: string, target: string): boolean {
  if (pattern === '*') return true;
  if (pattern === target) return true;
  // wildcard suffix: "project/*" matches "project/foo"
  if (pattern.endsWith('/*') && target.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

export function createGrant(
  dataDir: string,
  input: {
    actor_type: ActorType;
    actor_id: string;
    capabilities: Grant['capabilities'];
    trusted?: boolean;
    quarantine?: boolean;
    expires_at?: string | null;
  },
): Grant {
  const config = loadConfig(dataDir);
  const grant: Grant = {
    id: `grant_${ulid()}`,
    actor_type: input.actor_type,
    actor_id: input.actor_id,
    capabilities: input.capabilities,
    trusted: input.trusted ?? false,
    quarantine: input.quarantine ?? false,
    created_at: new Date().toISOString(),
    expires_at: input.expires_at ?? null,
    status: 'active',
  };
  config.grants.push(grant);
  saveConfig(dataDir, config);
  return grant;
}

export function revokeGrant(dataDir: string, grantId: string): boolean {
  const config = loadConfig(dataDir);
  const grant = config.grants.find(g => g.id === grantId);
  if (!grant) return false;
  grant.status = 'revoked';
  saveConfig(dataDir, config);
  return true;
}

export function getGrantForActor(actorId: string, config: SmartwareConfig): Grant | null {
  return getActiveGrants(config).find(g => g.actor_id === actorId) ?? null;
}

/** All active grants that authorise `operation` on `scope` for this actor. */
export function getAuthorizingGrants(
  actorId: string,
  operation: keyof Grant['capabilities'],
  scope: string,
  config: SmartwareConfig,
): Grant[] {
  return getActiveGrants(config).filter(g =>
    (g.actor_id === actorId || g.actor_id === '*') &&
    (g.capabilities[operation] ?? []).some(s => scopeMatches(s, scope)),
  );
}
