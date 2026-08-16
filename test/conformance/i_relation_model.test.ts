// Conformance Suite I — Relation Model (§6)

import { describe, it, expect } from 'vitest';
import type { ClaimRelation, RelationKind, RelationProvenance } from '../../src/layer1/types.js';
import { isCanonicalRelationValid, EPISTEMIC_RELATION_KINDS } from '../../src/layer1/types.js';

function makeRelation(overrides: Partial<ClaimRelation> = {}): ClaimRelation {
  return {
    relation_id: 'rel_TEST01',
    kind: 'references',
    target: 'claim_TARGET01',
    valid_at: '2026-01-01T00:00:00Z',
    invalid_at: null,
    provenance: {
      origin: 'deterministic',
      rule_id: 'url_mention',
      asserted_in_source_version: 1,
      target_claim_version: 1,
      observation_ids: ['obs_test1'],
    },
    ...overrides,
  };
}

describe('Relation Model', () => {
  it('I1: all_seven_relation_kinds_creatable', () => {
    const kinds: RelationKind[] = [
      'supports', 'contradicts', 'supersedes', 'corrects',
      'invalidates', 'summarizes', 'references',
    ];
    for (const kind of kinds) {
      const rel = makeRelation({ kind, provenance: { origin: 'user' } });
      expect(rel.kind).toBe(kind);
    }
  });

  it('I2: canonical_edge_has_required_provenance', () => {
    const rel = makeRelation();
    expect(rel.provenance).toBeDefined();
    expect(rel.provenance.origin).toBeDefined();
  });

  it('I3: relation_id_immutable_on_carry_forward', () => {
    const rel = makeRelation({ relation_id: 'rel_STABLE01' });
    const carried = { ...rel };
    expect(carried.relation_id).toBe('rel_STABLE01');
  });

  it('I4: asserted_in_source_version_immutable', () => {
    const rel = makeRelation();
    expect(rel.provenance).toHaveProperty('asserted_in_source_version');
    if ('asserted_in_source_version' in rel.provenance) {
      expect(rel.provenance.asserted_in_source_version).toBe(1);
    }
  });

  it('I5: deterministic_references_require_rule_id', () => {
    const valid = isCanonicalRelationValid('references', 'deterministic');
    expect(valid).toBe(true);
    const rel = makeRelation({
      kind: 'references',
      provenance: {
        origin: 'deterministic',
        rule_id: 'url_mention',
        asserted_in_source_version: 1,
        target_claim_version: 1,
        observation_ids: [],
      },
    });
    expect(rel.provenance.origin).toBe('deterministic');
    expect((rel.provenance as { rule_id?: string }).rule_id).toBeTruthy();
  });

  it('I6: model_origin_rejected_as_canonical', () => {
    expect(isCanonicalRelationValid('references', 'model')).toBe(false);
    expect(isCanonicalRelationValid('supports', 'model')).toBe(false);
  });

  it('I7: epistemic_edge_requires_user_origin_in_beta', () => {
    for (const kind of EPISTEMIC_RELATION_KINDS) {
      expect(isCanonicalRelationValid(kind, 'user')).toBe(true);
      expect(isCanonicalRelationValid(kind, 'deterministic')).toBe(false);
      expect(isCanonicalRelationValid(kind, 'model')).toBe(false);
    }
  });

  it('I8: references_permits_deterministic_or_user', () => {
    expect(isCanonicalRelationValid('references', 'deterministic')).toBe(true);
    expect(isCanonicalRelationValid('references', 'user')).toBe(true);
    expect(isCanonicalRelationValid('references', 'model')).toBe(false);
    expect(isCanonicalRelationValid('references', 'reviewed')).toBe(false);
  });
});
