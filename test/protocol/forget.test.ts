// Tests: Protocol — FORGET handler

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import type { Observation } from '../../src/layer0/types.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { appendObservation } from '../../src/layer0/log.js';
import { assignIntegrity } from '../../src/layer0/integrity.js';
import { handleForget } from '../../src/protocol/forget.js';
import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';
import { ProtocolError } from '../../src/auth/middleware.js';
import { makeClaim as makeBaseClaim } from '../helpers.js';

let tmpDir: string;
let evidenceDir: string;
let layer0: Layer0Index;
let store: ClaimStore;
let config: SmartwareConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-forget-'));
  evidenceDir = path.join(tmpDir, 'evidence');
  fs.mkdirSync(evidenceDir);

  config = {
    instance_id: `smartware_${ulid()}`,
    owner_id: 'person_owner',
    writer_id: `writer_${ulid()}`,
    version: '0.5.1',
    data_dir: tmpDir,
    scopes: [{ id: 'personal', parent: null, visibility_default: 'private' }],
    grants: [],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
  saveConfig(tmpDir, config);

  const dbPath = path.join(tmpDir, 'test.db');
  layer0 = new Layer0Index(dbPath);
  store = new ClaimStore(dbPath);
});

afterEach(() => {
  layer0.close();
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertObservation(body = 'test message'): Observation {
  const obs: Observation = {
    id: `obs_${ulid()}`,
    version: '0.5.1',
    type: 'message',
    status: 'accepted',
    source: {
      app: 'test', app_version: '1.0', source_id: null,
      actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
      captured_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
    },
    scope: 'personal', visibility: 'private',
    content: { format: 'text/plain', body },
    provenance: { parent_ids: [], supersedes: [], context: '' },
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: config.writer_id, sequence: layer0.getLastSequence() + 1, previous_hash: null },
  };
  const withIntegrity = assignIntegrity(obs, config.writer_id, obs.integrity.sequence, null);
  appendObservation(evidenceDir, withIntegrity);
  layer0.insertOrSkip(withIntegrity);
  return withIntegrity;
}

function insertClaimForObs(obsId: string) {
  const entityId = `entity_${ulid()}`;
  store.insertEntity({ id: entityId, canonical_name: 'TestEnt', aliases: [], type: 'concept', scope: 'personal', created_at: new Date().toISOString() });
  const claim = makeBaseClaim({
    subject_id: entityId,
    subject_name: 'TestEnt',
    source_event_id: obsId,
    extraction_event_id: obsId,
    supporting_evidence: [obsId],
    confidence: 0.8,
  });
  store.insertClaim(claim);
  return claim;
}

describe('handleForget', () => {
  it('tombstones a target observation', async () => {
    const obs = insertObservation();

    const result = await handleForget(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        target_obs_id: obs.id,
        mode: 'tombstone',
      },
      evidenceDir, layer0, store, config,
    );

    expect(result.status).toBe('forgotten');
    expect(layer0.getEffectiveStatus(obs.id)).toBe('tombstoned');
  });

  it('retracts a claim with no remaining evidence after tombstone', async () => {
    const obs = insertObservation();
    const claim = insertClaimForObs(obs.id);

    await handleForget(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        target_obs_id: obs.id,
        mode: 'tombstone',
      },
      evidenceDir, layer0, store, config,
    );

    const updated = store.getClaim(claim.id)!;
    expect(updated.status).toBe('retracted');
  });

  it('throws when target is already tombstoned', async () => {
    const obs = insertObservation();
    // First tombstone
    await handleForget(
      { actor: { type: 'person', id: 'person_owner', display_name: 'Owner' }, target_obs_id: obs.id, mode: 'tombstone' },
      evidenceDir, layer0, store, config,
    );

    // Second tombstone should fail
    await expect(handleForget(
      { actor: { type: 'person', id: 'person_owner', display_name: 'Owner' }, target_obs_id: obs.id, mode: 'tombstone' },
      evidenceDir, layer0, store, config,
    )).rejects.toThrow(ProtocolError);
  });
});
