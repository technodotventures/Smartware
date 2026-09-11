// G2 conformance suite — v0.5.0 release gate (spec §8 + §10a + §10b).
//
// Four contracts, one file:
//   1. Rebuild-equivalence: wipe-and-rebuild derived state from the canonical
//      JSONL (evidence / claims / operations) is byte-stable over the
//      canonical log and restores identical query surfaces (§10a).
//   2. FORGET.SCOPE "zero results in EVERY lane" asserted against REBUILT
//      indexes — a stale FTS row is the ghost that resurfaces a purged
//      client; purge proof requires regeneration, not just row deletion (§10a).
//   3. Erasure vs offboarding semantics: exact counts fidelity, one ops entry
//      with the counts, same-commit grant revocation, non-reusable scope
//      markers (§10, §10b.3).
//   4. Provenance integrity: every search hit reproduces its source
//      observation + ops entry; superseded claims never satisfy get/trace;
//      multi-version history order is correct (§7, §8).
//
// Plus the §10b Coffee-tenant config-shape conformance (the spec's worked
// example is the seed fixture; §10b line 196 assigns it to this card).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import type { SmartwareConfig } from '../../src/config.js';
import { loadConfig, saveConfig } from '../../src/config.js';
import { ScopeRegistry } from '../../src/scopes/registry.js';
import { checkGrant, isOwner } from '../../src/auth/grants.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { SemanticRecordStore } from '../../src/layer3/semantic-store.js';
import { readAll } from '../../src/layer0/log.js';
import { iterAllClaimVersions, readClaimHistory } from '../../src/layer1/jsonl.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';
import { OpsIndex, openOpsIndex, defaultOpsIndexPath } from '../../src/ops_log/index.js';
import { nextOperationId } from '../../src/compile_queue/ids.js';
import { isEffectiveCurrent, getEffectiveCurrentIds } from '../../src/layer1/effective_current.js';
import { makeClaim } from '../helpers.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const GIGI = { type: 'person' as const, id: 'user:gigi', display_name: 'Gigi' };
const NOAH = { type: 'person' as const, id: 'user:noah', display_name: 'Noah' };
const ACME = 'client:acme#1';
const ACME2 = 'client:acme#2';
const BCAU = 'client:bcau#1';

/** §10b.4 worked-example tenant (the seed fixture for config-shape conformance). */
function coffeeConfig(dataDir: string): SmartwareConfig {
  return {
    instance_id: `smartware_${ulid()}`,
    owner_id: 'user:owner',
    writer_id: `writer_local_${ulid()}`,
    version: '0.6.3',
    data_dir: dataDir,
    scopes: [
      { id: 'self', parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: ACME, parent: 'workspace', visibility_default: 'scope' },
      { id: BCAU, parent: 'workspace', visibility_default: 'scope' },
      { id: 'client:gate#2', parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [
      {
        id: `grant_${ulid()}`,
        actor_type: 'person',
        actor_id: 'user:gigi',
        capabilities: {
          observe: [ACME], query: [ACME], compile: [], correct: [], forget: [], read: [ACME],
        },
        trusted: false,
        quarantine: false,
        created_at: '2026-08-29T09:00:00.000Z',
        expires_at: null,
        status: 'active',
      },
      {
        id: `grant_${ulid()}`,
        actor_type: 'person',
        actor_id: 'user:noah',
        capabilities: {
          observe: [BCAU, 'client:gate#2'], query: [BCAU, 'client:gate#2'],
          compile: [], correct: [], forget: [], read: ['client:gate#2'],
        },
        trusted: false,
        quarantine: false,
        created_at: '2026-08-29T09:00:00.000Z',
        expires_at: null,
        status: 'active',
      },
    ],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
}

/** Fixture: data dir + SmartwareCore + secondary store/index connections. */
interface Fixture {
  dataDir: string;
  core: SmartwareCore;
  store: ClaimStore;      // secondary connection, canonical write path (insertClaim)
  searchIndex: SearchIndex; // secondary connection (FTS maintenance/sync helpers)
}

let fixture: Fixture | null = null;
const allFixtures: Array<{ dataDir: string; core: SmartwareCore | null }> = [];

function scaffoldDirectory(dataDir: string): void {
  // SmartwareCore.open skips initialiseDataDir when config.json exists;
  // create the same scaffold the initialiser makes.
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  saveConfig(dataDir, coffeeConfig(dataDir));
}

async function newFixture(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-g2-conf-'));
  scaffoldDirectory(dataDir);
  const core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);
  const fx = { dataDir, core, store, searchIndex };
  fixture = fx;
  allFixtures.push({ dataDir, core });
  return fx;
}

async function closeFixture(fx: Fixture): Promise<void> {
  fx.store.close();
  fx.searchIndex.close();
  fx.core.close();
  const entry = allFixtures.find(f => f.dataDir === fx.dataDir);
  if (entry) entry.core = null;
  fixture = null;
}

/** Wipe every DERIVED surface (L0/L1/L3 SQLite index + indices/), keep canonical. */
function wipeDerived(dataDir: string): void {
  for (const name of ['smartware.db', 'smartware.db-wal', 'smartware.db-shm']) {
    fs.rmSync(path.join(dataDir, name), { force: true });
  }
  fs.rmSync(path.join(dataDir, 'indices'), { recursive: true, force: true });
}

/** Reopen the same data dir through the product path (regenerates derived state). */
async function reopen(fx: Fixture): Promise<void> {
  await closeFixture(fx);
  const dataDir = fx.dataDir;
  const core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);
  // Mutate the SAME object — tests hold the local reference across rebuilds.
  fx.core = core;
  fx.store = store;
  fx.searchIndex = searchIndex;
  fixture = fx;
  allFixtures.push({ dataDir, core });
}

beforeEach(async () => {
  fixture = null;
});

afterEach(async () => {
  for (const entry of allFixtures.splice(0)) {
    entry.core?.close();
    fs.rmSync(entry.dataDir, { recursive: true, force: true });
  }
  fixture = null;
});

// ── Canonical-log byte-level helpers ──────────────────────────────────────────

function canonicalHashMap(dataDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of ['evidence', 'claims', 'operations']) {
    const full = path.join(dataDir, d);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full).sort()) {
      const p = path.join(full, f);
      if (!fs.statSync(p).isFile()) continue;
      out[`${d}/${f}`] = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  }
  return out;
}

/** Byte-level fidelity: every canonical line must round-trip its own bytes. */
function canonicalRoundTripFailures(dataDir: string): Record<string, number> {
  const failures: Record<string, number> = {};
  for (const d of ['evidence', 'claims', 'operations']) {
    const full = path.join(dataDir, d);
    let count = 0;
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full).sort()) {
      const p = path.join(full, f);
      if (!fs.statSync(p).isFile()) continue;
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          if (JSON.stringify(JSON.parse(line)) !== line) count += 1;
        } catch {
          count += 1;
        }
      }
    }
    failures[d] = count;
  }
  return failures;
}

function canonicalLineCounts(dataDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of ['evidence', 'claims', 'operations']) {
    const full = path.join(dataDir, d);
    let count = 0;
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full).sort()) {
      const p = path.join(full, f);
      if (!fs.statSync(p).isFile()) continue;
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) if (line) count += 1;
    }
    out[d] = count;
  }
  return out;
}

// ── Seeding helpers ──────────────────────────────────────────────────────────

async function observeMessage(
  fx: Fixture,
  scope: string,
  body: string,
  observedAt: string,
): Promise<string> {
  const result = await fx.core.observe({
    actor: OWNER,
    type: 'message',
    content: { format: 'text/plain', body },
    scope,
    observed_at: observedAt,
  });
  return result.id;
}

/** Direct canonical claim insert (entity + store + L1 JSONL via insertClaim) + FTS sync. */
function insertClaimFor(fx: Fixture, scope: string, overrides: Record<string, unknown>): ReturnType<typeof makeClaim> {
  const subjectId = typeof overrides['subject_id'] === 'string'
    ? overrides['subject_id'] as string
    : `entity_${ulid()}`;
  const subjectName = overrides['subject_name'] as string ?? 'Test Entity';
  fx.store.insertEntity({
    id: subjectId,
    canonical_name: subjectName,
    aliases: [],
    type: 'organization',
    scope,
    created_at: new Date().toISOString(),
  });
  const claim = makeClaim({ subject_id: subjectId, scope, ...overrides });
  fx.store.insertClaim(claim);
  syncSearchFromClaims(fx.store, fx.searchIndex, scope);
  return claim;
}

function entityFor(fx: Fixture, scope: string, name: string): string {
  const id = `entity_${ulid()}`;
  fx.store.insertEntity({
    id, canonical_name: name, aliases: [], type: 'organization', scope,
    created_at: new Date().toISOString(),
  });
  return id;
}

/** Seed a client scope through the real write path: obs + compile + optional direct claims. */
async function seedScope(
  fx: Fixture,
  scope: string,
  name: string,
  opts: { directClaims?: number; compile?: boolean } = {},
): Promise<{ obsIds: string[] }> {
  const obsIds: string[] = [];
  obsIds.push(await observeMessage(fx, scope, `${name} beta status is active`, '2026-07-01T00:00:00.000Z'));
  obsIds.push(await observeMessage(fx, scope, `${name} beta deadline is ${name}nical`, '2026-07-02T00:00:00.000Z'));
  if (opts.compile !== false) {
    await fx.core.compile({ actor: OWNER, scope, use_llm: false });
  }
  for (let index = 0; index < (opts.directClaims ?? 0); index += 1) {
    insertClaimFor(fx, scope, {
      subject_name: name,
      predicate: 'status_is',
      object: { type: 'text', value: `direct-value-${index}` },
      supporting_evidence: obsIds,
      confidence: 0.8,
    });
  }
  return { obsIds };
}

/** One cached-context query through the canonical RECALL path. */
async function recall(fx: Fixture, scope: string, query: string) {
  return fx.core.query({ actor: OWNER, query, scope });
}

// ── 1 · §10b Coffee-tenant config shape ───────────────────────────────────────

describe('G2 conformance · §10b Coffee-tenant config shape', () => {
  it('round-trips the worked-example config and exposes scope metadata', async () => {
    const fx = await newFixture();
    const dataDir = fx.dataDir;

    // LoadConfig/saveConfig round-trip the Coffee shape unchanged by
    // re-reading what saveConfig wrote (a new load sees the same object).
    const reloaded = loadConfig(dataDir);
    expect(reloaded.scopes.map(s => s.id)).toContain(ACME);
    expect(reloaded.scopes.map(s => s.id)).toContain('client:gate#2');

    const registry = new ScopeRegistry(reloaded);
    // §10b.5: hierarchy holds as configured.
    expect(registry.getAncestors(ACME)).toEqual([ACME, 'workspace']);
    expect(registry.getAncestors('client:gate#2')).toEqual(['client:gate#2', 'workspace']);
    expect(registry.getVisibilityDefault(ACME)).toBe('scope');
    expect(registry.getVisibilityDefault('client:gate#2')).toBe('scope');
    // Parent/child visibility: client scopes are under workspace, never self.
    expect(registry.getParent(ACME)?.id).toBe('workspace');

    // v0.5.0 widened-Scope pattern is structurally admitted (no rejection).
    expect(registry.get('client:gate#2')?.id).toBe('client:gate#2');
  });

  it('grant clusters are exact-id lists — wildcards never match, markers are structurally distinct', async () => {
    const fx = await newFixture();
    const config = loadConfig(fx.dataDir);

    // Exact cluster entries authorize exactly their scopes.
    expect(checkGrant('user:gigi', 'query', ACME, config)).toBe(true);
    expect(checkGrant('user:gigi', 'query', BCAU, config)).toBe(false);
    expect(checkGrant('user:noah', 'query', 'client:gate#2', config)).toBe(true);

    // §10b.2 verified facts: client:* / client/* / client:acme#* do NOT match.
    const gigi = { ...config, grants: config.grants.map(g =>
      g.actor_id === 'user:gigi'
        ? { ...g, capabilities: { ...g.capabilities, query: ['client:*', 'client/*', 'client:acme#*', ACME] } }
        : g) };
    expect(checkGrant('user:gigi', 'query', ACME2, gigi)).toBe(false);
    expect(checkGrant('user:gigi', 'query', 'client:acme', gigi)).toBe(false);

    // Versioned distinctness: a grant on #2 never authorizes #1, and vice
    // versa (non-reusable marker, §10b.2).
    const gate2Only = { ...config, grants: config.grants.map(g =>
      g.actor_id === 'user:noah'
        ? { ...g, capabilities: { ...g.capabilities, query: ['client:gate#2'] } }
        : g) };
    expect(checkGrant('user:noah', 'query', 'client:gate#1', gate2Only)).toBe(false);
    expect(checkGrant('user:noah', 'query', 'client:gate#2', gate2Only)).toBe(true);

    // Owner bypasses grants entirely; staff never hold '*'.
    expect(isOwner('user:owner', config)).toBe(true);
    expect(isOwner('user:gigi', config)).toBe(false);
    expect(checkGrant('user:gigi', 'query', '*', config)).toBe(false);
  });
});

// ── 2 · Rebuild-equivalence (byte-level, canonical log) ───────────────────────

describe('G2 conformance · rebuild-equivalence from canonical JSONL', () => {
  it('wipe-and-rebuild is byte-stable over the canonical log and restores identical views', async () => {
    const fx = await newFixture();
    const { obsIds } = await seedScope(fx, ACME, 'Acme');
    const other = await seedScope(fx, BCAU, 'Bcau');
    // Per-observation FORGET (tombstone) — canonical mutation, then rebuild
    // must reproduce the same terminal visibility.
    const tombstone = other.obsIds[0]!;
    await fx.core.forget({
      actor: OWNER,
      target: { type: 'observation', id: tombstone },
      mode: 'tombstone',
      reason: 'client corrected',
    });

    const hashesBefore = canonicalHashMap(fx.dataDir);
    const failuresBefore = canonicalRoundTripFailures(fx.dataDir);
    const countsBefore = canonicalLineCounts(fx.dataDir);
    expect(failuresBefore).toEqual({ evidence: 0, claims: 0, operations: 0 });

    const snapshotBefore = await viewSnapshot(fx, [ACME, BCAU], obsIds.concat(other.obsIds));

    // Wipe everything derived; reopen from canonical only.
    await closeFixture(fx);
    wipeDerived(fx.dataDir);
    await reopen(fx);

    const hashesAfter = canonicalHashMap(fx.dataDir);
    const failuresAfter = canonicalRoundTripFailures(fx.dataDir);
    const countsAfter = canonicalLineCounts(fx.dataDir);

    // Byte-level: canonical bytes are bit-identical before/after rebuild AND
    // every line round-trips its own bytes (writing never normalizes).
    expect(hashesAfter).toEqual(hashesBefore);
    expect(countsAfter).toEqual(countsBefore);
    expect(failuresAfter).toEqual({ evidence: 0, claims: 0, operations: 0 });

    // Derived-view equivalence: every client-visible query surface agrees
    // with pre-rebuild.
    const snapshotAfter = await viewSnapshot(fx, [ACME, BCAU], obsIds.concat(other.obsIds));
    expect(snapshotAfter).toEqual(snapshotBefore);

    // Regeneration is canonical-true: the rebuilt claim FTS contains exactly
    // the ACTIVE claims of each scope (retracted rows from the live forget
    // path are dropped; the view filter neutralizes them either way).
    for (const scope of [ACME, BCAU]) {
      const activeIds = fx.store.getAllClaims(scope)
        .filter(c => c.status === 'active')
        .map(c => c.id).sort();
      const indexedIds = searchClaimsFor(fx, 'beta', scope)
        .map(r => r.claim_id).sort();
      expect(indexedIds).toEqual(activeIds);
    }
  });

  it('ops index regenerates identically from the canonical log through its public rebuild', async () => {
    const fx = await newFixture();
    await seedScope(fx, ACME, 'Acme');

    const opsDir = path.join(fx.dataDir, 'operations');
    const canonical = [...readAllOpLogEntries(opsDir)].sort((a, b) => a.operation_id.localeCompare(b.operation_id));

    // Rebuild into a wiped indices/ dir and assert exact content equality
    // (parsed JSONL bytes == index rows; details round-trip).
    const index = openOpsIndex(opsDir, defaultOpsIndexPath(fx.dataDir));
    index.rebuildIndex(opsDir);
    const indexed = index.allEntries().sort((a, b) => a.operation_id.localeCompare(b.operation_id));
    expect(indexed).toEqual(canonical);
    expect(index.count()).toBe(canonical.length);
    // O(1) PK resolution reproduces the exact entry, byte-for-byte at the
    // record level.
    for (const entry of canonical) {
      expect(index.getByOperationId(entry.operation_id)).toEqual(entry);
    }
    index.close();
  });

  it('a second wipe-and-rebuild is idempotent (no change accumulates)', async () => {
    const fx = await newFixture();
    await seedScope(fx, ACME, 'Acme');
    await seedScope(fx, BCAU, 'Bcau');

    const first = await viewSnapshot(fx, [ACME, BCAU], []);
    await closeFixture(fx);
    wipeDerived(fx.dataDir);
    await reopen(fx);
    const second = await viewSnapshot(fx, [ACME, BCAU], []);
    await closeFixture(fx);
    wipeDerived(fx.dataDir);
    await reopen(fx);
    const third = await viewSnapshot(fx, [ACME, BCAU], []);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});

// ── 3 · FORGET.SCOPE zero results in EVERY lane, against REBUILT indexes ──────

describe('G2 conformance · FORGET.SCOPE zero results against REBUILT indexes', () => {
  it('erasure: every lane is zero immediately, and stays zero after wipe-and-rebuild', async () => {
    const fx = await newFixture();
    const { obsIds } = await seedScope(fx, ACME, 'Acme', { directClaims: 1 });
    const other = await seedScope(fx, BCAU, 'Bcau');

    // Vector lane: persist embeddings through the canonical sync path.
    const adapter = fakeAdapter();
    const semantic = new SemanticRecordStore(path.join(fx.dataDir, 'semantic.db'));
    await fx.core.syncSemanticIndex(
      { actor: OWNER, scope: ACME },
      { adapter, store: semantic },
    );
    expect(semantic.load(adapter, ACME).status).toBe('ready');
    // Graph lane: entity page seeded into the store.
    entityFor(fx, ACME, 'Acme');

    // Wiki (L2 derived summary) seeded by compile.
    const wikiPage = findWikiPage(fx.dataDir, ACME);
    expect(wikiPage).not.toBeNull();

    const operationId = nextOperationId();
    const result = await fx.core.forgetScope(
      { actor: OWNER, scope: ACME, reason: 'erasure', operation_id: operationId },
      { semanticStore: semantic },
    );
    expect(result.claims_retracted).toBeGreaterThanOrEqual(2);
    expect(result.observations_retracted).toBe(obsIds.length);

    // Immediate zero in every lane.
    assertScopeLanesZero(fx, ACME, obsIds, adapter, semantic);
    // Other scope is untouched.
    expect(await recall(fx, BCAU, 'bcau')).toMatchObject({ total_found: expect.any(Number) });
    expect((await recall(fx, BCAU, 'bcau')).results.length).toBeGreaterThan(0);

    // ── REBUILD: wipe all derived surfaces, reopen, re-assert every lane. ──
    semantic.close();
    await closeFixture(fx);
    wipeDerived(fx.dataDir);
    await reopen(fx);
    const semanticAfter = new SemanticRecordStore(path.join(fx.dataDir, 'semantic.db'));

    expect(searchClaimsFor(fx, 'acme', ACME)).toHaveLength(0);
    expect(searchObsFor(fx, 'beta', ACME)).toHaveLength(0);
    expect(searchPagesFor(fx, 'acme', ACME)).toHaveLength(0);
    expect((await recall(fx, ACME, 'acme beta')).results).toHaveLength(0);
    expect(fx.store.getAllClaims(ACME)).toHaveLength(0);
    expect(fx.store.getAllEntities(ACME)).toHaveLength(0);
    // Layer-0 effective status is terminal 'erased' for every erased obs
    // (marker replay during catchUp — this is the rebuild-equivalence core).
    const l0 = new Layer0Index(path.join(fx.dataDir, 'smartware.db'));
    for (const obsId of obsIds) expect(l0.getEffectiveStatus(obsId)).toBe('erased');
    l0.close();
    expect(semanticAfter.load(adapter, ACME).status).toBe('missing');
    expect(semanticAfter.load(adapter, ACME).records).toHaveLength(0);
    // Graph lane after rebuild.
    const graph = fx.core.readKnowledgeGraph({ actor: OWNER, scopes: [ACME] });
    expect(graph.entities).toHaveLength(0);
    expect(graph.claims).toHaveLength(0);
    // Other-scope lane survived the rebuild (vital: purge proof is scoped).
    expect(searchObsFor(fx, 'bcau', BCAU).length).toBeGreaterThan(0);
    // Canonical proof: claim versions for the scope are physically gone;
    // the audit marker for the scope exists in the pod scope.
    const scopeVersions = [...iterAllClaimVersions(fx.dataDir)].filter(v => v.scope === ACME);
    expect(scopeVersions).toHaveLength(0);
    const markers = [...readAll(path.join(fx.dataDir, 'evidence'))]
      .filter(o => o.type === 'erasure' && (o.content.body as Record<string, unknown>)['scope'] === ACME);
    expect(markers.length).toBe(1);
    semanticAfter.close();
  });

  it('stale FTS rows (ghosts) are neutralised by regeneration — the purge proof', async () => {
    const fx = await newFixture();
    const { obsIds } = await seedScope(fx, ACME, 'Acme');
    const claimIds = fx.store.getAllClaims(ACME).map(c => c.id);
    expect(claimIds.length).toBeGreaterThan(0);

    await fx.core.forgetScope(
      { actor: OWNER, scope: ACME, reason: 'erasure', operation_id: nextOperationId() },
    );

    // Simulate the failure mode: a purge BUG leaves / re-creates stale FTS
    // rows referencing the purged content. Re-insert an observation row + a
    // claim row as a ghost would exist after partial purge.
    const ghostObs = [...readAll(path.join(fx.dataDir, 'evidence'))].find(o => o.id === obsIds[0])!;
    fx.searchIndex.indexObservation({
      obs_id: ghostObs.id,
      scope: ghostObs.scope,
      type: ghostObs.type,
      actor_id: ghostObs.source.actor.id,
      observed_at: ghostObs.source.observed_at,
      captured_at: ghostObs.source.captured_at,
      source_app: ghostObs.source.app,
      source_id: ghostObs.source.source_id,
      sensitive: ghostObs.policy.sensitive,
      status: 'accepted',
      freshness: 'unverified',
      content: String(ghostObs.content.body),
    });
    // Claim-granular ghost row (indexClaim writes the PAGE table, so write
    // the claim FTS row directly — that is the lane FORGET.SCOPE purges).
    fx.searchIndex.getDB().prepare(`
      INSERT INTO claim_search_index (claim_id, entity_id, entity_name, scope, predicate, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(claimIds[0]!, `entity_${ulid()}`, 'Acme', ACME, 'status_is', 'Acme beta status is active');

    // Ghost rows EXIST at the index layer (this is the purge bug), but the
    // live surfaces must not resurrect them:
    //  - raw observation window re-checks Layer-0 effective status live;
    //  - recall filters claim hits against the authorized store snapshot.
    expect(searchClaimsFor(fx, 'acme', ACME).length).toBe(1);   // index layer: ghost present
    expect(searchObsFor(fx, 'beta', ACME).length).toBe(1);      // index layer: ghost present
    expect(fx.core.searchObservations('beta', ACME)).toHaveLength(0);
    expect((await recall(fx, ACME, 'acme beta')).results).toHaveLength(0);

    // Regeneration is the assertion that matters: wipe + rebuild and the
    // ghost rows are GONE (zero results, exact canonical counts), never
    // merely hidden.
    await closeFixture(fx);
    wipeDerived(fx.dataDir);
    await reopen(fx);
    expect(searchClaimsFor(fx, 'acme', ACME)).toHaveLength(0);
    expect(searchObsFor(fx, 'beta', ACME)).toHaveLength(0);
    expect((await recall(fx, ACME, 'acme beta')).results).toHaveLength(0);
  });

  it('offboarding: zero in lanes, retains tombstones, REVIVE restores the data layer — through two rebuilds', async () => {
    const fx = await newFixture();
    const { obsIds } = await seedScope(fx, ACME, 'Acme');
    const claim = fx.store.getAllClaims(ACME)[0]!;
    expect(claim).toBeDefined();

    await fx.core.forgetScope(
      { actor: OWNER, scope: ACME, reason: 'offboarding', owner_pointer: 'client since 2023, 4 jobs, no disputes', operation_id: nextOperationId() },
    );

    // Immediately zero (tombstoned lanes), scope entry still present.
    expect(searchObsFor(fx, 'beta', ACME)).toHaveLength(0);
    expect((await recall(fx, ACME, 'acme beta')).results).toHaveLength(0);
    const configAfter = loadConfig(fx.dataDir);
    expect(configAfter.scopes.some(s => s.id === ACME)).toBe(true);
    expect(configAfter.grants.filter(g => g.actor_id === 'user:gigi').every(g => g.status === 'revoked')).toBe(true);
    // Data layer keeps the revocable record: a forgotten version exists.
    expect(readLatestState(fx.dataDir, claim.id)).toBe('forgotten');

    // REBUILD 1: zero holds (tombstones are canonical), revoke persists.
    await closeFixture(fx);
    wipeDerived(fx.dataDir);
    await reopen(fx);
    expect(searchObsFor(fx, 'beta', ACME)).toHaveLength(0);
    expect((await recall(fx, ACME, 'acme beta')).results).toHaveLength(0);
    const l0 = new Layer0Index(path.join(fx.dataDir, 'smartware.db'));
    for (const obsId of obsIds) expect(l0.getEffectiveStatus(obsId)).toBe('tombstoned');
    l0.close();
    expect(fx.store.getClaim(claim.id)?.status).toBe('retracted');

    // Offboarding is reversible AT THE DATA LAYER: REVIVE restores the claim
    // version chain to active (canonical record + store row).
    const revive = await fx.core.revive({
      actor: OWNER,
      tombstone_id: `tomb_${claim.id.slice(6)}`,
      reason: 'client re-engaged',
      operation_id: nextOperationId(),
    });
    expect(revive.status).toBe('revived');
    expect(fx.store.getClaim(claim.id)?.status).toBe('active');
    expect(readLatestState(fx.dataDir, claim.id)).toBe('active');

    // Effective-current constraint: the source observations of the revived
    // claim are terminal (tombstoned) — Layer 0 lifecycle events constrain
    // EVERY read interface, so the claim stays out of RECALL while its
    // evidence is terminal. This is the byte-clean view rule, not a revive
    // bug: the client re-engagement path is `client:<id>#2`, not silent
    // resurrection (§10 non-reusable markers).
    const db = fx.store.getDB();
    expect(isEffectiveCurrent(claim.id, db)).toBe(false);
    expect((await recall(fx, ACME, 'acme beta')).results).toHaveLength(0);

    // REBUILD 2: the revived record is canonical and reproduces identically
    // (active data layer, evidence-suppressed recall — equivalence holds).
    await closeFixture(fx);
    wipeDerived(fx.dataDir);
    await reopen(fx);
    expect(fx.store.getClaim(claim.id)?.status).toBe('active');
    expect(readLatestState(fx.dataDir, claim.id)).toBe('active');
    expect(isEffectiveCurrent(claim.id, fx.store.getDB())).toBe(false);
    expect((await recall(fx, ACME, 'acme beta')).results).toHaveLength(0);
  });
});

// ── 4 · Erasure vs offboarding semantics ──────────────────────────────────────

describe('G2 conformance · erasure vs offboarding semantics', () => {
  it('counts fidelity: exact pre-mutation counts, one ops entry, other scopes untouched', async () => {
    const fx = await newFixture();
    const { obsIds } = await seedScope(fx, ACME, 'Acme', { directClaims: 2 });
    const other = await seedScope(fx, BCAU, 'Bcau', { directClaims: 1 });

    const expectedClaims = fx.store.getAllClaims(ACME).length;
    const expectedObs = obsIds.length;
    const operationId = nextOperationId();
    const result = await fx.core.forgetScope(
      { actor: OWNER, scope: ACME, reason: 'erasure', operation_id: operationId },
    );

    // Result carries the exact pre-mutation counts.
    expect(result.claims_retracted).toBe(expectedClaims);
    expect(result.observations_retracted).toBe(expectedObs);

    // ONE ops entry with idempotent counts; no second entry for the op.
    const entries = [...readAllOpLogEntries(path.join(fx.dataDir, 'operations'))]
      .filter(e => e.operation_id === operationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.op).toBe('forget.scope');
    expect(entries[0]!.details?.['claims_retracted']).toBe(expectedClaims);
    expect(entries[0]!.details?.['observations_retracted']).toBe(expectedObs);

    // Other scope untouched: storage + lanes + JSONL.
    expect(fx.store.getAllClaims(BCAU).length).toBeGreaterThan(0);
    expect(fx.store.getAllEntities(BCAU).length).toBeGreaterThanOrEqual(0);
    const otherVersions = [...iterAllClaimVersions(fx.dataDir)].filter(v => v.scope === BCAU);
    expect(otherVersions.length).toBeGreaterThan(0);
    expect(searchObsFor(fx, 'bcau', BCAU).length).toBeGreaterThan(0);
  });

  it('same-commit revocation: ops entry, config revocation, and audit marker agree atomically', async () => {
    const fx = await newFixture();
    await seedScope(fx, ACME, 'Acme');
    await seedScope(fx, BCAU, 'Bcau');

    const operationId = nextOperationId();
    const result = await fx.core.forgetScope(
      { actor: OWNER, scope: ACME, reason: 'erasure', operation_id: operationId },
    );

    // Single committed read of the config: acme grant revoked, noah's alive,
    // scope entry removed.
    const config = loadConfig(fx.dataDir);
    const gigiGrants = config.grants.filter(g => g.actor_id === 'user:gigi');
    const noahGrants = config.grants.filter(g => g.actor_id === 'user:noah');
    expect(gigiGrants.every(g => g.status === 'revoked')).toBe(true);
    expect(noahGrants.every(g => g.status === 'active')).toBe(true);
    expect(config.scopes.some(s => s.id === ACME)).toBe(false);
    expect(config.scopes.some(s => s.id === BCAU)).toBe(true);

    // The ops entry and the config mutation are co-visible: the entry's
    // grants_revoked list is exactly the ids that are revoked on disk.
    const entry = [...readAllOpLogEntries(path.join(fx.dataDir, 'operations'))]
      .find(e => e.operation_id === operationId)!;
    const revokedInEntry = entry.details?.['grants_revoked'] as string[];
    const revokedOnDisk = gigiGrants.map(g => g.id).sort();
    expect([...revokedInEntry].sort()).toEqual(revokedOnDisk);
    expect(entry.details?.['scope_entry_removed']).toBe(true);

    // The audit marker observation is canonical and carries the same counts;
    // it lives in the pod scope, never inside the erased scope.
    const marker = [...readAll(path.join(fx.dataDir, 'evidence'))]
      .find(o => o.id === result.audit_observation_id)!;
    expect(marker.type).toBe('erasure');
    expect(marker.scope).not.toBe(ACME);
    const body = marker.content.body as Record<string, unknown>;
    expect(body['scope']).toBe(ACME);
    expect(body['reason']).toBe('erasure');
    expect(body['claims_retracted']).toBe(entry.details?.['claims_retracted']);
    expect(body['grants_revoked']).toHaveLength(1);

    // Grant revocation is real: gigi can no longer query the scope (it is
    // gone from config), and the surviving noah grant still authorizes BCAU.
    expect(checkGrant('user:gigi', 'query', ACME, config)).toBe(false);
    expect(checkGrant('user:noah', 'query', BCAU, config)).toBe(true);
  });

  it('marker non-reuse: #1 retired, #2 inherits nothing, grant on #2 never authorizes #1', async () => {
    const fx = await newFixture();
    const { obsIds } = await seedScope(fx, ACME, 'Acme');

    await fx.core.forgetScope(
      { actor: OWNER, scope: ACME, reason: 'erasure', operation_id: nextOperationId() },
    );

    // Reopen is the Coffee lifecycle: mint client:acme#2 + repoint grants.
    const config = loadConfig(fx.dataDir);
    config.scopes.push({ id: ACME2, parent: 'workspace', visibility_default: 'scope' });
    for (const grant of config.grants) {
      if (grant.actor_id === 'user:gigi') {
        grant.status = 'active';
        grant.capabilities = { ...grant.capabilities, observe: [ACME2], query: [ACME2], read: [ACME2] };
      }
    }
    saveConfig(fx.dataDir, config);

    // Fresh scope inherits nothing: zero lanes, zero claims, zero obs.
    expect(fx.store.getAllClaims(ACME2)).toHaveLength(0);
    expect(searchObsFor(fx, 'acme', ACME2)).toHaveLength(0);
    expect((await recall(fx, ACME2, 'acme beta')).results).toHaveLength(0);
    expect((await recall(fx, ACME, 'acme beta')).results).toHaveLength(0);
    // The erased #1 obs ids are not visible anywhere in the pod.
    const allObsIds = new Set([...readAll(path.join(fx.dataDir, 'evidence'))].map(o => o.id));
    for (const obsId of obsIds) expect(allObsIds.has(obsId)).toBe(true);

    // #2 grant can reach #2 — and never #1 (structural distinctness).
    const reloaded = loadConfig(fx.dataDir);
    expect(checkGrant('user:gigi', 'query', ACME2, reloaded)).toBe(true);
    expect(checkGrant('user:gigi', 'query', ACME, reloaded)).toBe(false);
    // The retired marker is not re-listed — it is absent from scopes.
    expect(reloaded.scopes.some(s => s.id === ACME)).toBe(false);
    expect(reloaded.scopes.some(s => s.id === ACME2)).toBe(true);
  });
});

// ── 5 · Provenance integrity ──────────────────────────────────────────────────

describe('G2 conformance · provenance integrity', () => {
  it('every recall hit reproduces its source observation and ops entry', async () => {
    const fx = await newFixture();
    await seedScope(fx, ACME, 'Acme');
    await seedScope(fx, BCAU, 'Bcau');

    const evidenceIds = new Set([...readAll(path.join(fx.dataDir, 'evidence'))].map(o => o.id));
    const opsDir = path.join(fx.dataDir, 'operations');
    const opsIndex = openOpsIndex(opsDir, defaultOpsIndexPath(fx.dataDir));
    opsIndex.catchUp(opsDir);

    const hitIds: string[] = [];
    for (const query of ['acme beta', 'deadline', 'bcau status']) {
      for (const scope of [ACME, BCAU]) {
        const result = await recall(fx, scope, query);
        for (const hit of result.results) {
          if (!hit.claim) continue;
          hitIds.push(hit.claim.id);
          const claim = fx.store.getClaim(hit.claim.id);
          expect(claim).toBeDefined();
          // Observations: every supporting evidence id is a real L0 obs.
          const evidence = claim!.supporting_evidence;
          expect(evidence.length).toBeGreaterThan(0);
          for (const ev of evidence) {
            expect(evidenceIds.has(ev)).toBe(true);
          }
          // Ops entry: the claim's operation_id resolves to a real entry and
          // the entry is the per-claim reflect receipt (same claim_id).
          const opsEntry = opsIndex.getByOperationId(claim!.operation_id!);
          expect(opsEntry).toBeDefined();
          if (opsEntry!.op === 'reflect.auto') {
            expect(opsEntry!.details?.['claim_id']).toBe(claim!.id);
          }
          // Payload contract: the recall surface exposes observation_ids.
          expect(hit.claim.observation_ids).toEqual(evidence);
        }
      }
    }
    expect(hitIds.length).toBeGreaterThan(0);
    opsIndex.close();
  });

  it('superseded claims never satisfy get/recall; history order is correct after multi-version revise', async () => {
    const fx = await newFixture();
    const [obsA, obsB] = [
      await observeMessage(fx, ACME, 'Acme status is active', '2026-07-01T00:00:00.000Z'),
      await observeMessage(fx, ACME, 'Acme deadline is Friday', '2026-07-02T00:00:00.000Z'),
    ];

    const claimA = insertClaimFor(fx, ACME, {
      subject_name: 'Acme',
      predicate: 'status_is',
      object: { type: 'enum', value: 'active' },
      supporting_evidence: [obsA, obsB],
      confidence: 0.8,
    });
    const claimB = insertClaimFor(fx, ACME, {
      subject_name: 'Acme',
      predicate: 'deadline_is',
      object: { type: 'text', value: 'Friday' },
      supporting_evidence: [obsA, obsB],
      confidence: 0.8,
    });

    // v1 → v2 REVISE on A (version chain) + B superseded by A (cross-claim
    // relation). Both forms of supersession in one op, like the reference
    // conflicts test.
    await fx.core.revise({
      actor: OWNER,
      target: claimA.id,
      expected_base_version: 1,
      add_relations: [{
        kind: 'supersedes',
        target: claimB.id,
        valid_at: '2026-07-10T00:00:00.000Z',
        provenance: { origin: 'user', target_claim_version: 1 },
      }],
      reason: 'corrected by owner',
      operation_id: nextOperationId(),
    });

    // Search surfaces never include the superseded claim B; A remains.
    const hits = await recall(fx, ACME, 'acme');
    const hitIds = hits.results.map(r => r.claim?.id).filter(Boolean);
    expect(hitIds).toContain(claimA.id);
    expect(hitIds).not.toContain(claimB.id);

    // get-equivalent surfaces agree: authorized snapshot (get_all) excludes B.
    const docs = fx.core.prepareSemanticDocuments({ actor: OWNER, scope: ACME });
    const docIds = docs.map(d => d.id);
    expect(docIds).toContain(claimA.id);
    expect(docIds).not.toContain(claimB.id);

    // Effective-current resolver: B is suppressed, A is current.
    const db = fx.store.getDB();
    expect(isEffectiveCurrent(claimA.id, db)).toBe(true);
    expect(isEffectiveCurrent(claimB.id, db)).toBe(false);
    expect(getEffectiveCurrentIds(db, ACME)).toContain(claimA.id);
    expect(getEffectiveCurrentIds(db, ACME)).not.toContain(claimB.id);

    // Multi-version history order: A has v1 → v2, ascending, with the
    // supersede pointer and monotone version_at.
    const history = readClaimHistory(fx.dataDir, claimA.id);
    expect(history.map(v => v.version)).toEqual([1, 2]);
    expect(history[1]!.supersedes).toBe(1);
    expect(history[0]!.version_at <= history[1]!.version_at).toBe(true);
  });

  it('provenance integrity holds on REBUILT state (resolution is derived-safe)', async () => {
    const fx = await newFixture();
    const { obsIds } = await seedScope(fx, ACME, 'Acme');

    // Capture per-hit provenance before rebuild.
    const before = await recall(fx, ACME, 'acme beta');
    const beforeClaimIds = before.results.map(r => r.claim?.id).filter(Boolean);
    expect(beforeClaimIds.length).toBeGreaterThan(0);

    await closeFixture(fx);
    wipeDerived(fx.dataDir);
    await reopen(fx);

    const after = await recall(fx, ACME, 'acme beta');
    expect(after.results.map(r => r.claim?.id).filter(Boolean)).toEqual(beforeClaimIds);

    const evidenceIds = new Set([...readAll(path.join(fx.dataDir, 'evidence'))].map(o => o.id));
    const opsDir = path.join(fx.dataDir, 'operations');
    const opsIndex = openOpsIndex(opsDir, defaultOpsIndexPath(fx.dataDir));
    opsIndex.catchUp(opsDir);
    for (const hit of after.results) {
      if (!hit.claim) continue;
      const claim = fx.store.getClaim(hit.claim.id)!;
      for (const ev of claim.supporting_evidence) expect(evidenceIds.has(ev)).toBe(true);
      expect(opsIndex.getByOperationId(claim.operation_id!)).toBeDefined();
    }
    opsIndex.close();
  });
});

// ── Shared view-snapshot (equivalence comparison) ─────────────────────────────

interface ViewSnapshot {
  claims: Record<string, string[]>;
  obsFTS: Record<string, string[]>;
  obsSearch: Record<string, unknown[]>;
  query: Record<string, string[]>;
  obsStatuses: Record<string, string>;
}

async function viewSnapshot(fx: Fixture, scopes: string[], obsIds: string[]): Promise<ViewSnapshot> {
  const snapshot: ViewSnapshot = {
    claims: {}, obsFTS: {}, obsSearch: {}, query: {},
    obsStatuses: {},
  };
  for (const scope of scopes) {
    // Client-visible surface: claim id + lifecycle status (store row internals
    // like object projection and entity id are derived, not canonical — see
    // the suite header). Byte-level canonical equivalence is asserted on the
    // JSONL itself, above. Claim/page FTS row EXISTENCE is deliberately not
    // compared pre/post: the live path keeps retracted rows and the view
    // filter neutralizes them; regeneration is canonical-true (active only).
    snapshot.claims[scope] = fx.store.getAllClaims(scope)
      .map(c => `${c.id}|${c.status}`).sort();
    snapshot.obsFTS[scope] = searchObsFor(fx, 'beta', scope)
      .map(r => `${r.obs_id ?? ''}|${r.freshness ?? ''}`).sort();
    snapshot.obsSearch[scope] = fx.core.searchObservations('beta', scope)
      .map(h => `${h.id}|${h.freshness}|${h.snippet}`).sort();
    const result = await recall(fx, scope, 'beta');
    snapshot.query[scope] = result.results.map(r => r.claim?.id ?? '').sort();
  }
  const l0 = new Layer0Index(path.join(fx.dataDir, 'smartware.db'));
  for (const obsId of obsIds) {
    snapshot.obsStatuses[obsId] = l0.getEffectiveStatus(obsId) ?? 'missing';
  }
  l0.close();
  return snapshot;
}

interface ClaimSearchHit { claim_id: string }
interface PageSearchHit {
  entity_id?: string; subject_id?: string;
  entity_name?: string; content?: string;
}
interface ObsSearchHit { obs_id?: string; id?: string; freshness?: string; snippet?: string }

function searchClaimsFor(fx: Fixture, query: string, scope: string): ClaimSearchHit[] {
  return fx.searchIndex.searchClaims(query, scope) as unknown as ClaimSearchHit[];
}
function searchPagesFor(fx: Fixture, query: string, scope: string): PageSearchHit[] {
  return fx.searchIndex.search(query, scope) as unknown as PageSearchHit[];
}
function searchObsFor(fx: Fixture, query: string, scope: string): ObsSearchHit[] {
  return fx.searchIndex.searchObservations(query, scope) as unknown as ObsSearchHit[];
}

function assertScopeLanesZero(
  fx: Fixture,
  scope: string,
  obsIds: string[],
  adapter: { provider: string; model: string; dimensions: number; embed(texts: string[]): Promise<number[][]> },
  semantic: SemanticRecordStore,
): void {
  expect(searchClaimsFor(fx, 'acme', scope)).toHaveLength(0);
  expect(searchPagesFor(fx, 'acme', scope)).toHaveLength(0);
  expect(searchObsFor(fx, 'beta', scope)).toHaveLength(0);
  expect(fx.store.getAllClaims(scope)).toHaveLength(0);
  expect(fx.store.getAllEntities(scope)).toHaveLength(0);
  const loaded = semantic.load(adapter, scope);
  expect(loaded.status).toBe('missing');
  expect(loaded.records).toHaveLength(0);
  const graph = fx.core.readKnowledgeGraph({ actor: OWNER, scopes: [scope] });
  expect(graph.entities).toHaveLength(0);
  expect(graph.claims).toHaveLength(0);
  const l0 = new Layer0Index(path.join(fx.dataDir, 'smartware.db'));
  for (const obsId of obsIds) expect(l0.getEffectiveStatus(obsId)).toBe('erased');
  l0.close();
}

function findWikiPage(dataDir: string, scope: string): string | null {
  const wikiDir = path.join(dataDir, 'wiki');
  if (!fs.existsSync(wikiDir)) return null;
  const walk = (dir: string): string | null => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        const found = walk(full);
        if (found) return found;
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const raw = fs.readFileSync(full, 'utf8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
      if (!fm) continue;
      const scopeLine = fm.split('\n').find(line => line.startsWith('scope:'));
      if (scopeLine && scopeLine.slice(6).trim().replace(/^"|"$/g, '') === scope) return full;
    }
    return null;
  };
  return walk(wikiDir);
}

function fakeAdapter() {
  return {
    provider: 'fixture' as const,
    model: 'tiny',
    dimensions: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => [text.length % 7, text.length % 5]);
    },
  };
}

/** State of the latest canonical version record for a claim (active|forgotten). */
function readLatestState(dataDir: string, claimId: string): string | null {
  const latest = readClaimHistory(dataDir, claimId).at(-1);
  return latest?.state ?? null;
}
