// Layer 3 — SQLite FTS5 full-text search

import Database from 'better-sqlite3';
import type { CompiledPage, FreshnessCounts } from '../layer2/types.js';
import { stripEnvelopeBlock } from '../layer2/envelope.js';
import type { Claim, Entity } from '../layer1/types.js';
import type { ClaimStore } from '../layer1/store.js';
import { dirname } from 'node:path';
import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';
import { readAll } from '../layer0/log.js';
import type { Observation } from '../layer0/types.js';
import type { Layer0Index } from '../layer0/index.js';

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

// Raw-observation full-text index (v0.5.0-bound, spec §10a).
//
// The raw-searchable freshness promise is state-based: an observation is
// searchable from the instant it is written, before any compile job resolves.
// `freshness` carries the state-based label — 'unverified' (default, raw
// window), 'EXTRACTED' (compile resolved; claim ranks above, obs retained as
// evidence), or 'FAILED' (compile failed; stays raw-searchable forever). A
// time window would desync from what durably happened, so the label is the
// only freshness criterion, never a timestamp.
//
// PERFORMANCE STRUCTURE (spec §11.2 re-run finding): the FTS row holds the
// metadata columns (immutable at index time). A meta side table
// (observation_meta) is the fast-path index:
//   - deletes/purges go by rowid (O(log n)) instead of by an UNINDEXED
//     column (measured full-scan ~2.4–3.6ms/row) — the write path indexes
//     synchronously and FORGET.SCOPE purges by scope, so both must stay cheap;
//   - freshness transitions update the meta table only (µs-scale), never the
//     FTS row (FTS5 UPDATE rewrites the token index, ~2.3ms/row at 10k).
const OBSERVATION_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS observation_search_index USING fts5(
  obs_id UNINDEXED,
  scope UNINDEXED,
  type UNINDEXED,
  actor_id UNINDEXED,
  observed_at UNINDEXED,
  captured_at UNINDEXED,
  source_app UNINDEXED,
  source_id UNINDEXED,
  sensitive UNINDEXED,
  status UNINDEXED,
  freshness UNINDEXED,
  content,
  tokenize='porter'
);
`;

const OBSERVATION_META_SCHEMA = `
CREATE TABLE IF NOT EXISTS observation_meta (
  obs_id TEXT PRIMARY KEY,
  fts_rowid INTEGER NOT NULL,
  scope TEXT NOT NULL,
  freshness TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_meta_scope ON observation_meta(scope);
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

/**
 * State-based freshness label for a raw observation (spec §10a). Never
 * time-based: 'unverified' = written, compile job not resolved (raw window);
 * 'EXTRACTED' = compile resolved, claims rank above the obs, obs retained as
 * evidence; 'FAILED' = compile failed, obs stays raw-searchable forever.
 */
export type ObservationFreshness = 'unverified' | 'EXTRACTED' | 'FAILED';

export interface ObservationSearchResult {
  obs_id: string;
  type: string;
  scope: string;
  actor_id: string;
  observed_at: string;
  captured_at: string;
  source_app: string;
  source_id: string | null;
  sensitive: boolean;
  /** Effective status at index time (accepted/quarantined/tombstoned/...). */
  status: string;
  freshness: ObservationFreshness;
  rank: number;
  /** Content body text used for the index entry (stringified if structured). */
  content: string;
}

export interface ObservationSearchOptions {
  limit?: number;
  includeSensitive?: boolean;
  temporalRange?: { from: string; to: string };
  /** Only rows with these freshness labels. Omitted = all (no winnowing). */
  freshness?: ObservationFreshness[];
}

/** Row shape accepted by SearchIndex.indexObservation. */
export interface ObsIndexRow {
  obs_id: string;
  scope: string;
  type: string;
  actor_id: string;
  observed_at: string;
  captured_at: string;
  source_app: string;
  source_id: string | null;
  sensitive: boolean;
  status: string;
  freshness: ObservationFreshness;
  content: string;
}

/** Project an observation onto its raw-index row. */
export function observationToIndexRow(
  obs: Observation,
  opts: {
    /** Effective status from Layer 0 (defaults to obs.status). */
    status?: string;
    /** State-based freshness label (defaults to 'unverified'). */
    freshness?: ObservationFreshness;
  } = {},
): ObsIndexRow {
  const body = typeof obs.content.body === 'string'
    ? obs.content.body
    : JSON.stringify(obs.content.body);
  return {
    obs_id: obs.id,
    scope: obs.scope,
    type: obs.type,
    actor_id: obs.source.actor.id,
    observed_at: obs.source.observed_at,
    captured_at: obs.source.captured_at,
    source_app: obs.source.app,
    source_id: obs.source.source_id ?? null,
    sensitive: obs.policy.sensitive,
    status: opts.status ?? obs.status,
    freshness: opts.freshness ?? 'unverified',
    content: body,
  };
}

export class SearchIndex {
  private db: Database.Database;
  /** Cached per-row statements — per-call prepare() dominated the compile
   *  freshness loop (measured ~2ms/row at 50k; see §11.2 re-run). */
  private stmtInsertObservationFts?: Database.Statement;
  private stmtDeleteObservationFtsByRowid?: Database.Statement;
  private stmtSelectMetaRowidByObsId?: Database.Statement;
  private stmtUpsertObservationMeta?: Database.Statement;
  private stmtGetFtsRowidByObsId?: Database.Statement;
  private stmtRemoveClaimRow?: Database.Statement;
  private stmtInsertClaimRow?: Database.Statement;
  private stmtUpdateFreshness?: Database.Statement;
  private stmtUpdateStatus?: Database.Statement;
  private stmtRemoveObservation?: Database.Statement;
  private stmtLegacyDeleteFtsByObsId?: Database.Statement;
  private stmtRemoveObsMetaByScope?: Database.Statement;
  private stmtGetObservationFreshness?: Database.Statement;
  private stmtRemoveClaimsByScope?: Database.Statement;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') ensurePrivateDirectory(dirname(dbPath));
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') ensurePrivateFile(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    // Derived-shape migration: the observation FTS is wipe-and-rebuildable
    // from the evidence JSONL, so a stale shape (metadata columns inside the
    // FTS row — deletes by UNINDEXED column cost a full scan, §11.2 re-run)
    // is dropped and recreated with the meta-table design.
    const obsFtsSql = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observation_search_index'",
    ).get() as { sql: string } | undefined;
    this.db.exec(FTS_SCHEMA);
    this.db.exec(CLAIM_FTS_SCHEMA);
    // Derived-shape migration: the observation FTS is wipe-and-rebuildable
    // from the evidence JSONL, so a stale shape (an earlier dev build without
    // the metadata columns / meta table) is dropped and recreated. Data loss
    // is impossible — syncObservationsFromEvidence rebuilds at open.
    if (obsFtsSql && !obsFtsSql.sql.includes('obs_id UNINDEXED')) {
      this.db.exec('DROP TABLE IF EXISTS observation_search_index');
      this.db.exec('DROP TABLE IF EXISTS observation_meta');
      this.db.exec('DROP TABLE IF EXISTS observation_freshness');
    }
    this.db.exec(OBSERVATION_FTS_SCHEMA);
    this.db.exec(OBSERVATION_META_SCHEMA);
    this.db.exec('DROP TABLE IF EXISTS observation_freshness');
  }

  /** Index or re-index a compiled page */
  indexPage(page: CompiledPage): void {
    const { entity_id, entity } = page.envelope;
    const { scope } = page.frontmatter;

    // Index only the page BODY, not the YAML frontmatter. Frontmatter fields
    // (type, scope, epistemic, model, ids, dates) are metadata, not content —
    // indexing them pollutes full-text search (e.g. "person" matching every
    // `type: person` page and cross-contaminating results). The derived
    // envelope block inside the body is machine metadata for the same reason.
    const body = stripEnvelopeBlock(page.raw.replace(/^---\n[\s\S]*?\n---\n/, ''));

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

  // ── Observation raw-search index (v0.5.0, spec §10a) ──────────────────────

  /**
   * Index or re-index one raw observation. Called synchronously on the observe
   * write path so the raw window is searchable before any compile job runs.
   * Freshness defaults to 'unverified' — the state-based raw window. The
   * FTS row holds only tokenised content; metadata (incl. freshness) lives in
   * observation_meta, so deletes and transitions stay O(log n).
   */
  indexObservation(obs: ObsIndexRow): void {
    this.writeObservationRow(obs);
  }

  /**
   * Batch insert rows (syncObservationsFromEvidence rebuild path). One
   * transaction for the whole batch.
   */
  indexObservations(rows: ObsIndexRow[]): void {
    if (rows.length === 0) return;
    this.db.transaction(() => {
      for (const obs of rows) this.writeObservationRow(obs);
    })();
  }

  /**
   * Remove one observation from the raw index (e.g. terminal state).
   * Fast path via the meta rowid; falls back to the UNINDEXED-column delete
   * for rows written before the meta table existed (e.g. test seeding).
   */
  removeObservation(obsId: string): void {
    const getRowid = this.stmtGetFtsRowidByObsId
      ??= this.db.prepare('SELECT fts_rowid FROM observation_meta WHERE obs_id = ?');
    const rowid = getRowid.get(obsId) as { fts_rowid: number } | undefined;
    if (rowid) {
      const delFts = this.stmtDeleteObservationFtsByRowid
        ??= this.db.prepare('DELETE FROM observation_search_index WHERE rowid = ?');
      delFts.run(rowid.fts_rowid);
    } else {
      const legacy = this.stmtLegacyDeleteFtsByObsId
        ??= this.db.prepare('DELETE FROM observation_search_index WHERE obs_id = ?');
      legacy.run(obsId);
    }
    const delMeta = this.stmtRemoveObservation
      ??= this.db.prepare('DELETE FROM observation_meta WHERE obs_id = ?');
    delMeta.run(obsId);
  }

  /**
   * Remove every observation of a scope from the raw index. The FORGET.SCOPE
   * erasure lane must physically purge, not just hide — this is the purge
   * backing zero-results-in-every-lane conformance.
   */
  removeObservationsByScope(scope: string): number {
    const select = this.stmtSelectMetaRowidByObsId
      ??= this.db.prepare('SELECT fts_rowid FROM observation_meta WHERE scope = ?');
    const rowids = select.all(scope) as Array<{ fts_rowid: number }>;
    const delMeta = this.stmtRemoveObsMetaByScope
      ??= this.db.prepare('DELETE FROM observation_meta WHERE scope = ?');
    const info = delMeta.run(scope);
    if (rowids.length > 0) {
      // Collect rowids BEFORE the meta purge, then remove the FTS rows by
      // rowid (O(log n) each) — never by the UNINDEXED scope column.
      this.db.transaction(() => {
        const delFts = this.stmtDeleteObservationFtsByRowid
          ??= this.db.prepare('DELETE FROM observation_search_index WHERE rowid = ?');
        for (const row of rowids) delFts.run(row.fts_rowid);
      })();
    }
    return info.changes;
  }

  /** Update only the freshness label — state transitions, never timestamps. */
  updateObservationFreshness(obsId: string, freshness: ObservationFreshness): void {
    const stmt = this.stmtUpdateFreshness
      ??= this.db.prepare(
        'UPDATE observation_meta SET freshness = ? WHERE obs_id = ?',
      );
    stmt.run(freshness, obsId);
  }

  /**
   * Batch freshness transition — one transaction for the whole set (spec
   * §10a state contract). Plain-table UPDATEs are µs-scale; the earlier FTS5
   * in-place column update measured ~2.3ms/row at 10k and was the dominant
   * compile cost until moved to this side table (§11.2 re-run).
   */
  updateObservationsFreshness(obsIds: string[], freshness: ObservationFreshness): void {
    if (obsIds.length === 0) return;
    const stmt = this.stmtUpdateFreshness
      ??= this.db.prepare(
        'UPDATE observation_meta SET freshness = ? WHERE obs_id = ?',
      );
    this.db.transaction(() => {
      for (const obsId of obsIds) stmt.run(freshness, obsId);
    })();
  }

  /**
   * Update the effective-status column in place (quarantine approval flips a
   * quarantined row to accepted). Terminal transitions should use
   * removeObservation instead, matching rebuild semantics.
   */
  updateObservationStatus(obsId: string, status: string): void {
    // The FTS row carries the searchable status; keep it current. This is a
    // rare operation (quarantine review), so the FTS rewrite cost is fine.
    const stmt = this.stmtUpdateStatus
      ??= this.db.prepare(
        'UPDATE observation_search_index SET status = ? WHERE obs_id = ?',
      );
    stmt.run(status, obsId);
  }

  getObservationFreshness(obsId: string): ObservationFreshness | null {
    const stmt = this.stmtGetObservationFreshness
      ??= this.db.prepare(
        'SELECT freshness FROM observation_meta WHERE obs_id = ?',
      );
    const row = stmt.get(obsId) as { freshness: ObservationFreshness } | undefined;
    return row?.freshness ?? null;
  }

  /** Insert (or re-insert) one observation: FTS row + meta fast-path row. */
  private writeObservationRow(obs: ObsIndexRow): void {
    const getRowid = this.stmtGetFtsRowidByObsId
      ??= this.db.prepare('SELECT fts_rowid FROM observation_meta WHERE obs_id = ?');
    const existing = getRowid.get(obs.obs_id) as { fts_rowid: number } | undefined;
    if (existing) {
      const delFts = this.stmtDeleteObservationFtsByRowid
        ??= this.db.prepare('DELETE FROM observation_search_index WHERE rowid = ?');
      delFts.run(existing.fts_rowid);
    }
    const insert = this.stmtInsertObservationFts
      ??= this.db.prepare(`
      INSERT INTO observation_search_index
        (obs_id, scope, type, actor_id, observed_at, captured_at,
         source_app, source_id, sensitive, status, freshness, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const inserted = insert.run(
      obs.obs_id,
      obs.scope,
      obs.type,
      obs.actor_id,
      obs.observed_at,
      obs.captured_at,
      obs.source_app,
      obs.source_id,
      obs.sensitive ? 1 : 0,
      obs.status,
      obs.freshness,
      obs.content,
    );
    const upsertMeta = this.stmtUpsertObservationMeta
      ??= this.db.prepare(`
        INSERT INTO observation_meta (obs_id, fts_rowid, scope, freshness)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(obs_id) DO UPDATE SET
          fts_rowid = excluded.fts_rowid,
          scope = excluded.scope,
          freshness = excluded.freshness
      `);
    upsertMeta.run(obs.obs_id, inserted.lastInsertRowid, obs.scope, obs.freshness);
  }

  /** Full-text search over the raw observation window. */
  searchObservations(
    query: string,
    scope: string,
    options: ObservationSearchOptions = {},
  ): ObservationSearchResult[] {
    const limit = options.limit ?? 10;
    const terms = searchObservationQueryTerms(query);
    // A query with no content words and no temporal anchor must not dump the
    // whole scope — the legacy substring matcher returned nothing for it.
    if (terms.length === 0 && !options.temporalRange) return [];
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    clauses.push('o.scope = ?');
    params.push(scope);

    clauses.push("o.status = 'accepted'");
    if (!options.includeSensitive) {
      clauses.push('o.sensitive = 0');
    }
    if (options.temporalRange) {
      clauses.push('o.observed_at >= ?', 'o.observed_at < ?');
      params.push(options.temporalRange.from, options.temporalRange.to);
    }
    if (options.freshness && options.freshness.length > 0) {
      clauses.push(`COALESCE(m.freshness, 'unverified') IN (${options.freshness.map(() => '?').join(', ')})`);
      params.push(...options.freshness);
    }

    // FTS5 implicit-AND on the sanitised term list — a bare punctuation-only
    // query has no tokens and must not error; a null MATCH clause means a pure
    // temporal/scope scan (blank query + temporal range is a valid legacy
    // non-empty call per the old substring matcher).
    const fts = terms.length > 0 ? sanitiseObservationFTS(terms) : null;
    const where = fts
      ? `observation_search_index MATCH ? AND ${clauses.join(' AND ')}`
      : clauses.join(' AND ');
    if (fts) params.unshift(fts);

    let rows: Array<Record<string, unknown>>;
    try {
      rows = this.db.prepare(`
        SELECT o.obs_id, o.type, o.scope, o.actor_id, o.observed_at, o.captured_at,
               o.source_app, o.source_id, o.sensitive, o.status,
               COALESCE(m.freshness, 'unverified') as freshness, o.content, o.rank
        FROM observation_search_index o
        LEFT JOIN observation_meta m ON m.obs_id = o.obs_id
        WHERE ${where}
        ORDER BY o.observed_at DESC
        LIMIT ?
      `).all(...params, limit) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }

    return rows.map(row => ({
      obs_id: row.obs_id as string,
      type: row.type as string,
      scope: row.scope as string,
      actor_id: row.actor_id as string,
      observed_at: row.observed_at as string,
      captured_at: row.captured_at as string,
      source_app: row.source_app as string,
      source_id: row.source_id as string | null,
      sensitive: Boolean(row.sensitive),
      status: row.status as string,
      freshness: row.freshness as ObservationFreshness,
      rank: row.rank === null || row.rank === undefined ? 0 : Math.abs(row.rank as number),
      content: row.content as string,
    }));
  }

  /** Count indexed raw observations. */
  countObservations(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM observation_search_index').get() as { c: number }).c;
  }

  /**
   * State-based freshness counts over the raw-observation window (spec §10a
   * payload contract). Literal labels only — never derived from timestamps.
   * The live label is the meta table's (freshness transitions never rewrite
   * the FTS row); rows without a meta row (legacy/test seeding) default to
   * 'unverified'.
   */
  countObservationsByFreshness(): FreshnessCounts {
    const rows = this.db.prepare(`
      SELECT COALESCE(m.freshness, 'unverified') as freshness, COUNT(*) as c
      FROM observation_search_index o
      LEFT JOIN observation_meta m ON m.obs_id = o.obs_id
      GROUP BY COALESCE(m.freshness, 'unverified')
    `).all() as Array<{ freshness: string; c: number }>;
    const result: FreshnessCounts = { unverified: 0, extracted: 0, failed: 0 };
    for (const row of rows) {
      if (row.freshness === 'unverified') result.unverified = row.c;
      else if (row.freshness === 'EXTRACTED') result.extracted = row.c;
      else if (row.freshness === 'FAILED') result.failed = row.c;
    }
    return result;
  }

  /** Wipe the observation index — used by rebuild-equivalence conformance. */
  clearObservations(): void {
    this.db.exec('DELETE FROM observation_search_index');
    this.db.exec('DELETE FROM observation_meta');
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

  /**
   * Upsert one claim into the claim-granular FTS table. This is the
   * incremental form of replaceClaimIndex — used by the background compile
   * queue after a batch commits, so new claims are queryable immediately
   * without rebuilding the whole claim index.
   */
  indexSingleClaim(claim: Claim): void {
    const content = typeof claim.object.value === 'string'
      ? claim.object.value
      : JSON.stringify(claim.object.value);
    this.db.prepare('DELETE FROM claim_search_index WHERE claim_id = ?').run(claim.id);
    this.db.prepare(`
      INSERT INTO claim_search_index (claim_id, entity_id, entity_name, scope, predicate, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      claim.id,
      claim.subject_id,
      claim.subject_name,
      claim.scope,
      claim.predicate,
      `${claim.subject_name}\n${claim.predicate}: ${content}`,
    );
  }

  /**
   * Batch upsert claims into the claim-granular FTS table — one transaction.
   * Used by the compile worker so per-claim autocommit does not dominate the
   * drain (spec §11.2 re-run).
   */
  indexSingleClaims(claims: Claim[]): void {
    if (claims.length === 0) return;
    const del = this.stmtRemoveClaimRow
      ??= this.db.prepare('DELETE FROM claim_search_index WHERE claim_id = ?');
    const insert = this.stmtInsertClaimRow
      ??= this.db.prepare(`
      INSERT INTO claim_search_index (claim_id, entity_id, entity_name, scope, predicate, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const claim of claims) {
        const content = typeof claim.object.value === 'string'
          ? claim.object.value
          : JSON.stringify(claim.object.value);
        del.run(claim.id);
        insert.run(
          claim.id,
          claim.subject_id,
          claim.subject_name,
          claim.scope,
          claim.predicate,
          `${claim.subject_name}\n${claim.predicate}: ${content}`,
        );
      }
    })();
  }

  /** Replace the claim-granular index for one scope, or for the whole store. */
  replaceClaimIndex(claims: Claim[], scope?: string): void {
    const insert = this.stmtInsertClaimRow
      ??= this.db.prepare(`
      INSERT INTO claim_search_index
        (claim_id, entity_id, entity_name, scope, predicate, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const replace = this.db.transaction(() => {
      if (scope) {
        const remove = this.stmtRemoveClaimsByScope
          ??= this.db.prepare('DELETE FROM claim_search_index WHERE scope = ?');
        remove.run(scope);
      } else {
        this.db.exec('DELETE FROM claim_search_index');
      }

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
    this.db.exec("DELETE FROM observation_search_index");
    this.db.exec("DELETE FROM observation_meta");
  }

  /**
   * Purge every entity-page row of a scope (FORGET.SCOPE erasure, spec §10).
   * Physical removal — a rebuilt index must not contain the document either.
   */
  removePagesByScope(scope: string): number {
    return this.db.prepare('DELETE FROM search_index WHERE scope = ?').run(scope).changes;
  }

  /**
   * Purge every claim-granular FTS row of a scope (FORGET.SCOPE erasure).
   * The claim rows themselves are purged from Layer 1; this is the BM25 lane
   * hash removal so zero results hold against a rebuilt index too.
   */
  removeClaimsByScope(scope: string): number {
    return this.db.prepare('DELETE FROM claim_search_index WHERE scope = ?').run(scope).changes;
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

/**
 * Sync the raw-observation FTS index from the evidence JSONL.
 *
 * Regenerable artifact (spec §10a rebuild-equivalence): wipe and rebuild from
 * the canonical log, with effective status pulled from Layer 0 so terminal
 * (tombstoned/redacted/rejected/quarantined) observations never appear in the
 * raw window, and freshness defaulted to 'unverified' (compile-queue state
 * re-applies EXTRACTED/FAILED labels afterwards — the JSONL has no freshness
 * column by design; that state is derived, not canonical).
 *
 * Returns the number of observations indexed.
 */
export function syncObservationsFromEvidence(
  evidenceDir: string,
  layer0: Layer0Index,
  searchIndex: SearchIndex,
): number {
  searchIndex.clearObservations();
  const rows: ObsIndexRow[] = [];
  let indexed = 0;
  for (const obs of readAll(evidenceDir)) {
    const effectiveStatus = layer0.getEffectiveStatus(obs.id) ?? obs.status;
    if (effectiveStatus !== 'accepted') continue;
    rows.push(observationToIndexRow(obs, { status: effectiveStatus }));
    indexed++;
  }
  // One transaction for the whole rebuild — per-row FTS inserts (no batching)
  // measured ~1.3ms/row, making a 50k open cost ~65s (see §11.2 re-run).
  searchIndex.indexObservations(rows);
  return indexed;
}

/**
 * Tokenise a free-text raw-observation query. FTS5 implicit-AND is used for
 * the raw window: every content word must appear (matches the old substring
 * matcher's all-terms contract), while stopword clipping keeps question-form
 * queries ("what is the current status of ...") from failing on function
 * words the way FTS5's implicit AND would.
 */
export function searchObservationQueryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (words.length === 0) return [];
  const meaningful = words.filter(w => !QUERY_STOPWORDS.has(w));
  return meaningful.length > 0 ? meaningful : words;
}

function sanitiseObservationFTS(terms: string[]): string {
  return terms.map(t => `"${t}"`).join(' AND ');
}

/** Build a snippet for an observation hit, centred on the first query term. */
export function makeObservationSnippet(text: string, terms: string[]): string {
  if (terms.length === 0) return text.slice(0, 240);
  const term = terms[0]!;
  const index = text.toLowerCase().indexOf(term);
  if (index < 0) return text.slice(0, 240);
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + term.length + 160);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
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
