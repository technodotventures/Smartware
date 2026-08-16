// Tests: Layer 1 — Corroboration

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import { ClaimStore } from '../../src/layer1/store.js';
import { addCorroborationEvidence, removeEvidenceFromClaims } from '../../src/layer1/corroboration.js';
import type { Claim } from '../../src/layer1/types.js';
import { makeClaim as makeBaseClaim } from '../helpers.js';

let tmpDir: string;
let store: ClaimStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-corr-'));
  store = new ClaimStore(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertClaim(supporting: string[]): Claim {
  const entityId = `entity_${ulid()}`;
  store.insertEntity({ id: entityId, canonical_name: 'TestEntity', aliases: [], type: 'concept', scope: 'personal', created_at: new Date().toISOString() });

  const c = makeBaseClaim({
    subject_id: entityId,
    subject_name: 'TestEntity',
    source_event_id: supporting[0] ?? `obs_${ulid()}`,
    extraction_event_id: supporting[0] ?? `obs_${ulid()}`,
    supporting_evidence: supporting,
    confidence: 0.5,
  });
  store.insertClaim(c);
  return c;
}

describe('addCorroborationEvidence', () => {
  it('adds new evidence to the claim', () => {
    const obs1 = `obs_${ulid()}`;
    const claim = insertClaim([obs1]);

    const obs2 = `obs_${ulid()}`;
    addCorroborationEvidence(claim.id, obs2, store);

    const updated = store.getClaim(claim.id)!;
    expect(updated.supporting_evidence).toContain(obs1);
    expect(updated.supporting_evidence).toContain(obs2);
  });

  it('does not duplicate already-present evidence', () => {
    const obs1 = `obs_${ulid()}`;
    const claim = insertClaim([obs1]);

    addCorroborationEvidence(claim.id, obs1, store);

    const updated = store.getClaim(claim.id)!;
    expect(updated.supporting_evidence.filter(e => e === obs1)).toHaveLength(1);
  });
});

describe('removeEvidenceFromClaims', () => {
  it('retracts claim when last evidence is removed', () => {
    const obs1 = `obs_${ulid()}`;
    const claim = insertClaim([obs1]);

    const retracted = removeEvidenceFromClaims(obs1, store);

    expect(retracted).toContain(claim.id);
    const updated = store.getClaim(claim.id)!;
    expect(updated.status).toBe('retracted');
  });

  it('keeps claim active when other evidence remains', () => {
    const obs1 = `obs_${ulid()}`;
    const obs2 = `obs_${ulid()}`;
    const claim = insertClaim([obs1, obs2]);

    const retracted = removeEvidenceFromClaims(obs1, store);

    expect(retracted).not.toContain(claim.id);
    const updated = store.getClaim(claim.id)!;
    expect(updated.status).toBe('active');
    expect(updated.supporting_evidence).not.toContain(obs1);
    expect(updated.supporting_evidence).toContain(obs2);
  });
});
