import { describe, expect, it } from 'vitest';

import {
  rankHybridDocuments,
  type HybridRankOptions,
} from '../../src/layer3/hybrid.js';
import {
  syncSemanticRecords,
  type EmbeddingAdapter,
  type SemanticDocument,
} from '../../src/layer3/semantic.js';

function document(
  id: string,
  text: string,
  transactionFrom = '2026-07-01T00:00:00.000Z',
): SemanticDocument {
  return {
    id,
    scope: 'workspace',
    version: transactionFrom,
    text,
    valid_time: { from: '2026-01-01T00:00:00.000Z', to: null },
    transaction_time: { from: transactionFrom, to: null },
  };
}

function adapterFor(vectors: Record<string, number[]>): EmbeddingAdapter {
  return {
    provider: 'fixture',
    model: 'hybrid-v1',
    dimensions: 2,
    async embed(texts) {
      return texts.map(text => {
        const vector = vectors[text];
        if (!vector) throw new Error(`Missing fixture vector: ${text}`);
        return vector;
      });
    },
  };
}

const options: HybridRankOptions = {
  min_similarity: -1,
  limit: 5,
  rrf_k: 60,
};

describe('Layer 3 hybrid retrieval', () => {
  it('fuses lexical and semantic ranks without comparing their raw scores', async () => {
    const alpha = document('claim_alpha', 'Alpha policy');
    const beta = document('claim_beta', 'Beta policy');
    const gamma = document('claim_gamma', 'Gamma policy');
    const query = 'Which policy matches alpha?';
    const adapter = adapterFor({
      [alpha.text]: [1, 0],
      [beta.text]: [0.8, 0.2],
      [gamma.text]: [0.9, 0.1],
      [query]: [1, 0],
    });
    const synced = await syncSemanticRecords([alpha, beta, gamma], [], adapter);

    const result = await rankHybridDocuments(
      query,
      ['claim_beta', 'claim_alpha'],
      [alpha, beta, gamma],
      synced.records,
      adapter,
      options,
    );

    expect(result.semantic_status).toBe('ok');
    expect(result.matches.map(match => match.id)).toEqual([
      'claim_alpha',
      'claim_beta',
      'claim_gamma',
    ]);
    expect(result.matches[0]).toMatchObject({
      lexical_rank: 2,
      semantic_rank: 1,
    });
    expect(result.matches[0]?.rrf_score).toBeGreaterThan(result.matches[1]!.rrf_score);
  });

  it('applies event-boundary eligibility to both channels before fusion', async () => {
    const knownBefore = document(
      'claim_known_before',
      'Release policy',
      '2026-01-01T00:00:00.000Z',
    );
    const learnedInJuly = document(
      'claim_learned_july',
      'Retention policy',
      '2026-07-12T00:00:00.000Z',
    );
    let unavailable = false;
    const adapter: EmbeddingAdapter = {
      provider: 'fixture',
      model: 'offline',
      dimensions: 2,
      async embed(texts) {
        if (unavailable) throw new Error('provider unavailable');
        return texts.map(() => [1, 0]);
      },
    };
    const synced = await syncSemanticRecords([knownBefore, learnedInJuly], [], adapter);
    unavailable = true;

    const result = await rankHybridDocuments(
      'Which policy did Smartware first learn in July?',
      ['claim_known_before', 'claim_learned_july'],
      [knownBefore, learnedInJuly],
      synced.records,
      adapter,
      {
        ...options,
        temporal: {
          mode: 'range',
          relation: 'starts_in',
          axis: 'transaction_time',
          from: '2026-07-01T00:00:00.000Z',
          to: '2026-08-01T00:00:00.000Z',
        },
      },
    );

    expect(result.semantic_status).toBe('fallback');
    expect(result.matches.map(match => match.id)).toEqual(['claim_learned_july']);
  });

  it('preserves lexical order on semantic failure and never expands eligibility', async () => {
    const first = document('claim_first', 'First eligible memory');
    const second = document('claim_second', 'Second eligible memory');
    const query = 'eligible memory';
    const working = adapterFor({
      [first.text]: [1, 0],
      [second.text]: [0, 1],
      [query]: [1, 0],
    });
    const synced = await syncSemanticRecords([first, second], [], working);
    const malformed: EmbeddingAdapter = {
      ...working,
      async embed() {
        return [];
      },
    };

    const result = await rankHybridDocuments(
      query,
      ['claim_outside_policy', 'claim_second', 'claim_first'],
      [first, second],
      synced.records,
      malformed,
      options,
    );

    expect(result.semantic_status).toBe('fallback');
    expect(result.matches.map(match => match.id)).toEqual([
      'claim_second',
      'claim_first',
    ]);
    expect(result.matches.every(match => match.semantic_rank === null)).toBe(true);
  });

  it('reports a missing semantic index while returning lexical candidates', async () => {
    const memory = document('claim_memory', 'Indexed only by lexical search');
    const adapter = adapterFor({
      [memory.text]: [1, 0],
      query: [1, 0],
    });

    const result = await rankHybridDocuments(
      'query',
      ['claim_memory'],
      [memory],
      [],
      adapter,
      options,
    );

    expect(result.semantic_status).toBe('unavailable');
    expect(result.matches.map(match => match.id)).toEqual(['claim_memory']);
  });

  it('rejects invalid fusion controls instead of silently changing ranking', async () => {
    const memory = document('claim_memory', 'Memory');
    const adapter = adapterFor({
      [memory.text]: [1, 0],
      query: [1, 0],
    });
    const synced = await syncSemanticRecords([memory], [], adapter);

    await expect(rankHybridDocuments(
      'query',
      ['claim_memory'],
      [memory],
      synced.records,
      adapter,
      { ...options, rrf_k: 0 },
    )).rejects.toThrow(/RRF k/);
  });
});
