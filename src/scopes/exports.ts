// Scopes — Personal preference exports

import type { SmartwareConfig, ScopeEntry } from '../config.js';

/**
 * Export rules define which personal-scope data is shared with other scopes.
 * For MVP this is a simple allow-list based on predicate patterns.
 */
export interface ExportRule {
  from_scope: string;
  to_scope: string;
  predicates: string[];  // predicate patterns, '*' = all
}

/**
 * Determine whether a claim in fromScope is visible to a query from toScope,
 * based on export rules.
 */
export function isExported(
  fromScope: string,
  toScope: string,
  predicate: string,
  config: SmartwareConfig,
): boolean {
  if (fromScope === toScope) return true;

  // Check if the scope visibility allows cross-scope access
  const scopeEntry = config.scopes.find(s => s.id === fromScope);
  if (!scopeEntry) return false;

  // Private scopes are never exported unless explicitly configured
  if (scopeEntry.visibility_default === 'private') return false;
  if (scopeEntry.visibility_default === 'public') return true;

  // Workspace/scope: accessible within the same parent
  // For MVP, use simple parent matching
  return false;
}

/**
 * Check if the effective visibility of a claim allows it to be returned
 * to an actor querying from a given scope.
 */
export function isVisibleToActor(
  claimScope: string,
  claimVisibility: string,
  querierScope: string,
  config: SmartwareConfig,
): boolean {
  if (claimScope === querierScope) return true;
  if (claimVisibility === 'public') return true;
  if (claimVisibility === 'private') return false;

  const scopeEntry = config.scopes.find(s => s.id === claimScope);
  if (!scopeEntry) return false;

  if (claimVisibility === 'workspace' || claimVisibility === 'scope') {
    // Check if they share a workspace parent
    const querierEntry = config.scopes.find(s => s.id === querierScope);
    if (!querierEntry) return false;

    // Same parent = siblings
    if (scopeEntry.parent && scopeEntry.parent === querierEntry.parent) return true;
    // Direct parent/child
    if (scopeEntry.parent === querierScope || querierEntry.parent === claimScope) return true;
  }

  return false;
}
