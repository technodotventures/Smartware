import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SmartwareConfig } from '../src/config.js';
import { Layer0Index } from '../src/layer0/index.js';
import { ClaimStore } from '../src/layer1/store.js';
import { SearchIndex } from '../src/layer3/search.js';
import { handleObserve } from '../src/protocol/observe.js';
import { handleCompile } from '../src/protocol/compile.js';
import {
  deriveSessionCheckpointId,
  type SessionCheckpointV1,
  validateSessionCheckpoint,
} from '../src/session/checkpoint.js';

const OWNER = 'person_owner';
const SCOPE = 'project/checkpoints';

function checkpoint(overrides: Partial<SessionCheckpointV1> = {}): SessionCheckpointV1 {
  const sessionId = overrides.session_id ?? 'session_deploy_42';
  const trigger = overrides.trigger ?? 'pre_compaction';
  const generation = overrides.generation ?? 3;
  return {
    kind: 'session_checkpoint',
    version: 1,
    operation_id: overrides.operation_id ?? `op_${ulid()}`,
    checkpoint_id: overrides.checkpoint_id
      ?? deriveSessionCheckpointId(sessionId, trigger, generation),
    session_id: sessionId,
    scope: overrides.scope ?? SCOPE,
    trigger,
    generation,
    summary: overrides.summary ?? 'Database migration is staged but not applied.',
    decisions: overrides.decisions ?? ['Use the online migration path.'],
    open_loops: overrides.open_loops ?? ['Verify the replica lag before applying.'],
    source_digest: overrides.source_digest ?? `sha256:${'a'.repeat(64)}`,
  };
}

describe('session checkpoint v1', () => {
  let tmp: string;
  let evidenceDir: string;
  let wikiDir: string;
  let opsDir: string;
  let layer0: Layer0Index;
  let store: ClaimStore;
  let search: SearchIndex;
  let config: SmartwareConfig;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smartware-checkpoint-'));
    evidenceDir = path.join(tmp, 'evidence');
    wikiDir = path.join(tmp, 'wiki');
    opsDir = path.join(tmp, 'operations');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.mkdirSync(opsDir, { recursive: true });
    config = {
      instance_id: `smartware_${ulid()}`,
      owner_id: OWNER,
      writer_id: `writer_${ulid()}`,
      version: '0.6.0',
      data_dir: tmp,
      scopes: [{ id: SCOPE, parent: null, visibility_default: 'scope' }],
      grants: [],
      llm: { provider: 'none', model: '' },
      staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
    };
    const dbPath = path.join(tmp, 'smartware.db');
    layer0 = new Layer0Index(dbPath);
    store = new ClaimStore(dbPath);
    store.setDataDir(tmp);
    search = new SearchIndex(dbPath);
  });

  afterEach(() => {
    layer0.close();
    store.close();
    search.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('requires deterministic checkpoint identity and hard field bounds', () => {
    expect(validateSessionCheckpoint(checkpoint()).checkpoint_id).toMatch(/^checkpoint_[a-f0-9]{64}$/);

    expect(() => validateSessionCheckpoint(checkpoint({ checkpoint_id: 'checkpoint_random' })))
      .toThrow(/deterministically derived/);
    expect(() => validateSessionCheckpoint(checkpoint({ summary: 'x'.repeat(4_001) })))
      .toThrow(/summary exceeds/);
    expect(() => validateSessionCheckpoint(checkpoint({ decisions: Array(21).fill('decision') })))
      .toThrow(/decisions exceeds/);
  });

  it('uses normal OBSERVE idempotency and rejects a changed retry payload', async () => {
    const payload = checkpoint();
    const params = {
      actor: { type: 'person' as const, id: OWNER, display_name: 'Owner' },
      type: 'compaction' as const,
      scope: SCOPE,
      source_id: payload.checkpoint_id,
      operation_id: payload.operation_id,
      content: { format: 'application/json' as const, body: payload },
      app: 'checkpoint-test',
    };

    const first = await handleObserve(params, evidenceDir, layer0, config, undefined, opsDir);
    const retry = await handleObserve(params, evidenceDir, layer0, config, undefined, opsDir);
    expect(retry).toEqual(first);

    await expect(handleObserve(
      { ...params, content: { ...params.content, body: { ...payload, summary: 'Changed on retry.' } } },
      evidenceDir,
      layer0,
      config,
      undefined,
      opsDir,
    )).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reflects one typed checkpoint claim with complete L0 provenance', async () => {
    const payload = checkpoint();
    const observed = await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'compaction',
        scope: SCOPE,
        source_id: payload.checkpoint_id,
        operation_id: payload.operation_id,
        content: { format: 'application/json', body: payload },
        app: 'checkpoint-test',
      },
      evidenceDir,
      layer0,
      config,
      undefined,
      opsDir,
    );

    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: SCOPE },
      evidenceDir,
      wikiDir,
      layer0,
      store,
      search,
      config,
      tmp,
      { opsDir },
    );

    const claims = store.getAllClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      claim_type: 'checkpoint',
      claim_role: 'checkpoint',
      subject_name: payload.session_id,
      scope: SCOPE,
      supporting_evidence: [observed.id],
    });
    expect(claims[0]?.object).toMatchObject({
      type: 'any',
      value: { checkpoint_id: payload.checkpoint_id, open_loops: payload.open_loops },
    });
  });
});
