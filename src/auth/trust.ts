// Auth — Trust determination rules

import type { Actor } from '../layer0/types.js';
import type { Grant } from './grants.js';

/**
 * Determine whether an observation from this actor should be quarantined.
 *
 * Rules:
 * - No grant → should never reach here (rejected at middleware), but return true as safety net
 * - grant.quarantine = true → force quarantine
 * - grant.trusted = true → do NOT quarantine
 * - Default: persons and agents are trusted; system actors are quarantined
 */
export function shouldQuarantine(_actor: Actor, grant: Grant | null): boolean {
  if (!grant) return true;
  if (grant.quarantine) return true;
  if (grant.trusted) return false;
  // Default: system actors quarantined, humans/agents trusted — keyed off the
  // grant's SERVER-RECORDED actor_type, not the client-supplied actor.type
  // (which an actor could spoof to dodge default quarantine).
  return grant.actor_type === 'system';
}

/**
 * Quarantine decision across all grants that authorise a given operation+scope.
 * Using the scope-relevant grants (not an arbitrary "first" grant) stops a
 * trusted grant on one scope from silently trusting observations into another.
 * Precedence: any explicit quarantine → hold; else any trusted → accept; else
 * default by recorded actor type. Empty set → hold (safety net).
 */
export function quarantineForGrants(grants: Grant[]): boolean {
  if (grants.length === 0) return true;
  if (grants.some(g => g.quarantine)) return true;
  if (grants.some(g => g.trusted)) return false;
  return grants.some(g => g.actor_type === 'system');
}

/**
 * Determine if the actor is allowed to bypass a minimum confidence threshold.
 * Owners and trusted actors can query lower-confidence claims.
 */
export function canQueryLowConfidence(grant: Grant | null): boolean {
  if (!grant) return false;
  return grant.trusted;
}
