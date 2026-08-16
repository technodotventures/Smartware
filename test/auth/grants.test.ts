// Tests: Auth — Grants

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import { checkGrant, isOwner, isExpired, createGrant, revokeGrant } from '../../src/auth/grants.js';
import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig, loadConfig } from '../../src/config.js';

let tmpDir: string;
let config: SmartwareConfig;

function makeConfig(): SmartwareConfig {
  return {
    instance_id: `smartware_${ulid()}`,
    owner_id: 'person_owner',
    writer_id: `writer_${ulid()}`,
    version: '0.5.1',
    data_dir: tmpDir,
    scopes: [{ id: 'personal', parent: null, visibility_default: 'private' }],
    grants: [],
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-grants-'));
  config = makeConfig();
  saveConfig(tmpDir, config);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isOwner', () => {
  it('returns true for owner_id', () => {
    expect(isOwner('person_owner', config)).toBe(true);
  });

  it('returns false for non-owner', () => {
    expect(isOwner('agent_bob', config)).toBe(false);
  });
});

describe('checkGrant', () => {
  it('returns false when no grants exist', () => {
    expect(checkGrant('agent_bob', 'query', 'personal', config)).toBe(false);
  });

  it('returns true when matching grant exists', () => {
    const grant = createGrant(tmpDir, {
      actor_type: 'agent',
      actor_id: 'agent_bob',
      capabilities: { observe: [], query: ['personal'], compile: [], correct: [], forget: [], read: ['personal'] },
    });
    const freshConfig = loadConfig(tmpDir);
    expect(checkGrant('agent_bob', 'query', 'personal', freshConfig)).toBe(true);
  });

  it('wildcard scope matches all scopes', () => {
    createGrant(tmpDir, {
      actor_type: 'agent',
      actor_id: 'agent_wide',
      capabilities: { observe: ['*'], query: ['*'], compile: [], correct: [], forget: [], read: ['*'] },
    });
    const freshConfig = loadConfig(tmpDir);
    expect(checkGrant('agent_wide', 'query', 'project/anything', freshConfig)).toBe(true);
  });
});

describe('isExpired', () => {
  it('returns false for non-expiring grant', () => {
    const grant = createGrant(tmpDir, {
      actor_type: 'agent',
      actor_id: 'agent_x',
      capabilities: { observe: [], query: [], compile: [], correct: [], forget: [], read: [] },
    });
    expect(isExpired(grant)).toBe(false);
  });

  it('returns true for past expiry', () => {
    const grant = createGrant(tmpDir, {
      actor_type: 'agent',
      actor_id: 'agent_y',
      capabilities: { observe: [], query: [], compile: [], correct: [], forget: [], read: [] },
      expires_at: '2020-01-01T00:00:00Z',
    });
    expect(isExpired(grant)).toBe(true);
  });
});

describe('revokeGrant', () => {
  it('revoked grant is no longer active', () => {
    const grant = createGrant(tmpDir, {
      actor_type: 'agent',
      actor_id: 'agent_revoked',
      capabilities: { observe: [], query: ['personal'], compile: [], correct: [], forget: [], read: [] },
    });

    revokeGrant(tmpDir, grant.id);
    const freshConfig = loadConfig(tmpDir);
    expect(checkGrant('agent_revoked', 'query', 'personal', freshConfig)).toBe(false);
  });
});
