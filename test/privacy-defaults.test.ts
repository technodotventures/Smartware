import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveConfig } from '../src/config.js';
import { SmartwareCore } from '../src/core.js';

const opened: SmartwareCore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const core of opened.splice(0)) core.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function openCore(): Promise<SmartwareCore> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-privacy-'));
  directories.push(dataDir);
  const core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
  opened.push(core);
  return core;
}

describe('private-by-default reflection', () => {
  it.runIf(process.platform !== 'win32')('restricts the local data root and canonical files', async () => {
    const core = await openCore();
    const dataDir = core.getConfig().data_dir;
    const mode = (file: string) => fs.statSync(file).mode & 0o777;

    expect(mode(dataDir)).toBe(0o700);
    expect(mode(path.join(dataDir, 'config.json'))).toBe(0o600);
    expect(mode(path.join(dataDir, 'smartware.db'))).toBe(0o600);
    expect(mode(path.join(dataDir, 'wiki'))).toBe(0o700);
    expect(mode(path.join(dataDir, 'wiki', 'smartware.md'))).toBe(0o600);
    expect(mode(path.join(dataDir, 'agents'))).toBe(0o700);
    expect(mode(path.join(dataDir, 'agents', 'registry.md'))).toBe(0o600);
  });

  it('starts with no remote model configured and does not call fetch by default', async () => {
    const core = await openCore();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(core.getConfig().llm).toEqual({ provider: 'none', model: '' });

    await core.observe({
      actor: { type: 'person', id: 'user:owner', display_name: 'Owner' },
      type: 'decision',
      content: { format: 'text/plain', body: 'Deadline: 2026-09-01 for the beta.' },
      scope: 'personal',
    });
    await core.reflect({
      actor: { type: 'person', id: 'user:owner', display_name: 'Owner' },
      scope: 'personal',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never sends sensitive observations to a configured remote model', async () => {
    const core = await openCore();
    const config = core.getConfig();
    config.llm = { provider: 'openai', model: 'test-model' };
    saveConfig(config.data_dir, config);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await core.observe({
      actor: { type: 'person', id: 'user:owner', display_name: 'Owner' },
      type: 'decision',
      content: { format: 'text/plain', body: 'Private deadline: 2026-10-01.' },
      scope: 'personal',
      sensitive: true,
    });
    const reflected = await core.reflect({
      actor: { type: 'person', id: 'user:owner', display_name: 'Owner' },
      scope: 'personal',
      use_llm: true,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reflected.telemetry).toMatchObject({
      llm_extraction_attempted: 0,
      llm_extraction_failed: 0,
      llm_extraction_skipped_sensitive: 1,
      llm_synthesis_attempted: 0,
      llm_synthesis_failed: 0,
      llm_synthesis_skipped_sensitive: 1,
    });
  });

  it('falls back deterministically and reports remote model failures', async () => {
    const core = await openCore();
    const config = core.getConfig();
    config.llm = { provider: 'openai', model: 'test-model' };
    saveConfig(config.data_dir, config);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider unavailable'));

    await core.observe({
      actor: { type: 'person', id: 'user:owner', display_name: 'Owner' },
      type: 'decision',
      content: { format: 'text/plain', body: 'Release deadline: 2026-11-01.' },
      scope: 'personal',
    });
    const reflected = await core.reflect({
      actor: { type: 'person', id: 'user:owner', display_name: 'Owner' },
      scope: 'personal',
      use_llm: true,
    });

    expect(reflected.claims_created).toBeGreaterThan(0);
    expect(reflected.telemetry).toMatchObject({
      llm_extraction_attempted: 1,
      llm_extraction_failed: 1,
      llm_synthesis_attempted: 1,
      llm_synthesis_failed: 1,
    });
  });
});
