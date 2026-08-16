import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Ajv2020, { type AnySchema } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex } from '../../src/layer3/search.js';
import { ScopeRegistry } from '../../src/scopes/registry.js';
import { handleObserve } from '../../src/protocol/observe.js';
import { handleContext } from '../../src/protocol/context.js';
import { makeClaim } from '../helpers.js';

let tmpDir: string;
let evidenceDir: string;
let layer0: Layer0Index;
let store: ClaimStore;
let searchIndex: SearchIndex;
let config: SmartwareConfig;
let registry: ScopeRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-context-'));
  evidenceDir = path.join(tmpDir, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  config = {
    instance_id: `smartware_${ulid()}`,
    owner_id: 'user:owner',
    writer_id: `writer_${ulid()}`,
    version: '0.6.0',
    data_dir: tmpDir,
    scopes: [{ id: 'workspace', parent: null, visibility_default: 'workspace' }],
    grants: [],
    llm: { provider: 'none', model: '' },
    staleness: {
      default_half_life_days: 90,
      scope_overrides: {},
      stale_threshold: 0.3,
    },
  };
  saveConfig(tmpDir, config);
  const dbPath = path.join(tmpDir, 'smartware.db');
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

function contextValidator() {
  const schemaDir = path.join(process.cwd(), 'schemas', 'v0.4.2');
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  addFormats(ajv);
  for (const file of fs.readdirSync(schemaDir).filter(name => name.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(
      fs.readFileSync(path.join(schemaDir, file), 'utf8'),
    ) as AnySchema);
  }
  const validate = ajv.getSchema(
    'https://smartware.dev/schemas/v0.4.2/context-bundle.schema.json',
  );
  assert.ok(validate);
  return validate;
}

describe('CONTEXT conformance', () => {
  it('returns schema-valid provenance and resolves pinned relation versions', async () => {
    const observation = await handleObserve(
      {
        actor: { type: 'person', id: 'user:owner', display_name: 'Owner' },
        type: 'decision',
        content: { format: 'text/plain', body: 'Source memory references the original target.' },
        scope: 'workspace',
        observed_at: '2026-07-24T00:00:00.000Z',
      },
      evidenceDir,
      layer0,
      config,
    );
    const target = makeClaim({
      id: `claim_${ulid()}`,
      subject_name: 'Target',
      object: { type: 'text', value: 'target original' },
      scope: 'workspace',
      supporting_evidence: [observation.id],
      confidence: 0.9,
      claim_type: 'decision',
      author: 'user',
      epistemic_owner: 'user',
      version_at: '2026-07-24T00:00:00.000Z',
      created_at: '2026-07-24T00:00:00.000Z',
    });
    const source = makeClaim({
      id: `claim_${ulid()}`,
      subject_name: 'Source',
      object: { type: 'text', value: 'source memory needle' },
      scope: 'workspace',
      supporting_evidence: [observation.id],
      confidence: 0.9,
      claim_type: 'decision',
      author: 'user',
      epistemic_owner: 'user',
      version_at: '2026-07-24T00:00:00.000Z',
      created_at: '2026-07-24T00:00:00.000Z',
      relations: [{
        relation_id: `rel_${ulid()}`,
        kind: 'references',
        target: target.id,
        valid_at: '2026-07-24T00:00:00.000Z',
        invalid_at: null,
        provenance: {
          origin: 'user',
          asserted_in_source_version: 1,
          target_claim_version: 1,
          observation_ids: [observation.id],
        },
      }],
    });
    for (const claim of [target, source]) {
      store.insertEntity({
        id: claim.subject_id,
        canonical_name: claim.subject_name,
        aliases: [],
        type: 'concept',
        scope: claim.scope,
        created_at: claim.created_at!,
      });
    }
    store.insertClaim(target);
    store.insertClaim({
      ...target,
      object: { type: 'text', value: 'target current' },
      version_at: '2026-07-25T00:00:00.000Z',
    });
    store.insertClaim(source);
    searchIndex.replaceClaimIndex(store.getActiveClaims('workspace'), 'workspace');

    const result = await handleContext(
      {
        actor_id: 'user:owner',
        query: 'source memory needle',
        scope: 'workspace',
        limit: 1,
      },
      store,
      searchIndex,
      config,
      registry,
      evidenceDir,
      layer0,
    );

    expect(result.seeds[0]?.claim_id).toBe(source.id);
    expect(result.outbound_relations).toHaveLength(1);
    expect(result.outbound_relations[0]?.target_claim).toMatchObject({
      claim_id: target.id,
      version: 1,
      content: 'target original',
    });
    expect(result.outbound_relations[0]?.target_current).toMatchObject({
      version: 2,
      state: 'active',
    });
    expect(result.provenance).toEqual([
      expect.objectContaining({ observation_id: observation.id }),
    ]);

    const validate = contextValidator();
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });
});
