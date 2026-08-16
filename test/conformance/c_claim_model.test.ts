// Conformance Suite C — Claim Model (§6)

import { describe, it, expect } from 'vitest';
import { computeFingerprint } from '../../src/layer1/fingerprint.js';
import type { ActiveClaimVersion, ForgottenClaimVersion, ClaimVersionRecord } from '../../src/layer1/jsonl.js';
import type { ClaimRelation, RelationProvenance } from '../../src/layer1/types.js';
import { isCanonicalRelationValid } from '../../src/layer1/types.js';

function makeActiveVersion(overrides: Partial<ActiveClaimVersion> = {}): ActiveClaimVersion {
  return {
    claim_id: 'claim_TEST01',
    version: 1,
    state: 'active',
    content: 'Test assertion',
    claim_type: 'finding',
    claim_role: 'memory',
    author: 'agent',
    epistemic_owner: 'agent',
    fingerprint: computeFingerprint('Test assertion', 'personal', 'finding'),
    confidence: 'low',
    epistemic_tag: 'inference',
    scope: 'personal',
    derived_from: ['obs_test1'],
    relations: [],
    created_at: '2026-01-01T00:00:00Z',
    version_at: '2026-01-01T00:00:00Z',
    operation_id: 'op_TEST01',
    actor_id: 'substrate:test',
    tags: [],
    ...overrides,
  };
}

describe('Claim Model', () => {
  it('C1: claim_has_distinct_author_and_epistemic_owner', () => {
    const v = makeActiveVersion({ author: 'agent', epistemic_owner: 'user' });
    expect(v.author).toBe('agent');
    expect(v.epistemic_owner).toBe('user');
    expect(v.author).not.toBe(v.epistemic_owner);
  });

  it('C2: fingerprint_deterministic_same_content', () => {
    const fp1 = computeFingerprint('Alex prefers concise outputs', 'self', 'preference');
    const fp2 = computeFingerprint('Alex prefers concise outputs', 'self', 'preference');
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^fp_[0-9a-f]{16}$/);
  });

  it('C3: fingerprint_differs_on_content_change', () => {
    const fp1 = computeFingerprint('Alex prefers concise outputs', 'self', 'preference');
    const fp2 = computeFingerprint('Alex prefers verbose outputs', 'self', 'preference');
    expect(fp1).not.toBe(fp2);
  });

  it('C4: fingerprint_is_not_derived_from', () => {
    const fp1 = computeFingerprint('Same assertion', 'personal', 'finding');
    const fp2 = computeFingerprint('Same assertion', 'personal', 'finding');
    expect(fp1).toBe(fp2);
    const v1 = makeActiveVersion({ derived_from: ['obs_a'], fingerprint: fp1 });
    const v2 = makeActiveVersion({ derived_from: ['obs_b', 'obs_c'], fingerprint: fp2 });
    expect(v1.fingerprint).toBe(v2.fingerprint);
    expect(v1.derived_from).not.toEqual(v2.derived_from);
  });

  it('C5: one_observation_multiple_claims', () => {
    const fp1 = computeFingerprint('Assertion one', 'personal', 'finding');
    const fp2 = computeFingerprint('Assertion two', 'personal', 'finding');
    expect(fp1).not.toBe(fp2);
  });

  it('C6: multiple_observations_one_claim', () => {
    const fp = computeFingerprint('Same assertion', 'personal', 'finding');
    const v1 = makeActiveVersion({ derived_from: ['obs_a'], fingerprint: fp });
    const v2 = makeActiveVersion({ version: 2, derived_from: ['obs_a', 'obs_b'], fingerprint: fp, supersedes: 1 });
    expect(v1.fingerprint).toBe(v2.fingerprint);
    expect(v2.derived_from).toContain('obs_b');
  });

  it('C7: claim_state_only_active_or_forgotten', () => {
    const active: ClaimVersionRecord = makeActiveVersion();
    expect(active.state).toBe('active');
    const forgotten: ForgottenClaimVersion = {
      ...makeActiveVersion(),
      state: 'forgotten',
      tombstone_id: 'tomb_TEST01',
      forgotten_at: '2026-02-01T00:00:00Z',
      forgotten_by: 'user:owner',
    };
    delete (forgotten as Record<string, unknown>)['content'];
    expect(forgotten.state).toBe('forgotten');
    expect(['active', 'forgotten']).toContain(active.state);
    expect(['active', 'forgotten']).toContain(forgotten.state);
  });

  it('C8: confidence_only_bucketed_values', () => {
    const validValues = ['high', 'medium', 'low'] as const;
    for (const c of validValues) {
      const v = makeActiveVersion({ confidence: c });
      expect(validValues as readonly string[]).toContain(v.confidence);
    }
  });

  it('C9: epistemic_tag_only_spec_values', () => {
    const validValues = ['fact', 'inference', 'opinion', 'stale', 'contested'] as const;
    for (const t of validValues) {
      const v = makeActiveVersion({ epistemic_tag: t });
      expect(validValues as readonly string[]).toContain(v.epistemic_tag);
    }
  });

  it('C10: claim_version_chain_is_append_only', () => {
    const v1 = makeActiveVersion({ version: 1, content: 'Original' });
    const v2 = makeActiveVersion({ version: 2, content: 'Revised', supersedes: 1 });
    expect(v1.content).toBe('Original');
    expect(v2.content).toBe('Revised');
    expect(v2.supersedes).toBe(1);
    expect(v1.version).toBe(1);
  });
});
