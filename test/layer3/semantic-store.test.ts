import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  openSemanticRecordStore,
  rankHybridDocuments,
  semanticModelKey,
  SemanticRecordStore,
  syncPersistedSemanticRecords,
} from '../../src/core.js';
import type {
  EmbeddingAdapter,
  SemanticDocument,
} from '../../src/layer3/semantic.js';

const temporaryDirectories: string[] = [];

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'smartware-semantic-store-'));
  temporaryDirectories.push(directory);
  return join(directory, 'indices', 'semantic.db');
}

function document(id: string, text: string): SemanticDocument {
  return {
    id,
    scope: 'workspace',
    version: '2026-07-25T00:00:00.000Z',
    text,
    valid_time: { from: '2026-07-25T00:00:00.000Z', to: null },
    transaction_time: { from: '2026-07-25T00:00:00.000Z', to: null },
  };
}

function adapter(calls: string[][], model = 'persistent-v1'): EmbeddingAdapter {
  return {
    provider: 'fixture',
    model,
    dimensions: 2,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map(text => text.includes('alpha') ? [1, 0] : [0, 1]);
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Layer 3 semantic record persistence', () => {
  it('reuses records across restarts and atomically prunes deleted documents', async () => {
    const dbPath = temporaryPath();
    const calls: string[][] = [];
    const embeddingAdapter = adapter(calls);
    const alpha = document('claim_alpha', 'alpha memory');
    const beta = document('claim_beta', 'beta memory');
    let store = new SemanticRecordStore(dbPath);

    const first = await syncPersistedSemanticRecords(
      store,
      'workspace',
      [alpha, beta],
      embeddingAdapter,
    );
    expect(first).toMatchObject({
      prior_status: 'missing',
      embedded: 2,
      reused: 0,
      removed: 0,
    });
    store.close();

    calls.length = 0;
    store = new SemanticRecordStore(dbPath);
    const second = await syncPersistedSemanticRecords(
      store,
      'workspace',
      [alpha],
      embeddingAdapter,
    );
    expect(second).toMatchObject({
      prior_status: 'ready',
      embedded: 0,
      reused: 1,
      removed: 1,
    });
    expect(calls).toEqual([]);
    expect(store.load(embeddingAdapter, 'workspace')).toMatchObject({
      status: 'ready',
      records: [{ id: 'claim_alpha' }],
      invalid_records: 0,
      expected_records: 1,
    });
    store.close();
  });

  it('rejects an invalid replacement without losing the last good snapshot', async () => {
    const calls: string[][] = [];
    const embeddingAdapter = adapter(calls);
    const memory = document('claim_memory', 'alpha memory');
    const store = new SemanticRecordStore(temporaryPath());
    const synced = await syncPersistedSemanticRecords(
      store,
      'workspace',
      [memory],
      embeddingAdapter,
    );

    expect(() => store.replace(
      embeddingAdapter,
      'workspace',
      [synced.records[0]!, synced.records[0]!],
    )).toThrow(/Duplicate/);
    expect(store.load(embeddingAdapter, 'workspace')).toMatchObject({
      status: 'ready',
      records: [{ id: 'claim_memory' }],
      expected_records: 1,
    });
    store.close();
  });

  it('never deletes records from another scope during sync or reset', async () => {
    const calls: string[][] = [];
    const embeddingAdapter = adapter(calls);
    const workspace = document('claim_workspace', 'alpha workspace memory');
    const personal = {
      ...document('claim_personal', 'alpha personal memory'),
      scope: 'personal',
    };
    const store = new SemanticRecordStore(temporaryPath());
    await syncPersistedSemanticRecords(
      store,
      'workspace',
      [workspace],
      embeddingAdapter,
    );
    await syncPersistedSemanticRecords(store, 'personal', [personal], embeddingAdapter);

    await syncPersistedSemanticRecords(store, 'workspace', [], embeddingAdapter);
    expect(store.load(embeddingAdapter, 'workspace')).toMatchObject({
      status: 'ready',
      records: [],
      expected_records: 0,
    });
    expect(store.load(embeddingAdapter, 'personal')).toMatchObject({
      status: 'ready',
      records: [{ id: 'claim_personal' }],
      expected_records: 1,
    });

    await syncPersistedSemanticRecords(
      store,
      'workspace',
      [workspace],
      embeddingAdapter,
    );
    expect(store.reset({ scope: 'workspace' })).toBe(1);
    expect(store.load(embeddingAdapter, 'workspace').status).toBe('missing');
    expect(store.load(embeddingAdapter, 'personal').status).toBe('ready');
    store.close();
  });

  it('detects and rebuilds a malformed derived row', async () => {
    const dbPath = temporaryPath();
    const calls: string[][] = [];
    const embeddingAdapter = adapter(calls);
    const memory = document('claim_memory', 'alpha memory');
    let store = new SemanticRecordStore(dbPath);
    await syncPersistedSemanticRecords(
      store,
      'workspace',
      [memory],
      embeddingAdapter,
    );
    store.close();

    const db = new Database(dbPath);
    db.prepare('UPDATE semantic_records SET vector_json = ?').run('{broken');
    db.close();

    store = new SemanticRecordStore(dbPath);
    expect(store.load(embeddingAdapter, 'workspace')).toMatchObject({
      status: 'degraded',
      records: [],
      invalid_records: 1,
      expected_records: 1,
    });

    calls.length = 0;
    const repaired = await syncPersistedSemanticRecords(
      store,
      'workspace',
      [memory],
      embeddingAdapter,
    );
    expect(repaired).toMatchObject({
      prior_status: 'degraded',
      invalid_records: 1,
      embedded: 1,
    });
    expect(calls).toEqual([[memory.text]]);
    expect(store.load(embeddingAdapter, 'workspace').status).toBe('ready');
    store.close();
  });

  it('isolates model resets and fails open when the database is unreadable', async () => {
    const dbPath = temporaryPath();
    const calls: string[][] = [];
    const firstAdapter = adapter(calls, 'model-one');
    const secondAdapter = adapter(calls, 'model-two');
    const memory = document('claim_memory', 'alpha memory');
    const store = new SemanticRecordStore(dbPath);
    await syncPersistedSemanticRecords(store, 'workspace', [memory], firstAdapter);
    await syncPersistedSemanticRecords(store, 'workspace', [memory], secondAdapter);

    expect(store.reset({ model_key: semanticModelKey(firstAdapter) })).toBe(1);
    expect(store.load(firstAdapter, 'workspace').status).toBe('missing');
    expect(store.load(secondAdapter, 'workspace').status).toBe('ready');
    store.close();

    const original = Buffer.from('not a sqlite database');
    writeFileSync(dbPath, original);
    const opened = openSemanticRecordStore(dbPath);
    expect(opened).toMatchObject({
      status: 'unavailable',
      store: null,
    });
    expect(readFileSync(dbPath)).toEqual(original);

    const records = opened.status === 'ready'
      ? opened.store.load(firstAdapter, 'workspace').records
      : [];
    const fallback = await rankHybridDocuments(
      'alpha',
      [memory.id],
      [memory],
      records,
      firstAdapter,
      { min_similarity: 0.4, limit: 5 },
    );
    expect(fallback.semantic_status).toBe('unavailable');
    expect(fallback.matches.map(match => match.id)).toEqual([memory.id]);
  });
});
