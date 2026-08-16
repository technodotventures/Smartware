// E2E Lifecycle — Full epistemic lifecycle through real handlers
// OBSERVE → reflect.auto → RECALL → REVISE → FORGET → REVIVE

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';

import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex } from '../../src/layer3/search.js';
import { ScopeRegistry } from '../../src/scopes/registry.js';
import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';

import { handleObserve } from '../../src/protocol/observe.js';
import { handleCompile, type CompileHandlerResult } from '../../src/protocol/reflect.js';
import { handleRevise, type ReviseResult } from '../../src/protocol/revise.js';
import { handleForget, handleRevive } from '../../src/protocol/forget.js';
import { iterAllClaimVersions, type ActiveClaimVersion } from '../../src/layer1/jsonl.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';

let tmpDir: string;
let evidenceDir: string;
let wikiDir: string;
let layer0: Layer0Index;
let store: ClaimStore;
let searchIndex: SearchIndex;
let config: SmartwareConfig;
let registry: ScopeRegistry;

const OWNER = 'person_owner';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-e2e-lifecycle-'));
  evidenceDir = path.join(tmpDir, 'evidence');
  wikiDir = path.join(tmpDir, 'wiki');
  fs.mkdirSync(evidenceDir, { recursive: true });
  for (const cat of ['concepts', 'entities', 'decisions', 'synthesis', 'tombstones', 'profiles']) {
    fs.mkdirSync(path.join(wikiDir, cat), { recursive: true });
  }

  config = {
    instance_id: `smartware_${ulid()}`,
    owner_id: OWNER,
    writer_id: `writer_${ulid()}`,
    version: '0.6.0',
    data_dir: tmpDir,
    scopes: [
      { id: 'personal', parent: null, visibility_default: 'private' },
      { id: 'project/test', parent: null, visibility_default: 'scope' },
    ],
    grants: [],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
  saveConfig(tmpDir, config);

  const dbPath = path.join(tmpDir, 'test.db');
  layer0 = new Layer0Index(dbPath);
  store = new ClaimStore(dbPath);
  store.setDataDir(tmpDir);
  searchIndex = new SearchIndex(dbPath);
  registry = new ScopeRegistry(config);
});

afterEach(() => {
  layer0.close();
  store.close();
  searchIndex.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('E2E Epistemic Lifecycle', () => {
  it('OBSERVE → reflect.auto → RECALL → REVISE → FORGET → REVIVE', async () => {
    // Step 1: OBSERVE — write to L0 only
    const obsResult = await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Deadline: 2026-09-01. Status: active. The project is running smoothly.' },
        scope: 'project/test',
      },
      evidenceDir, layer0, config,
    );
    expect(obsResult.status).toBe('accepted');
    expect(store.claimCount()).toBe(0);

    // Step 2: reflect.auto — creates bounded hypotheses in L1
    const compileResult = await handleCompile(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        scope: 'project/test',
        use_llm: false,
      },
      evidenceDir, wikiDir, layer0, store, searchIndex, config,
      tmpDir,
    );

    // Check that reflect.auto created claims in canonical JSONL
    const claimVersions = [...iterAllClaimVersions(tmpDir)];
    expect(claimVersions.length).toBeGreaterThan(0);

    // All auto-created claims should be bounded hypotheses
    for (const v of claimVersions) {
      expect(v.author).toBe('agent');
      expect(v.epistemic_owner).toBe('agent');
      expect(v.confidence).toBe('low');
      expect(v.epistemic_tag).toBe('inference');
      expect(v.claim_type).toBe('hypothesis');
      expect(v.fingerprint).toMatch(/^fp_/);
    }

    // Step 3: REVISE — user elevates a hypothesis
    const firstClaim = claimVersions[0]!;
    const reviseResult = await handleRevise(
      {
        actor: { type: 'person', id: `${OWNER}`, display_name: 'Owner' },
        target: firstClaim.claim_id,
        expected_base_version: firstClaim.version,
        set_confidence: 'high',
        set_epistemic_tag: 'fact',
        adopt_body: true,
        reason: 'Verified by user',
        operation_id: `op_${ulid()}`,
      },
      tmpDir, store, config,
    );

    expect(reviseResult.status).toBe('revised');
    expect(reviseResult.epistemic_owner).toBe('user');

    // Verify the revised version in JSONL
    const revisedVersions = [...iterAllClaimVersions(tmpDir)]
      .filter(v => v.claim_id === firstClaim.claim_id)
      .sort((a, b) => a.version - b.version);
    const latestRevised = revisedVersions[revisedVersions.length - 1]!;
    expect(latestRevised.author).toBe('user');
    expect(latestRevised.epistemic_owner).toBe('user');
    expect(latestRevised.confidence).toBe('high');
    expect(latestRevised.epistemic_tag).toBe('fact');
    expect(latestRevised.fingerprint).toBe(firstClaim.fingerprint);

    // Step 4: FORGET — tombstone the claim
    await handleForget(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        target: { type: 'claim', id: firstClaim.claim_id },
        mode: 'tombstone',
        reason: 'No longer relevant',
      },
      evidenceDir, layer0, store, config,
    );

    const afterForget = [...iterAllClaimVersions(tmpDir)]
      .filter(v => v.claim_id === firstClaim.claim_id)
      .sort((a, b) => a.version - b.version);
    const forgottenVersion = afterForget[afterForget.length - 1]!;
    expect(forgottenVersion.state).toBe('forgotten');

    // Step 5: REVIVE — restore from tombstone
    const tombstoneId = `tomb_${firstClaim.claim_id.slice(6)}`;
    const reviveResult = await handleRevive(
      {
        actor: { type: 'person', id: `${OWNER}`, display_name: 'Owner' },
        tombstone_id: tombstoneId,
        reason: 'Still relevant after all',
        operation_id: `op_${ulid()}`,
      },
      tmpDir, store, config,
    );

    expect(reviveResult.status).toBe('revived');

    const afterRevive = [...iterAllClaimVersions(tmpDir)]
      .filter(v => v.claim_id === firstClaim.claim_id)
      .sort((a, b) => a.version - b.version);
    const revivedVersion = afterRevive[afterRevive.length - 1]! as ActiveClaimVersion;
    expect(revivedVersion.state).toBe('active');
    expect(revivedVersion.author).toBe('user');
    expect(revivedVersion.epistemic_owner).toBe('user');
    expect(revivedVersion.confidence).toBe('high');
    expect(revivedVersion.fingerprint).toBe(firstClaim.fingerprint);
    expect(revivedVersion.revived_via).toBe(tombstoneId);
  });
});
