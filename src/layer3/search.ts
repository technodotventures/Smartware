// Layer 3 — SQLite FTS5 full-text search

import Database from 'better-sqlite3';
import type { CompiledPage } from '../layer2/types.js';
import type { Claim, Entity } from '../layer1/types.js';
import type { ClaimStore } from '../layer1/store.js';
import { dirname } from 'node:path';
import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  entity_id UNINDEXED,
  entity_name,
  scope UNINDEXED,
  content,
  tokenize='porter'
);
`;

const CLAIM_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS claim_search_index USING fts5(
  claim_id UNINDEXED,
  entity_id UNINDEXED,
  entity_name,
  scope UNINDEXED,
  predicate,
  content,
  tokenize='porter'
);
`;

export interface SearchResult {
  entity_id: string;
  entity_name: string;
  scope: string;
  rank: number;
  snippet?: string;
}

export interface ClaimSearchResult extends SearchResult {
  claim_id: string;
}

export class SearchIndex {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') ensurePrivateDirectory(dirname(dbPath));
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') ensurePrivateFile(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(FTS_SCHEMA);
    this.db.exec(CLAIM_FTS_SCHEMA);
  }

  /** Index or re-index a compiled page */
  indexPage(page: CompiledPage): void {
    const { entity_id, entity, scope } = page.frontmatter;

    // Index only the page BODY, not the YAML frontmatter. Frontmatter fields
    // (type, scope, epistemic, model, ids, dates) are metadata, not content —
    // indexing them pollutes full-text search (e.g. "person" matching every
    // `type: person` page and cross-contaminating results).
    const body = page.raw.replace(/^---\n[\s\S]*?\n---\n/, '');

    // Delete old entry
    this.db.prepare("DELETE FROM search_index WHERE entity_id = ?").run(entity_id);

    // Insert fresh
    this.db.prepare(`
      INSERT INTO search_index (entity_id, entity_name, scope, content)
      VALUES (?, ?, ?, ?)
    `).run(entity_id, entity, scope, body);
  }

  /** Remove an entity from the index */
  removePage(entityId: string): void {
    this.db.prepare("DELETE FROM search_index WHERE entity_id = ?").run(entityId);
  }

  /** Full-text search. Returns results sorted by rank (best first). */
  search(query: string, scope?: string): SearchResult[] {
    if (!query.trim()) return [];

    try {
      // FTS5 uses negative rank (lower = better match), so ORDER BY rank ASC
      // Scope must be constrained before LIMIT. Post-filtering a global top-N
      // lets stronger matches in unrelated scopes starve valid scoped results.
      const rows = scope
        ? this.db.prepare(`
          SELECT entity_id, entity_name, scope, rank
          FROM search_index
          WHERE search_index MATCH ? AND scope = ?
          ORDER BY rank
          LIMIT 50
        `).all(sanitiseFTSQuery(query), scope)
        : this.db.prepare(`
          SELECT entity_id, entity_name, scope, rank
          FROM search_index
          WHERE search_index MATCH ?
          ORDER BY rank
          LIMIT 50
        `).all(sanitiseFTSQuery(query));
      const typedRows = rows as Array<{
        entity_id: string;
        entity_name: string;
        scope: string;
        rank: number;
      }>;

      return typedRows.map(r => ({ ...r, rank: Math.abs(r.rank) }));
    } catch {
      // FTS query parse error — return empty
      return [];
    }
  }

  /** Full-text search over individual active/stale claims. */
  searchClaims(query: string, scope?: string): ClaimSearchResult[] {
    if (!query.trim()) return [];

    try {
      const rows = scope
        ? this.db.prepare(`
          SELECT claim_id, entity_id, entity_name, scope, rank
          FROM claim_search_index
          WHERE claim_search_index MATCH ? AND scope = ?
          ORDER BY rank
          LIMIT 50
        `).all(sanitiseFTSQuery(query), scope)
        : this.db.prepare(`
          SELECT claim_id, entity_id, entity_name, scope, rank
          FROM claim_search_index
          WHERE claim_search_index MATCH ?
          ORDER BY rank
          LIMIT 50
        `).all(sanitiseFTSQuery(query));
      const typedRows = rows as Array<{
        claim_id: string;
        entity_id: string;
        entity_name: string;
        scope: string;
        rank: number;
      }>;

      return typedRows.map(r => ({ ...r, rank: Math.abs(r.rank) }));
    } catch {
      return [];
    }
  }

  /** Count indexed pages */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM search_index').get() as { c: number }).c;
  }

  /**
   * Index an entity directly from its L1 claims — no L2 CompiledPage needed.
   * This is the key decoupling: L3 search stays current even if L2 synthesis
   * fails or times out.
   */
  indexEntityFromClaims(entity: Entity, claims: Claim[]): void {
    // Build searchable text from claim predicates + object values
    const claimTexts = claims.map(c => {
      const objStr = typeof c.object.value === 'string'
        ? c.object.value
        : JSON.stringify(c.object.value);
      return `${c.predicate}: ${objStr}`;
    });
    const content = `${entity.canonical_name}\n${claimTexts.join('\n')}`;

    // Delete old entry
    this.db.prepare("DELETE FROM search_index WHERE entity_id = ?").run(entity.id);

    // Insert fresh
    this.db.prepare(`
      INSERT INTO search_index (entity_id, entity_name, scope, content)
      VALUES (?, ?, ?, ?)
    `).run(entity.id, entity.canonical_name, entity.scope, content);
  }

  indexClaim(claimId: string, subjectName: string, scope: string, content: string): void {
    this.db.prepare("DELETE FROM search_index WHERE entity_id = ?").run(claimId);
    this.db.prepare(`
      INSERT INTO search_index (entity_id, entity_name, scope, content)
      VALUES (?, ?, ?, ?)
    `).run(claimId, subjectName, scope, content);
  }

  /** Replace the claim-granular index for one scope, or for the whole store. */
  replaceClaimIndex(claims: Claim[], scope?: string): void {
    const insert = this.db.prepare(`
      INSERT INTO claim_search_index
        (claim_id, entity_id, entity_name, scope, predicate, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const replace = this.db.transaction(() => {
      if (scope) this.db.prepare('DELETE FROM claim_search_index WHERE scope = ?').run(scope);
      else this.db.exec('DELETE FROM claim_search_index');

      for (const claim of claims) {
        const content = typeof claim.object.value === 'string'
          ? claim.object.value
          : JSON.stringify(claim.object.value);
        insert.run(
          claim.id,
          claim.subject_id,
          claim.subject_name,
          claim.scope,
          claim.predicate,
          `${claim.subject_name}\n${claim.predicate}: ${content}`,
        );
      }
    });
    replace();
  }

  /** Clear all indexed content */
  clear(): void {
    this.db.exec("DELETE FROM search_index");
    this.db.exec("DELETE FROM claim_search_index");
  }

  close(): void { this.db.close(); }
  getDB(): Database.Database { return this.db; }
}

/**
 * Sync Layer 3 search index from Layer 1 claims.
 * Reads all entities and their active claims from the store, indexes each
 * entity's claim content into FTS5. This runs independently of Layer 2
 * synthesis — claims become queryable within seconds of extraction.
 *
 * Returns the number of entities indexed.
 */
export function syncSearchFromClaims(store: ClaimStore, searchIndex: SearchIndex, scope?: string): number {
  const entities = store.getAllEntities(scope);
  const allActive = store.getActiveClaims(scope);
  searchIndex.replaceClaimIndex(allActive, scope);
  let indexed = 0;
  const indexedEntityIds = new Set<string>();

  for (const entity of entities) {
    const claims = allActive
      .filter(c => c.subject_id === entity.id && c.status === 'active');
    if (claims.length === 0) {
      // All claims retracted/superseded/stale — drop the entity from the index
      // so forgotten (and possibly sensitive) content stops being searchable
      // and the entity can't resurface in query results.
      searchIndex.removePage(entity.id);
      continue;
    }

    searchIndex.indexEntityFromClaims(entity, claims);
    indexedEntityIds.add(entity.id);
    indexed++;
  }

  for (const claim of allActive) {
    if (indexedEntityIds.has(claim.subject_id)) continue;
    if (claim.status !== 'active') continue;

    const objStr = typeof claim.object.value === 'string'
      ? claim.object.value
      : JSON.stringify(claim.object.value);
    const content = `${claim.subject_name}\n${claim.predicate}: ${objStr}`;

    searchIndex.indexClaim(claim.id, claim.subject_name, claim.scope, content);
    indexed++;
  }

  return indexed;
}

// Common English function words stripped from free-text queries. Without this,
// a natural-language question ("What is the current status of Atlas?") is either
// combined by FTS5's implicit-AND (requiring every function word to appear in
// the terse indexed claim text → zero matches) or errors on punctuation like
// '?', which search() silently swallows into an empty result.
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'as', 'into', 'over', 'up',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'has', 'have', 'had',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'my', 'your', 'our', 'their', 'his', 'her', 'its',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'and', 'or', 'not', 'no', 'if', 'then', 'so', 'than', 'there', 'here', 'current', 'currently',
]);

/**
 * Sanitise a free-text query for FTS5.
 *
 * Extracts alphanumeric content words (dropping punctuation and function words),
 * quotes each as a safe phrase, and OR-combines them so a natural-language
 * question matches entities containing ANY content word — FTS5 BM25 then ranks
 * by relevance. Falls back to all words if every word is a stopword.
 */
export function searchQueryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (words.length === 0) return [];
  const meaningful = words.filter(w => !QUERY_STOPWORDS.has(w));
  return meaningful.length > 0 ? meaningful : words;
}

function sanitiseFTSQuery(query: string): string {
  const tokens = searchQueryTerms(query);
  if (tokens.length === 0) return '""';
  return tokens.map(t => `"${t}"`).join(' OR ');
}
