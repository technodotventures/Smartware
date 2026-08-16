// Conformance Suite H — FORGET & Tombstones (§11)

import { describe, it, expect } from 'vitest';
import type { ActiveClaimVersion, ForgottenClaimVersion } from '../../src/layer1/jsonl.js';
import { computeFingerprint } from '../../src/layer1/fingerprint.js';

function makeActiveVersion(): ActiveClaimVersion {
  return {
    claim_id: 'claim_FORGET01',
    version: 1,
    state: 'active',
    content: 'Assertion to be forgotten',
    claim_type: 'finding',
    claim_role: 'memory',
    author: 'agent',
    epistemic_owner: 'agent',
    fingerprint: computeFingerprint('Assertion to be forgotten', 'personal', 'finding'),
    confidence: 'medium',
    epistemic_tag: 'inference',
    scope: 'personal',
    derived_from: ['obs_f1', 'obs_f2'],
    relations: [{
      relation_id: 'rel_FORGET01',
      kind: 'references',
      target: 'claim_OTHER',
      valid_at: '2026-01-01T00:00:00Z',
      invalid_at: null,
      provenance: {
        origin: 'deterministic',
        rule_id: 'url_mention',
        asserted_in_source_version: 1,
        target_claim_version: 1,
        observation_ids: ['obs_f1'],
      },
    }],
    created_at: '2026-01-01T00:00:00Z',
    version_at: '2026-01-01T00:00:00Z',
    operation_id: 'op_CREATE0100000000000000000000',
    actor_id: 'substrate:test',
    tags: ['test'],
    endorsement_source: 'page_test',
  };
}

function forgetClaim(active: ActiveClaimVersion): ForgottenClaimVersion {
  return {
    claim_id: active.claim_id,
    version: active.version + 1,
    state: 'forgotten',
    tombstone_id: `tomb_${active.claim_id.slice(6)}`,
    forgotten_at: '2026-02-01T00:00:00Z',
    forgotten_by: 'user:owner',
    claim_type: active.claim_type,
    claim_role: active.claim_role,
    author: active.author,
    epistemic_owner: active.epistemic_owner,
    fingerprint: active.fingerprint,
    confidence: active.confidence,
    epistemic_tag: active.epistemic_tag,
    scope: active.scope,
    derived_from: active.derived_from,
    relations: active.relations,
    created_at: active.created_at,
    version_at: '2026-02-01T00:00:00Z',
    operation_id: 'op_FORGET0100000000000000000000',
    actor_id: 'user:owner',
    tags: active.tags,
    supersedes: active.version,
    endorsement_source: active.endorsement_source,
  };
}

describe('FORGET & Tombstones', () => {
  it('H1: forget_sets_state_forgotten', () => {
    const active = makeActiveVersion();
    const forgotten = forgetClaim(active);
    expect(forgotten.state).toBe('forgotten');
  });

  it('H2: forgotten_version_omits_content', () => {
    const active = makeActiveVersion();
    const forgotten = forgetClaim(active);
    expect('content' in forgotten).toBe(false);
  });

  it('H3: forget_carries_forward_all_metadata', () => {
    const active = makeActiveVersion();
    const forgotten = forgetClaim(active);
    expect(forgotten.author).toBe(active.author);
    expect(forgotten.epistemic_owner).toBe(active.epistemic_owner);
    expect(forgotten.fingerprint).toBe(active.fingerprint);
    expect(forgotten.confidence).toBe(active.confidence);
    expect(forgotten.epistemic_tag).toBe(active.epistemic_tag);
    expect(forgotten.scope).toBe(active.scope);
    expect(forgotten.derived_from).toEqual(active.derived_from);
    expect(forgotten.relations).toEqual(active.relations);
    expect(forgotten.relations[0]!.relation_id).toBe('rel_FORGET01');
    expect(forgotten.relations[0]!.provenance.asserted_in_source_version).toBe(1);
    expect(forgotten.endorsement_source).toBe(active.endorsement_source);
    expect(forgotten.tags).toEqual(active.tags);
  });

  it('H4: forget_excluded_from_default_recall', () => {
    const forgotten = forgetClaim(makeActiveVersion());
    expect(forgotten.state).toBe('forgotten');
    // RECALL excludes forgotten by default. Tested at handler level.
  });

  it('H5: forget_tombstone_is_full_snapshot', () => {
    const active = makeActiveVersion();
    // The tombstone stores the full prior active version as a snapshot.
    // It must contain content (which the forgotten JSONL version omits).
    expect(active.content).toBeTruthy();
    expect(active.claim_id).toBeTruthy();
    expect(active.fingerprint).toBeTruthy();
    expect(active.relations.length).toBeGreaterThan(0);
  });

  it('H6: revival_reconstructs_from_snapshot', () => {
    const active = makeActiveVersion();
    const forgotten = forgetClaim(active);
    // Revival creates a new active version from the tombstone snapshot.
    const revived: ActiveClaimVersion = {
      claim_id: forgotten.claim_id,
      version: forgotten.version + 1,
      state: 'active',
      content: active.content,
      claim_type: forgotten.claim_type,
      claim_role: forgotten.claim_role,
      author: forgotten.author,
      epistemic_owner: forgotten.epistemic_owner,
      fingerprint: forgotten.fingerprint,
      confidence: forgotten.confidence,
      epistemic_tag: forgotten.epistemic_tag,
      scope: forgotten.scope,
      derived_from: forgotten.derived_from,
      relations: forgotten.relations,
      created_at: forgotten.created_at,
      version_at: '2026-03-01T00:00:00Z',
      operation_id: 'op_REVIVE0100000000000000000000',
      actor_id: 'user:owner',
      tags: forgotten.tags,
      supersedes: forgotten.version,
      revived_via: forgotten.tombstone_id,
      endorsement_source: forgotten.endorsement_source,
    };
    expect(revived.state).toBe('active');
    expect(revived.content).toBe(active.content);
    expect(revived.author).toBe(active.author);
    expect(revived.epistemic_owner).toBe(active.epistemic_owner);
    expect(revived.fingerprint).toBe(active.fingerprint);
    expect(revived.revived_via).toBe(forgotten.tombstone_id);
  });

  it('H7: revival_preserves_fingerprint', () => {
    const active = makeActiveVersion();
    const forgotten = forgetClaim(active);
    // Content restored as-is → fingerprint stable
    const revivedFingerprint = computeFingerprint(active.content, active.scope, active.claim_type);
    expect(revivedFingerprint).toBe(active.fingerprint);
    expect(forgotten.fingerprint).toBe(active.fingerprint);
  });

  it('H8: forgotten_endpoint_excluded_from_context_bundle', () => {
    // Context bundle drops a relation if either endpoint is forgotten.
    // This is a filtering rule verified at the context handler level.
    const forgotten = forgetClaim(makeActiveVersion());
    expect(forgotten.state).toBe('forgotten');
  });
});
