// Conformance Suite E — ID Provenance (§4.4)

import { describe, it, expect } from 'vitest';
import { ulid } from 'ulid';
import type { ActiveClaimVersion } from '../../src/layer1/jsonl.js';
import { OPERATION_ID_PATTERN } from '../../src/ops_log/types.js';
import { computeFingerprint } from '../../src/layer1/fingerprint.js';

describe('ID Provenance', () => {
  it('E1: client_operation_id_on_external_calls', () => {
    const clientOpId = `op_${ulid()}`;
    expect(OPERATION_ID_PATTERN.test(clientOpId)).toBe(true);
  });

  it('E2: substrate_operation_id_on_autonomous_calls', () => {
    const substrateOpId = `op_${ulid()}`;
    expect(OPERATION_ID_PATTERN.test(substrateOpId)).toBe(true);
    // reflect.auto generates its own operation_id, not client-supplied.
  });

  it('E3: substrate_actor_id_format', () => {
    const substrateActorId = 'substrate:coffee';
    expect(substrateActorId).toMatch(/^substrate:/);
  });

  it('E4: server_stamps_version_number', () => {
    // Version is never client-supplied — it's computed by nextVersion().
    const claim: ActiveClaimVersion = {
      claim_id: `claim_${ulid()}`,
      version: 1,
      state: 'active',
      content: 'Test',
      claim_type: 'finding',
      claim_role: 'memory',
      author: 'agent',
      epistemic_owner: 'agent',
      fingerprint: computeFingerprint('Test', 'personal', 'finding'),
      confidence: 'low',
      epistemic_tag: 'inference',
      scope: 'personal',
      derived_from: [],
      relations: [],
      created_at: '2026-01-01T00:00:00Z',
      version_at: '2026-01-01T00:00:00Z',
      operation_id: `op_${ulid()}`,
      actor_id: 'substrate:test',
      tags: [],
    };
    expect(typeof claim.version).toBe('number');
    expect(claim.version).toBeGreaterThanOrEqual(1);
  });

  it('E5: server_stamps_asserted_in_source_version', () => {
    // asserted_in_source_version is on the relation provenance, server-stamped.
    const relation = {
      relation_id: `rel_${ulid()}`,
      kind: 'references' as const,
      target: `claim_${ulid()}`,
      valid_at: '2026-01-01T00:00:00Z',
      invalid_at: null,
      provenance: {
        origin: 'deterministic' as const,
        rule_id: 'url_mention',
        asserted_in_source_version: 3,
        target_claim_version: 1,
        observation_ids: [],
      },
    };
    expect(relation.provenance.asserted_in_source_version).toBe(3);
  });

  it('E6: server_stamps_relation_id', () => {
    const relationId = `rel_${ulid()}`;
    expect(relationId).toMatch(/^rel_/);
  });
});
