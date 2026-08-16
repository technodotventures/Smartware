// Tests: Layer 1 — Conflict Detection

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import { ClaimStore } from '../../src/layer1/store.js';
import { detectConflict } from '../../src/layer1/conflicts.js';
import type { Claim } from '../../src/layer1/types.js';
import { makeClaim as makeBaseClaim } from '../helpers.js';

let tmpDir: string;
let store: ClaimStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-conf-'));
  store = new ClaimStore(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntity(name: string): string {
  const id = `entity_${ulid()}`;
  store.insertEntity({ id, canonical_name: name, aliases: [], type: 'project', scope: 'personal', created_at: new Date().toISOString() });
  return id;
}

function makeClaim(subjectId: string, predicate: string, value: string, validityFrom = '2024-01-01T00:00:00Z'): Claim {
  return makeBaseClaim({
    subject_id: subjectId,
    subject_name: 'Test',
    predicate,
    object: { type: 'text', value },
    validity: { from: validityFrom, to: null },
    t_valid_from: { value: validityFrom, state: 'known' },
    confidence: 0.8,
  });
}

describe('detectConflict', () => {
  it('returns no_conflict when no existing claim', () => {
    const entityId = makeEntity('Alpha');
    const newClaim = makeClaim(entityId, 'status_is', 'active');
    const result = detectConflict(newClaim, store);
    expect(result.type).toBe('no_conflict');
  });

  it('detects corroboration when same key + same value', () => {
    const entityId = makeEntity('Beta');
    const existing = makeClaim(entityId, 'status_is', 'active');
    store.insertClaim(existing);

    const newClaim = { ...existing, id: `claim_${ulid()}` };
    const result = detectConflict(newClaim, store);
    expect(result.type).toBe('corroboration');
    expect(result.existingClaim?.id).toBe(existing.id);
  });

  it('detects semantic_conflict when same key + different value', () => {
    const entityId = makeEntity('Gamma');
    const existing = makeClaim(entityId, 'status_is', 'active');
    store.insertClaim(existing);

    const newClaim = { ...existing, id: `claim_${ulid()}`, object: { type: 'text' as const, value: 'cancelled' } };
    const result = detectConflict(newClaim, store);
    expect(result.type).toBe('semantic_conflict');
  });

  it('detects temporal_supersession when newer validity.from', () => {
    const entityId = makeEntity('Delta');
    const old = makeClaim(entityId, 'status_is', 'active', '2024-01-01T00:00:00Z');
    store.insertClaim(old);

    const newer = { ...old, id: `claim_${ulid()}`, validity: { from: '2024-06-01T00:00:00Z', to: null } };
    const result = detectConflict(newer, store);
    expect(result.type).toBe('temporal_supersession');
    expect(result.existingClaim?.id).toBe(old.id);
  });
});
