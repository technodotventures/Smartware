import { describe, expect, it } from 'vitest';

import { makeClaim } from '../helpers.js';
import {
  claimToSemanticDocument,
  rankSemanticDocuments,
  SEMANTIC_INDEX_VERSION,
  syncSemanticRecords,
  type EmbeddingAdapter,
  type SemanticDocument,
} from '../../src/layer3/semantic.js';

function vectorFor(text: string): number[] {
  if (/checkpoint|restore|manifest/i.test(text)) return [1, 0];
  if (/catering|lunch/i.test(text)) return [0, 1];
  return [Math.SQRT1_2, Math.SQRT1_2];
}

function fakeAdapter(calls: string[][]): EmbeddingAdapter {
  return {
    provider: 'test',
    model: 'semantic-v1',
    dimensions: 2,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map(vectorFor);
    },
  };
}

function semanticDocument(
  id: string,
  text: string,
  validFrom = '2026-01-01T00:00:00.000Z',
  validTo: string | null = null,
): SemanticDocument {
  return {
    id,
    scope: 'workspace',
    version: '2026-07-01T00:00:00.000Z',
    text,
    valid_time: { from: validFrom, to: validTo },
    transaction_time: {
      from: '2026-07-01T00:00:00.000Z',
      to: null,
    },
  };
}

describe('Layer 3 semantic retrieval', () => {
  it('builds a stable claim-level document without mixing temporal metadata into semantic text', () => {
    const claim = makeClaim({
      id: 'claim_release',
      subject_name: 'Release',
      predicate: 'blocked_by',
      object: { type: 'text', value: 'restore hangs after manifest load' },
      version_at: '2026-07-02T00:00:00.000Z',
      t_valid_from: { value: '2026-07-01T00:00:00.000Z', state: 'known' },
      t_valid_to: { value: null, state: 'null' },
      t_ingested: { value: '2026-07-02T00:00:00.000Z', state: 'known' },
      t_invalidated: { value: null, state: 'null' },
    });

    expect(claimToSemanticDocument(claim)).toEqual({
      id: 'claim_release',
      scope: 'personal',
      version: '2026-07-02T00:00:00.000Z',
      text: 'Release\nblocked by: restore hangs after manifest load',
      valid_time: {
        from: '2026-07-01T00:00:00.000Z',
        to: null,
      },
      transaction_time: {
        from: '2026-07-02T00:00:00.000Z',
        to: null,
      },
    });
  });

  it('embeds only new or changed documents and prunes deleted derived records', async () => {
    const calls: string[][] = [];
    const adapter = fakeAdapter(calls);
    const release = semanticDocument('claim_release', 'Release\nblocked by: restore hangs after manifest load');
    const lunch = semanticDocument('claim_lunch', 'Lunch\ndescription: team catering menu');

    const first = await syncSemanticRecords([release, lunch], [], adapter);
    expect(first.embedded).toBe(2);
    expect(first.reused).toBe(0);
    expect(first.removed).toBe(0);
    expect(calls).toEqual([[release.text, lunch.text]]);

    calls.length = 0;
    const second = await syncSemanticRecords([release, lunch], first.records, adapter);
    expect(second.embedded).toBe(0);
    expect(second.reused).toBe(2);
    expect(calls).toEqual([]);

    const changed = { ...release, text: `${release.text} at startup` };
    const third = await syncSemanticRecords([changed], second.records, adapter);
    expect(third.embedded).toBe(1);
    expect(third.reused).toBe(0);
    expect(third.removed).toBe(1);
    expect(calls).toEqual([[changed.text]]);
  });

  it('recovers a paraphrase while searching only the caller-supplied eligible documents', async () => {
    const calls: string[][] = [];
    const adapter = fakeAdapter(calls);
    const eligible = semanticDocument('claim_release', 'Release\nblocked by: restore hangs after manifest load');
    const forbidden = semanticDocument('claim_secret', 'Secret\nblocked by: restore checkpoint failure');
    const synced = await syncSemanticRecords([eligible, forbidden], [], adapter);

    calls.length = 0;
    const matches = await rankSemanticDocuments(
      'Why does the checkpoint stall?',
      [eligible],
      synced.records,
      adapter,
      { min_similarity: 0.5, limit: 5 },
    );

    expect(matches.map(match => match.id)).toEqual(['claim_release']);
    expect(matches[0]?.semantic_relevance).toBe(1);
    expect(calls).toEqual([['Why does the checkpoint stall?']]);
  });

  it('applies explicit temporal eligibility before semantic ranking', async () => {
    const calls: string[][] = [];
    const adapter = fakeAdapter(calls);
    const expired = semanticDocument(
      'claim_expired',
      'Release\nblocked by: restore hangs after manifest load',
      '2026-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    );
    const current = semanticDocument(
      'claim_current',
      'Release\nblocked by: checkpoint recovery is slow',
      '2026-07-01T00:00:00.000Z',
    );
    const synced = await syncSemanticRecords([expired, current], [], adapter);

    const matches = await rankSemanticDocuments(
      'Why does the checkpoint stall?',
      [expired, current],
      synced.records,
      adapter,
      {
        min_similarity: 0.5,
        limit: 5,
        temporal: {
          mode: 'current',
          axis: 'valid_time',
          at: '2026-07-24T00:00:00.000Z',
        },
      },
    );

    expect(matches.map(match => match.id)).toEqual(['claim_current']);
  });

  it('can rank only memories first learned inside a transaction-time range', async () => {
    const calls: string[][] = [];
    const adapter = fakeAdapter(calls);
    const knownBefore = {
      ...semanticDocument('claim_known_before', 'Release policy\nrequires: two reviewers'),
      transaction_time: {
        from: '2026-01-01T00:00:00.000Z',
        to: null,
      },
    };
    const learnedInJuly = {
      ...semanticDocument('claim_learned_july', 'Retention policy\nrequires: delete archives'),
      transaction_time: {
        from: '2026-07-12T00:00:00.000Z',
        to: null,
      },
    };
    const synced = await syncSemanticRecords([knownBefore, learnedInJuly], [], adapter);

    calls.length = 0;
    const matches = await rankSemanticDocuments(
      'Which policy did Smartware first learn in July?',
      [knownBefore, learnedInJuly],
      synced.records,
      adapter,
      {
        min_similarity: -1,
        limit: 5,
        temporal: {
          mode: 'range',
          relation: 'starts_in',
          axis: 'transaction_time',
          from: '2026-07-01T00:00:00.000Z',
          to: '2026-08-01T00:00:00.000Z',
        },
      },
    );

    expect(matches.map(match => match.id)).toEqual(['claim_learned_july']);
    expect(calls).toEqual([['Which policy did Smartware first learn in July?']]);
  });

  it('rejects incomplete or malformed embedding batches', async () => {
    const document = semanticDocument('claim_release', 'Release checkpoint');
    const incomplete: EmbeddingAdapter = {
      provider: 'test',
      model: 'bad',
      dimensions: 2,
      async embed() {
        return [];
      },
    };
    await expect(syncSemanticRecords([document], [], incomplete))
      .rejects.toThrow(/one vector per input/);

    const nonFinite: EmbeddingAdapter = {
      provider: 'test',
      model: 'bad',
      dimensions: 2,
      async embed() {
        return [[Number.NaN, 0]];
      },
    };
    await expect(syncSemanticRecords([document], [], nonFinite))
      .rejects.toThrow(/finite numbers/);
  });

  it('bounds indexing and query provider latency with explicit timeouts', async () => {
    const document = semanticDocument('claim_release', 'Release checkpoint');
    const hanging: EmbeddingAdapter = {
      provider: 'test',
      model: 'hanging',
      dimensions: 2,
      async embed() {
        return new Promise<number[][]>(() => {});
      },
    };

    await expect(syncSemanticRecords([document], [], hanging, 64, 10))
      .rejects.toThrow(/timed out/);

    const working = fakeAdapter([]);
    const synced = await syncSemanticRecords([document], [], working);
    const hangingQuery = { ...hanging, model: working.model };
    await expect(rankSemanticDocuments(
      'release',
      [document],
      synced.records,
      hangingQuery,
      { min_similarity: 0.4, limit: 5, timeout_ms: 10 },
    )).rejects.toThrow(/timed out/);
  });

  it('rebuilds corrupt or model-incompatible derived records', async () => {
    const calls: string[][] = [];
    const document = semanticDocument('claim_release', 'Release checkpoint');
    const adapter = fakeAdapter(calls);
    const first = await syncSemanticRecords([document], [], adapter);
    const corrupt = [{
      ...first.records[0]!,
      vector: [Number.NaN, 0],
    }];

    calls.length = 0;
    const repaired = await syncSemanticRecords([document], corrupt, adapter);
    expect(repaired.embedded).toBe(1);
    expect(repaired.reused).toBe(0);
    expect(calls).toEqual([[document.text]]);

    calls.length = 0;
    const changedModel = {
      ...adapter,
      model: 'semantic-v2',
    };
    const rebuilt = await syncSemanticRecords(
      [document],
      repaired.records,
      changedModel,
    );
    expect(rebuilt.embedded).toBe(1);
    expect(rebuilt.records[0]?.model_key).toBe('test/semantic-v2');
    expect(calls).toEqual([[document.text]]);

    calls.length = 0;
    const staleIndex = rebuilt.records.map(record => ({
      ...record,
      index_version: SEMANTIC_INDEX_VERSION + 1,
    }));
    const reindexed = await syncSemanticRecords([document], staleIndex, changedModel);
    expect(reindexed.embedded).toBe(1);
    expect(reindexed.records[0]?.index_version).toBe(SEMANTIC_INDEX_VERSION);
    expect(calls).toEqual([[document.text]]);
  });
});
