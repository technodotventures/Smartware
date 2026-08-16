import { describe, expect, it } from 'vitest';

import { normaliseTextRelevance } from '../../src/layer4/scoring.js';

describe('Layer 4 lexical relevance', () => {
  it('normalises query-local BM25 magnitudes instead of dividing tiny FTS5 values by a global constant', () => {
    const relevance = normaliseTextRelevance([4.4e-6, 1.1e-6]);

    expect(relevance[0]).toBe(1);
    expect(relevance[1]).toBeCloseTo(0.25);
  });

  it('keeps empty, zero, and non-finite inputs bounded', () => {
    expect(normaliseTextRelevance([])).toEqual([]);
    expect(normaliseTextRelevance([0, Number.NaN, Number.POSITIVE_INFINITY]))
      .toEqual([0, 0, 0]);
  });

  it('does not pretend query-local lexical relevance is calibrated across queries', () => {
    expect(normaliseTextRelevance([1e-9])).toEqual([1]);
    expect(normaliseTextRelevance([12])).toEqual([1]);
  });
});
