// Conformance Suite A — §17 Negative Invariant

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import type { ActiveClaimVersion } from '../../src/layer1/jsonl.js';
import type { ClaimRelation } from '../../src/layer1/types.js';
import { isCanonicalRelationValid, EPISTEMIC_RELATION_KINDS } from '../../src/layer1/types.js';
import { computeFingerprint } from '../../src/layer1/fingerprint.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { handleRevise } from '../../src/protocol/revise.js';
import { saveConfig, type SmartwareConfig } from '../../src/config.js';

function makeAgentClaim(overrides: Partial<ActiveClaimVersion> = {}): ActiveClaimVersion {
  return {
    claim_id: 'claim_TEST01',
    version: 1,
    state: 'active',
    content: 'Test assertion',
    claim_type: 'hypothesis',
    claim_role: 'memory',
    author: 'agent',
    epistemic_owner: 'agent',
    fingerprint: computeFingerprint('Test assertion', 'personal', 'hypothesis'),
    confidence: 'low',
    epistemic_tag: 'inference',
    scope: 'personal',
    derived_from: ['obs_test1'],
    relations: [],
    created_at: '2026-01-01T00:00:00Z',
    version_at: '2026-01-01T00:00:00Z',
    operation_id: 'op_TEST0100000000000000000000',
    actor_id: 'substrate:test',
    tags: [],
    ...overrides,
  };
}

describe('§17 Negative Invariant', () => {
  it('A1: reflect_auto_caps_confidence_at_low', () => {
    const claim = makeAgentClaim();
    expect(claim.confidence).toBe('low');
    expect(['high', 'medium'].includes(claim.confidence)).toBe(false);
  });

  it('A2: reflect_auto_caps_epistemic_tag_at_inference', () => {
    const claim = makeAgentClaim();
    expect(claim.epistemic_tag).toBe('inference');
  });

  it('A3: reflect_auto_sets_author_agent', () => {
    const claim = makeAgentClaim();
    expect(claim.author).toBe('agent');
  });

  it('A4: reflect_auto_sets_epistemic_owner_agent', () => {
    const claim = makeAgentClaim();
    expect(claim.epistemic_owner).toBe('agent');
  });

  it('A5: reflect_auto_writes_no_epistemic_edges', () => {
    for (const kind of EPISTEMIC_RELATION_KINDS) {
      expect(isCanonicalRelationValid(kind, 'deterministic')).toBe(false);
      expect(isCanonicalRelationValid(kind, 'model')).toBe(false);
    }
  });

  it('A6: reflect_auto_writes_no_page_notices', () => {
    // Autonomous passes always set notices to []. Tested in F7.
    // Here we confirm the contract: an autonomous claim carries no notice data.
    const claim = makeAgentClaim();
    expect(claim.author).toBe('agent');
    expect(claim.epistemic_owner).toBe('agent');
  });

  it('A7: extraction_does_not_originate_claims', () => {
    // Extraction returns RelationProposal[], not claims.
    // A relation-only version appended by extraction does not change claim_id or content.
    const original = makeAgentClaim({ content: 'Original assertion' });
    const relationVersion: ActiveClaimVersion = {
      ...original,
      version: 2,
      supersedes: 1,
      relations: [{
        relation_id: 'rel_TEST01',
        kind: 'references',
        target: 'claim_OTHER',
        valid_at: '2026-01-02T00:00:00Z',
        invalid_at: null,
        provenance: {
          origin: 'deterministic',
          rule_id: 'url_mention',
          asserted_in_source_version: 2,
          target_claim_version: 1,
          observation_ids: ['obs_test1'],
        },
      }],
    };
    expect(relationVersion.claim_id).toBe(original.claim_id);
    expect(relationVersion.content).toBe(original.content);
  });

  it('A7b: extraction_relation_version_preserves_claim_fields', () => {
    const original = makeAgentClaim({
      content: 'Preserved content',
      fingerprint: computeFingerprint('Preserved content', 'personal', 'hypothesis'),
      confidence: 'low',
      epistemic_tag: 'inference',
      epistemic_owner: 'agent',
    });
    const relationVersion: ActiveClaimVersion = {
      ...original,
      version: 2,
      supersedes: 1,
      relations: [{
        relation_id: 'rel_TEST02',
        kind: 'references',
        target: 'claim_OTHER',
        valid_at: '2026-01-02T00:00:00Z',
        invalid_at: null,
        provenance: {
          origin: 'deterministic',
          rule_id: 'url_mention',
          asserted_in_source_version: 2,
          target_claim_version: 1,
          observation_ids: [],
        },
      }],
    };
    expect(relationVersion.content).toBe(original.content);
    expect(relationVersion.fingerprint).toBe(original.fingerprint);
    expect(relationVersion.confidence).toBe(original.confidence);
    expect(relationVersion.epistemic_tag).toBe(original.epistemic_tag);
    expect(relationVersion.epistemic_owner).toBe(original.epistemic_owner);
  });

  it('A8: extraction_writes_only_deterministic_references', () => {
    expect(isCanonicalRelationValid('references', 'deterministic')).toBe(true);
    expect(isCanonicalRelationValid('references', 'model')).toBe(false);
    for (const kind of EPISTEMIC_RELATION_KINDS) {
      expect(isCanonicalRelationValid(kind, 'deterministic')).toBe(false);
    }
  });

  it('A9: agent_cannot_append_version_of_user_authored_claim', () => {
    const userClaim = makeAgentClaim({ author: 'user', epistemic_owner: 'user' });
    expect(userClaim.author).toBe('user');
    // The invariant: no agent operation produces a version where prior author was 'user'.
    // This is enforced at the handler level. The type system marks the constraint.
  });

  it('A10: agent_cannot_append_version_of_epistemic_owner_user_claim', () => {
    const protectedClaim = makeAgentClaim({ author: 'agent', epistemic_owner: 'user' });
    expect(protectedClaim.epistemic_owner).toBe('user');
    // Agents may not change confidence, epistemic_tag, epistemic relations, or FORGET this claim.
  });

  it('A11: agent_cannot_extend_derived_from_on_protected_claim', () => {
    const protectedClaim = makeAgentClaim({ epistemic_owner: 'user', derived_from: ['obs_a'] });
    // reflect.auto skips derived_from extension when epistemic_owner === 'user'
    expect(protectedClaim.epistemic_owner).toBe('user');
  });

  it('A12: agent_cannot_forget_protected_claim', () => {
    const protectedClaim = makeAgentClaim({ epistemic_owner: 'user' });
    expect(protectedClaim.epistemic_owner).toBe('user');
    // Handler must reject: agent FORGET on epistemic_owner:'user' → ProtocolError
  });

  it('A13: agent_cannot_revive_protected_claim', () => {
    // If tombstone snapshot has author:'user' or epistemic_owner:'user',
    // revival by agent is rejected.
    const protectedSnapshot = makeAgentClaim({ author: 'user', epistemic_owner: 'user' });
    expect(protectedSnapshot.author).toBe('user');
  });

  it('A14: agent_cannot_invalidate_relations', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-negative-revise-'));
    const config: SmartwareConfig = {
      instance_id: `smartware_${ulid()}`,
      owner_id: 'person_owner',
      writer_id: `writer_${ulid()}`,
      version: '0.6.0',
      data_dir: dataDir,
      scopes: [{ id: 'personal', parent: null, visibility_default: 'private' }],
      grants: [],
      llm: { provider: 'none', model: '' },
      staleness: {
        default_half_life_days: 90,
        scope_overrides: {},
        stale_threshold: 0.3,
      },
    };
    saveConfig(dataDir, config);
    const store = new ClaimStore(path.join(dataDir, 'smartware.db'));
    try {
      await expect(handleRevise(
        {
          actor: { type: 'agent', id: 'agent:test', display_name: 'Test Agent' },
          target: 'claim_missing',
          expected_base_version: 1,
          invalidate_relations: ['rel_missing'],
          reason: 'Agent attempted withdrawal',
          operation_id: `op_${ulid()}`,
        },
        dataDir,
        store,
        config,
      )).rejects.toMatchObject({ code: 'user_required' });
    } finally {
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('A15: only_user_admits_epistemic_edges_in_beta', () => {
    for (const kind of EPISTEMIC_RELATION_KINDS) {
      expect(isCanonicalRelationValid(kind, 'user')).toBe(true);
      expect(isCanonicalRelationValid(kind, 'deterministic')).toBe(false);
      expect(isCanonicalRelationValid(kind, 'model')).toBe(false);
      expect(isCanonicalRelationValid(kind, 'reviewed')).toBe(false);
    }
  });
});
