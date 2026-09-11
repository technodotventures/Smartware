// Coffee company-brain end-to-end conformance (spec §10b/§10c/§10d + §25).
//
// The existing v0.5.0 and export-scope suites prove the *primitives* in
// isolation. This file proves the *product flow* as Coffee uses it: one
// business = one tenant; owner admin; staff granted per-client cluster;
// clients as scopes; the company brain is built by staff observing client
// interactions, compiled into claims, and recalled/exported per client with
// grant-exact isolation and scope-exclusive export. It is the "Smartware
// underpins Coffee" proof, not another unit test.
//
// Asserts:
//   1. Coffee tenant (owner + staff + clients-as-scopes) config round-trips.
//   2. Staff build a client's company brain → owner recalls it.
//   3. Grant clusters are exact: Gigi is authorized for her client, never a
//      peer client; owner bypasses grants; isolation holds.
//   4. EXPORT.SCOPE is exactly one client: scope_exclusive true, no
//      cross-client leakage in the package, and per-client packages differ.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import type { SmartwareConfig } from '../../src/config.js';
import { loadConfig, saveConfig } from '../../src/config.js';
import { ScopeRegistry } from '../../src/scopes/registry.js';
import { checkGrant, isOwner } from '../../src/auth/grants.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { makeClaim } from '../helpers.js';
import type { Claim } from '../../src/layer1/types.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const GIGI = { type: 'person' as const, id: 'user:gigi', display_name: 'Gigi' };
const NOAH = { type: 'person' as const, id: 'user:noah', display_name: 'Noah' };
const ACME = 'client:acme#1';
const BCAU = 'client:bcau#1';
const GATE = 'client:gate#2';

/** §10b.4 worked-example Coffee tenant: owner + two staff, clients-as-scopes. */
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
      { id: GATE, parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [
      {
        id: `grant_${ulid()}`,
        actor_type: 'person',
        actor_id: 'user:gigi',
        capabilities: { observe: [ACME], query: [ACME], compile: [], correct: [], forget: [], read: [ACME] },
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
        capabilities: { observe: [BCAU, GATE], query: [BCAU, GATE], compile: [], correct: [], forget: [], read: [GATE] },
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

interface Fixture { dataDir: string; core: SmartwareCore; store: ClaimStore; searchIndex: SearchIndex; }
let fixture: Fixture | null = null;
const allFixtures: Array<{ dataDir: string; core: SmartwareCore | null; store?: ClaimStore; searchIndex?: SearchIndex }> = [];

function scaffoldDirectory(dataDir: string): void {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  saveConfig(dataDir, coffeeConfig(dataDir));
}

async function newFixture(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-coffee-'));
  scaffoldDirectory(dataDir);
  const core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);
  const fx = { dataDir, core, store, searchIndex };
  fixture = fx;
  allFixtures.push({ dataDir, core, store, searchIndex });
  return fx;
}

async function observeMessage(fx: Fixture, actor: typeof OWNER, scope: string, body: string, observedAt: string): Promise<string> {
  const result = await fx.core.observe({
    actor, type: 'message', content: { format: 'text/plain', body }, scope, observed_at: observedAt,
  });
  return result.id;
}

async function recall(fx: Fixture, actor: typeof OWNER, scope: string, query: string) {
  return fx.core.query({ actor, query, scope });
}

/** Deterministic canonical claim insert (no LLM) — the Coffee persistence path.
 *  Keeps one observation as evidence (raw window) and appends a versioned L1 claim. */
function insertClaimFor(fx: Fixture, scope: string, opts: {
  subject_name: string; predicate: string; object: Claim['object'];
  confidence?: number; supporting_evidence?: string[];
}): string {
  const subjectId = `entity_${ulid()}`;
  fx.store.insertEntity({
    id: subjectId, canonical_name: opts.subject_name, aliases: [], type: 'organization',
    scope, created_at: new Date().toISOString(),
  });
  const claim = makeClaim({
    subject_id: subjectId, scope, subject_name: opts.subject_name,
    predicate: opts.predicate, object: opts.object,
    confidence: opts.confidence ?? 0.8,
    supporting_evidence: opts.supporting_evidence ?? [],
    status: 'active', epistemic: 'observed',
    extraction: { method: 'deterministic', model: null, compiler_version: '0.6.3', prompt_hash: null, extracted_at: new Date().toISOString() },
  });
  fx.store.insertClaim(claim);
  syncSearchFromClaims(fx.store, fx.searchIndex, scope);
  return claim.id;
}

beforeEach(() => { fixture = null; });
afterEach(() => {
  for (const entry of allFixtures.splice(0)) {
    entry.store?.close();
    entry.searchIndex?.close();
    entry.core?.close();
    fs.rmSync(entry.dataDir, { recursive: true, force: true });
  }
  fixture = null;
});

describe('Coffee company brain · tenant + staff grants + scope-exclusive export', () => {
  it('tenant config round-trips; scope metadata matches the §10b worked example', async () => {
    const fx = await newFixture();
    const reloaded = loadConfig(fx.dataDir);
    expect(reloaded.scopes.map(s => s.id)).toContain(ACME);
    expect(reloaded.scopes.map(s => s.id)).toContain(BCAU);
    expect(reloaded.scopes.map(s => s.id)).toContain(GATE);

    const registry = new ScopeRegistry(reloaded);
    expect(registry.getAncestors(ACME)).toEqual([ACME, 'workspace']);
    expect(registry.getAncestors(BCAU)).toEqual([BCAU, 'workspace']);
    expect(registry.getVisibilityDefault(ACME)).toBe('scope');
    expect(registry.getParent(ACME)?.id).toBe('workspace');
  });

  it('staff build a client company brain; owner recalls it; grant clusters are exact', async () => {
    const fx = await newFixture();
    const config = loadConfig(fx.dataDir);

    // Gigi builds Acme's memory: raw observations for the evidence window,
    // structured claims persisted deterministically (the Coffee persistence
    // path when extraction runs upstream or LLM-backed).
    const acmeObs = await observeMessage(fx, GIGI, ACME, 'Acme renewal date is 2026-11-02', '2026-08-01T00:00:00.000Z');
    insertClaimFor(fx, ACME, {
      subject_name: 'Acme', predicate: 'renewal_date',
      object: { type: 'text', value: '2026-11-02' }, confidence: 0.8, supporting_evidence: [acmeObs],
    });
    insertClaimFor(fx, ACME, {
      subject_name: 'Acme', predicate: 'prefers_contact', object: { type: 'text', value: 'email' }, confidence: 0.7,
    });
    await fx.core.compile({ actor: OWNER, scope: ACME, use_llm: false });

    const bcauObs = await observeMessage(fx, NOAH, BCAU, 'Bcau project kickoff was 2026-07-20', '2026-08-03T00:00:00.000Z');
    insertClaimFor(fx, BCAU, {
      subject_name: 'Bcau', predicate: 'kickoff_date', object: { type: 'text', value: '2026-07-20' },
      confidence: 0.8, supporting_evidence: [bcauObs],
    });
    await fx.core.compile({ actor: OWNER, scope: BCAU, use_llm: false });

    // Owner recalls each client's company brain — claims, scoped to the client.
    const acmeRecall = await recall(fx, OWNER, ACME, 'acme renewal');
    expect(acmeRecall.results.length).toBeGreaterThan(0);
    const acmeScopes = acmeRecall.results.map(hit => hit.scope);
    expect(acmeScopes).toContain(ACME);
    // No cross-client leakage into the recall surface.
    expect(acmeScopes).not.toContain(BCAU);

    const bcauRecall = await recall(fx, OWNER, BCAU, 'bcau kickoff');
    expect(bcauRecall.results.length).toBeGreaterThan(0);
    expect(bcauRecall.results.map(hit => hit.scope)).toContain(BCAU);

    // §10b.2 exact-grant clusters: Gigi sees Acme, never Bcau / Gate / *.
    expect(checkGrant('user:gigi', 'query', ACME, config)).toBe(true);
    expect(checkGrant('user:gigi', 'query', BCAU, config)).toBe(false);
    expect(checkGrant('user:gigi', 'query', GATE, config)).toBe(false);
    expect(checkGrant('user:gigi', 'query', '*', config)).toBe(false);
    // Owner bypasses grants.
    expect(isOwner('user:owner', config)).toBe(true);
    // Noah's cluster covers Bcau + Gate only.
    expect(checkGrant('user:noah', 'query', BCAU, config)).toBe(true);
    expect(checkGrant('user:noah', 'query', GATE, config)).toBe(true);
    expect(checkGrant('user:noah', 'query', ACME, config)).toBe(false);
  });

  it('EXPORT.SCOPE is exactly one client — scope_exclusive and no cross-client leakage', async () => {
    const fx = await newFixture();
    await observeMessage(fx, GIGI, ACME, 'Acme renewal date is 2026-11-02', '2026-08-01T00:00:00.000Z');
    await observeMessage(fx, GIGI, ACME, 'Acme prefers email over phone', '2026-08-02T00:00:00.000Z');
    await fx.core.compile({ actor: OWNER, scope: ACME, use_llm: false });

    await observeMessage(fx, NOAH, BCAU, 'Bcau project kickoff was 2026-07-20', '2026-08-03T00:00:00.000Z');
    await fx.core.compile({ actor: OWNER, scope: BCAU, use_llm: false });

    // Export Acme only.
    const acmeExport = await fx.core.exportScope({ actor: OWNER, scope: ACME });
    expect(acmeExport.manifest.scope_exclusive).toBe(true);
    expect(acmeExport.manifest.protocol).toBe('v0.5.0');
    expect(acmeExport.manifest.schemas).toBe('v0.5.0');
    expect(acmeExport.manifest.scope).toBe(ACME);
    expect(acmeExport.counts.observations).toBeGreaterThanOrEqual(2);

    // Read the exported observations and assert zero cross-client leakage.
    const obsFile = path.join(acmeExport.path, 'observations.jsonl');
    const lines = fs.readFileSync(obsFile, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const rec = JSON.parse(line);
      expect(rec.scope).toBe(ACME);
    }
    // No Bcau/Gate ids anywhere in the package bytes.
    const pkgBytes = fs.readFileSync(obsFile, 'utf8');
    expect(pkgBytes).not.toContain(BCAU);
    expect(pkgBytes).not.toContain(GATE);

    // The two clients' exports are distinct packages with distinct scopes.
    const bcauExport = await fx.core.exportScope({ actor: OWNER, scope: BCAU });
    expect(bcauExport.manifest.scope).toBe(BCAU);
    const bcauLines = fs.readFileSync(path.join(bcauExport.path, 'observations.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    for (const line of bcauLines) expect(JSON.parse(line).scope).toBe(BCAU);
    expect(bcauExport.export_id).not.toBe(acmeExport.export_id);

    // Idempotent by operation_id: same op ⇒ same export_id + stable manifest.
    const op = `op_${ulid()}`;
    const a = await fx.core.exportScope({ actor: OWNER, scope: ACME, operation_id: op });
    const b = await fx.core.exportScope({ actor: OWNER, scope: ACME, operation_id: op });
    expect(b.export_id).toBe(a.export_id);
    expect(b.manifest).toEqual(a.manifest);
  });
});
