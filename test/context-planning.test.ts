import { describe, expect, it } from 'vitest';

import {
  decideContextRetrieval,
  planContextPacking,
} from '../src/layer4/context-planning.js';
import { isReflectAutoTerminalReceipt } from '../src/protocol/reflect.js';
import type { OpLogEntry } from '../src/ops_log/types.js';

const policy = {
  lane_order: ['profile', 'lessons', 'conversations', 'claims'] as const,
  lane_weights: { profile: 20, lessons: 20, conversations: 25, claims: 35 },
  overflow_order: ['claims', 'conversations', 'lessons', 'profile'] as const,
};

describe('Layer 4 context planning', () => {
  it('fails open to retrieval for uncertain automatic requests', () => {
    expect(decideContextRetrieval('auto', 'Coffee launch deadline').decision).toBe('retrieve');
    expect(decideContextRetrieval('auto', 'hello!')).toEqual({
      mode: 'auto',
      decision: 'skip',
      reason: 'self_contained_greeting',
    });
    expect(decideContextRetrieval('auto', "what's 12 × 8?").reason).toBe('self_contained_arithmetic');
    expect(decideContextRetrieval('auto', 'hello', true).reason).toBe('structured_task');
  });

  it('protects populated lanes and redistributes unused shares', () => {
    const balanced = planContextPacking({
      profile: [12, 12, 12],
      lessons: [12, 12],
      conversations: [12, 12],
      claims: [12, 12, 12, 12],
    }, 100, policy);

    expect(balanced.used_tokens).toBeLessThanOrEqual(100);
    expect(Object.values(balanced.selected).every(indices => indices.length > 0)).toBe(true);

    const claimsOnly = planContextPacking({
      profile: [],
      lessons: [],
      conversations: [],
      claims: [20, 20, 20, 20, 20],
    }, 100, policy);
    expect(claimsOnly.selected.claims).toEqual([0, 1, 2, 3, 4]);
    expect(claimsOnly.used_tokens).toBe(100);
  });

  it('preserves ranked prefixes when a candidate cannot fit', () => {
    const plan = planContextPacking({
      profile: [],
      lessons: [],
      conversations: [],
      claims: [80, 10],
    }, 50, policy);

    expect(plan.selected.claims).toEqual([]);
  });

  it('fails loudly when policy and cost lanes disagree', () => {
    expect(() => planContextPacking(
      { claims: [10], conversations: [10] },
      20,
      { lane_order: ['claims'] },
    )).toThrow(/disagree on lane "conversations"/);
  });
});

describe('REFLECT terminal receipt', () => {
  it('recognises the content-free checkpoint shape only', () => {
    const receipt: OpLogEntry = {
      operation_id: 'op_01J00000000000000000000000',
      actor_id: 'substrate:test',
      timestamp: '2026-07-21T00:00:00.000Z',
      op: 'reflect.auto',
      details: {
        observation_id: 'obs_example',
        scope: 'workspace/default',
        reflection_complete: true,
        outcome: 'no_claims',
        candidates_found: 0,
        claim_versions_written: 0,
      },
    };
    const claimCommit: OpLogEntry = {
      ...receipt,
      details: { claim_id: 'claim_example', payload_hash: 'example' },
    };

    expect(isReflectAutoTerminalReceipt(receipt)).toBe(true);
    expect(isReflectAutoTerminalReceipt(claimCommit)).toBe(false);
  });
});
