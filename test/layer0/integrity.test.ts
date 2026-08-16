// Tests: Layer 0 — Hash Chain Integrity

import { describe, it, expect } from 'vitest';
import type { Observation } from '../../src/layer0/types.js';
import { computeHash, assignIntegrity, verifyChain } from '../../src/layer0/integrity.js';
import { ulid } from 'ulid';

function baseObs(seq: number): Observation {
  return {
    id: `obs_${ulid()}`,
    version: '0.5.1',
    type: 'message',
    status: 'accepted',
    source: {
      app: 'test',
      app_version: '1.0',
      source_id: null,
      actor: { type: 'person', id: 'user_1', display_name: 'Test' },
      captured_at: '2024-01-01T00:00:00Z',
      observed_at: '2024-01-01T00:00:00Z',
    },
    scope: 'personal',
    visibility: 'private',
    content: { format: 'text/plain', body: `message ${seq}` },
    provenance: { parent_ids: [], supersedes: [], context: '' },
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: 'writer_1', sequence: seq, previous_hash: null },
  };
}

describe('computeHash', () => {
  it('produces a sha256 hash string', () => {
    const obs = assignIntegrity(baseObs(1), 'writer_1', 1, null);
    expect(obs.integrity.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('same content produces same hash', () => {
    const obs = baseObs(1);
    const h1 = computeHash(obs);
    const h2 = computeHash(obs);
    expect(h1).toBe(h2);
  });

  it('different content produces different hash', () => {
    const obs1 = baseObs(1);
    const obs2 = { ...baseObs(1), id: 'different_id' };
    expect(computeHash(obs1)).not.toBe(computeHash(obs2));
  });
});

describe('verifyChain', () => {
  it('valid chain of 10 events passes', () => {
    const observations: Observation[] = [];
    let prevHash: string | null = null;

    for (let i = 1; i <= 10; i++) {
      const obs = assignIntegrity(baseObs(i), 'writer_1', i, prevHash);
      prevHash = obs.integrity.hash;
      observations.push(obs);
    }

    const result = verifyChain(observations);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it('tampered observation breaks the chain', () => {
    const observations: Observation[] = [];
    let prevHash: string | null = null;

    for (let i = 1; i <= 5; i++) {
      const obs = assignIntegrity(baseObs(i), 'writer_1', i, prevHash);
      prevHash = obs.integrity.hash;
      observations.push(obs);
    }

    // Tamper with index 2 (0-based)
    observations[2] = {
      ...observations[2]!,
      content: { format: 'text/plain', body: 'TAMPERED CONTENT' },
    };

    const result = verifyChain(observations);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBeDefined();
  });

  it('empty chain is valid', () => {
    const result = verifyChain([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a deletion cover-up (rewriting previous_hash to skip a record)', () => {
    const chain: Observation[] = [];
    let prev: string | null = null;
    for (let i = 1; i <= 3; i++) {
      const o = assignIntegrity(baseObs(i), 'writer_1', i, prev);
      prev = o.integrity.hash;
      chain.push(o);
    }
    const [A, , C] = chain;
    // Attacker deletes B and forges C's link to point at A. previous_hash is now
    // authenticated by the hash, so C's hash no longer matches → detected.
    const forgedC: Observation = { ...C!, integrity: { ...C!.integrity, previous_hash: A!.integrity.hash } };
    const result = verifyChain([A!, forgedC]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('authenticates sequence and writer_id, not just content', () => {
    const o = assignIntegrity(baseObs(1), 'writer_1', 1, null);
    expect(verifyChain([{ ...o, integrity: { ...o.integrity, sequence: 999 } }]).valid).toBe(false);
    expect(verifyChain([{ ...o, integrity: { ...o.integrity, writer_id: 'attacker' } }]).valid).toBe(false);
  });
});
