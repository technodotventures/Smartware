// Conformance Suite K — Registry & ACCESS Enforcement (§7)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';
import { requireRegisteredActor, requireGrant, evaluateAccess, ProtocolError } from '../../src/auth/middleware.js';
import { renderRegistryMarkdown, writeRegistryMarkdown } from '../../src/auth/registry-md.js';
import { resolveActorId, loadAliasMap, appendAlias } from '../../src/auth/alias-map.js';

let tmpDir: string;
let config: SmartwareConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-access-'));
  config = {
    instance_id: `smartware_${ulid()}`,
    owner_id: 'person_owner',
    writer_id: `writer_${ulid()}`,
    version: '0.5.1',
    data_dir: tmpDir,
    scopes: [{ id: 'personal', parent: null, visibility_default: 'private' }],
    grants: [
      {
        id: `grant_${ulid()}`,
        actor_type: 'agent',
        actor_id: 'agent:research',
        capabilities: {
          observe: ['personal'],
          query: ['personal'],
          compile: ['personal'],
          correct: [],
          forget: [],
          read: ['personal'],
        },
        trusted: false,
        quarantine: false,
        created_at: new Date().toISOString(),
        expires_at: null,
        status: 'active',
      },
      {
        id: `grant_${ulid()}`,
        actor_type: 'agent',
        actor_id: 'agent:forgetter',
        capabilities: {
          observe: ['personal'],
          query: ['personal'],
          compile: [],
          correct: [],
          forget: ['personal'],
          read: ['personal'],
        },
        trusted: false,
        quarantine: false,
        created_at: new Date().toISOString(),
        expires_at: null,
        status: 'active',
      },
    ],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
  saveConfig(tmpDir, config);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Registry & ACCESS Enforcement', () => {
  it('K1: unregistered_actor_rejected', () => {
    expect(() => requireRegisteredActor('agent:unknown', config)).toThrow(ProtocolError);
    try {
      requireRegisteredActor('agent:unknown', config);
    } catch (e) {
      expect((e as ProtocolError).code).toBe('actor_unregistered');
    }
  });

  it('K2: grant_required_for_write_ops', () => {
    const decision = evaluateAccess('agent:research', 'observe', 'personal', config);
    expect(decision.decision).toBe('allow');

    const denyDecision = evaluateAccess('agent:research', 'correct', 'personal', config);
    expect(denyDecision.decision).toBe('deny');
  });

  it('K3: agent_forget_requires_forget_grant', () => {
    const noForgetGrant = evaluateAccess('agent:research', 'forget', 'personal', config);
    expect(noForgetGrant.decision).toBe('deny');

    const hasForgetGrant = evaluateAccess('agent:forgetter', 'forget', 'personal', config);
    expect(hasForgetGrant.decision).toBe('allow');
  });

  it('K4: registry_md_reflects_grants', () => {
    writeRegistryMarkdown(tmpDir, config);
    const registryPath = path.join(tmpDir, 'agents', 'registry.md');
    expect(fs.existsSync(registryPath)).toBe(true);
    const content = fs.readFileSync(registryPath, 'utf-8');
    expect(content).toContain('agent:research');
    expect(content).toContain('agent:forgetter');
    expect(content).toContain(config.owner_id);
  });

  it('K5: alias_map_resolves_actor_ids', () => {
    appendAlias(tmpDir, {
      legacy_id: 'agent:old-name',
      spec_id: 'agent:research',
      reason: 'test rename',
    });
    const map = loadAliasMap(tmpDir);
    const resolved = resolveActorId(map, 'agent:old-name');
    expect(resolved).toBe('agent:research');

    const unchanged = resolveActorId(map, 'agent:research');
    expect(unchanged).toBe('agent:research');
  });

  it('K6: single_canonical_registry_authority', () => {
    // config.json grants are the canonical enforcement source.
    // registry.md is a derived human-readable projection.
    // Test: programmatic access decisions always come from config.json.
    const md = renderRegistryMarkdown(config);
    expect(md).toContain('Agent Registry');

    // Enforcement uses config, not markdown
    const decision = evaluateAccess('agent:research', 'observe', 'personal', config);
    expect(decision.decision).toBe('allow');
    expect(decision.reason).toContain('Grant');
  });
});
