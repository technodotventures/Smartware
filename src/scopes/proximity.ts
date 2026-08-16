// Scopes — Scope proximity scoring

import type { ScopeRegistry } from './registry.js';

/**
 * Compute a 0–1 proximity score between a query scope and a result scope.
 *
 * 1.0 — exact match
 * 0.7 — direct parent/child relationship
 * 0.3 — siblings (share same parent)
 * 0.0 — unrelated
 */
export function getScopeProximity(
  queryScope: string,
  resultScope: string,
  registry: ScopeRegistry,
): number {
  if (queryScope === resultScope) return 1.0;

  const queryEntry = registry.get(queryScope);
  const resultEntry = registry.get(resultScope);

  // Direct parent/child
  if (queryEntry?.parent === resultScope || resultEntry?.parent === queryScope) return 0.7;

  // Siblings: same parent, neither is null
  if (
    queryEntry?.parent &&
    resultEntry?.parent &&
    queryEntry.parent === resultEntry.parent
  ) return 0.3;

  return 0.0;
}
