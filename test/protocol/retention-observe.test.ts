// Retention resolution + OBSERVE population (ADR-0001).
// Proves the declared-but-unenforced `policy.retention_duration` field is now
// populated from the optional `retention` config, while the default (no config)
// stays byte-identical to pre-retention behavior.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SmartwareCore } from '../../src/core.js';
import {
  createDefaultConfig,
  resolveRetention,
  saveConfig,
  toRetentionDurationString,
  type SmartwareConfig,
} from '../../src/config.js';
import { readAll } from '../../src/layer0/log.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };

function scaffold(dataDir: string, config: SmartwareConfig): void {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  saveConfig(dataDir, config);
}

function makeConfig(dataDir: string, retention?: SmartwareConfig['retention']): SmartwareConfig {
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = 'user:owner';
  cfg.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    { id: 'client:acme#1', parent: 'workspace', visibility_default: 'scope' },
  ];
  if (retention) cfg.retention = retention;
  return cfg;
}

describe('resolveRetention (config resolver)', () => {
  const cfg = makeConfig('/tmp/x', {
    default: { policy: 'forever', duration_days: null },
    scope_overrides: { 'client:acme#1': { policy: 'duration', duration_days: 30 } },
  });

  it('scope override resolves before default', () => {
    expect(resolveRetention(cfg, 'client:acme#1')).toEqual({ policy: 'duration', duration_days: 30 });
  });

  it('non-overridden scope falls back to default', () => {
    expect(resolveRetention(cfg, 'workspace')).toEqual({ policy: 'forever', duration_days: null });
  });

  it('absent config resolves to forever', () => {
    expect(resolveRetention(makeConfig('/tmp/y'), 'client:acme#1'))
      .toEqual({ policy: 'forever', duration_days: null });
  });
});

describe('toRetentionDurationString', () => {
  it('emits ISO 8601 duration for duration policy', () => {
    expect(toRetentionDurationString({ policy: 'duration', duration_days: 90 })).toBe('P90D');
  });
  it('is null for forever / until_revoked / zero days', () => {
    expect(toRetentionDurationString({ policy: 'forever', duration_days: null })).toBeNull();
    expect(toRetentionDurationString({ policy: 'until_revoked', duration_days: null })).toBeNull();
    expect(toRetentionDurationString({ policy: 'duration', duration_days: 0 })).toBeNull();
  });
});

describe('OBSERVE populates policy.retention_duration', () => {
  let core: SmartwareCore | null = null;
  let dataDir: string;

  afterEach(() => {
    core?.close();
    core = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function openWith(retention?: SmartwareConfig['retention']): Promise<SmartwareCore> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-retention-'));
    scaffold(dataDir, makeConfig(dataDir, retention));
    core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
    return core;
  }

  function storedObs(dataDir: string, id: string) {
    return [...readAll(path.join(dataDir, 'evidence'))].find(o => o.id === id)!;
  }

  it('scope override drives retention + duration', async () => {
    const c = await openWith({
      default: { policy: 'forever', duration_days: null },
      scope_overrides: { 'client:acme#1': { policy: 'duration', duration_days: 30 } },
    });
    const r = await c.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'Acme renewal note' },
      scope: 'client:acme#1',
    });
    const policy = storedObs(dataDir, r.id).policy;
    expect(policy.retention).toBe('duration');
    expect(policy.retention_duration).toBe('P30D');
  });

  it('no override → default; no config → forever/null', async () => {
    const c = await openWith({ default: { policy: 'forever', duration_days: null } });
    const r = await c.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'workspace note' },
      scope: 'workspace',
    });
    expect(storedObs(dataDir, r.id).policy).toMatchObject({ retention: 'forever', retention_duration: null });

    // No retention config at all: identical default.
    core?.close();
    const c2 = await openWith(undefined);
    const r2 = await c2.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'another workspace note' },
      scope: 'workspace',
    });
    expect(storedObs(dataDir, r2.id).policy).toMatchObject({ retention: 'forever', retention_duration: null });
  });

  it('explicit retention_duration param wins over config', async () => {
    const c = await openWith({
      default: { policy: 'forever', duration_days: null },
      scope_overrides: { 'client:acme#1': { policy: 'duration', duration_days: 30 } },
    });
    const r = await c.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'short-lived note' },
      scope: 'client:acme#1',
      retention: 'duration',
      retention_duration: 'P7D',
    });
    expect(storedObs(dataDir, r.id).policy).toMatchObject({ retention: 'duration', retention_duration: 'P7D' });
  });

  it('non-null retention_duration changes the canonical id (field is in the payload)', async () => {
    const c = await openWith({
      default: { policy: 'forever', duration_days: null },
      scope_overrides: { 'client:acme#1': { policy: 'duration', duration_days: 30 } },
    });
    const body = 'identical body';
    const a = await c.observe({ actor: OWNER, type: 'message', content: { format: 'text/plain', body }, scope: 'workspace' });
    const b = await c.observe({ actor: OWNER, type: 'message', content: { format: 'text/plain', body }, scope: 'client:acme#1' });
    expect(a.id).not.toBe(b.id);
  });
});
