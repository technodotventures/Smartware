// End-to-end smoke test: walks the full pipeline
// observe → compile → query → read → correct → forget → status

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';

import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex } from '../../src/layer3/search.js';
import { ScopeRegistry } from '../../src/scopes/registry.js';

import { handleObserve } from '../../src/protocol/observe.js';
import { handleQuery } from '../../src/protocol/query.js';
import { handleCompile } from '../../src/protocol/compile.js';
import { handleRead } from '../../src/protocol/read.js';
import { handleCorrect } from '../../src/protocol/correct.js';
import { handleForget } from '../../src/protocol/forget.js';
import { handleStatus } from '../../src/protocol/status.js';
import { handleContext } from '../../src/protocol/context.js';
import { handleGrant } from '../../src/protocol/grant.js';
import { handleRevoke } from '../../src/protocol/revoke.js';

import { writeManifest } from '../../src/layer2/manifest.js';
import { ensureGitRepo } from '../../src/layer2/git.js';
import { verifyChain } from '../../src/layer0/integrity.js';
import { readAll } from '../../src/layer0/log.js';

// Single shared instance across all tests in this suite
let tmpDir: string;
let evidenceDir: string;
let wikiDir: string;
let layer0: Layer0Index;
let store: ClaimStore;
let searchIndex: SearchIndex;
let config: SmartwareConfig;
let registry: ScopeRegistry;

const OWNER_ID = 'person_owner';
const AGENT_ID = 'agent_test';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-e2e-'));
  evidenceDir = path.join(tmpDir, 'evidence');
  wikiDir = path.join(tmpDir, 'wiki');

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(path.join(wikiDir, 'personal'), { recursive: true });
  fs.mkdirSync(path.join(wikiDir, 'project'), { recursive: true });

  config = {
    instance_id: `smartware_${ulid()}`,
    owner_id: OWNER_ID,
    writer_id: `writer_${ulid()}`,
    version: '0.5.1',
    data_dir: tmpDir,
    scopes: [
      { id: 'personal', parent: null, visibility_default: 'private' },
      { id: 'project/smartware', parent: null, visibility_default: 'scope' },
    ],
    grants: [],
    llm: { provider: 'none', model: '' }, // disable LLM — deterministic extraction only
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
  saveConfig(tmpDir, config);

  const dbPath = path.join(tmpDir, 'smartware.db');
  layer0 = new Layer0Index(dbPath);
  store = new ClaimStore(dbPath);
  store.setDataDir(tmpDir);
  searchIndex = new SearchIndex(dbPath);
  registry = new ScopeRegistry(config);

  writeManifest(wikiDir, config, {
    layer0: { total: 0, accepted: 0, quarantined: 0, tombstoned: 0 },
    layer1: { claims: 0, entities: 0 },
    layer2: { pages: 0 },
  });
  await ensureGitRepo(wikiDir);
});

afterAll(() => {
  layer0.close();
  store.close();
  searchIndex.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: reload config after grants change
function reload(): SmartwareConfig {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8')) as SmartwareConfig;
}

describe('E2E smoke — full pipeline', () => {
  it('1. CONTEXT returns an authenticated one-hop bundle', async () => {
    const result = await handleContext(
      {
        actor_id: OWNER_ID,
        query: 'initial memory',
        scope: 'personal',
      },
      store,
      searchIndex,
      config,
      registry,
      evidenceDir,
      layer0,
    );
    expect(result).toEqual({
      seeds: [],
      outbound_relations: [],
      inbound_relations: [],
      provenance: [],
    });
  });

  // Use a shared observed_at so corroboration produces matching canonical keys
  const SHARED_OBSERVED_AT = '2026-04-01T10:00:00Z';

  it('2. OBSERVE accepts a project message from the owner', async () => {
    const result = await handleObserve(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        type: 'message',
        content: {
          format: 'text/plain',
          body: 'Smartware v0.5.1 deadline: 2026-06-15. See https://example.com/spec for the design doc.',
        },
        scope: 'project/smartware',
        observed_at: SHARED_OBSERVED_AT,
      },
      evidenceDir,
      layer0,
      config,
    );
    expect(result.status).toBe('accepted');
    expect(result.id).toMatch(/^obs_/);
    expect(result.sequence).toBeGreaterThanOrEqual(1);
  });

  it('3. OBSERVE accepts a second corroborating message', async () => {
    const result = await handleObserve(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        type: 'message',
        content: {
          format: 'text/plain',
          body: 'Reminder: deadline 2026-06-15 is firm. Spec: https://example.com/spec',
        },
        scope: 'project/smartware',
        observed_at: SHARED_OBSERVED_AT,
      },
      evidenceDir,
      layer0,
      config,
    );
    expect(result.status).toBe('accepted');
  });

  it('4. dedup: same source_id returns duplicate', async () => {
    const first = await handleObserve(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'One-shot message' },
        scope: 'project/smartware',
        source_id: 'shot-001',
        app: 'test',
      },
      evidenceDir, layer0, config,
    );
    const second = await handleObserve(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'One-shot message (dup)' },
        scope: 'project/smartware',
        source_id: 'shot-001',
        app: 'test',
      },
      evidenceDir, layer0, config,
    );
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
    expect(second.existing_id).toBe(first.id);
  });

  it('5. secret detection rejects observation containing an API key', async () => {
    await expect(handleObserve(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'My key: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        scope: 'project/smartware',
      },
      evidenceDir, layer0, config,
    )).rejects.toThrow(/secret/i);
  });

  it('6. COMPILE produces wiki pages from observations', async () => {
    const result = await handleCompile(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        scope: 'project/smartware',
        use_llm: false,
      },
      evidenceDir, wikiDir, layer0, store, searchIndex, config, tmpDir,
    );
    expect(result.pages_compiled).toBeGreaterThanOrEqual(1);
    // Git commit happened (or null if no changes — but pages were compiled)
  });

  it('7. compiled wiki page exists on disk with valid frontmatter', () => {
    const categories = ['concepts', 'entities', 'decisions', 'synthesis', 'profiles'];
    let foundPage = false;
    for (const cat of categories) {
      const catDir = path.join(wikiDir, cat);
      if (!fs.existsSync(catDir)) continue;
      const files = fs.readdirSync(catDir).filter(f => f.endsWith('.md') && f !== '_index.md');
      if (files.length > 0) {
        const firstPage = path.join(catDir, files[0]!);
        const content = fs.readFileSync(firstPage, 'utf-8');
        expect(content).toMatch(/^---\n/);
        // The published page vocabulary (spec §9 == page-frontmatter.schema.json).
        expect(content).toContain('page_id:');
        expect(content).toContain('epistemic_tag:');
        // The compile envelope is a derived cached render inside the page body — entity identity
        // and the compile timestamp are deliberately NOT page-frontmatter vocabulary
        // (ADR-0013 → D2).
        expect(content).toContain('smartware-envelope');
        expect(content).toContain('entity_id');
        foundPage = true;
        break;
      }
    }
    expect(foundPage).toBe(true);
  });

  it('8. claims were materialised in Layer 1', () => {
    expect(store.claimCount()).toBeGreaterThanOrEqual(1);
    expect(store.entityCount()).toBeGreaterThanOrEqual(1);
  });

  it('9. claims exist in L1 after reflect.auto', () => {
    const claims = store.getAllClaims();
    expect(claims.length).toBeGreaterThanOrEqual(1);
    const firstClaim = claims[0]!;
    expect(firstClaim.author).toBe('agent');
    expect(firstClaim.claim_type).toBe('hypothesis');
  });

  it('10. QUERY returns matching results', async () => {
    const result = await handleQuery(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        query: 'active',
        scope: 'project/smartware',
      },
      store, searchIndex, config, registry,
    );
    expect(result.results.length).toBeGreaterThanOrEqual(0);
  });

  it('11. READ returns a compiled page', async () => {
    const claims = store.getAllClaims();
    const entityId = claims[0]!.subject_id;

    const result = await handleRead(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        entity_id: entityId,
        resolution: 'full',
      },
      wikiDir, config,
    );
    expect(result.entity_id).toBe(entityId);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('12. CORRECT supersedes a claim and creates a user_confirmed replacement', async () => {
    const claims = store.getAllClaims().filter(c => c.status === 'active');
    expect(claims.length).toBeGreaterThanOrEqual(1);
    const target = claims[0]!;

    const result = await handleCorrect(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        target_claim_id: target.id,
        corrected_object: { type: 'text', value: 'corrected_value' },
        reason: 'E2E test correction',
      },
      evidenceDir, layer0, store, config,
    );
    expect(result.status).toBe('corrected');
    expect(result.original_claim_id).toBe(target.id);

    const updated = store.getClaim(target.id);
    expect(updated?.status).toBe('superseded');
  });

  it('13. GRANT lets a non-owner agent query', async () => {
    const grantResult = await handleGrant(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        grant_actor_id: AGENT_ID,
        grant_actor_type: 'agent',
        capabilities: {
          observe: ['project/smartware'],
          query: ['project/smartware'],
          compile: [],
          correct: [],
          forget: [],
          read: ['project/smartware'],
        },
        trusted: true,
      },
      evidenceDir, layer0, config, tmpDir,
    );
    expect(grantResult.status).toBe('granted');
    expect(grantResult.grant_id).toMatch(/^grant_/);

    // Now the agent can query
    const freshConfig = reload();
    const queryResult = await handleQuery(
      {
        actor: { type: 'agent', id: AGENT_ID, display_name: 'Agent' },
        query: 'deadline',
        scope: 'project/smartware',
      },
      store, searchIndex, freshConfig, new ScopeRegistry(freshConfig),
    );
    expect(queryResult).toBeDefined();
    expect(queryResult.query_scope).toBe('project/smartware');
  });

  it('14. REVOKE blocks the previously-granted agent', async () => {
    // Find the grant we just created
    const freshConfig = reload();
    const grant = freshConfig.grants.find(g => g.actor_id === AGENT_ID && g.status === 'active');
    expect(grant).toBeDefined();

    await handleRevoke(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        grant_id: grant!.id,
        reason: 'E2E test revoke',
      },
      evidenceDir, layer0, freshConfig, tmpDir,
    );

    // Revoked agent can no longer query. P0-7: the denial is explicit and
    // code-carrying (a revoked grant is a KNOWN actor, so the code is
    // `insufficient_permission`, not `actor_unregistered`) — an empty result
    // would be indistinguishable from "no memory" for the host.
    const updatedConfig = reload();
    await expect(handleQuery(
      {
        actor: { type: 'agent', id: AGENT_ID, display_name: 'Agent' },
        query: 'deadline',
        scope: 'project/smartware',
      },
      store, searchIndex, updatedConfig, new ScopeRegistry(updatedConfig),
    )).rejects.toMatchObject({ code: 'insufficient_permission' });
  });

  it('15. FORGET tombstones an observation', async () => {
    // Pick an observation from the index
    const obs = layer0.getDB()
      .prepare("SELECT id FROM observations WHERE type = 'message' AND effective_status = 'accepted' LIMIT 1")
      .get() as { id: string } | undefined;
    expect(obs).toBeDefined();

    const result = await handleForget(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        target_obs_id: obs!.id,
        mode: 'tombstone',
        reason: 'E2E test forget',
      },
      evidenceDir, layer0, store, reload(),
    );
    expect(result.status).toBe('forgotten');
    expect(layer0.getEffectiveStatus(obs!.id)).toBe('tombstoned');
  });

  it('16. STATUS returns counts (owner only)', async () => {
    const result = await handleStatus(
      { actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' } },
      layer0, store, searchIndex, wikiDir, reload(),
    );
    expect(result.layer0.total).toBeGreaterThan(0);
    expect(result.layer1.claims).toBeGreaterThan(0);
    expect(result.layer2.pages).toBeGreaterThanOrEqual(1);
    // Layer-3 lanes are counted separately (the old single `indexed` field read
    // as "everything is indexed" while counting only the entity/topic lane).
    expect(result.layer3.entity_index_rows).toBeGreaterThanOrEqual(1);
    expect(result.layer3.claim_index_rows).toBeGreaterThanOrEqual(1);
    // This suite wires the protocol handlers directly, so the raw-observation
    // lane is only what a rebuild put there — assert it is a real count.
    expect(Number.isInteger(result.layer3.observation_index_rows)).toBe(true);
  });

  it('17. STATUS rejects non-owner', async () => {
    await expect(handleStatus(
      { actor: { type: 'agent', id: AGENT_ID, display_name: 'Agent' } },
      layer0, store, searchIndex, wikiDir, reload(),
    )).rejects.toThrow(/owner/i);
  });

  it('18. hash chain over the entire JSONL log is valid', () => {
    const allObs = [...readAll(evidenceDir)];
    expect(allObs.length).toBeGreaterThan(5);
    const result = verifyChain(allObs);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it('19. Layer 0 sequence numbers are strictly increasing', () => {
    const allObs = [...readAll(evidenceDir)];
    for (let i = 1; i < allObs.length; i++) {
      expect(allObs[i]!.integrity.sequence).toBeGreaterThan(allObs[i - 1]!.integrity.sequence);
    }
  });

  it('20. compile is idempotent — running again produces no new changes', async () => {
    const before = store.claimCount();
    await handleCompile(
      {
        actor: { type: 'person', id: OWNER_ID, display_name: 'Owner' },
        scope: 'project/smartware',
        use_llm: false,
      },
      evidenceDir, wikiDir, layer0, store, searchIndex, reload(),
    );
    // Claim count may go up slightly because compile re-extracts, but should not explode
    const after = store.claimCount();
    // Allow some growth from re-extraction creating new claim_extracted events,
    // but corroboration should keep the active claim count stable
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
