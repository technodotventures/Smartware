// Tests: Protocol — QUERY handler

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex } from '../../src/layer3/search.js';
import { ScopeRegistry } from '../../src/scopes/registry.js';
import { handleQuery } from '../../src/protocol/query.js';
import type { SmartwareConfig } from '../../src/config.js';
import type { CompiledPage } from '../../src/layer2/types.js';
import { ProtocolError } from '../../src/auth/middleware.js';
import { makeClaim } from '../helpers.js';

let tmpDir: string;
let store: ClaimStore;
let searchIndex: SearchIndex;
let config: SmartwareConfig;
let registry: ScopeRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-query-'));
  const dbPath = path.join(tmpDir, 'test.db');
  store = new ClaimStore(dbPath);
  searchIndex = new SearchIndex(dbPath);

  config = {
    instance_id: `smartware_${ulid()}`,
    owner_id: 'person_owner',
    writer_id: `writer_${ulid()}`,
    version: '0.5.1',
    data_dir: tmpDir,
    scopes: [
      { id: 'personal', parent: null, visibility_default: 'private' },
      { id: 'project/foo', parent: null, visibility_default: 'scope' },
    ],
    grants: [],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
  registry = new ScopeRegistry(config);

  // Index a test page. The page is built in the published vocabulary (spec §9 ==
  // `page-frontmatter.schema.json`), with the compile envelope in its own structure — the
  // frontmatter no longer carries `entity_id`/`compiled_at` (ADR-0013 → D2).
  const page: CompiledPage = {
    path: '/fake/path/alice.md',
    frontmatter: {
      title: 'Alice Johnson',
      page_id: 'page_alice-johnson',
      category: 'entity',
      author: 'agent',
      sources: [],
      supporting_claims: [],
      created: '2026-01-01',
      updated: '2026-01-01',
      scope: 'personal',
      confidence: 'high',
      epistemic_tag: 'inference',
      summary: 'Alice Johnson: senior engineer',
    },
    envelope: {
      compiled_at: '2024-01-01T00:00:00Z',
      compiled_by: 'test',
      entity_id: `entity_${ulid()}`,
      entity: 'Alice Johnson',
      type: 'person',
      sensitive: false,
      source_observation_ids: [],
      supersedes: [],
      related: [],
    },
    oneliner: 'Alice Johnson: senior engineer',
    paragraph: 'Alice Johnson is a senior engineer working on Smartware.',
    fullPage: '## Alice Johnson\n\nAlice Johnson is a senior engineer.',
    raw: '',
  };
  page.raw = `---\ntitle: Alice Johnson\npage_id: page_alice-johnson\ncategory: entity\nauthor: agent\n`
    + 'sources: []\nsupporting_claims: []\ncreated: 2026-01-01\nupdated: 2026-01-01\nscope: personal\n'
    + 'confidence: high\nepistemic_tag: inference\nsummary: "Alice Johnson: senior engineer"\n'
    + '---\n\nAlice Johnson is a senior engineer.\n';
  searchIndex.indexPage(page);
});

afterEach(() => {
  store.close();
  searchIndex.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleQuery', () => {
  it('owner can query and get results', async () => {
    const result = await handleQuery(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        query: 'Alice Johnson',
        scope: 'personal',
      },
      store, searchIndex, config, registry,
    );
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.entity_name).toBe('Alice Johnson');
    expect(result.results[0]!.signals.textRelevance).toBe(1);
  });

  it('returns empty results for non-matching query', async () => {
    const result = await handleQuery(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        query: 'completely unrelated xyz',
        scope: 'personal',
      },
      store, searchIndex, config, registry,
    );
    expect(result.results).toHaveLength(0);
  });

  it('throws on empty query', async () => {
    await expect(handleQuery(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        query: '',
        scope: 'personal',
      },
      store, searchIndex, config, registry,
    )).rejects.toThrow(ProtocolError);
  });

  it('filters superseded claims before applying the result limit', async () => {
    const suppressed = makeClaim({
      id: `claim_${ulid()}`,
      subject_name: 'Suppressed',
      object: { type: 'text', value: 'needle alpha needle alpha needle alpha' },
    });
    const current = makeClaim({
      id: `claim_${ulid()}`,
      subject_name: 'Current',
      object: { type: 'text', value: 'needle alpha' },
    });
    const suppressor = makeClaim({
      id: `claim_${ulid()}`,
      subject_name: 'Correction',
      object: { type: 'text', value: 'replacement content' },
      relations: [{
        relation_id: `rel_${ulid()}`,
        kind: 'supersedes',
        target: suppressed.id,
        valid_at: new Date().toISOString(),
        invalid_at: null,
        provenance: { origin: 'user' },
      }],
    });
    for (const claim of [suppressed, current, suppressor]) {
      store.insertEntity({
        id: claim.subject_id,
        canonical_name: claim.subject_name,
        aliases: [],
        type: 'concept',
        scope: claim.scope,
        created_at: new Date().toISOString(),
      });
    }
    store.insertClaim(suppressed);
    store.insertClaim(current);
    store.insertClaim(suppressor);
    searchIndex.replaceClaimIndex([suppressed, current, suppressor]);

    const result = await handleQuery(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        query: 'needle alpha',
        scope: 'personal',
        limit: 1,
      },
      store, searchIndex, config, registry,
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.claim?.id).toBe(current.id);
    expect(result.filtered_out).toBe(1);
  });

  it('applies valid-time constraints before ranking and supports time-only recall', async () => {
    store.insertEntity({
      id: 'entity_june',
      canonical_name: 'June decision',
      aliases: [],
      type: 'decision',
      scope: 'personal',
      created_at: '2026-06-10T00:00:00.000Z',
    });
    store.insertEntity({
      id: 'entity_july',
      canonical_name: 'July decision',
      aliases: [],
      type: 'decision',
      scope: 'personal',
      created_at: '2026-07-10T00:00:00.000Z',
    });
    store.insertClaim(makeClaim({
      id: 'claim_june',
      subject_id: 'entity_june',
      subject_name: 'June decision',
      scope: 'personal',
      object: { type: 'text', value: 'Ship the private beta' },
      validity: {
        from: '2026-06-10T00:00:00.000Z',
        to: '2026-06-11T00:00:00.000Z',
      },
      t_valid_from: { value: '2026-06-10T00:00:00.000Z', state: 'known' },
      t_valid_to: { value: '2026-06-11T00:00:00.000Z', state: 'known' },
    }));
    store.insertClaim(makeClaim({
      id: 'claim_july',
      subject_id: 'entity_july',
      subject_name: 'July decision',
      scope: 'personal',
      object: { type: 'text', value: 'Open the public beta' },
      validity: {
        from: '2026-07-10T00:00:00.000Z',
        to: '2026-07-11T00:00:00.000Z',
      },
      t_valid_from: { value: '2026-07-10T00:00:00.000Z', state: 'known' },
      t_valid_to: { value: '2026-07-11T00:00:00.000Z', state: 'known' },
    }));

    const result = await handleQuery(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        query: '',
        scope: 'personal',
        temporal: {
          mode: 'range',
          axis: 'valid_time',
          from: '2026-06-01T00:00:00.000Z',
          to: '2026-07-01T00:00:00.000Z',
        },
      },
      store, searchIndex, config, registry,
    );

    expect(result.results.map(item => item.claim?.id)).toEqual(['claim_june']);
    expect(result.results[0]?.claim).toMatchObject({
      valid_at: '2026-06-10T00:00:00.000Z',
      invalid_at: '2026-06-11T00:00:00.000Z',
    });
  });

  it('reconstructs transaction-time history from claims no longer in the active index', async () => {
    store.insertEntity({
      id: 'entity_plan',
      canonical_name: 'Launch plan',
      aliases: [],
      type: 'decision',
      scope: 'personal',
      created_at: '2026-06-01T00:00:00.000Z',
    });
    store.insertClaim(makeClaim({
      id: 'claim_private_beta',
      subject_id: 'entity_plan',
      subject_name: 'Launch plan',
      scope: 'personal',
      object: { type: 'text', value: 'Private beta in August' },
      status: 'superseded',
      t_ingested: { value: '2026-06-01T00:00:00.000Z', state: 'known' },
      t_invalidated: { value: '2026-07-15T00:00:00.000Z', state: 'known' },
    }));
    store.insertClaim(makeClaim({
      id: 'claim_public_beta',
      subject_id: 'entity_plan',
      subject_name: 'Launch plan',
      scope: 'personal',
      object: { type: 'text', value: 'Public beta in August' },
      t_ingested: { value: '2026-07-15T00:00:00.000Z', state: 'known' },
    }));

    const result = await handleQuery(
      {
        actor: { type: 'person', id: 'person_owner', display_name: 'Owner' },
        query: 'beta',
        scope: 'personal',
        temporal: {
          mode: 'as_of',
          axis: 'transaction_time',
          at: '2026-06-20T00:00:00.000Z',
        },
      },
      store, searchIndex, config, registry,
    );

    expect(result.results.map(item => item.claim?.id)).toEqual(['claim_private_beta']);
  });
});
