import { describe, expect, it } from 'vitest';

import {
  matchesTemporalConstraint,
  type TemporalConstraint,
  type TemporalDocument,
} from '../../src/layer3/temporal.js';

const document: TemporalDocument = {
  valid_time: {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-06-01T00:00:00.000Z',
  },
  transaction_time: {
    from: '2026-01-02T00:00:00.000Z',
    to: '2026-06-02T00:00:00.000Z',
  },
};

describe('Layer 3 temporal constraints', () => {
  it('uses half-open valid-time intervals for as-of retrieval', () => {
    expect(matchesTemporalConstraint(document, {
      mode: 'as_of',
      axis: 'valid_time',
      at: '2026-05-31T23:59:59.999Z',
    })).toBe(true);
    expect(matchesTemporalConstraint(document, {
      mode: 'as_of',
      axis: 'valid_time',
      at: '2026-06-01T00:00:00.000Z',
    })).toBe(false);
  });

  it('keeps transaction time distinct from when the claim was valid', () => {
    expect(matchesTemporalConstraint(document, {
      mode: 'as_of',
      axis: 'transaction_time',
      at: '2026-01-01T12:00:00.000Z',
    })).toBe(false);
    expect(matchesTemporalConstraint(document, {
      mode: 'as_of',
      axis: 'valid_time',
      at: '2026-01-01T12:00:00.000Z',
    })).toBe(true);
  });

  it('matches ranges by interval overlap and supports open-ended claims', () => {
    expect(matchesTemporalConstraint(document, {
      mode: 'range',
      axis: 'valid_time',
      from: '2026-05-15T00:00:00.000Z',
      to: '2026-06-15T00:00:00.000Z',
    })).toBe(true);
    expect(matchesTemporalConstraint(document, {
      mode: 'range',
      axis: 'valid_time',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
    })).toBe(false);
    expect(matchesTemporalConstraint({
      ...document,
      valid_time: {
        from: '2026-07-01T00:00:00.000Z',
        to: null,
      },
    }, {
      mode: 'current',
      axis: 'valid_time',
      at: '2026-07-24T00:00:00.000Z',
    })).toBe(true);
  });

  it('distinguishes interval overlap from intervals that start within a range', () => {
    expect(matchesTemporalConstraint(document, {
      mode: 'range',
      relation: 'starts_in',
      axis: 'transaction_time',
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
    })).toBe(false);
    expect(matchesTemporalConstraint({
      ...document,
      transaction_time: {
        from: '2026-07-01T00:00:00.000Z',
        to: null,
      },
    }, {
      mode: 'range',
      relation: 'starts_in',
      axis: 'transaction_time',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    })).toBe(true);
    expect(matchesTemporalConstraint({
      ...document,
      transaction_time: {
        from: '2026-08-01T00:00:00.000Z',
        to: null,
      },
    }, {
      mode: 'range',
      relation: 'starts_in',
      axis: 'transaction_time',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    })).toBe(false);
    expect(matchesTemporalConstraint({
      ...document,
      transaction_time: {
        from: null,
        to: null,
      },
    }, {
      mode: 'range',
      relation: 'starts_in',
      axis: 'transaction_time',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    })).toBe(false);
  });

  it('rejects malformed constraints instead of silently changing recall', () => {
    expect(() => matchesTemporalConstraint(document, {
      mode: 'range',
      axis: 'valid_time',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
    })).toThrow(/after from/);
    expect(() => matchesTemporalConstraint(document, {
      mode: 'as_of',
      axis: 'valid_time',
      at: 'not-a-date',
    })).toThrow(/ISO 8601/);
    expect(() => matchesTemporalConstraint(document, {
      mode: 'range',
      relation: 'contains',
      axis: 'valid_time',
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
    } as unknown as TemporalConstraint)).toThrow(/Unsupported temporal range relation/);
  });
});
