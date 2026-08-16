// Tests: Layer 1 — Confidence Scoring

import { describe, it, expect } from 'vitest';
import { ulid } from 'ulid';
import { computeConfidence, isStale } from '../../src/layer1/confidence.js';
import { makeClaim } from '../helpers.js';

describe('computeConfidence', () => {
  it('user_confirmed claim gets highest confidence', () => {
    // user_confirmed with 3 supporting evidence: srcRel(1.0*0.20) + userConf(1.0*0.25) + recency(~1.0*0.15) + corroboration(1.0*0.15) + extractConf(1.0*0.10) ≈ 0.85
    const claim = makeClaim({
      epistemic: 'user_confirmed',
      supporting_evidence: [`obs_1`, `obs_2`, `obs_3`],
    });
    const score = computeConfidence(claim);
    expect(score).toBeGreaterThan(0.8);
  });

  it('inferred claim gets lower confidence', () => {
    const claim = makeClaim({ epistemic: 'inferred' });
    const score = computeConfidence(claim);
    expect(score).toBeLessThan(0.8);
  });

  it('contested claim has lower confidence than uncontested', () => {
    const uncontested = makeClaim({ epistemic: 'observed' });
    const contested = makeClaim({
      epistemic: 'observed',
      contested_by: [`claim_${ulid()}`, `claim_${ulid()}`],
    });
    expect(computeConfidence(contested)).toBeLessThan(computeConfidence(uncontested));
  });

  it('corroborated claim (3+ evidence) gets higher confidence', () => {
    const weak = makeClaim({ supporting_evidence: [`obs_${ulid()}`] });
    const strong = makeClaim({
      supporting_evidence: [`obs_${ulid()}`, `obs_${ulid()}`, `obs_${ulid()}`],
    });
    expect(computeConfidence(strong)).toBeGreaterThan(computeConfidence(weak));
  });

  it('score is always in [0, 1]', () => {
    const extremeClaims = [
      makeClaim({ epistemic: 'user_confirmed', contested_by: [], supporting_evidence: ['a', 'b', 'c'] }),
      makeClaim({ epistemic: 'inferred', contested_by: ['x', 'x', 'x', 'x'], supporting_evidence: [] }),
    ];
    for (const c of extremeClaims) {
      const score = computeConfidence(c);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('deterministic extraction gets higher confidence than LLM', () => {
    const det = makeClaim({ extraction: { method: 'deterministic', model: null, compiler_version: '0.5.1', prompt_hash: null, extracted_at: new Date().toISOString() } });
    const llm = makeClaim({ extraction: { method: 'llm', model: 'claude', compiler_version: '0.5.1', prompt_hash: null, extracted_at: new Date().toISOString() } });
    expect(computeConfidence(det)).toBeGreaterThan(computeConfidence(llm));
  });
});

describe('isStale', () => {
  it('returns true for active claim below threshold', () => {
    const claim = makeClaim({ status: 'active', confidence: 0.1 });
    expect(isStale(claim, 0.3)).toBe(true);
  });

  it('returns false for active claim above threshold', () => {
    const claim = makeClaim({ status: 'active', confidence: 0.8 });
    expect(isStale(claim, 0.3)).toBe(false);
  });

  it('returns false for non-active claim even if low confidence', () => {
    const claim = makeClaim({ status: 'superseded', confidence: 0.1 });
    expect(isStale(claim, 0.3)).toBe(false);
  });
});
