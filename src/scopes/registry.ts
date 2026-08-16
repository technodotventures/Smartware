// Scopes — Scope registry with parent hierarchy

import type { SmartwareConfig, ScopeEntry } from '../config.js';

export type { ScopeEntry };

export class ScopeRegistry {
  private scopes: Map<string, ScopeEntry>;

  constructor(config: SmartwareConfig) {
    this.scopes = new Map(config.scopes.map(s => [s.id, s]));
  }

  get(id: string): ScopeEntry | undefined {
    return this.scopes.get(id);
  }

  getAll(): ScopeEntry[] {
    return [...this.scopes.values()];
  }

  getParent(id: string): ScopeEntry | null {
    const entry = this.scopes.get(id);
    if (!entry?.parent) return null;
    return this.scopes.get(entry.parent) ?? null;
  }

  /** Return the full ancestor chain including the scope itself */
  getAncestors(id: string): string[] {
    const chain: string[] = [];
    let current: string | null = id;
    while (current) {
      chain.push(current);
      const entry = this.scopes.get(current);
      current = entry?.parent ?? null;
    }
    return chain;
  }

  /** Check if targetScope is in the ancestor chain of queryScope */
  isAncestorOf(ancestor: string, descendant: string): boolean {
    return this.getAncestors(descendant).includes(ancestor);
  }

  /** Visibility default for a scope */
  getVisibilityDefault(id: string): ScopeEntry['visibility_default'] {
    return this.scopes.get(id)?.visibility_default ?? 'scope';
  }
}
