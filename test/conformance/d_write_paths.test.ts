// Conformance Suite D — Write-Path Ownership (§4.3)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex } from '../../src/layer3/search.js';
import { handleObserve } from '../../src/protocol/observe.js';
import { handleCompile } from '../../src/protocol/reflect.js';
import { handleRevise } from '../../src/protocol/revise.js';
import { ProtocolError } from '../../src/auth/middleware.js';
import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';
import { extractDeterministic } from '../../src/extraction/deterministic.js';
import {
  appendClaimVersion,
  iterAllClaimVersions,
  readLatestVersion,
  type ActiveClaimVersion,
} from '../../src/layer1/jsonl.js';
import { computeFingerprint } from '../../src/layer1/fingerprint.js';

let tmpDir: string;
let evidenceDir: string;
let wikiDir: string;
let layer0: Layer0Index;
let store: ClaimStore;
let search: SearchIndex;
let config: SmartwareConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-wp-'));
  evidenceDir = path.join(tmpDir, 'evidence');
  wikiDir = path.join(tmpDir, 'wiki');
  fs.mkdirSync(evidenceDir);
  for (const category of ['concepts', 'entities', 'decisions', 'synthesis', 'tombstones', 'profiles']) {
    fs.mkdirSync(path.join(wikiDir, category), { recursive: true });
  }

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
  store.setDataDir(tmpDir);
  search = new SearchIndex(dbPath);
});

afterEach(() => {
  layer0.close();
  store.close();
  search.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedAgentClaim(): ActiveClaimVersion {
  const now = new Date().toISOString();
  const claim: ActiveClaimVersion = {
    claim_id: `claim_${ulid()}`,
    version: 1,
    state: 'active',
    content: 'The release requires final approval',
    claim_type: 'hypothesis',
    claim_role: 'memory',
    author: 'agent',
    epistemic_owner: 'agent',
    fingerprint: computeFingerprint(
      'The release requires final approval',
      'personal',
      'hypothesis',
    ),
    confidence: 'low',
    epistemic_tag: 'inference',
    scope: 'personal',
    derived_from: [`obs_${ulid()}`],
    relations: [],
    created_at: now,
    version_at: now,
    operation_id: `op_${ulid()}`,
    actor_id: 'substrate:test',
    tags: [],
  };
  appendClaimVersion(tmpDir, claim);
  store.syncFromJsonlVersion(claim);
  return claim;
}

describe('Write-Path Ownership', () => {
  it('D1: observe_writes_L0_only', async () => {
    const claimCountBefore = store.claimCount();
    await handleObserve(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Test observation' },
        scope: 'personal',
      },
      evidenceDir, layer0, config,
    );
    expect(store.claimCount()).toBe(claimCountBefore);
    expect(layer0.totalCount()).toBeGreaterThan(0);
  });

  it('D2: observe_rejects_claims_parameter', async () => {
    await expect(handleObserve(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Test' },
        scope: 'personal',
        claims: [{ subject_name: 'Test', predicate: 'status_is', object: { type: 'text', value: 'active' }, scope: 'personal', validity: { from: new Date().toISOString(), to: null }, sensitive: false, extraction: { method: 'deterministic', model: null, compiler_version: '0.5.1', prompt_hash: null }, epistemic: 'observed', confidence: 0.9 }],
      },
      evidenceDir, layer0, config,
    )).rejects.toThrow(ProtocolError);
  });

  it('D3: reflect_auto_is_sole_autonomous_L1_creator', async () => {
    await handleObserve(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Deadline: 2026-09-01.' },
        scope: 'personal',
      },
      evidenceDir,
      layer0,
      config,
    );
    expect(store.claimCount()).toBe(0);

    await handleCompile(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        scope: 'personal',
        use_llm: false,
      },
      evidenceDir,
      wikiDir,
      layer0,
      store,
      search,
      config,
      tmpDir,
    );
    const versions = [...iterAllClaimVersions(tmpDir)];
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every(version =>
      version.author === 'agent'
      && version.epistemic_owner === 'agent'
      && version.confidence === 'low'
      && version.epistemic_tag === 'inference')).toBe(true);
  });

  it('D4: extraction_outputs_have_no_canonical_write_authority', () => {
    const extracted = extractDeterministic(
      'See https://example.com. Deadline: 2026-09-01.',
      'personal',
      'Release',
      new Date().toISOString(),
    );
    expect(store.claimCount()).toBe(0);
    expect(extracted.relation_proposals).toEqual([
      expect.objectContaining({
        kind: 'references',
        origin: 'deterministic',
        rule_id: 'url_mention',
      }),
    ]);
    expect(extracted.claims.every(claim => !('claim_id' in claim))).toBe(true);
  });

  it('D5: revise_creates_user_epistemic_admission', async () => {
    const claim = seedAgentClaim();
    await handleRevise(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        target: claim.claim_id,
        expected_base_version: 1,
        set_confidence: 'high',
        reason: 'Verified',
        operation_id: `op_${ulid()}`,
      },
      tmpDir,
      store,
      config,
    );
    expect(readLatestVersion(tmpDir, claim.claim_id)).toMatchObject({
      author: 'agent',
      epistemic_owner: 'user',
      confidence: 'high',
    });
  });

  it('D6: revise_adopt_body_sets_author_user', async () => {
    const claim = seedAgentClaim();
    await handleRevise(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        target: claim.claim_id,
        expected_base_version: 1,
        adopt_body: true,
        reason: 'Adopted',
        operation_id: `op_${ulid()}`,
      },
      tmpDir,
      store,
      config,
    );
    expect(readLatestVersion(tmpDir, claim.claim_id)).toMatchObject({
      author: 'user',
      epistemic_owner: 'user',
    });
  });

  it('D7: revise_optimistic_concurrency', async () => {
    const claim = seedAgentClaim();
    await expect(handleRevise(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        target: claim.claim_id,
        expected_base_version: 0,
        set_confidence: 'high',
        reason: 'Stale write',
        operation_id: `op_${ulid()}`,
      },
      tmpDir,
      store,
      config,
    )).rejects.toMatchObject({ code: 'conflict' });
  });

  it('D8: revise_add_derived_from_requires_protection', async () => {
    const claim = seedAgentClaim();
    await expect(handleRevise(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        target: claim.claim_id,
        expected_base_version: 1,
        add_derived_from: [`obs_${ulid()}`],
        reason: 'Unsupported corroboration',
        operation_id: `op_${ulid()}`,
      },
      tmpDir,
      store,
      config,
    )).rejects.toMatchObject({ code: 'invalid_add_derived_from' });
  });
});
