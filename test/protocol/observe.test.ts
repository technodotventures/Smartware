// Tests: Protocol — OBSERVE handler

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import { Layer0Index } from '../../src/layer0/index.js';
import { handleObserve } from '../../src/protocol/observe.js';
import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';
import { ProtocolError } from '../../src/auth/middleware.js';

let tmpDir: string;
let evidenceDir: string;
let layer0: Layer0Index;
let config: SmartwareConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-obs-'));
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

  layer0 = new Layer0Index(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  layer0.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleObserve', () => {
  it('owner can observe to personal scope', async () => {
    const result = await handleObserve(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Hello world' },
        scope: 'personal',
      },
      evidenceDir,
      layer0,
      config,
    );
    expect(result.status).toBe('accepted');
    expect(result.id).toMatch(/^obs_[a-f0-9]{64}$/);
  });

  it('content-addresses the canonical payload and deduplicates exact re-ingest', async () => {
    const params = {
      actor: { type: 'person' as const, id: 'person_owner', display_name: 'Owner' },
      type: 'message' as const,
      content: { format: 'text/plain' as const, body: 'Same canonical memory' },
      scope: 'personal',
    };

    const first = await handleObserve(params, evidenceDir, layer0, config);
    const second = await handleObserve(params, evidenceDir, layer0, config);

    expect(first.id).toMatch(/^obs_[a-f0-9]{64}$/);
    expect(second).toEqual({
      id: first.id,
      status: 'duplicate',
      existing_id: first.id,
      sequence: first.sequence,
    });
    expect(layer0.totalCount()).toBe(1);
  });

  it('returns duplicate for same source_id on second call', async () => {
    const firstResult = await handleObserve(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Hello world' },
        scope: 'personal',
        source_id: 'unique-msg-001',
        app: 'test-app',
      },
      evidenceDir,
      layer0,
      config,
    );
    expect(firstResult.status).toBe('accepted');

    const secondResult = await handleObserve(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Hello world (duplicate)' },
        scope: 'personal',
        source_id: 'unique-msg-001',
        app: 'test-app',
      },
      evidenceDir,
      layer0,
      config,
    );
    expect(secondResult.status).toBe('duplicate');
    expect(secondResult.existing_id).toBe(firstResult.id);
  });

  it('rejects observation with secret pattern', async () => {
    await expect(handleObserve(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'My AWS key is AKIAIOSFODNN7EXAMPLE' },
        scope: 'personal',
      },
      evidenceDir,
      layer0,
      config,
    )).rejects.toThrow(ProtocolError);
  });

  it('rejects non-owner without grant', async () => {
    await expect(handleObserve(
      {
        actor: { type: 'agent', id: 'agent_unknown', display_name: 'Unknown Agent' },
        type: 'message',
        content: { format: 'text/plain', body: 'Trying to observe' },
        scope: 'personal',
      },
      evidenceDir,
      layer0,
      config,
    )).rejects.toThrow(ProtocolError);
  });

  it('increments sequence for each observation', async () => {
    const r1 = await handleObserve(
      { actor: { type: 'person', id: 'person_owner', display_name: 'Owner' }, type: 'message', content: { format: 'text/plain', body: 'first' }, scope: 'personal' },
      evidenceDir, layer0, config,
    );
    const r2 = await handleObserve(
      { actor: { type: 'person', id: 'person_owner', display_name: 'Owner' }, type: 'message', content: { format: 'text/plain', body: 'second' }, scope: 'personal' },
      evidenceDir, layer0, config,
    );
    expect(r2.sequence).toBeGreaterThan(r1.sequence);
  });
});
