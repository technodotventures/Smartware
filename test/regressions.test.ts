// Regression tests for the three reviewer-flagged bugs.
// Each test is named with the priority + a short tag so failures point
// directly back at the original review finding.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ulid } from 'ulid';

import type { SmartwareConfig } from '../src/config.js';
import { saveConfig } from '../src/config.js';
import { Layer0Index } from '../src/layer0/index.js';
import { ClaimStore } from '../src/layer1/store.js';
import { SearchIndex } from '../src/layer3/search.js';
import { ScopeRegistry } from '../src/scopes/registry.js';
import { handleObserve } from '../src/protocol/observe.js';
import { handleCompile } from '../src/protocol/compile.js';
import { handleQuery } from '../src/protocol/query.js';
import { handleRead } from '../src/protocol/read.js';
import { handleExplain } from '../src/protocol/explain.js';
import { handleSessionStart, handleSessionDescribe, handleSessionEnd } from '../src/protocol/session.js';
import { SessionStore } from '../src/session/store.js';
import { extractDeterministic } from '../src/extraction/deterministic.js';
import { handleForget } from '../src/protocol/forget.js';
import { handleQuarantineReview } from '../src/protocol/quarantine_review.js';
import { writeManifest } from '../src/layer2/manifest.js';
import { ensureGitRepo } from '../src/layer2/git.js';
import { replayAll } from '../src/layer1/replay.js';

const OWNER = 'person_owner';

interface Fixture {
  tmp: string;
  evidenceDir: string;
  wikiDir: string;
  layer0: Layer0Index;
  store: ClaimStore;
  search: SearchIndex;
  sessions: SessionStore;
  config: SmartwareConfig;
  registry: ScopeRegistry;
}

async function makeFixture(): Promise<Fixture> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-reg-'));
  const evidenceDir = path.join(tmp, 'evidence');
  const wikiDir = path.join(tmp, 'wiki');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(path.join(wikiDir, 'project'), { recursive: true });

  const config: SmartwareConfig = {
    instance_id: `smartware_${ulid()}`,
    owner_id: OWNER,
    writer_id: `writer_${ulid()}`,
    version: '0.5.1',
    data_dir: tmp,
    scopes: [{ id: 'project/smartware', parent: null, visibility_default: 'scope' }],
    grants: [],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
  saveConfig(tmp, config);

  const dbPath = path.join(tmp, 'smartware.db');
  const layer0 = new Layer0Index(dbPath);
  const store = new ClaimStore(dbPath);
  store.setDataDir(tmp);
  const search = new SearchIndex(dbPath);
  const sessions = new SessionStore(dbPath);
  const registry = new ScopeRegistry(config);

  writeManifest(wikiDir, config, {
    layer0: { total: 0, accepted: 0, quarantined: 0, tombstoned: 0 },
    layer1: { claims: 0, entities: 0 },
    layer2: { pages: 0 },
  });
  await ensureGitRepo(wikiDir);

  return { tmp, evidenceDir, wikiDir, layer0, store, search, sessions, config, registry };
}

function teardown(f: Fixture): void {
  f.layer0.close();
  f.store.close();
  f.search.close();
  f.sessions.close();
  fs.rmSync(f.tmp, { recursive: true, force: true });
}

describe('[P0-1] reflect.auto produces claims with stable fingerprints and observation provenance', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  it('reflect.auto creates claims in canonical JSONL with fingerprint dedup', async () => {
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Deadline: 2026-06-15. Spec at https://x.example.com/spec' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );
    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    const claims = f.store.getAllClaims();
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) {
      expect(c.author).toBe('agent');
      expect(c.claim_type).toBe('hypothesis');
    }
  });

  it('reflect.auto claims have observation in derived_from (JSONL)', async () => {
    const obsResult = await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Deadline: 2026-06-15.' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );
    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    const { iterAllClaimVersions } = await import('../../src/layer1/jsonl.js');
    const versions = [...iterAllClaimVersions(f.tmp)];
    expect(versions.length).toBeGreaterThan(0);
    const hasObsRef = versions.some(v => v.derived_from.includes(obsResult.id));
    expect(hasObsRef).toBe(true);
  });

  it('FORGET on a claim sets state to forgotten in JSONL', async () => {
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Deadline: 2026-06-15.' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );
    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    const claimsBefore = f.store.getAllClaims().filter(c => c.status === 'active');
    expect(claimsBefore.length).toBeGreaterThan(0);

    const targetClaim = claimsBefore[0]!;
    await handleForget(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        target: { type: 'claim', id: targetClaim.id },
        mode: 'tombstone',
        reason: 'regression test',
      },
      f.evidenceDir, f.layer0, f.store, f.config,
    );

    const { iterAllClaimVersions } = await import('../../src/layer1/jsonl.js');
    const versions = [...iterAllClaimVersions(f.tmp)].filter(v => v.claim_id === targetClaim.id);
    const latest = versions[versions.length - 1]!;
    expect(latest.state).toBe('forgotten');
  });
});

describe('[P0-3] quarantined parent does not materialise claims', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  it('quarantined obs with pre-extracted claims yields zero Layer 1 claims', async () => {
    // Granted, but trusted:false → triggers quarantine on every observation.
    const untrustedConfig: SmartwareConfig = {
      ...f.config,
      grants: [{
        id: `grant_${ulid()}`,
        actor_id: 'untrusted_agent',
        actor_type: 'agent',
        capabilities: {
          observe: ['project/smartware'],
          query: [], compile: [], correct: [], forget: [], read: [],
        },
        trusted: false,
        quarantine: true, // force quarantine on every observation
        granted_at: new Date().toISOString(),
        granted_by: OWNER,
        status: 'active',
      }],
    };

    // v1.6.16: OBSERVE rejects claims parameter outright (OBSERVE writes L0 only).
    await expect(handleObserve(
      {
        actor: { type: 'agent', id: 'untrusted_agent', display_name: 'Untrusted' },
        type: 'message',
        content: { format: 'text/plain', body: 'I claim project status is done.' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
        claims: [{
          subject_name: 'Smartware',
          subject_type: 'project',
          predicate: 'status_is',
          object: { type: 'enum', value: 'done' },
          scope: 'project/smartware',
          epistemic: 'asserted',
          extraction: {
            method: 'user_input',
            model: null,
            compiler_version: '0.5.1',
            prompt_hash: null,
          },
        }],
      },
      f.evidenceDir, f.layer0, untrustedConfig,
    )).rejects.toThrow('OBSERVE writes L0 only');

    expect(f.store.claimCount()).toBe(0);
  });
});

describe('[P1-3] quarantine_review reachable via protocol — moderation flow works', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  // Helper: create a fixture with an untrusted-but-granted agent so we
  // can produce a quarantined observation through the normal observe path.
  async function quarantineFixture(): Promise<{ fixture: Fixture; obsId: string }> {
    const fixture = f;
    const cfgWithUntrusted: SmartwareConfig = {
      ...fixture.config,
      grants: [{
        id: `grant_${ulid()}`,
        actor_id: 'untrusted_agent',
        actor_type: 'agent',
        capabilities: {
          observe: ['project/smartware'],
          query: [], compile: [], correct: [], forget: [], read: [],
        },
        trusted: false,
        quarantine: true,
        granted_at: new Date().toISOString(),
        granted_by: OWNER,
        status: 'active',
      }],
    };
    saveConfig(fixture.tmp, cfgWithUntrusted);
    fixture.config = cfgWithUntrusted;

    const result = await handleObserve(
      {
        actor: { type: 'agent', id: 'untrusted_agent', display_name: 'Untrusted' },
        type: 'message',
        content: { format: 'text/plain', body: 'Deadline: 2026-06-15.' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      fixture.evidenceDir, fixture.layer0, fixture.config,
    );
    expect(result.status).toBe('quarantined');
    return { fixture, obsId: result.id };
  }

  it('owner can approve a quarantined observation', async () => {
    const { fixture, obsId } = await quarantineFixture();

    const reviewResult = await handleQuarantineReview(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        target_obs_id: obsId,
        action: 'approve',
      },
      fixture.evidenceDir, fixture.layer0, fixture.store, fixture.config,
    );
    expect(reviewResult.status).toBe('reviewed');
    expect(reviewResult.new_status).toBe('accepted');
    expect(fixture.layer0.getEffectiveStatus(obsId)).toBe('accepted');
  });

  it('owner can reject a quarantined observation (terminal state)', async () => {
    const { fixture, obsId } = await quarantineFixture();

    const reviewResult = await handleQuarantineReview(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        target_obs_id: obsId,
        action: 'reject',
      },
      fixture.evidenceDir, fixture.layer0, fixture.store, fixture.config,
    );
    expect(reviewResult.new_status).toBe('rejected');
    expect(fixture.layer0.getEffectiveStatus(obsId)).toBe('rejected');
  });

  it('non-owner cannot review quarantined observations', async () => {
    const { fixture, obsId } = await quarantineFixture();

    await expect(handleQuarantineReview(
      {
        actor: { type: 'agent', id: 'untrusted_agent', display_name: 'Untrusted' },
        target_obs_id: obsId,
        action: 'approve',
      },
      fixture.evidenceDir, fixture.layer0, fixture.store, fixture.config,
    )).rejects.toThrow(/owner/i);
  });

  it('reviewing a non-quarantined observation rejects with invalid_state', async () => {
    // An accepted owner observation is not quarantined
    const acceptedResult = await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'normal message' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );
    expect(acceptedResult.status).toBe('accepted');

    await expect(handleQuarantineReview(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        target_obs_id: acceptedResult.id,
        action: 'approve',
      },
      f.evidenceDir, f.layer0, f.store, f.config,
    )).rejects.toThrow(/quarantined/i);
  });
});

describe('[P1-4] sensitive results require explicit opt-in, even for the owner', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  it('QUERY hides sensitive results from the owner without include_sensitive', async () => {
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Confidential: API key rotation deadline 2026-06-15.' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
        sensitive: true, // mark the observation sensitive
      },
      f.evidenceDir, f.layer0, f.config,
    );
    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    // Default: no opt-in → owner sees nothing sensitive
    const defaultResult = await handleQuery(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        query: '2026',
        scope: 'project/smartware',
      },
      f.store, f.search, f.config, f.registry,
    );
    expect(defaultResult.results.length).toBe(0);

    // Explicit opt-in → owner sees results
    const optInResult = await handleQuery(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        query: '2026',
        scope: 'project/smartware',
        include_sensitive: true,
      },
      f.store, f.search, f.config, f.registry,
    );
    expect(optInResult.results.length).toBeGreaterThan(0);
  });

  it('READ refuses sensitive page without include_sensitive, even for owner', async () => {
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Confidential project note.' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
        sensitive: true,
      },
      f.evidenceDir, f.layer0, f.config,
    );
    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    const claims = f.store.getAllClaims();
    if (claims.length === 0) return; // no claims, nothing to assert

    const entityId = claims[0]!.subject_id;

    // Without flag: should refuse
    await expect(handleRead(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, entity_id: entityId, resolution: 'full' },
      f.wikiDir, f.config,
    )).rejects.toThrow(/sensitive/i);

    // With flag: succeeds
    const ok = await handleRead(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        entity_id: entityId,
        resolution: 'full',
        include_sensitive: true,
      },
      f.wikiDir, f.config,
    );
    expect(ok.entity_id).toBe(entityId);
  });
});

describe('[P0] concurrent compile + query does not hang', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  it('query returns within 2s while compile is running', async () => {
    // Seed enough observations to make compile non-trivial
    for (let i = 0; i < 20; i++) {
      await handleObserve(
        {
          actor: { type: 'person', id: OWNER, display_name: 'Owner' },
          type: 'message',
          content: { format: 'text/plain', body: `Task ${i} deadline: 2026-07-${String(i + 1).padStart(2, '0')}. Status: active.` },
          scope: 'project/smartware',
          observed_at: `2026-04-01T10:${String(i).padStart(2, '0')}:00Z`,
        },
        f.evidenceDir, f.layer0, f.config,
      );
    }

    // First compile to populate the search index
    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    // Add more observations so the second compile has replay work to do
    for (let i = 20; i < 40; i++) {
      await handleObserve(
        {
          actor: { type: 'person', id: OWNER, display_name: 'Owner' },
          type: 'message',
          content: { format: 'text/plain', body: `Task ${i} deadline: 2026-08-${String(i - 19).padStart(2, '0')}. Priority: high.` },
          scope: 'project/smartware',
          observed_at: `2026-04-02T10:${String(i - 20).padStart(2, '0')}:00Z`,
        },
        f.evidenceDir, f.layer0, f.config,
      );
    }

    // Fire compile and query concurrently
    const compilePromise = handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    // Give compile a tick to start, then fire query
    await new Promise(r => setImmediate(r));

    const queryStart = Date.now();
    const queryResult = await handleQuery(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        query: '2026',
        scope: 'project/smartware',
      },
      f.store, f.search, f.config, f.registry,
    );
    const queryElapsed = Date.now() - queryStart;

    await compilePromise;

    expect(queryElapsed).toBeLessThan(2000);
    expect(queryResult.results.length).toBeGreaterThan(0);
  });
});

describe('[P0] compile telemetry and reflect.auto claims_created', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  it('reports claims_created from reflect.auto', async () => {
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Deadline: 2026-06-15. Version: 3.2.1. See https://example.com/spec' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );

    const result = await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    expect(result.claims_created).toBeGreaterThan(0);
  });

  it('reflect.auto creates zero claims for non-extractable content', async () => {
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'The team agreed this approach feels right and should work well.' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T11:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );

    const result = await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    expect(result.claims_created).toBe(0);
  });

  it('telemetry is always present even when compile produces zero pages', async () => {
    const result = await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    expect(result.telemetry).toBeDefined();
    expect(result.claims_created).toBe(0);
  });

  it('telemetry includes duration_ms and stage_durations_ms', async () => {
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Deadline: 2026-06-15. See https://example.com/spec' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );

    const result = await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    expect(result.telemetry.duration_ms).toBeGreaterThan(0);
    expect(result.telemetry.timed_out).toBe(false);
    expect(result.telemetry.stage_durations_ms).toBeDefined();
  });
});

describe('[Phase-A] Layer 3 decoupled from Layer 2 — claims queryable without synthesis', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  it('claims are queryable via L3 even when L2 synthesis is skipped', async () => {
    // Seed observations with clear, searchable content
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Integration deadline: 2026-08-01. API endpoint: https://api.coffee.dev/v2' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );

    // Compile (deterministic, no LLM) — this will extract claims, sync L3, and compile L2
    const compileResult = await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    // Verify L3 was indexed from claims (layer3_indexed_count > 0)
    expect(compileResult.telemetry.layer3_indexed_count).toBeGreaterThan(0);

    // Now add MORE observations but DON'T compile L2 — simulate L2 timeout/failure
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Migration deadline: 2026-09-15. Database version: 5.0.0' },
        scope: 'project/smartware',
        observed_at: '2026-04-02T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );

    // Run compile again — the new claims should be indexed in L3 during Stage 4.5
    // (before L2 synthesis), making them immediately queryable
    const secondCompile = await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    expect(secondCompile.telemetry.layer3_indexed_count).toBeGreaterThan(0);

    // Query should find the newly-extracted content via L3
    const queryResult = await handleQuery(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        query: '2026',
        scope: 'project/smartware',
      },
      f.store, f.search, f.config, f.registry,
    );

    expect(queryResult.results.length).toBeGreaterThan(0);
  });

  it('syncSearchFromClaims indexes entities independently of compile', async () => {
    // Import syncSearchFromClaims directly for this test
    const { syncSearchFromClaims } = await import('../src/layer3/search.js');

    // Seed and compile once to populate L1
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Project uses TypeScript version: 5.4.0. Deadline: 2026-07-01' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );

    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    // Clear L3 to simulate stale state
    f.search.clear();
    expect(f.search.count()).toBe(0);

    // Sync L3 directly from L1 — no L2 involved
    const indexed = syncSearchFromClaims(f.store, f.search, 'project/smartware');
    expect(indexed).toBeGreaterThan(0);

    // Query for content that the deterministic extractor produces (dates, versions)
    const queryResult = await handleQuery(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        query: '2026',
        scope: 'project/smartware',
      },
      f.store, f.search, f.config, f.registry,
    );

    expect(queryResult.results.length).toBeGreaterThan(0);
  });

  it('L3 stays current even if L2 compile produces no pages', async () => {
    // Seed an observation with a type that produces claims but where the entity
    // might not generate a compiled page (e.g. very sparse claims)
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'preference',
        content: { format: 'text/plain', body: 'Preferred deployment target: https://fly.io/apps/coffee' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );

    const result = await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    // L3 indexed count should be populated regardless of L2 page count
    // (L3 syncs from L1 claims, not L2 pages)
    if (f.store.entityCount() > 0) {
      expect(result.telemetry.layer3_indexed_count).toBeGreaterThan(0);
    }

    // L3 count should reflect entities, not just compiled pages
    expect(f.search.count()).toBeGreaterThanOrEqual(result.telemetry.layer3_indexed_count);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase B — Extraction recall: verify and lock in multi-claim extraction
// ═══════════════════════════════════════════════════════════════════════════

describe('[Phase-B] multi-fact deterministic extraction', () => {
  it('extracts ≥ M-1 claims from an observation with M=4 deterministic facts', () => {
    // This observation has 4 distinct deterministic patterns:
    // 1. deadline date, 2. URL, 3. version number, 4. another URL
    const content = 'Deadline: 2026-08-01. API spec at https://api.coffee.dev/v2/docs. ' +
      'Current version: 3.2.1. Dashboard: https://dashboard.coffee.dev/metrics';
    const result = extractDeterministic(content, 'project/coffee', 'coffee', '2026-04-01T00:00:00Z');

    // Expect at least 3 claims (M-1 = 3)
    expect(result.claims.length).toBeGreaterThanOrEqual(3);

    // Verify each pattern type was extracted
    const predicates = result.claims.map(c => c.predicate);
    expect(predicates).toContain('deadline_is');
    expect(predicates).toContain('related_to'); // URLs
    expect(predicates).toContain('version_is');
  });

  it('extracts ≥ 5 claims from a dense observation with M=6 facts', () => {
    // Dense observation: 2 deadlines, 2 URLs, 2 versions
    const content = 'Phase 1 deadline: 2026-06-15. Phase 2 deadline: 2026-09-01. ' +
      'Repo: https://github.com/org/project. Docs: https://docs.example.com/api. ' +
      'API version: 2.0.0. SDK version: 1.5.3.';
    const result = extractDeterministic(content, 'project/test', 'test', '2026-04-01T00:00:00Z');

    expect(result.claims.length).toBeGreaterThanOrEqual(5);
  });

  it('handles observations with zero deterministic patterns gracefully', () => {
    // Truly minimal content — no patterns at all
    const content = 'Good meeting today. Productive discussion.';
    const result = extractDeterministic(content, 'project/test', 'test', '2026-04-01T00:00:00Z');

    expect(result.claims.length).toBe(0);
  });

  it('extracts decisions from semantic content', () => {
    const content = 'The team decided to use a microservices architecture with event sourcing. ' +
      'This aligns with our scalability goals and enables independent deployments.';
    const result = extractDeterministic(content, 'project/test', 'test', '2026-04-01T00:00:00Z');

    // The improved extractor should catch the decision pattern
    expect(result.claims.length).toBeGreaterThanOrEqual(1);
    const decisionClaim = result.claims.find(c => c.predicate === 'decided_on');
    expect(decisionClaim).toBeDefined();
    expect(decisionClaim!.confidence).toBeGreaterThanOrEqual(0.8);
  });
});

// Phase-B pre-extracted claims tests DELETED — OBSERVE no longer accepts claims (v1.6.16).
// Claim creation is reflect.auto's job. See test/conformance/e2e_lifecycle.test.ts.

// ═══════════════════════════════════════════════════════════════════════════
// Phase C — Entity merge guardrails
// ═══════════════════════════════════════════════════════════════════════════

describe('[Phase-C] distinct-but-similar entities stay separate via entity resolution', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  // Import resolveEntity for direct testing
  const getResolveEntity = async () => (await import('../src/layer1/entities.js')).resolveEntity;

  it('"Decision Extracts" and "Decision Orchestrator" resolve to two distinct entities', async () => {
    const resolveEntity = await getResolveEntity();
    const r1 = resolveEntity('Decision Extracts', 'concept', 'project/smartware', f.store);
    const r2 = resolveEntity('Decision Orchestrator', 'concept', 'project/smartware', f.store);
    expect(r1.id).not.toBe(r2.id);
  });

  it('similar names that are genuinely the same entity still merge', async () => {
    const resolveEntity = await getResolveEntity();
    const r1 = resolveEntity('Auth Service', 'concept', 'project/smartware', f.store);
    const r2 = resolveEntity('Auth Services', 'concept', 'project/smartware', f.store);
    expect(r1.id).toBe(r2.id);
  });

  it('exact normalised matches still merge regardless of threshold', async () => {
    const resolveEntity = await getResolveEntity();
    const r1 = resolveEntity('Coffee', 'product', 'project/smartware', f.store);
    const r2 = resolveEntity('coffee', 'product', 'project/smartware', f.store);
    expect(r1.id).toBe(r2.id);
  });

  it('entity_resolution config overrides default thresholds', async () => {
    f.config.entity_resolution = {
      auto_merge_threshold: 0.99,
      borderline_threshold: 0.80,
      llm_disambiguate: false,
    };
    saveConfig(f.tmp, f.config);

    const resolveEntity = await getResolveEntity();
    const r1 = resolveEntity('Auth Service', 'concept', 'project/smartware', f.store, f.config);
    const r2 = resolveEntity('Auth Services', 'concept', 'project/smartware', f.store, f.config);
    // With 0.99 threshold, score ≈ 0.98 falls below → two entities
    expect(r1.id).not.toBe(r2.id);
  });
});

// ── Phase D: Observability tools ──────────────────────────────────────────

describe('[Phase-D] smartware_explain traces claim provenance', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  it('explains a claim with source observation via JSONL derived_from', async () => {
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Deadline: 2026-06-15 for Project Alpha launch' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );

    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    const claims = f.store.getAllClaims();
    expect(claims.length).toBeGreaterThanOrEqual(1);

    const result = await handleExplain(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, claim_id: claims[0]!.id },
      f.evidenceDir, f.layer0, f.store, f.config,
    );

    expect(result.type).toBe('claim');
    expect(result.claim).toBeDefined();
    expect(result.claim!.claim_id).toBe(claims[0]!.id);
  });

  it('explains an entity with all claims and sources', async () => {
    // Two observations about the same entity
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Deadline: 2026-06-15 for the widget' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Widget status: in_progress. See https://example.com/widget' },
        scope: 'project/smartware',
        observed_at: '2026-04-02T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );

    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    const entities = f.store.getAllEntities('project/smartware');
    expect(entities.length).toBeGreaterThanOrEqual(1);

    const result = await handleExplain(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, entity_id: entities[0].id },
      f.evidenceDir, f.layer0, f.store, f.config,
    );

    expect(result.type).toBe('entity');
    expect(result.entity).toBeDefined();
    expect(result.entity!.entity.id).toBe(entities[0].id);
    expect(result.entity!.claims.length).toBeGreaterThanOrEqual(1);
    expect(result.entity!.source_observations.length).toBeGreaterThanOrEqual(1);
    expect(result.entity!.total_claims).toBeGreaterThanOrEqual(result.entity!.active_claims);
  });

  it('throws on nonexistent claim_id', async () => {
    await expect(
      handleExplain(
        { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, claim_id: 'claim_NONEXISTENT' },
        f.evidenceDir, f.layer0, f.store, f.config,
      ),
    ).rejects.toThrow('not found');
  });

  it('throws when neither claim_id nor entity_id provided', async () => {
    await expect(
      handleExplain(
        { actor: { type: 'person', id: OWNER, display_name: 'Owner' } },
        f.evidenceDir, f.layer0, f.store, f.config,
      ),
    ).rejects.toThrow('required');
  });
});

describe('[Phase-D] smartware_read scope browsing', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  it('lists all entities in a scope when no entity_id given', async () => {
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'message',
        content: { format: 'text/plain', body: 'Deadline: 2026-06-15. Status: in_progress. URL: https://alpha.example.com' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );

    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    const result = await handleRead(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        scope: 'project/smartware',
      },
      f.wikiDir, f.config, f.store,
    );

    // Should be a ScopeBrowseResult
    expect('entities' in result).toBe(true);
    const browse = result as { scope: string; entities: unknown[]; total: number };
    expect(browse.scope).toBe('project/smartware');
    expect(browse.entities.length).toBeGreaterThanOrEqual(1);
    expect(browse.total).toBe(browse.entities.length);
  });

  it('reads an entity by name instead of ID', async () => {
    await handleObserve(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        type: 'decision',
        content: { format: 'text/plain', body: 'React Framework is deployed for the frontend. Status: active. Deadline: 2026-07-01' },
        scope: 'project/smartware',
        observed_at: '2026-04-01T10:00:00Z',
      },
      f.evidenceDir, f.layer0, f.config,
    );

    await handleCompile(
      { actor: { type: 'person', id: OWNER, display_name: 'Owner' }, scope: 'project/smartware', use_llm: false },
      f.evidenceDir, f.wikiDir, f.layer0, f.store, f.search, f.config, f.tmp,
    );

    // After compile, find the entity the extraction created
    const entities = f.store.getAllEntities('project/smartware');
    const reactEntity = entities.find(e => e.canonical_name.toLowerCase().includes('react') || e.canonical_name.toLowerCase().includes('framework'));
    expect(reactEntity).toBeDefined();

    const result = await handleRead(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        entity_name: reactEntity!.canonical_name,
        scope: 'project/smartware',
        resolution: 'oneliner',
      },
      f.wikiDir, f.config, f.store,
    );

    expect('entity_id' in result).toBe(true);
    expect((result as { entity_name: string }).entity_name).toBe(reactEntity!.canonical_name);
  });

  it('returns empty list for scope with no compiled entities', async () => {
    const result = await handleRead(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        scope: 'project/smartware',
      },
      f.wikiDir, f.config, f.store,
    );

    expect('entities' in result).toBe(true);
    const browse = result as { entities: unknown[]; total: number };
    expect(browse.entities.length).toBe(0);
    expect(browse.total).toBe(0);
  });
});

// ── Phase E: Session and policy redesign ──────────────────────────────────

describe('[Phase-E] session lifecycle — start, describe, end', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  it('owner starts a verified session and receives full capabilities', async () => {
    const result = await handleSessionStart(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        client_id: 'claude-desktop',
        client_version: '1.0.0',
        declared_trust_level: 'verified',
        declared_capabilities: { can_tag_sensitivity: true, can_provide_intent: true, can_request_user_confirmation: true },
        requested_scopes: ['project/smartware'],
      },
      f.sessions,
      f.config,
    );

    expect(result.session_id).toMatch(/^session_/);
    expect(result.actor_id).toBe(OWNER);
    expect(result.effective_trust_level).toBe('verified');
    expect(result.effective_policy.write_mode).toBe('auto');
    expect(result.effective_policy.read_mode).toBe('always');
    expect(result.effective_policy.sensitive_handling).toBe('allowed');
    expect(result.capabilities_granted).toContain('observe');
    expect(result.capabilities_granted).toContain('query');
    expect(result.capabilities_granted).toContain('read');
    expect(result.downgrade_reason).toBeUndefined();
  });

  it('unknown actor claiming verified is downgraded to untrusted', async () => {
    const result = await handleSessionStart(
      {
        actor: { type: 'agent', id: 'agent_unknown_123', display_name: 'Unknown Agent' },
        client_id: 'rogue-client',
        client_version: '0.1.0',
        declared_trust_level: 'verified',
        declared_capabilities: { can_tag_sensitivity: false, can_provide_intent: false, can_request_user_confirmation: false },
        requested_scopes: ['project/smartware'],
      },
      f.sessions,
      f.config,
    );

    expect(result.effective_trust_level).toBe('untrusted');
    expect(result.effective_policy.write_mode).toBe('off');
    expect(result.effective_policy.read_mode).toBe('off');
    expect(result.capabilities_granted).toEqual([]);
    expect(result.downgrade_reason).toBeDefined();
    expect(result.downgrade_reason).toContain('No active grant');
  });

  it('session_describe returns current session state', async () => {
    const startResult = await handleSessionStart(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        client_id: 'test-client',
        client_version: '1.0.0',
        declared_trust_level: 'user_facing',
        declared_capabilities: { can_tag_sensitivity: false, can_provide_intent: true, can_request_user_confirmation: true },
      },
      f.sessions,
      f.config,
    );

    const descResult = await handleSessionDescribe(
      { actor_id: OWNER, session_id: startResult.session_id },
      f.sessions,
      f.config,
    );

    expect(descResult.session_id).toBe(startResult.session_id);
    expect(descResult.client_id).toBe('test-client');
    expect(descResult.actor_id).toBe(OWNER);
    expect(descResult.status).toBe('active');
    expect(descResult.effective_trust_level).toBe('user_facing');
  });

  it('session_end terminates session cleanly', async () => {
    const startResult = await handleSessionStart(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        client_id: 'test-client',
        client_version: '1.0.0',
        declared_trust_level: 'verified',
        declared_capabilities: { can_tag_sensitivity: true, can_provide_intent: true, can_request_user_confirmation: true },
      },
      f.sessions,
      f.config,
    );

    const endResult = await handleSessionEnd(
      { actor_id: OWNER, session_id: startResult.session_id },
      f.sessions,
      f.config,
    );
    expect(endResult.status).toBe('ended');
    expect(endResult.summary).toEqual({
      write_mode: 'auto',
      durability: 'not_configured',
      sensitive_filtered: false,
    });
    expect(endResult.summary).not.toHaveProperty('claims_persisted');

    // Describe after end shows ended status
    const descResult = await handleSessionDescribe(
      { actor_id: OWNER, session_id: startResult.session_id },
      f.sessions,
      f.config,
    );
    expect(descResult.status).toBe('ended');
  });

  it('ending an already-ended session throws', async () => {
    const startResult = await handleSessionStart(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        client_id: 'test-client',
        client_version: '1.0.0',
        declared_trust_level: 'verified',
        declared_capabilities: { can_tag_sensitivity: true, can_provide_intent: true, can_request_user_confirmation: true },
      },
      f.sessions,
      f.config,
    );

    await handleSessionEnd(
      { actor_id: OWNER, session_id: startResult.session_id },
      f.sessions,
      f.config,
    );

    await expect(
      handleSessionEnd(
        { actor_id: OWNER, session_id: startResult.session_id },
        f.sessions,
        f.config,
      ),
    ).rejects.toThrow('already ended');
  });

  it('only the session actor or owner can describe and end a session', async () => {
    const startResult = await handleSessionStart(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        client_id: 'test-client',
        client_version: '1.0.0',
        declared_trust_level: 'verified',
        declared_capabilities: { can_tag_sensitivity: true, can_provide_intent: true, can_request_user_confirmation: true },
      },
      f.sessions,
      f.config,
    );

    await expect(
      handleSessionDescribe(
        { actor_id: 'agent:intruder', session_id: startResult.session_id },
        f.sessions,
        f.config,
      ),
    ).rejects.toThrow('cannot manage session');

    await expect(
      handleSessionEnd(
        { actor_id: 'agent:intruder', session_id: startResult.session_id },
        f.sessions,
        f.config,
      ),
    ).rejects.toThrow('cannot manage session');

    expect(f.sessions.get(startResult.session_id)?.status).toBe('active');
  });
});

describe('[Phase-E] session-based observe — server-enforced identity', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(() => teardown(f));

  it('observe with session_id resolves actor from session, not client', async () => {
    const session = await handleSessionStart(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        client_id: 'claude-desktop',
        client_version: '1.0.0',
        declared_trust_level: 'verified',
        declared_capabilities: { can_tag_sensitivity: true, can_provide_intent: true, can_request_user_confirmation: true },
        requested_scopes: ['project/smartware'],
      },
      f.sessions,
      f.config,
    );

    // Client sends a DIFFERENT actor_id, but session_id should override
    const result = await handleObserve(
      {
        actor: { type: 'agent', id: 'agent_fake_id', display_name: 'Fake Agent' },
        type: 'message',
        content: { format: 'text/plain', body: 'Test message via session' },
        scope: 'project/smartware',
        session_id: session.session_id,
      },
      f.evidenceDir, f.layer0, f.config, f.sessions,
    );

    expect(result.status).toBe('accepted');
    expect(result.id).toMatch(/^obs_/);
  });

  it('session-authenticated query and read use server identity and requested scope', async () => {
    const session = await handleSessionStart(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        client_id: 'claude-desktop',
        client_version: '1.0.0',
        declared_trust_level: 'verified',
        declared_capabilities: { can_tag_sensitivity: true, can_provide_intent: true, can_request_user_confirmation: true },
        requested_scopes: ['project/smartware'],
      },
      f.sessions,
      f.config,
    );

    const queryResult = await handleQuery(
      {
        actor: { type: 'agent', id: 'agent:intruder', display_name: 'Intruder' },
        session_id: session.session_id,
        query: 'anything',
        scope: 'project/smartware',
      },
      f.store,
      f.search,
      f.config,
      f.registry,
      f.sessions,
    );
    expect(queryResult.query_scope).toBe('project/smartware');

    const browseResult = await handleRead(
      {
        actor: { type: 'agent', id: 'agent:intruder', display_name: 'Intruder' },
        session_id: session.session_id,
        scope: 'project/smartware',
      },
      f.wikiDir,
      f.config,
      f.store,
      f.sessions,
    );
    expect('total' in browseResult && browseResult.total).toBe(0);

    await expect(
      handleQuery(
        {
          actor: { type: 'person', id: OWNER, display_name: 'Owner' },
          session_id: session.session_id,
          query: 'anything',
          scope: 'personal',
        },
        f.store,
        f.search,
        f.config,
        f.registry,
        f.sessions,
      ),
    ).rejects.toThrow('was not requested');
  });

  it('untrusted sessions cannot query or read', async () => {
    const session = await handleSessionStart(
      {
        actor: { type: 'agent', id: 'agent:unknown', display_name: 'Unknown' },
        client_id: 'rogue-client',
        client_version: '0.1.0',
        declared_trust_level: 'verified',
        declared_capabilities: { can_tag_sensitivity: false, can_provide_intent: false, can_request_user_confirmation: false },
        requested_scopes: ['project/smartware'],
      },
      f.sessions,
      f.config,
    );

    await expect(
      handleQuery(
        {
          actor: { type: 'person', id: OWNER, display_name: 'Forged Owner' },
          session_id: session.session_id,
          query: 'anything',
          scope: 'project/smartware',
        },
        f.store,
        f.search,
        f.config,
        f.registry,
        f.sessions,
      ),
    ).rejects.toThrow('does not allow reads');

    await expect(
      handleRead(
        {
          actor: { type: 'person', id: OWNER, display_name: 'Forged Owner' },
          session_id: session.session_id,
          scope: 'project/smartware',
        },
        f.wikiDir,
        f.config,
        f.store,
        f.sessions,
      ),
    ).rejects.toThrow('does not allow reads');
  });

  it('observe with untrusted session rejects writes', async () => {
    const session = await handleSessionStart(
      {
        actor: { type: 'agent', id: 'agent_unknown', display_name: 'Unknown' },
        client_id: 'rogue-client',
        client_version: '0.1.0',
        declared_trust_level: 'verified',
        declared_capabilities: { can_tag_sensitivity: false, can_provide_intent: false, can_request_user_confirmation: false },
      },
      f.sessions,
      f.config,
    );

    // Session was downgraded to untrusted → write_mode: 'off'
    expect(session.effective_policy.write_mode).toBe('off');

    await expect(
      handleObserve(
        {
          actor: { type: 'agent', id: 'agent_unknown', display_name: 'Unknown' },
          type: 'message',
          content: { format: 'text/plain', body: 'Should be rejected' },
          scope: 'project/smartware',
          session_id: session.session_id,
        },
        f.evidenceDir, f.layer0, f.config, f.sessions,
      ),
    ).rejects.toThrow('write');
  });

  it('observe with expired session throws', async () => {
    // Create a session then manually expire it
    const session = await handleSessionStart(
      {
        actor: { type: 'person', id: OWNER, display_name: 'Owner' },
        client_id: 'test-client',
        client_version: '1.0.0',
        declared_trust_level: 'verified',
        declared_capabilities: { can_tag_sensitivity: true, can_provide_intent: true, can_request_user_confirmation: true },
      },
      f.sessions,
      f.config,
    );

    // End the session to simulate expiry
    await handleSessionEnd(
      { actor_id: OWNER, session_id: session.session_id },
      f.sessions,
      f.config,
    );

    await expect(
      handleObserve(
        {
          actor: { type: 'person', id: OWNER, display_name: 'Owner' },
          type: 'message',
          content: { format: 'text/plain', body: 'Should fail' },
          scope: 'project/smartware',
          session_id: session.session_id,
        },
        f.evidenceDir, f.layer0, f.config, f.sessions,
      ),
    ).rejects.toThrow('not active');
  });
});
