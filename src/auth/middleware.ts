// Auth — Per-tool auth check middleware

import type { SmartwareConfig } from '../config.js';
import type { Grant } from './grants.js';
import { checkGrant, isOwner, getGrantForActor } from './grants.js';

export class ProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * Require a grant for an operation on a scope.
 * Owners bypass all grant checks.
 * Throws ProtocolError if insufficient permission.
 */
export function requireGrant(
  actorId: string,
  operation: keyof Grant['capabilities'],
  scope: string,
  config: SmartwareConfig,
): void {
  if (isOwner(actorId, config)) return;
  if (!checkGrant(actorId, operation, scope, config)) {
    throw new ProtocolError(
      'insufficient_permission',
      `Actor '${actorId}' does not have '${operation}' permission for scope '${scope}'`,
    );
  }
}

/**
 * Require that the actor is the owner.
 * Throws ProtocolError if not.
 */
export function requireOwner(actorId: string, config: SmartwareConfig): void {
  if (!isOwner(actorId, config)) {
    throw new ProtocolError(
      'owner_required',
      `This operation requires owner privileges. Actor '${actorId}' is not the owner.`,
    );
  }
}

/**
 * Resolve the actor's grant (or null if no grant exists).
 * Note: for owners, returns null (they bypass grant checks anyway).
 */
export function resolveGrant(actorId: string, config: SmartwareConfig): Grant | null {
  if (isOwner(actorId, config)) return null;
  return getGrantForActor(actorId, config);
}

/**
 * Spec-conformant ACCESS decision per Protocol Contract v0.4.1 + Errors and
 * Recovery v0.1.1. Returns a structured allow/deny rather than throwing,
 * so the /pod/access route can surface the same envelope ACCESS expects.
 *
 *   - Owner → allow (AC-01)
 *   - Registered actor with required capability covering scope → allow (AC-02)
 *   - Registered actor outside capability or scope → deny (AC-03, AC-05)
 *   - Unregistered actor → deny with code `actor_unregistered` (AC-04)
 *
 * `forbidden` is a generic deny; `actor_unregistered` is its more-specific
 * counterpart for the no-grant case so consumers can surface the right UX.
 */
export type AccessOperation = keyof Grant['capabilities'];

export interface AccessDecision {
  decision: 'allow' | 'deny';
  reason: string;
  /** Spec error code when deny; undefined when allow. */
  code?: 'forbidden' | 'actor_unregistered';
}

/**
 * Reject writes from unregistered actors. An actor is registered if they
 * are the owner or have any active grant. Throws ProtocolError with code
 * `actor_unregistered` if not.
 */
export function requireRegisteredActor(actorId: string, config: SmartwareConfig): void {
  if (isOwner(actorId, config)) return;
  if (!getGrantForActor(actorId, config)) {
    throw new ProtocolError(
      'actor_unregistered',
      `Actor '${actorId}' is not registered with this Pod.`,
    );
  }
}

export function evaluateAccess(
  actorId: string,
  operation: AccessOperation,
  scope: string,
  config: SmartwareConfig,
): AccessDecision {
  if (isOwner(actorId, config)) {
    return { decision: 'allow', reason: 'Pod owner bypasses grant checks.' };
  }
  const grant = getGrantForActor(actorId, config);
  if (!grant) {
    return {
      decision: 'deny',
      reason: `Actor '${actorId}' is not registered with this Pod.`,
      code: 'actor_unregistered',
    };
  }
  if (!checkGrant(actorId, operation, scope, config)) {
    const granted = grant.capabilities[operation] ?? [];
    return {
      decision: 'deny',
      reason:
        granted.length === 0
          ? `Actor '${actorId}' has no '${operation}' capability.`
          : `Actor '${actorId}' has '${operation}' capability but not for scope '${scope}'.`,
      code: 'forbidden',
    };
  }
  return { decision: 'allow', reason: `Grant ${grant.id} authorises '${operation}' on '${scope}'.` };
}
