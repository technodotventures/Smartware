// Tests: Protocol — CORRECT handler

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { handleCorrect } from '../../src/protocol/correct.js';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-correct-'));
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

function insertTestClaim() {
  const entityId = `entity_${ulid()}`;
  store.insertEntity({ id: entityId, canonical_name: 'Alice', aliases: [], type: 'person', scope: 'personal', created_at: new Date().toISOString() });

  const claim = makeBaseClaim({
    subject_id: entityId,
    subject_name: 'Alice',
    confidence: 0.8,
  });
  store.insertClaim(claim);
  return claim;
}

describe('handleCorrect', () => {
  it('supersedes the original claim', async () => {
    const original = insertTestClaim();

    await handleCorrect(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        target_claim_id: original.id,
        corrected_object: { type: 'text', value: 'inactive' },
        reason: 'User corrected status',
      },
      evidenceDir, layer0, store, config,
    );

    const updated = store.getClaim(original.id)!;
    expect(updated.status).toBe('superseded');
    expect(updated.superseded_by).toBeTruthy();
  });

  it('throws when target claim does not exist', async () => {
    await expect(handleCorrect(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        target_claim_id: `claim_${ulid()}`,
        corrected_object: { type: 'text', value: 'new value' },
      },
      evidenceDir, layer0, store, config,
    )).rejects.toThrow(ProtocolError);
  });
});
