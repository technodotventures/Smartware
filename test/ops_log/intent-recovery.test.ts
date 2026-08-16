import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import type { SmartwareConfig } from '../../src/config.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { readAll } from '../../src/layer0/log.js';
import { readOperationIntent } from '../../src/ops_log/intent.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';
import { runRecovery } from '../../src/ops_log/recovery.js';
import { handleObserve } from '../../src/protocol/observe.js';

describe('operation-intent recovery', () => {
  let dataDir: string;
  let evidenceDir: string;
  let opsDir: string;
  let layer0: Layer0Index;
  let config: SmartwareConfig;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartware-intent-'));
    evidenceDir = path.join(dataDir, 'evidence');
    opsDir = path.join(dataDir, 'operations');
    fs.mkdirSync(evidenceDir, { recursive: true });
    config = {
      instance_id: `smartware_${ulid()}`,
      owner_id: 'user:owner',
      writer_id: `writer_${ulid()}`,
      version: '0.6.0',
      data_dir: dataDir,
      scopes: [{ id: 'workspace', parent: null, visibility_default: 'workspace' }],
      grants: [],
      llm: { provider: 'none', model: '' },
      staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
    };
    layer0 = new Layer0Index(path.join(dataDir, 'smartware.db'));
  });

  afterEach(() => {
    layer0.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('finalizes an exact L0 artifact after interruption without leaking content or duplicating the write', async () => {
    const operationId = `op_${ulid()}`;
    const content = 'Private recovery fixture content.';
    const params = {
      actor: { type: 'person' as const, id: 'user:owner', display_name: 'Owner' },
      type: 'message' as const,
      content: { format: 'text/plain' as const, body: content },
      scope: 'workspace',
      app: 'smartware-test',
      operation_id: operationId,
    };

    await expect(handleObserve(
      params,
      evidenceDir,
      layer0,
      config,
      undefined,
      opsDir,
      { afterObservation: () => { throw new Error('simulated interruption'); } },
    )).rejects.toThrow('simulated interruption');

    const intentPath = path.join(opsDir, 'intents', `${operationId}.json`);
    expect(fs.statSync(intentPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(intentPath, 'utf8')).not.toContain(content);
    const prepared = readOperationIntent(opsDir, operationId);
    expect(prepared?.op).toBe('observe');

    const recovery = runRecovery({
      opsDir,
      evidenceDir,
      quarantineDir: path.join(dataDir, 'quarantine'),
    });
    expect(recovery.completed).toEqual([operationId]);
    expect(recovery.requiresManualReview).toEqual([]);
    expect(readOperationIntent(opsDir, operationId)).toBeNull();

    const commits = [...readAllOpLogEntries(opsDir)]
      .filter(entry => entry.operation_id === operationId);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.details?.['recovered']).toBe(true);

    const replay = await handleObserve(params, evidenceDir, layer0, config, undefined, opsDir);
    expect(replay.id).toBe(prepared?.result.id);
    expect([...readAll(evidenceDir)]).toHaveLength(1);
    expect([...readAllOpLogEntries(opsDir)]
      .filter(entry => entry.operation_id === operationId)).toHaveLength(1);
  });
});
