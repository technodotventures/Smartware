import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { ensureColumn } from '../storage/schema.js';

import {
  SEMANTIC_INDEX_VERSION,
  semanticDocumentSetHash,
  semanticModelKey,
  semanticRecordSetHash,
  syncSemanticRecords,
  type EmbeddingAdapter,
  type SemanticDocument,
  type SemanticEmbeddingRecord,
  type SemanticSyncResult,
} from './semantic.js';
import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS semantic_records (
  id TEXT NOT NULL,
  scope TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_key TEXT NOT NULL,
  index_version INTEGER NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  PRIMARY KEY (model_key, index_version, scope, id)
);

CREATE INDEX IF NOT EXISTS idx_semantic_records_scope
  ON semantic_records(model_key, index_version, scope);

CREATE TABLE IF NOT EXISTS semantic_index_manifests (
  model_key TEXT NOT NULL,
  index_version INTEGER NOT NULL,
  scope TEXT NOT NULL,
  dimensions INTEGER,
  record_count INTEGER NOT NULL,
  source_document_count INTEGER,
  document_set_hash TEXT,
  coverage TEXT,
  replaced_at TEXT NOT NULL,
  PRIMARY KEY (model_key, index_version, scope)
);
`;

interface SemanticRecordRow {
  id: string;
  scope: string;
  content_hash: string;
  model_key: string;
  index_version: number;
  dimensions: number;
  vector_json: string;
}

interface SemanticManifestRow {
  dimensions: number | null;
  record_count: number;
  source_document_count: number | null;
  document_set_hash: string | null;
  coverage: string | null;
}

export type SemanticIndexCoverage = 'complete' | 'partial';

export interface SemanticIndexSnapshot {
  source_document_count: number;
  document_set_hash: string;
  coverage: SemanticIndexCoverage;
}

export interface SemanticIndexExpectation {
  source_document_count: number;
  document_set_hash: string;
  require_complete?: boolean;
}

export type SemanticRecordLoadStatus =
  | 'ready'
  | 'missing'
  | 'degraded'
  | 'unavailable';

export interface SemanticRecordLoadResult {
  status: SemanticRecordLoadStatus;
  records: SemanticEmbeddingRecord[];
  invalid_records: number;
  expected_records: number | null;
  source_document_count: number | null;
  document_set_hash: string | null;
  coverage: SemanticIndexCoverage | null;
  error?: string;
}

export type SemanticRecordStoreOpenResult =
  | { status: 'ready'; store: SemanticRecordStore }
  | { status: 'unavailable'; store: null; error: string };

export interface PersistedSemanticSyncResult extends SemanticSyncResult {
  prior_status: SemanticRecordLoadStatus;
  invalid_records: number;
  indexed_document_count: number;
  source_document_count: number;
  document_set_hash: string;
  coverage: SemanticIndexCoverage;
}

export interface PersistedSemanticSyncOptions {
  source_documents?: SemanticDocument[];
  coverage?: SemanticIndexCoverage;
  timeout_ms?: number;
}

export interface SemanticRecordResetOptions {
  model_key?: string;
  scope?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validIndexVersion(indexVersion: number): void {
  if (!Number.isInteger(indexVersion) || indexVersion < 1) {
    throw new Error('Semantic index version must be a positive integer');
  }
}

function validSnapshot(snapshot: SemanticIndexSnapshot): void {
  if (!Number.isInteger(snapshot.source_document_count)
    || snapshot.source_document_count < 0) {
    throw new Error('Semantic source document count must be a non-negative integer');
  }
  if (!/^[a-f0-9]{64}$/u.test(snapshot.document_set_hash)) {
    throw new Error('Semantic document set hash must be a SHA-256 hex digest');
  }
  if (snapshot.coverage !== 'complete' && snapshot.coverage !== 'partial') {
    throw new Error('Semantic index coverage must be complete or partial');
  }
}

function validVector(
  dimensions: number,
  vector: unknown,
  expectedDimensions?: number,
): vector is number[] {
  return Number.isInteger(dimensions)
    && dimensions > 0
    && Array.isArray(vector)
    && vector.length === dimensions
    && (expectedDimensions === undefined || dimensions === expectedDimensions)
    && vector.every(value => typeof value === 'number' && Number.isFinite(value))
    && vector.some(value => value !== 0);
}

function parseRecord(
  row: SemanticRecordRow,
  expectedModelKey: string,
  expectedIndexVersion: number,
  expectedDimensions?: number,
): SemanticEmbeddingRecord | null {
  try {
    const vector = JSON.parse(row.vector_json) as unknown;
    if (!row.id
      || !row.scope
      || !/^[a-f0-9]{64}$/u.test(row.content_hash)
      || row.model_key !== expectedModelKey
      || row.index_version !== expectedIndexVersion
      || !validVector(row.dimensions, vector, expectedDimensions)) {
      return null;
    }
    return {
      id: row.id,
      scope: row.scope,
      content_hash: row.content_hash,
      model_key: row.model_key,
      index_version: row.index_version,
      dimensions: row.dimensions,
      vector: [...vector],
    };
  } catch {
    return null;
  }
}

function validateReplacement(
  records: SemanticEmbeddingRecord[],
  adapter: EmbeddingAdapter,
  indexVersion: number,
): void {
  const key = semanticModelKey(adapter);
  const ids = new Set<string>();
  let dimensions = adapter.dimensions;
  for (const record of records) {
    if (!record.id || ids.has(record.id)) {
      throw new Error(`Duplicate or missing semantic record id: ${record.id}`);
    }
    ids.add(record.id);
    if (!record.scope) throw new Error('Semantic record scope is required');
    if (!/^[a-f0-9]{64}$/u.test(record.content_hash)) {
      throw new Error(`Invalid semantic content hash: ${record.id}`);
    }
    if (record.model_key !== key) {
      throw new Error(`Semantic record model mismatch: ${record.id}`);
    }
    if (record.index_version !== indexVersion) {
      throw new Error(`Semantic record index version mismatch: ${record.id}`);
    }
    dimensions ??= record.dimensions;
    if (!validVector(record.dimensions, record.vector, dimensions)) {
      throw new Error(`Invalid semantic vector: ${record.id}`);
    }
  }
}

/**
 * Disposable local persistence for derived semantic records.
 *
 * Canonical claims never live here. Replacing a model-and-scope partition is
 * atomic, and callers can delete the database or call reset without affecting
 * memory.
 */
export class SemanticRecordStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') ensurePrivateDirectory(dirname(dbPath));

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath);
      if (dbPath !== ':memory:') ensurePrivateFile(dbPath);
      const integrity = db.pragma('quick_check', { simple: true });
      if (integrity !== 'ok') {
        throw new Error(`Semantic index integrity check failed: ${String(integrity)}`);
      }
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.exec(SCHEMA);
      ensureColumn(db, 'semantic_index_manifests', 'source_document_count', 'INTEGER');
      ensureColumn(db, 'semantic_index_manifests', 'document_set_hash', 'TEXT');
      ensureColumn(db, 'semantic_index_manifests', 'coverage', 'TEXT');
      this.db = db;
    } catch (error) {
      db?.close();
      throw error;
    }
  }

  load(
    adapter: EmbeddingAdapter,
    scope: string,
    indexVersion = SEMANTIC_INDEX_VERSION,
    expected?: SemanticIndexExpectation,
  ): SemanticRecordLoadResult {
    validIndexVersion(indexVersion);
    if (!scope) throw new Error('Semantic index scope is required');
    const key = semanticModelKey(adapter);
    try {
      const manifest = this.db.prepare(`
        SELECT dimensions, record_count, source_document_count, document_set_hash, coverage
        FROM semantic_index_manifests
        WHERE model_key = ? AND index_version = ? AND scope = ?
      `).get(key, indexVersion, scope) as SemanticManifestRow | undefined;
      const rows = this.db.prepare(`
        SELECT id, scope, content_hash, model_key, index_version, dimensions, vector_json
        FROM semantic_records
        WHERE model_key = ? AND index_version = ? AND scope = ?
        ORDER BY id
      `).all(key, indexVersion, scope) as SemanticRecordRow[];

      if (!manifest && rows.length === 0) {
        return {
          status: 'missing',
          records: [],
          invalid_records: 0,
          expected_records: null,
          source_document_count: null,
          document_set_hash: null,
          coverage: null,
        };
      }

      const manifestDimensions = manifest?.dimensions;
      const expectedDimensions = adapter.dimensions
        ?? (manifestDimensions !== null ? manifestDimensions : undefined);
      const records = rows.flatMap(row => {
        const record = parseRecord(row, key, indexVersion, expectedDimensions);
        return record ? [record] : [];
      });
      const invalidRecords = rows.length - records.length;
      const positiveManifestDimensions = Number.isInteger(manifestDimensions)
        && manifestDimensions! > 0;
      const manifestDimensionsValid = manifest !== undefined
        && ((manifest.record_count === 0 && manifestDimensions === null)
          || (positiveManifestDimensions
          && (adapter.dimensions === undefined
            || manifestDimensions === adapter.dimensions)));
      const complete = manifest !== undefined
        && manifestDimensionsValid
        && Number.isInteger(manifest.record_count)
        && manifest.record_count >= 0
        && rows.length === manifest.record_count
        && records.length === manifest.record_count;
      const coverage = manifest?.coverage === 'complete' || manifest?.coverage === 'partial'
        ? manifest.coverage
        : null;
      const sourceDocumentCount = manifest?.source_document_count ?? null;
      const documentSetHash = manifest?.document_set_hash ?? null;
      const snapshotValid = sourceDocumentCount !== null
        && Number.isInteger(sourceDocumentCount)
        && sourceDocumentCount >= manifest!.record_count
        && documentSetHash !== null
        && /^[a-f0-9]{64}$/u.test(documentSetHash)
        && coverage !== null
        && (coverage === 'partial' || sourceDocumentCount === manifest!.record_count);
      const expectationMatches = expected === undefined
        || (sourceDocumentCount === expected.source_document_count
          && documentSetHash === expected.document_set_hash
          && (expected.require_complete !== true || coverage === 'complete'));
      const ready = complete
        && snapshotValid
        && coverage === 'complete'
        && expectationMatches;
      let error: string | undefined;
      if (complete && snapshotValid && coverage === 'partial') {
        error = `Semantic index is partial (${manifest!.record_count}/${sourceDocumentCount} documents)`;
      } else if (complete && snapshotValid && !expectationMatches) {
        error = 'Semantic index is stale for the current authorized document set';
      } else if (!ready) {
        error = 'Semantic index manifest or records are incomplete';
      }

      return {
        status: ready ? 'ready' : 'degraded',
        records,
        invalid_records: invalidRecords,
        expected_records: manifest?.record_count ?? null,
        source_document_count: sourceDocumentCount,
        document_set_hash: documentSetHash,
        coverage,
        ...(error === undefined ? {} : { error }),
      };
    } catch (error) {
      return {
        status: 'unavailable',
        records: [],
        invalid_records: 0,
        expected_records: null,
        source_document_count: null,
        document_set_hash: null,
        coverage: null,
        error: errorMessage(error),
      };
    }
  }

  replace(
    adapter: EmbeddingAdapter,
    scope: string,
    records: SemanticEmbeddingRecord[],
    indexVersion = SEMANTIC_INDEX_VERSION,
    snapshot: SemanticIndexSnapshot = {
      source_document_count: records.length,
      document_set_hash: semanticRecordSetHash(records),
      coverage: 'complete',
    },
  ): void {
    validIndexVersion(indexVersion);
    if (!scope) throw new Error('Semantic index scope is required');
    if (records.some(record => record.scope !== scope)) {
      throw new Error('Semantic replacement records must match the index scope');
    }
    validateReplacement(records, adapter, indexVersion);
    validSnapshot(snapshot);
    if (snapshot.source_document_count < records.length) {
      throw new Error('Semantic source document count cannot be smaller than indexed records');
    }
    if (snapshot.coverage === 'complete'
      && snapshot.source_document_count !== records.length) {
      throw new Error('A complete semantic index must include every source document');
    }
    const key = semanticModelKey(adapter);
    const dimensions = adapter.dimensions ?? records[0]?.dimensions ?? null;
    const insertRecord = this.db.prepare(`
      INSERT INTO semantic_records
        (id, scope, content_hash, model_key, index_version, dimensions, vector_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM semantic_records WHERE model_key = ? AND scope = ?')
        .run(key, scope);
      this.db.prepare('DELETE FROM semantic_index_manifests WHERE model_key = ? AND scope = ?')
        .run(key, scope);
      for (const record of records) {
        insertRecord.run(
          record.id,
          record.scope,
          record.content_hash,
          record.model_key,
          record.index_version,
          record.dimensions,
          JSON.stringify(record.vector),
        );
      }
      this.db.prepare(`
        INSERT INTO semantic_index_manifests
          (model_key, index_version, scope, dimensions, record_count,
           source_document_count, document_set_hash, coverage, replaced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        key,
        indexVersion,
        scope,
        dimensions,
        records.length,
        snapshot.source_document_count,
        snapshot.document_set_hash,
        snapshot.coverage,
        new Date().toISOString(),
      );
    });
    replace();
  }

  reset(options: SemanticRecordResetOptions = {}): number {
    const { model_key: modelKey, scope } = options;
    const reset = this.db.transaction(() => {
      let records: Database.RunResult;
      if (modelKey && scope) {
        records = this.db.prepare(
          'DELETE FROM semantic_records WHERE model_key = ? AND scope = ?',
        ).run(modelKey, scope);
        this.db.prepare(
          'DELETE FROM semantic_index_manifests WHERE model_key = ? AND scope = ?',
        ).run(modelKey, scope);
      } else if (modelKey) {
        records = this.db.prepare('DELETE FROM semantic_records WHERE model_key = ?')
          .run(modelKey);
        this.db.prepare('DELETE FROM semantic_index_manifests WHERE model_key = ?')
          .run(modelKey);
      } else if (scope) {
        records = this.db.prepare('DELETE FROM semantic_records WHERE scope = ?')
          .run(scope);
        this.db.prepare('DELETE FROM semantic_index_manifests WHERE scope = ?')
          .run(scope);
      } else {
        records = this.db.prepare('DELETE FROM semantic_records').run();
        this.db.prepare('DELETE FROM semantic_index_manifests').run();
      }
      return records.changes;
    });
    return reset();
  }

  close(): void {
    this.db.close();
  }
}

export function openSemanticRecordStore(dbPath: string): SemanticRecordStoreOpenResult {
  try {
    return { status: 'ready', store: new SemanticRecordStore(dbPath) };
  } catch (error) {
    return {
      status: 'unavailable',
      store: null,
      error: errorMessage(error),
    };
  }
}

export async function syncPersistedSemanticRecords(
  store: SemanticRecordStore,
  scope: string,
  documents: SemanticDocument[],
  adapter: EmbeddingAdapter,
  batchSize = 64,
  options: PersistedSemanticSyncOptions = {},
): Promise<PersistedSemanticSyncResult> {
  if (!scope) throw new Error('Semantic index scope is required');
  if (documents.some(document => document.scope !== scope)) {
    throw new Error('Semantic sync documents must match the index scope');
  }
  const sourceDocuments = options.source_documents ?? documents;
  if (sourceDocuments.some(document => document.scope !== scope)) {
    throw new Error('Semantic source documents must match the index scope');
  }
  const coverage = options.coverage
    ?? (documents.length === sourceDocuments.length ? 'complete' : 'partial');
  const snapshot: SemanticIndexSnapshot = {
    source_document_count: sourceDocuments.length,
    document_set_hash: semanticDocumentSetHash(sourceDocuments),
    coverage,
  };
  validSnapshot(snapshot);
  const loaded = store.load(adapter, scope);
  const synced = await syncSemanticRecords(
    documents,
    loaded.records,
    adapter,
    batchSize,
    options.timeout_ms,
  );
  store.replace(adapter, scope, synced.records, SEMANTIC_INDEX_VERSION, snapshot);
  return {
    ...synced,
    prior_status: loaded.status,
    invalid_records: loaded.invalid_records,
    indexed_document_count: documents.length,
    ...snapshot,
  };
}
