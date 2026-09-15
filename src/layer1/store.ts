// Layer 1 — SQLite Claim Store

import Database from 'better-sqlite3';
import { ensureColumn, hasColumn } from '../storage/schema.js';
import type {
  Claim,
  ClaimAuthor,
  ClaimRelation,
  ClaimRole,
  ClaimStatus,
  ClaimTimeValue,
  ClaimType,
  ClaimState,
  Entity,
  EpistemicLabel,
  RelationKind,
  RelationProvenance,
} from './types.js';
import type { TypedValue } from '../layer0/types.js';
import {
  compatibilityValidity,
  confidenceToBucket,
  epistemicToTag,
  inferredTime,
  knownTime,
  normaliseValue,
  nullTime,
  statusToState,
} from './types.js';
import { appendClaimVersion, iterAllClaimVersions, nextVersion, type ClaimVersionRecord } from './jsonl.js';
import { computeStructuredClaimFingerprint } from './fingerprint.js';
import { resolveEntity } from './entities.js';
import { dirname } from 'node:path';
import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';

/**
 * OperationId stamped on an L1 record written by a legacy/migration path that carries no
 * OperationId of its own — an `insertClaim` caller that omits `operation_id` (pre-A3 rows, hosts
 * that mint none). Its ActorId counterpart is `substrate:legacy` (see the JSONL append below).
 *
 * The value MUST satisfy the contract the library publishes:
 * `schemas/v0.5.0/common.schema.json#/$defs/OperationId` is `^op_[0-9A-HJKMNP-TV-Z]{26}$` —
 * Crockford base32, which excludes I, L, O and U. This is an all-zero ULID body with the `A3` tail
 * that marks the PR-4/A3 legacy-backfill convention: the same value `tombstone-backfill.ts` stamps
 * on backfilled tombstones (`LEGACY_OPERATION_ID` there, alongside `substrate:legacy-migration`),
 * so one value identifies every record the library had to write without a real OperationId, and it
 * is distinguishable from any real one by construction.
 *
 * History: the placeholder used here was `op_LEGACY00000000000000000000`, whose `L` that pattern
 * rejects (measured on kanban t_9e124fe6, fixed by t_85817375). Records written before the fix
 * still carry it; readers should treat both values as "no real OperationId" rather than trusting
 * the shape.
 */
export const LEGACY_OPERATION_ID = 'op_000000000000000000000000A3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_name ON entities(canonical_name);
CREATE INDEX IF NOT EXISTS idx_entity_scope ON entities(scope);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES entities(id),
  subject_name TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_value TEXT NOT NULL,
  scope TEXT NOT NULL,
  validity_from TEXT NOT NULL,
  validity_to TEXT,
  t_ingested_value TEXT,
  t_ingested_state TEXT NOT NULL DEFAULT 'known',
  t_ingested_basis TEXT,
  t_invalidated_value TEXT,
  t_invalidated_state TEXT NOT NULL DEFAULT 'null',
  t_invalidated_basis TEXT,
  t_valid_from_value TEXT,
  t_valid_from_state TEXT NOT NULL DEFAULT 'null',
  t_valid_from_basis TEXT,
  t_valid_to_value TEXT,
  t_valid_to_state TEXT NOT NULL DEFAULT 'null',
  t_valid_to_basis TEXT,
  source_event_id TEXT NOT NULL,
  extraction_event_id TEXT NOT NULL,
  supporting_evidence TEXT NOT NULL DEFAULT '[]',
  extraction_method TEXT NOT NULL,
  extraction_model TEXT,
  compiler_version TEXT NOT NULL,
  prompt_hash TEXT,
  extracted_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  epistemic TEXT NOT NULL,
  confidence REAL NOT NULL,
  sensitive INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  contested_by TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_claim_canonical_key ON claims(subject_id, predicate, scope, validity_from);
CREATE INDEX IF NOT EXISTS idx_claim_subject ON claims(subject_id);
CREATE INDEX IF NOT EXISTS idx_claim_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claim_scope ON claims(scope);
CREATE INDEX IF NOT EXISTS idx_claim_predicate ON claims(predicate);

CREATE TABLE IF NOT EXISTS layer1_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Adjacency table for typed temporal claim-to-claim relations (Spec v1.6.16
-- §6). Latest-version-only: on each new claim version, prior rows for the
-- source_claim_id are deleted and rows for the new version's relations are
-- inserted. Canonical authority is the inline relations array in the JSONL
-- claim version record; this table is a derived query index.
CREATE TABLE IF NOT EXISTS claim_relations (
  relation_id               TEXT NOT NULL,
  source_claim_id           TEXT NOT NULL,
  source_version            INTEGER NOT NULL DEFAULT 1,
  kind                      TEXT NOT NULL,
  target_claim_id           TEXT NOT NULL,
  valid_at                  TEXT NOT NULL,
  invalid_at                TEXT,
  origin                    TEXT,
  asserted_in_source_version INTEGER,
  target_claim_version      INTEGER,
  provenance_json           TEXT,
  PRIMARY KEY (relation_id)
);

CREATE INDEX IF NOT EXISTS idx_rel_source ON claim_relations(source_claim_id);
CREATE INDEX IF NOT EXISTS idx_rel_target ON claim_relations(target_claim_id);
CREATE INDEX IF NOT EXISTS idx_rel_kind ON claim_relations(kind);
`;

function serialiseTime(value: ClaimTimeValue): [string | null, string, string | null] {
  return [value.value, value.state, value.basis ?? null];
}

function rowToTime(
  row: Record<string, unknown>,
  prefix: string,
  fallback: ClaimTimeValue,
): ClaimTimeValue {
  const state = row[`${prefix}_state`] as string | undefined;
  const value = row[`${prefix}_value`] as string | null | undefined;
  const basis = row[`${prefix}_basis`] as string | null | undefined;

  if (!state) return fallback;
  return {
    value: value ?? null,
    state: state as ClaimTimeValue['state'],
    basis: basis ?? undefined,
  };
}

function rowToClaimRelation(row: Record<string, unknown>): ClaimRelation {
  const origin = (row['origin'] as string | null) ?? 'user';
  const aisv = row['asserted_in_source_version'] as number | null;
  const tcv = row['target_claim_version'] as number | null;
  let provenance: RelationProvenance;
  const provenanceJson = row['provenance_json'];
  if (typeof provenanceJson === 'string' && provenanceJson) {
    try {
      provenance = JSON.parse(provenanceJson) as RelationProvenance;
    } catch {
      provenance = { origin: 'user' };
    }
  } else if (aisv != null) {
    provenance = {
      origin: origin as RelationProvenance['origin'],
      asserted_in_source_version: aisv,
      target_claim_version: tcv ?? 1,
      observation_ids: [],
    } as RelationProvenance;
  } else {
    provenance = { origin: 'user' } as RelationProvenance;
  }
  return {
    relation_id: (row['relation_id'] as string) ?? '',
    kind: row['kind'] as RelationKind,
    target: row['target_claim_id'] as string,
    valid_at: row['valid_at'] as string,
    invalid_at: (row['invalid_at'] as string | null) ?? null,
    provenance,
  };
}

export class ClaimStore {
  private db: Database.Database;
  /** Pod data directory — set after construction by SmartwareCore. Used
   *  for the L1 JSONL canonical surface (PR-14). When null, JSONL writes
   *  are skipped (test/legacy paths). */
  private dataDir: string | null = null;
  /** Cached prepared statements — per-call prepare() measured as the largest
   *  single cost in the compile hot loop (spec §11.2 re-run). */
  private stmtCache = new Map<string, Database.Statement>();

  /** Prepare (and cache) a statement — use in per-row hot paths. */
  private stmt(sql: string): Database.Statement {
    let prepared = this.stmtCache.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.stmtCache.set(sql, prepared);
    }
    return prepared;
  }

  /** Run fn inside one SQLite transaction (compile-path batched syncs). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') ensurePrivateDirectory(dirname(dbPath));
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') ensurePrivateFile(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrateSchema();
  }

  /** Set after construction. SmartwareCore.open() wires this. */
  setDataDir(dataDir: string): void {
    this.dataDir = dataDir;
    const latestByClaim = new Map<string, ClaimVersionRecord>();
    for (const version of iterAllClaimVersions(dataDir)) {
      const latest = latestByClaim.get(version.claim_id);
      if (!latest || version.version > latest.version) latestByClaim.set(version.claim_id, version);
    }
    for (const version of latestByClaim.values()) this.syncFromJsonlVersion(version);
  }

  getDataDir(): string | null {
    return this.dataDir;
  }

  /** Append a claim version record to the L1 JSONL canonical surface. */
  appendVersionRecord(record: ClaimVersionRecord): void {
    if (!this.dataDir) return;
    appendClaimVersion(this.dataDir, record);
  }

  /** Compute the next version number for a claim_id (1 if no history). */
  nextVersionFor(claimId: string): number {
    if (!this.dataDir) return 1;
    return nextVersion(this.dataDir, claimId);
  }

  private migrateSchema(): void {
    ensureColumn(this.db, 'claims', 't_ingested_value', 'TEXT');
    ensureColumn(this.db, 'claims', 't_ingested_state', "TEXT NOT NULL DEFAULT 'known'");
    ensureColumn(this.db, 'claims', 't_ingested_basis', 'TEXT');
    ensureColumn(this.db, 'claims', 't_invalidated_value', 'TEXT');
    ensureColumn(this.db, 'claims', 't_invalidated_state', "TEXT NOT NULL DEFAULT 'null'");
    ensureColumn(this.db, 'claims', 't_invalidated_basis', 'TEXT');
    ensureColumn(this.db, 'claims', 't_valid_from_value', 'TEXT');
    ensureColumn(this.db, 'claims', 't_valid_from_state', "TEXT NOT NULL DEFAULT 'null'");
    ensureColumn(this.db, 'claims', 't_valid_from_basis', 'TEXT');
    ensureColumn(this.db, 'claims', 't_valid_to_value', 'TEXT');
    ensureColumn(this.db, 'claims', 't_valid_to_state', "TEXT NOT NULL DEFAULT 'null'");
    ensureColumn(this.db, 'claims', 't_valid_to_basis', 'TEXT');

    // ── Spec v1.5.4.2 fields (PR-4 / A3) ────────────────────────────────
    ensureColumn(this.db, 'claims', 'state', "TEXT NOT NULL DEFAULT 'active'");
    ensureColumn(this.db, 'claims', 'author', "TEXT NOT NULL DEFAULT 'agent'");
    ensureColumn(this.db, 'claims', 'epistemic_owner', "TEXT NOT NULL DEFAULT 'agent'");
    ensureColumn(this.db, 'claims', 'claim_type', "TEXT NOT NULL DEFAULT 'finding'");
    ensureColumn(this.db, 'claims', 'claim_role', "TEXT NOT NULL DEFAULT 'memory'");
    ensureColumn(this.db, 'claims', 'version_at', 'TEXT');
    ensureColumn(this.db, 'claims', 'created_at', 'TEXT');
    ensureColumn(this.db, 'claims', 'operation_id', 'TEXT');
    ensureColumn(this.db, 'claims', 'actor_id', 'TEXT');
    ensureColumn(this.db, 'claims', 'relations', "TEXT NOT NULL DEFAULT '[]'");

    this.db.exec(`
      UPDATE claims
      SET
        t_ingested_value = COALESCE(t_ingested_value, extracted_at),
        t_ingested_state = COALESCE(NULLIF(t_ingested_state, ''), 'known'),
        t_valid_from_value = COALESCE(t_valid_from_value, validity_from),
        t_valid_from_state = CASE
          WHEN COALESCE(NULLIF(t_valid_from_state, ''), '') != '' THEN t_valid_from_state
          WHEN validity_from IS NOT NULL AND validity_from != '' THEN 'inferred'
          ELSE 'null'
        END,
        t_valid_from_basis = COALESCE(t_valid_from_basis, CASE
          WHEN validity_from IS NOT NULL AND validity_from != '' THEN 'legacy_validity_from'
          ELSE NULL
        END),
        t_valid_to_value = COALESCE(t_valid_to_value, validity_to),
        t_valid_to_state = CASE
          WHEN COALESCE(NULLIF(t_valid_to_state, ''), '') != '' THEN t_valid_to_state
          WHEN validity_to IS NOT NULL AND validity_to != '' THEN 'inferred'
          ELSE 'null'
        END,
        t_valid_to_basis = COALESCE(t_valid_to_basis, CASE
          WHEN validity_to IS NOT NULL AND validity_to != '' THEN 'legacy_validity_to'
          ELSE NULL
        END),
        t_invalidated_state = COALESCE(NULLIF(t_invalidated_state, ''), 'null')
    `);

    // Backfill spec-conformant columns on legacy rows.
    // state: project status → {active, forgotten}. retracted → forgotten;
    // everything else (active/superseded/contested/stale) → active.
    this.db.exec(`
      UPDATE claims
      SET state = CASE WHEN status = 'retracted' THEN 'forgotten' ELSE 'active' END
      WHERE state IS NULL OR state = '' OR (state = 'active' AND status = 'retracted')
    `);

    this.db.exec(`
      UPDATE claims
      SET epistemic_owner = author
      WHERE epistemic_owner IS NULL OR epistemic_owner = ''
    `);

    // version_at, created_at: backfill from extracted_at when absent.
    this.db.exec(`
      UPDATE claims
      SET version_at = COALESCE(version_at, extracted_at),
          created_at = COALESCE(created_at, extracted_at)
      WHERE version_at IS NULL OR created_at IS NULL
    `);

    // v0.6.0: claim_relations needs relation_id as PK + new columns.
    // The table is a derived index, safe to drop and recreate.
    if (!hasColumn(this.db, 'claim_relations', 'relation_id')) {
      this.db.exec('DROP TABLE IF EXISTS claim_relations');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS claim_relations (
          relation_id               TEXT NOT NULL,
          source_claim_id           TEXT NOT NULL,
          source_version            INTEGER NOT NULL DEFAULT 1,
          kind                      TEXT NOT NULL,
          target_claim_id           TEXT NOT NULL,
          valid_at                  TEXT NOT NULL,
          invalid_at                TEXT,
          origin                    TEXT,
          asserted_in_source_version INTEGER,
          target_claim_version      INTEGER,
          provenance_json           TEXT,
          PRIMARY KEY (relation_id)
        )
      `);
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_rel_source ON claim_relations(source_claim_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_rel_target ON claim_relations(target_claim_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_rel_kind ON claim_relations(kind)');
    }
    ensureColumn(this.db, 'claim_relations', 'provenance_json', 'TEXT');
  }

  insertEntity(entity: Entity): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO entities (id, canonical_name, aliases, type, scope, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entity.id, entity.canonical_name, JSON.stringify(entity.aliases), entity.type, entity.scope, entity.created_at);
  }

  getEntity(id: string): Entity | undefined {
    const row = this.stmt('SELECT * FROM entities WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToEntity(row) : undefined;
  }

  findEntityByName(name: string, scope?: string): Entity | undefined {
    let sql = 'SELECT * FROM entities WHERE canonical_name = ?';
    const params: unknown[] = [name];
    if (scope) { sql += ' AND scope = ?'; params.push(scope); }
    const row = this.stmt(sql).get(...params) as Record<string, unknown> | undefined;
    return row ? this.rowToEntity(row) : undefined;
  }

  getAllEntities(scope?: string): Entity[] {
    const sql = scope
      ? 'SELECT * FROM entities WHERE scope = ? ORDER BY canonical_name'
      : 'SELECT * FROM entities ORDER BY canonical_name';
    const rows = scope
      ? this.stmt(sql).all(scope) as Record<string, unknown>[]
      : this.stmt(sql).all() as Record<string, unknown>[];
    return rows.map(row => this.rowToEntity(row));
  }

  updateEntityType(id: string, type: string): void {
    this.db.prepare('UPDATE entities SET type = ? WHERE id = ?').run(type, id);
  }

  private rowToEntity(row: Record<string, unknown>): Entity {
    return {
      id: row['id'] as string,
      canonical_name: row['canonical_name'] as string,
      aliases: JSON.parse(row['aliases'] as string),
      type: row['type'] as string,
      scope: row['scope'] as string,
      created_at: row['created_at'] as string,
    };
  }

  insertClaim(claim: Claim): void {
    const [tIngestedValue, tIngestedState, tIngestedBasis] = serialiseTime(claim.t_ingested);
    const [tInvalidatedValue, tInvalidatedState, tInvalidatedBasis] = serialiseTime(claim.t_invalidated);
    const [tValidFromValue, tValidFromState, tValidFromBasis] = serialiseTime(claim.t_valid_from);
    const [tValidToValue, tValidToState, tValidToBasis] = serialiseTime(claim.t_valid_to);

    // Spec-conformant fields default to spec-compliant values when the
    // caller hasn't supplied them. Legacy callers continue to work; new
    // emitters (PR-5+) populate explicitly.
    const state: ClaimState = claim.state ?? statusToState(claim.status);
    const author: ClaimAuthor = claim.author ?? 'agent';
    const epistemicOwner: ClaimAuthor = claim.epistemic_owner ?? author;
    const claimType: ClaimType = claim.claim_type ?? 'finding';
    const claimRole: ClaimRole = claim.claim_role ?? 'memory';
    const versionAt = claim.version_at ?? claim.extraction.extracted_at;
    const createdAt = claim.created_at ?? claim.extraction.extracted_at;
    const operationId = claim.operation_id ?? null;
    const actorId = claim.actor_id ?? null;
    const relations = claim.relations ?? [];

    this.db.prepare(`
      INSERT OR REPLACE INTO claims
        (id, subject_id, subject_name, predicate, object_type, object_value,
         scope, validity_from, validity_to,
         t_ingested_value, t_ingested_state, t_ingested_basis,
         t_invalidated_value, t_invalidated_state, t_invalidated_basis,
         t_valid_from_value, t_valid_from_state, t_valid_from_basis,
         t_valid_to_value, t_valid_to_state, t_valid_to_basis,
         source_event_id, extraction_event_id,
         supporting_evidence, extraction_method, extraction_model, compiler_version,
         prompt_hash, extracted_at, status, epistemic, confidence, sensitive,
         superseded_by, contested_by,
         state, author, epistemic_owner, claim_type, claim_role,
         version_at, created_at, operation_id, actor_id, relations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?)
    `).run(
      claim.id,
      claim.subject_id,
      claim.subject_name,
      claim.predicate,
      claim.object.type,
      JSON.stringify(claim.object.value),
      claim.scope,
      claim.validity.from,
      claim.validity.to ?? null,
      tIngestedValue,
      tIngestedState,
      tIngestedBasis,
      tInvalidatedValue,
      tInvalidatedState,
      tInvalidatedBasis,
      tValidFromValue,
      tValidFromState,
      tValidFromBasis,
      tValidToValue,
      tValidToState,
      tValidToBasis,
      claim.source_event_id,
      claim.extraction_event_id,
      JSON.stringify(claim.supporting_evidence),
      claim.extraction.method,
      claim.extraction.model ?? null,
      claim.extraction.compiler_version,
      claim.extraction.prompt_hash ?? null,
      claim.extraction.extracted_at,
      claim.status,
      claim.epistemic,
      claim.confidence,
      claim.sensitive ? 1 : 0,
      claim.superseded_by ?? null,
      JSON.stringify(claim.contested_by),
      state,
      author,
      epistemicOwner,
      claimType,
      claimRole,
      versionAt,
      createdAt,
      operationId,
      actorId,
      JSON.stringify(relations),
    );

    // Latest-version-only adjacency maintenance (Reference Impl v0.1.2):
    // delete any prior rows for this claim, then insert rows for the new
    // version's relations.
    this.refreshAdjacency(claim.id, relations);

    // L1 JSONL append (PR-14). One line per insertClaim invocation. The
    // version chain on disk grows monotonically; the SQLite row above is
    // a "latest active view" derived from these canonical records.
    if (this.dataDir) {
      const contentStr = typeof claim.object.value === 'string'
        ? claim.object.value
        : JSON.stringify(claim.object.value);
      const version = this.nextVersionFor(claim.id);
      const opId = operationId ?? LEGACY_OPERATION_ID;
      const actId = actorId ?? 'substrate:legacy';
      const fp = computeStructuredClaimFingerprint(
        claim.subject_name,
        claim.predicate,
        claim.object,
        claim.scope,
        claimType,
      );
      const base = {
        claim_id: claim.id,
        version,
        claim_type: claimType,
        claim_role: claimRole,
        author,
        epistemic_owner: epistemicOwner,
        fingerprint: fp,
        confidence: confidenceToBucket(claim.confidence),
        epistemic_tag: epistemicToTag(claim.epistemic, claim.status),
        scope: claim.scope,
        derived_from: claim.supporting_evidence,
        relations,
        created_at: createdAt,
        version_at: versionAt,
        operation_id: opId,
        actor_id: actId,
        tags: [],
        // Spec §6 defines `supersedes` as "the prior version number this version replaces", and the
        // published record contract requires it for version > 1 (`claim.schema.json`: `if version >= 2
        // then required supersedes`). Every other writer of the canonical surface sets it — FORGET,
        // retention, consolidation, FORGET.SCOPE and REVISE all hand-build `supersedes: latest.version`
        // — while this one derived the number (from `nextVersionFor`) and then dropped it, so every
        // version ≥ 2 record it appended failed the contract (measured kanban t_3ba3ee39).
        // A version-1 record names nothing: a claim can be *born* forgotten on the legacy/migration
        // and `replay.ts` retraction paths, and there is no prior version to point at — which is why
        // `claim.schema.json`'s forgotten branch does not require this field (ADR-0012).
        ...(version > 1 ? { supersedes: version - 1 } : {}),
        // A demotion rides the canonical record, not just the derived row: without this,
        // re-materialising the record (compile-path sync) or replaying the log restores the
        // duplicate to the recall-eligible set. `t_invalidated` is the demotion commit time
        // when the caller stamped one; otherwise the record's own commit time stands in.
        ...(claim.status === 'superseded' && claim.superseded_by != null
          ? { superseded_by: claim.superseded_by, superseded_at: claim.t_invalidated.value ?? versionAt }
          : {}),
      };
      const record: ClaimVersionRecord = state === 'active'
        ? {
            ...base,
            state: 'active' as const,
            content: contentStr,
            semantic: {
              subject_name: claim.subject_name,
              subject_type: this.getEntity(claim.subject_id)?.type ?? 'concept',
              predicate: claim.predicate,
              object: claim.object,
              t_valid_from: claim.t_valid_from,
              t_valid_to: claim.t_valid_to,
              extracted_epistemic: claim.epistemic,
              extracted_confidence: claim.confidence,
              sensitive: claim.sensitive,
              extraction: claim.extraction,
            },
          }
        : { ...base, state: 'forgotten' as const, tombstone_id: `tomb_${claim.id.slice(6)}`, forgotten_at: versionAt, forgotten_by: actId };
      this.appendVersionRecord(record);
    }
  }

  /**
   * §11.2b re-scope: batch-sync a compile run's committed records in one
   * transaction with chunked multi-row INSERTs. The per-row version measured
   * ~20% of the 50k pipeline (each row: entity SELECT + 44-column INSERT OR
   * REPLACE + adjacency maintenance).
   *
   * `newIds` marks claim ids minted by THIS run. They are known-new, so:
   *   - the getClaim SELECT is elided (nothing can exist yet), and
   *   - adjacency maintenance is skipped for relations-less records (no prior
   *     adjacency rows can exist for a brand-new claim).
   * Entity resolution consults a per-batch memo (keyed scope|name|type) that
   * is populated only when resolveEntity CREATES the entity — a repeat of the
   * exact serial call sequence would find that entity by exact canonical_name
   * match anyway, so derived rows are identical and creation-log telemetry is
   * preserved. Extension/forgotten rows run the full path.
   */
  syncFromJsonlVersionsBatch(
    records: import('./jsonl.js').ClaimVersionRecord[],
    newIds?: ReadonlySet<string>,
    entityHints?: ReadonlyMap<string, { name: string; type: string; predicate?: string; sensitive?: boolean }>,
  ): void {
    if (records.length === 0) return;
    const isNew = newIds
      ? (record: import('./jsonl.js').ClaimVersionRecord) => newIds.has(record.claim_id)
      : () => false;
    this.transaction(() => {
      /** resolveEntity outcomes for entity creations — batch-local memo. */
      const entityMemo = new Map<string, string>();
      // Chunked multi-row INSERT: 45 columns × 200 rows = 9,000 binds, well
      // under SQLite's 32,767 default limit.
      const CHUNK = 200;
      let chunkVals: unknown[][] = [];
      let chunkRecords: import('./jsonl.js').ClaimVersionRecord[] = [];
      const flushChunk = (): void => {
        if (chunkVals.length === 0) return;
        const placeholders = chunkVals
          .map((row) => `(${row.map(() => '?').join(', ')})`)
          .join(', ');
        const stmt = this.stmt(
          `INSERT OR REPLACE INTO claims
            (id, subject_id, subject_name, predicate, object_type, object_value,
             scope, validity_from, validity_to,
             t_ingested_value, t_ingested_state, t_ingested_basis,
             t_invalidated_value, t_invalidated_state, t_invalidated_basis,
             t_valid_from_value, t_valid_from_state, t_valid_from_basis,
             t_valid_to_value, t_valid_to_state, t_valid_to_basis,
             source_event_id, extraction_event_id,
             supporting_evidence, extraction_method, extraction_model, compiler_version,
             prompt_hash, extracted_at, status, epistemic, confidence, sensitive,
             superseded_by, contested_by,
             state, author, epistemic_owner, claim_type, claim_role,
             version_at, created_at, operation_id, actor_id, relations)
          VALUES ${placeholders}`,
        );
        const flat: unknown[] = [];
        for (const row of chunkVals) for (const v of row) flat.push(v);
        stmt.run(...flat);
        for (let i = 0; i < chunkRecords.length; i++) {
          const record = chunkRecords[i]!;
          if (isNew(record) && record.relations.length === 0) continue;
          this.refreshAdjacency(record.claim_id, record.relations);
        }
        chunkVals = [];
        chunkRecords = [];
      };

      for (const record of records) {
        const entityHint = entityHints?.get(record.claim_id);
        chunkVals.push(this.claimVersionVals(record, entityHint, isNew(record), entityMemo));
        chunkRecords.push(record);
        if (chunkVals.length >= CHUNK) flushChunk();
      }
      flushChunk();
    });
  }

  /**
   * Build the 45 bound values for a claims-table row from a canonical
   * version record. Existing-row fallbacks (source_event_id, extraction,
   * superseded_by, contested_by) only apply when `existing` is supplied; the
   * caller elides the lookup for known-new records.
   */
  private claimVersionVals(
    v: import('./jsonl.js').ClaimVersionRecord,
    entityHint: { name: string; type: string; predicate?: string; sensitive?: boolean } | undefined,
    assumeNew: boolean,
    entityMemo?: Map<string, string>,
  ): unknown[] {
    const existing = assumeNew ? undefined : this.getClaim(v.claim_id);
    const content = v.state === 'active' ? v.content : '';
    const semantic = v.state === 'active' ? v.semantic : undefined;
    const confNum = v.confidence === 'high' ? 0.9 : v.confidence === 'medium' ? 0.5 : 0.2;
    const epist = v.epistemic_tag === 'fact' ? 'user_confirmed' : 'inferred';
    // Derived from the canonical record, never from the row being replaced: the row is
    // rebuild-equivalent only if this derivation is a pure function of the record. A demoted
    // duplicate carries `superseded_by`/`superseded_at` on its own version records, so a
    // compile-path sync or a replay reconstructs the demotion instead of restoring the row.
    const supersededBy = v.state === 'active' ? (v.superseded_by ?? null) : null;
    const supersededAt = supersededBy ? (v.superseded_at ?? v.version_at) : null;
    const status = v.state === 'active' ? (supersededBy ? 'superseded' : 'active') : 'retracted';
    const now = v.created_at;
    const existingEntity = existing ? this.getEntity(existing.subject_id) : undefined;
    const entityName = semantic?.subject_name
      ?? entityHint?.name
      ?? existing?.subject_name
      ?? (content.slice(0, 50) || 'observation');
    const entityType = semantic?.subject_type ?? entityHint?.type ?? existingEntity?.type ?? 'concept';
    const predicate = semantic?.predicate ?? entityHint?.predicate ?? existing?.predicate ?? 'content_is';
    const object = semantic?.object ?? { type: 'text' as const, value: content };
    const tValidFrom = semantic?.t_valid_from ?? existing?.t_valid_from ?? knownTime(now);
    const tValidTo = semantic?.t_valid_to ?? existing?.t_valid_to ?? nullTime();
    const [tValidFromValue, tValidFromState, tValidFromBasis] = serialiseTime(tValidFrom);
    const [tValidToValue, tValidToState, tValidToBasis] = serialiseTime(tValidTo);
    const validityFrom = tValidFrom.value ?? now;
    const validityTo = tValidTo.value;
    const sensitive = Number(
      semantic?.sensitive
      ?? entityHint?.sensitive
      ?? existing?.sensitive
      ?? false,
    );
    const extraction = semantic?.extraction ?? existing?.extraction;

    const memoKey = `${v.scope}|${entityName}|${entityType}`;
    let entityId: string;
    const memoEntityId = entityMemo?.get(memoKey);
    if (memoEntityId) {
      entityId = memoEntityId;
    } else {
      const resolved = resolveEntity(entityName, entityType, v.scope, this);
      entityId = resolved.id;
      // Memoize only creations: a repeat of this exact call would hit the
      // canonical_name exact-match path and return the same id; fuzzy-repeat
      // telemetry (merge logs) still runs every time, matching serial order.
      if (resolved.isNew) entityMemo?.set(memoKey, entityId);
    }

    return [
      v.claim_id, entityId, entityName, predicate, object.type, JSON.stringify(object.value),
      v.scope, validityFrom, validityTo,
      now, 'known', null,
      supersededAt, supersededAt ? 'known' : 'null', null,
      tValidFromValue, tValidFromState, tValidFromBasis,
      tValidToValue, tValidToState, tValidToBasis,
      existing?.source_event_id ?? v.derived_from[0] ?? '',
      existing?.extraction_event_id ?? '',
      JSON.stringify(v.derived_from), extraction?.method ?? 'deterministic',
      extraction?.model ?? null, extraction?.compiler_version ?? '0.6.1',
      extraction?.prompt_hash ?? null, extraction?.extracted_at ?? now, status, epist, confNum, sensitive,
      supersededBy, JSON.stringify(existing?.contested_by ?? []),
      v.state, v.author, v.epistemic_owner, v.claim_type, v.claim_role,
      v.version_at, v.created_at, v.operation_id, v.actor_id, JSON.stringify(v.relations),
    ];
  }

  /**
   * Replace adjacency rows for a single claim with the supplied relations.
   * Always invoked from insertClaim; safe to call standalone.
   */
  refreshAdjacency(claimId: string, relations: ClaimRelation[]): void {
    this.stmt('DELETE FROM claim_relations WHERE source_claim_id = ?').run(claimId);
    const insertRel = this.stmt(`
      INSERT OR IGNORE INTO claim_relations
        (relation_id, source_claim_id, source_version, kind, target_claim_id,
         valid_at, invalid_at, origin, asserted_in_source_version,
         target_claim_version, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const rel of relations) {
      insertRel.run(
        rel.relation_id,
        claimId,
        'asserted_in_source_version' in rel.provenance
          ? rel.provenance.asserted_in_source_version
          : 1,
        rel.kind,
        rel.target,
        rel.valid_at,
        rel.invalid_at,
        rel.provenance.origin,
        'asserted_in_source_version' in rel.provenance ? rel.provenance.asserted_in_source_version : null,
        'target_claim_version' in rel.provenance ? rel.provenance.target_claim_version : null,
        JSON.stringify(rel.provenance),
      );
    }
  }

  /** Outbound: source has relation `kind` to target. */
  getOutboundRelations(claimId: string, kind?: RelationKind): ClaimRelation[] {
    const sql = kind
      ? 'SELECT * FROM claim_relations WHERE source_claim_id = ? AND kind = ?'
      : 'SELECT * FROM claim_relations WHERE source_claim_id = ?';
    const rows = kind
      ? (this.db.prepare(sql).all(claimId, kind) as Array<Record<string, unknown>>)
      : (this.db.prepare(sql).all(claimId) as Array<Record<string, unknown>>);
    return rows.map(rowToClaimRelation);
  }

  /** Inbound: who has a relation pointing at this claim? */
  getInboundRelations(targetId: string, kind?: RelationKind): Array<ClaimRelation & { source: string }> {
    const sql = kind
      ? 'SELECT * FROM claim_relations WHERE target_claim_id = ? AND kind = ?'
      : 'SELECT * FROM claim_relations WHERE target_claim_id = ?';
    const rows = kind
      ? (this.db.prepare(sql).all(targetId, kind) as Array<Record<string, unknown>>)
      : (this.db.prepare(sql).all(targetId) as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      ...rowToClaimRelation(row),
      source: row['source_claim_id'] as string,
    }));
  }

  getClaim(id: string): Claim | undefined {
    const row = this.stmt('SELECT * FROM claims WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToClaim(row) : undefined;
  }

  findByCanonicalKey(subjectId: string, predicate: string, scope: string, validityFrom: string): Claim | undefined {
    const row = this.db.prepare(
      'SELECT * FROM claims WHERE subject_id = ? AND predicate = ? AND scope = ? AND validity_from = ?'
    ).get(subjectId, predicate, scope, validityFrom) as Record<string, unknown> | undefined;
    return row ? this.rowToClaim(row) : undefined;
  }

  getClaimsBySubject(subjectId: string, status?: ClaimStatus): Claim[] {
    const sql = status
      ? 'SELECT * FROM claims WHERE subject_id = ? AND status = ?'
      : 'SELECT * FROM claims WHERE subject_id = ?';
    const rows = status
      ? this.db.prepare(sql).all(subjectId, status) as Record<string, unknown>[]
      : this.db.prepare(sql).all(subjectId) as Record<string, unknown>[];
    return rows.map(row => this.rowToClaim(row));
  }

  findActiveFactMatches(
    subjectId: string,
    fact: { predicate: string; scope: string; object: TypedValue },
  ): Claim[] {
    const wanted = normaliseValue(fact.object);
    return this.getClaimsBySubject(subjectId, 'active')
      .filter(claim =>
        claim.predicate === fact.predicate
        && claim.scope === fact.scope
        && claim.validity.to === null
        && normaliseValue(claim.object) === wanted)
      // Survivor order: claim ids are ULIDs (time-ordered), so the smallest id is the
      // earliest-minted claim. Returning the list in that order means `matches[0]` is the
      // survivor even for a caller that ignores the rest.
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  getActiveClaims(scope?: string): Claim[] {
    const sql = scope
      ? "SELECT * FROM claims WHERE status IN ('active', 'stale') AND scope = ?"
      : "SELECT * FROM claims WHERE status IN ('active', 'stale')";
    const rows = scope
      ? this.db.prepare(sql).all(scope) as Record<string, unknown>[]
      : this.db.prepare(sql).all() as Record<string, unknown>[];
    return rows.map(row => this.rowToClaim(row));
  }

  getAllClaims(scope?: string): Claim[] {
    const rows = scope
      ? this.db.prepare('SELECT * FROM claims WHERE scope = ?').all(scope) as Record<string, unknown>[]
      : this.db.prepare('SELECT * FROM claims').all() as Record<string, unknown>[];
    return rows.map(row => this.rowToClaim(row));
  }

  syncFromJsonlVersion(
    v: import('./jsonl.js').ClaimVersionRecord,
    entityHint?: { name: string; type: string; predicate?: string; sensitive?: boolean },
    /**
     * §11.2b re-scope fast path: claim_id was minted by THIS run (known-new) —
     * skip the getClaim/getEntity SELECTs (nothing can exist yet) and skip the
     * adjacency DELETE (no prior rows for a brand-new claim). Equivalent rows
     * to the general path; only the lookups are elided.
     */
    assumeNew = false,
  ): void {
    const vals = this.claimVersionVals(v, entityHint, assumeNew);
    const placeholders = vals.map(() => '?').join(', ');
    this.stmt(`
      INSERT OR REPLACE INTO claims
        (id, subject_id, subject_name, predicate, object_type, object_value,
         scope, validity_from, validity_to,
         t_ingested_value, t_ingested_state, t_ingested_basis,
         t_invalidated_value, t_invalidated_state, t_invalidated_basis,
         t_valid_from_value, t_valid_from_state, t_valid_from_basis,
         t_valid_to_value, t_valid_to_state, t_valid_to_basis,
         source_event_id, extraction_event_id,
         supporting_evidence, extraction_method, extraction_model, compiler_version,
         prompt_hash, extracted_at, status, epistemic, confidence, sensitive,
         superseded_by, contested_by,
         state, author, epistemic_owner, claim_type, claim_role,
         version_at, created_at, operation_id, actor_id, relations)
      VALUES (${placeholders})
    `).run(...vals);
    // §11.2b fast path: brand-new claim + no relations → nothing to maintain
    // (prior adjacency rows cannot exist; nothing to insert either).
    if (!(assumeNew && v.relations.length === 0)) {
      this.refreshAdjacency(v.claim_id, v.relations);
    }
  }

  updateClaimStatus(id: string, status: ClaimStatus, supersededBy?: string, invalidatedAt?: ClaimTimeValue): void {
    const claim = this.getClaim(id);
    if (!claim) return;
    claim.status = status;
    claim.state = statusToState(status);
    if (status === 'superseded') {
      if (supersededBy !== undefined) {
        claim.superseded_by = supersededBy;
      }
    } else {
      // `superseded_by` only means something while the claim is superseded; leaving a stale
      // pointer behind is the same defect class as a demotion that exists only in the row.
      claim.superseded_by = null;
    }
    if (invalidatedAt) {
      claim.t_invalidated = invalidatedAt;
    }
    claim.validity = compatibilityValidity(claim.t_valid_from, claim.t_valid_to, claim.t_ingested);
    this.insertClaim(claim);
  }

  updateClaimSupportingEvidence(id: string, evidence: string[]): void {
    const claim = this.getClaim(id);
    if (!claim) return;
    claim.supporting_evidence = evidence;
    this.insertClaim(claim);
  }

  updateClaimConfidence(id: string, confidence: number): void {
    const claim = this.getClaim(id);
    if (!claim) return;
    claim.confidence = confidence;
    this.insertClaim(claim);
  }

  markContested(id1: string, id2: string): void {
    const first = this.getClaim(id1);
    const second = this.getClaim(id2);
    if (!first || !second) return;

    first.contested_by = [...new Set([...first.contested_by, id2])];
    second.contested_by = [...new Set([...second.contested_by, id1])];
    first.status = 'contested';
    second.status = 'contested';

    this.insertClaim(first);
    this.insertClaim(second);
  }

  redactClaim(id: string): void {
    const claim = this.getClaim(id);
    if (!claim) return;
    claim.object = { type: 'text', value: '[redacted]' };
    this.insertClaim(claim);
  }

  deleteAllClaims(): void {
    this.db.exec('DELETE FROM claims');
    this.db.exec('DELETE FROM entities');
  }

  /**
   * FORGET.SCOPE{reason:erasure} physical purge (spec §10): remove every
   * claim row, scope-owned entity row, and relation edge (source OR target)
   * for the scope's claims. Caller is responsible for the L1 JSONL purge —
   * this SQLite surface is derived, and the canonical log must agree so a
   * wipe-and-rebuild cannot resurrect erased content (rebuild-equivalence).
   */
  purgeByScope(scope: string): { claims: number; entities: number; relations: number } {
    const result = { claims: 0, entities: 0, relations: 0 };
    this.transaction(() => {
      const claimRows = this.stmt('SELECT id FROM claims WHERE scope = ?').all(scope) as Array<{ id: string }>;
      const ids = claimRows.map(row => row.id);
      result.claims = this.stmt('DELETE FROM claims WHERE scope = ?').run(scope).changes;
      result.entities = this.stmt('DELETE FROM entities WHERE scope = ?').run(scope).changes;
      if (ids.length > 0) {
        const relationDelete = this.stmt(
          'DELETE FROM claim_relations WHERE source_claim_id IN (SELECT value FROM json_each(?)) OR target_claim_id IN (SELECT value FROM json_each(?))',
        );
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = JSON.stringify(ids.slice(i, i + 500));
          result.relations += relationDelete.run(chunk, chunk).changes;
        }
      }
    });
    return result;
  }

  setLastReplayedSequence(seq: number): void {
    this.db.prepare("INSERT OR REPLACE INTO layer1_state (key, value) VALUES ('last_replayed_sequence', ?)")
      .run(String(seq));
  }

  getLastReplayedSequence(): number {
    const row = this.db.prepare("SELECT value FROM layer1_state WHERE key = 'last_replayed_sequence'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  claimCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as count FROM claims').get() as { count: number }).count;
  }

  entityCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as count FROM entities').get() as { count: number }).count;
  }

  private rowToClaim(row: Record<string, unknown>): Claim {
    const extractedAt = row['extracted_at'] as string;
    const fallbackIngested = knownTime(extractedAt);
    const tIngested = rowToTime(row, 't_ingested', fallbackIngested);
    const tInvalidated = rowToTime(row, 't_invalidated', nullTime());
    const legacyValidFrom = row['validity_from'] as string | undefined;
    const legacyValidTo = row['validity_to'] as string | null | undefined;
    const tValidFrom = rowToTime(
      row,
      't_valid_from',
      legacyValidFrom ? inferredTime(legacyValidFrom, 'legacy_validity_from') : nullTime(),
    );
    const tValidTo = rowToTime(
      row,
      't_valid_to',
      legacyValidTo ? inferredTime(legacyValidTo, 'legacy_validity_to') : nullTime(),
    );
    const validity = compatibilityValidity(tValidFrom, tValidTo, tIngested);

    return {
      id: row['id'] as string,
      subject_id: row['subject_id'] as string,
      subject_name: row['subject_name'] as string,
      predicate: row['predicate'] as string,
      object: {
        type: row['object_type'] as Claim['object']['type'],
        value: JSON.parse(row['object_value'] as string),
      },
      scope: row['scope'] as string,
      validity,
      t_ingested: tIngested,
      t_invalidated: tInvalidated,
      t_valid_from: tValidFrom,
      t_valid_to: tValidTo,
      source_event_id: row['source_event_id'] as string,
      extraction_event_id: row['extraction_event_id'] as string,
      supporting_evidence: JSON.parse(row['supporting_evidence'] as string),
      extraction: {
        method: row['extraction_method'] as Claim['extraction']['method'],
        model: row['extraction_model'] as string | null,
        compiler_version: row['compiler_version'] as string,
        prompt_hash: row['prompt_hash'] as string | null,
        extracted_at: extractedAt,
      },
      status: row['status'] as ClaimStatus,
      epistemic: row['epistemic'] as EpistemicLabel,
      confidence: row['confidence'] as number,
      sensitive: !!(row['sensitive'] as number),
      superseded_by: row['superseded_by'] as string | null,
      contested_by: JSON.parse(row['contested_by'] as string),
      // Spec v1.5.4.2 fields. Backfilled on legacy rows during migrateSchema.
      state: ((row['state'] as ClaimState | undefined) ?? statusToState(row['status'] as ClaimStatus)) as ClaimState,
      author: ((row['author'] as ClaimAuthor | undefined) ?? 'agent') as ClaimAuthor,
      epistemic_owner: ((row['epistemic_owner'] as ClaimAuthor | undefined)
        ?? (row['author'] as ClaimAuthor | undefined)
        ?? 'agent') as ClaimAuthor,
      claim_type: ((row['claim_type'] as ClaimType | undefined) ?? 'finding') as ClaimType,
      claim_role: ((row['claim_role'] as ClaimRole | undefined) ?? 'memory') as ClaimRole,
      version_at: ((row['version_at'] as string | undefined) ?? extractedAt) as string,
      created_at: ((row['created_at'] as string | undefined) ?? extractedAt) as string,
      operation_id: (row['operation_id'] as string | null | undefined) ?? null,
      actor_id: (row['actor_id'] as string | null | undefined) ?? null,
      relations: row['relations']
        ? (JSON.parse(row['relations'] as string) as ClaimRelation[])
        : [],
    };
  }

  close(): void {
    this.db.close();
  }

  getDB(): Database.Database {
    return this.db;
  }
}
