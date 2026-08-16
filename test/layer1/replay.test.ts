// Tests: Layer 1 — Event Replay

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import type { Observation, PreExtractedClaim } from '../../src/layer0/types.js';
import { appendObservation } from '../../src/layer0/log.js';
import { assignIntegrity } from '../../src/layer0/integrity.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { replayAll } from '../../src/layer1/replay.js';

let tmpDir: string;
let evidenceDir: string;
let layer0: Layer0Index;
let store: ClaimStore;
let seq = 0;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-replay-'));
  evidenceDir = path.join(tmpDir, 'evidence');
  fs.mkdirSync(evidenceDir);
  const dbPath = path.join(tmpDir, 'test.db');
  layer0 = new Layer0Index(dbPath);
  store = new ClaimStore(dbPath);
  seq = 0;
});

afterEach(() => {
  layer0.close();
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function appendObs(type: Observation['type'], body: unknown, claims?: PreExtractedClaim[]): Observation {
  seq++;
  const obs: Observation = {
    id: `obs_${ulid()}`,
    version: '0.5.1',
    type,
    status: 'accepted',
    source: {
      app: 'test', app_version: '1.0', source_id: null,
      actor: { type: 'person', id: 'user_1', display_name: 'Test' },
      captured_at: new Date().toISOString(),
      observed_at: '2024-03-01T00:00:00Z',
    },
    scope: 'personal', visibility: 'private',
    content: { format: 'application/json', body: body as object },
    claims,
    provenance: { parent_ids: [], supersedes: [], context: '' },
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: 'writer_1', sequence: seq, previous_hash: null },
  };
  const withIntegrity = assignIntegrity(obs, 'writer_1', seq, null);
  appendObservation(evidenceDir, withIntegrity);
  return withIntegrity;
}

function makeClaim(subjectName: string, predicate: string, value: string, scope = 'personal'): PreExtractedClaim {
  return {
    subject_name: subjectName,
    predicate,
    object: { type: 'text', value },
    scope,
    validity: { from: '2024-03-01T00:00:00Z', to: null },
    epistemic: 'observed',
    confidence: 0.8,
    sensitive: false,
    extraction: { method: 'deterministic', model: null, compiler_version: '0.5.1', prompt_hash: null },
  };
}

describe('replayAll', () => {
  it('inserts claims from claim_extracted events', () => {
    appendObs('claim_extracted', {}, [makeClaim('Alice', 'status_is', 'active')]);
    replayAll(evidenceDir, layer0, store);

    const claims = store.getAllClaims();
    expect(claims.length).toBeGreaterThanOrEqual(1);
    expect(claims[0]!.subject_name).toBe('Alice');
  });

  it('corroboration: same key + same value → one claim, two evidence entries', () => {
    const claim = makeClaim('Project X', 'status_is', 'active');
    appendObs('claim_extracted', {}, [claim]);
    appendObs('claim_extracted', {}, [claim]); // same claim again

    replayAll(evidenceDir, layer0, store);

    const claims = store.getAllClaims().filter(c => c.subject_name === 'Project X');
    // Should be just one active claim
    const active = claims.filter(c => c.status === 'active');
    expect(active.length).toBe(1);
    // Supporting evidence should have 2 entries
    expect(active[0]!.supporting_evidence.length).toBeGreaterThanOrEqual(2);
  });

  it('semantic conflict: same key + different value → two contested claims', () => {
    appendObs('claim_extracted', {}, [makeClaim('Project Y', 'status_is', 'active')]);
    appendObs('claim_extracted', {}, [makeClaim('Project Y', 'status_is', 'cancelled')]);

    replayAll(evidenceDir, layer0, store);

    const claims = store.getAllClaims().filter(c => c.subject_name === 'Project Y');
    const contested = claims.filter(c => c.status === 'contested');
    expect(contested.length).toBe(2);
  });

  it('tombstone with corroboration: removing one evidence keeps claim active', () => {
    appendObs('claim_extracted', {}, [makeClaim('Task A', 'status_is', 'open')]);
    const obs2 = appendObs('claim_extracted', {}, [makeClaim('Task A', 'status_is', 'open')]);

    replayAll(evidenceDir, layer0, store);

    // Tombstone the second extraction event
    appendObs('tombstone', { target_id: obs2.id });
    replayAll(evidenceDir, layer0, store);

    const claims = store.getAllClaims().filter(c => c.subject_name === 'Task A' && c.status === 'active');
    expect(claims.length).toBe(1);
  });

  it('tombstone without corroboration: retracts the only claim', () => {
    const obs = appendObs('claim_extracted', {}, [makeClaim('Task B', 'status_is', 'open')]);

    replayAll(evidenceDir, layer0, store);

    // Tombstone the only extraction event
    appendObs('tombstone', { target_id: obs.id });
    replayAll(evidenceDir, layer0, store);

    const claims = store.getAllClaims().filter(c => c.subject_name === 'Task B');
    const active = claims.filter(c => c.status === 'active');
    expect(active.length).toBe(0);
  });
});
