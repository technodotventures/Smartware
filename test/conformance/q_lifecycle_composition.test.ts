// Coffee lifecycle composition — end-to-end scenarios across retention, expiry,
// offboarding, erasure, export/restore, return (#N), consolidation and the
// dispute/hold lane (spec §10, §10a, §10c; ADR-0001/0002/0006).
//
// The primitive suites (forget-scope, export-scope, restore-scope, retention)
// prove each operation in isolation. This file runs the *composed* Coffee flows a
// company brain actually executes, in order, on live SmartwareCore instances:
//
//   C1  client retention expiry → sweep receipt, every lane, rebuilt indexes
//   C2  reversible offboarding → silence, same-commit grant revoke, REVIVE
//   C3  irreversible erasure after the hold lane → export snapshot survives,
//       deletion certificate, wipe-and-rebuild equivalence
//   C4  grant revocation is part of the same operation (staff loses access)
//   C5  export/restore equivalence for an offboarded scope, into a brain that
//       already holds another client's content
//   C6  returning client: fresh #2 marker inherits nothing, exact-id grants
//   C7  consolidation preserves the correction path and the evidence lineage
//   C8  legal-hold conflict (v1 composition): dispute → offboarding + export,
//       erasure only after the owner attestation is recorded

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import type { SmartwareConfig } from '../../src/config.js';
import { loadConfig, saveConfig } from '../../src/config.js';
import { ScopeRegistry } from '../../src/scopes/registry.js';
import { checkGrant } from '../../src/auth/grants.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims, syncObservationsFromEvidence } from '../../src/layer3/search.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { isEffectiveCurrent } from '../../src/layer1/effective_current.js';
import { SemanticRecordStore } from '../../src/layer3/semantic-store.js';
import { iterAllClaimVersions } from '../../src/layer1/jsonl.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';
import { ProtocolError } from '../../src/auth/middleware.js';
import { makeClaim } from '../helpers.js';
import type { Claim } from '../../src/layer1/types.js';
import type { Actor } from '../../src/layer0/types.js';

const OWNER: Actor = { type: 'person', id: 'user:owner', display_name: 'Owner' };
const GIGI: Actor = { type: 'person', id: 'user:gigi', display_name: 'Gigi' };
const NOAH: Actor = { type: 'person', id: 'user:noah', display_name: 'Noah' };
const ACME = 'client:acme#1';
const BCAU = 'client:bcau#1';

const semanticAdapter = {
  provider: 'fixture' as const,
  model: 'tiny-lifecycle',
  dimensions: 2,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.5, 0.5]);
  },
};

function tenantConfig(dataDir: string, opts: { retention?: SmartwareConfig['retention'] } = {}): SmartwareConfig {
  const config: SmartwareConfig = {
    instance_id: `smartware_${ulid()}`,
    owner_id: OWNER.id,
    writer_id: `writer_${ulid()}`,
    version: '0.7.0',
    data_dir: dataDir,
    scopes: [
      { id: 'self', parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: ACME, parent: 'workspace', visibility_default: 'scope' },
      { id: BCAU, parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [
      {
        id: `grant_${ulid()}`,
        actor_type: 'person',
        actor_id: GIGI.id,
        capabilities: { observe: [ACME], query: [ACME], compile: [], correct: [], forget: [], read: [ACME] },
        trusted: false,
        quarantine: false,
        created_at: '2026-08-01T00:00:00.000Z',
        expires_at: null,
        status: 'active',
      },
      {
        id: `grant_${ulid()}`,
        actor_type: 'person',
        actor_id: NOAH.id,
        capabilities: { observe: [BCAU], query: [BCAU], compile: [], correct: [], forget: [], read: [BCAU] },
        trusted: false,
        quarantine: false,
        created_at: '2026-08-01T00:00:00.000Z',
        expires_at: null,
        status: 'active',
      },
    ],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
  if (opts.retention) config.retention = opts.retention;
  return config;
}

interface Fx {
  dataDir: string;
  core: SmartwareCore;
  store: ClaimStore;
  searchIndex: SearchIndex;
  semantic: SemanticRecordStore;
}

const live: Fx[] = [];

function scaffoldDirectory(dataDir: string, opts: { retention?: SmartwareConfig['retention'] } = {}): void {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  saveConfig(dataDir, tenantConfig(dataDir, opts));
}

async function newBrain(opts: { retention?: SmartwareConfig['retention'] } = {}): Promise<Fx> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-lifecycle-'));
  scaffoldDirectory(dataDir, opts);
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);
  const semantic = new SemanticRecordStore(path.join(dataDir, 'semantic.db'));
  const fx: Fx = { dataDir, core, store, searchIndex, semantic };
  live.push(fx);
  return fx;
}

/** Reopen the core on the same brain (leases are process-scoped, one at a time). */
async function reopenCore(fx: Fx): Promise<void> {
  fx.core.close();
  fx.core = await SmartwareCore.open({ dataDir: fx.dataDir, ownerId: OWNER.id });
}

afterEach(() => {
  for (const fx of live.splice(0)) {
    try { fx.semantic.close(); } catch { /* already closed */ }
    try { fx.searchIndex.close(); } catch { /* already closed */ }
    try { fx.store.close(); } catch { /* already closed */ }
    try { fx.core.close(); } catch { /* already closed */ }
    fs.rmSync(fx.dataDir, { recursive: true, force: true });
  }
});

async function observe(fx: Fx, actor: Actor, scope: string, body: string, observedAt = '2026-08-01T00:00:00.000Z'): Promise<string> {
  const result = await fx.core.observe({
    actor, type: 'message', content: { format: 'text/plain', body }, scope, observed_at: observedAt,
  });
  return result.id;
}

/** Route-b persistence: the host extracted the claim; Smartware stores it canonically. */
function persistClaim(fx: Fx, opts: {
  scope: string; subject: string; predicate: string;
  value: string; evidence?: string[]; confidence?: number;
}): string {
  const subjectId = `entity_${ulid()}`;
  fx.store.insertEntity({
    id: subjectId, canonical_name: opts.subject, aliases: [], type: 'organization',
    scope: opts.scope, created_at: new Date().toISOString(),
  });
  const claim: Claim = makeClaim({
    subject_id: subjectId, subject_name: opts.subject, scope: opts.scope,
    predicate: opts.predicate, object: { type: 'text', value: opts.value },
    confidence: opts.confidence ?? 0.8,
    supporting_evidence: opts.evidence ?? [],
    status: 'active', epistemic: 'observed',
    extraction: { method: 'deterministic', model: null, compiler_version: '0.7.0', prompt_hash: null, extracted_at: new Date().toISOString() },
  });
  fx.store.insertClaim(claim);
  syncSearchFromClaims(fx.store, fx.searchIndex, opts.scope);
  return claim.id;
}

/** Persist this scope's vector records through the canonical boundary. */
async function refreshSemantic(fx: Fx, scope: string): Promise<void> {
  await fx.core.syncSemanticIndex({ actor: OWNER, scope }, { store: fx.semantic, adapter: semanticAdapter });
}

interface LaneProbe {
  claimLane: number;
  claimLaneWithForgotten: number;
  rawWindow: number;
  contextSeeds: number;
  hybrid: number;
}

/** Every read lane Coffee can ask through, for one scope + query. */
async function probeLanes(fx: Fx, actor: Actor, scope: string, query: string): Promise<LaneProbe> {
  const claimLane = await fx.core.query({ actor, query, scope, limit: 10 });
  const claimLaneWithForgotten = await fx.core.query({ actor, query, scope, limit: 10, include_forgotten: true });
  const rawWindow = fx.core.searchObservations({ actor, query, scope });
  const bundle = await fx.core.context({ actor_id: actor.id, query, scope, limit: 10 });
  const hybrid = await fx.core.recallHybrid(
    { actor, query, scope, limit: 10 },
    { store: fx.semantic, adapter: semanticAdapter, min_similarity: 0.0, limit: 10 },
  );
  return {
    claimLane: claimLane.results.length,
    claimLaneWithForgotten: claimLaneWithForgotten.results.length,
    rawWindow: rawWindow.length,
    contextSeeds: bundle.seeds.length,
    hybrid: hybrid.hybrid_results.length,
  };
}

/** Close the derived surfaces, wipe them, and rebuild from canonical logs only. */
function rebuildIndexes(fx: Fx): { layer0: Layer0Index; store: ClaimStore; searchIndex: SearchIndex } {
  fx.core.close();
  fx.searchIndex.close();
  fx.store.close();
  const dbPath = path.join(fx.dataDir, 'smartware.db');
  for (const name of ['smartware.db', 'smartware.db-wal', 'smartware.db-shm']) {
    fs.rmSync(path.join(fx.dataDir, name), { force: true });
  }
  const layer0 = new Layer0Index(dbPath);
  const store = new ClaimStore(dbPath);
  store.setDataDir(fx.dataDir);
  const searchIndex = new SearchIndex(dbPath);
  layer0.catchUp(path.join(fx.dataDir, 'evidence'));
  syncSearchFromClaims(store, searchIndex);
  syncObservationsFromEvidence(path.join(fx.dataDir, 'evidence'), layer0, searchIndex);
  return { layer0, store, searchIndex };
}

function opsEntries(fx: Fx, operationId: string) {
  return [...readAllOpLogEntries(path.join(fx.dataDir, 'operations'))]
    .filter(entry => entry.operation_id === operationId);
}

/** The single evidence day-file a fixture wrote (observe() lands on today's file). */
function dayFile(fx: Fx): string {
  const files = fs.readdirSync(path.join(fx.dataDir, 'evidence')).filter(name => name.endsWith('.jsonl'));
  expect(files).toHaveLength(1);
  return files[0]!;
}

function evidenceBytes(fx: Fx): string {
  return fs.readFileSync(path.join(fx.dataDir, 'evidence', dayFile(fx)), 'utf8');
}

describe('Coffee lifecycle composition', () => {
  it('C1 · client retention expiry: tombstone + retraction, receipt, every lane, rebuilt indexes', async () => {
    const fx = await newBrain({
      retention: {
        default: { policy: 'forever', duration_days: null },
        scope_overrides: { [ACME]: { policy: 'duration', duration_days: 1 } },
      },
    });
    const oldObs = await observe(fx, GIGI, ACME, 'Acme renewal note (stale)', '2026-08-01T00:00:00.000Z');
    const freshObs = await observe(fx, GIGI, ACME, 'Acme renewal note (fresh)', '2026-09-10T00:00:00.000Z');
    persistClaim(fx, { scope: ACME, subject: 'Acme', predicate: 'renewal_note', value: 'stale', evidence: [oldObs] });
    persistClaim(fx, { scope: ACME, subject: 'Acme', predicate: 'renewal_note', value: 'fresh', evidence: [freshObs] });
    await refreshSemantic(fx, ACME);

    const before = await probeLanes(fx, OWNER, ACME, 'renewal');
    expect(before.claimLane).toBeGreaterThan(0);

    const operationId = `op_${ulid()}`;
    const sweep = await fx.core.expireRetention({ actor: OWNER, scope: ACME, as_of: '2026-09-10T00:00:00.000Z', operation_id: operationId });
    expect(sweep.observations_expired).toBe(1);
    expect(sweep.claims_retracted).toBe(1);

    // Receipt: exactly one ops entry with the exact counts.
    const entries = opsEntries(fx, operationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.op).toBe('retention.expire');
    expect(entries[0]!.details?.['observations_expired']).toBe(1);
    expect(entries[0]!.details?.['claims_retracted']).toBe(1);

    // The expired observation is terminal in L0; the fresh one is untouched.
    expect(fx.core.readObservationEvidence({ actor: OWNER, observation_id: oldObs })?.status).toBe('tombstoned');
    expect(fx.core.readObservationEvidence({ actor: OWNER, observation_id: freshObs })?.status).toBe('accepted');

    // Every lane: the sole-evidence claim is out; the fresh one stays.
    const after = await probeLanes(fx, OWNER, ACME, 'renewal');
    expect(after.claimLane).toBeGreaterThan(0); // the fresh claim survives
    const afterStale = await probeLanes(fx, OWNER, ACME, 'stale');
    expect(afterStale.claimLane).toBe(0);
    expect(afterStale.rawWindow).toBe(0);
    expect(afterStale.contextSeeds).toBe(0);

    // Evidence retained (append-only): the canonical record is still exportable.
    const exported = await fx.core.exportScope({ actor: OWNER, scope: ACME });
    expect(exported.counts.observations).toBeGreaterThanOrEqual(2);

    // Rebuilt indexes agree with the live ones.
    const rebuilt = rebuildIndexes(fx);
    try {
      expect(rebuilt.layer0.getEffectiveStatus(oldObs)).toBe('tombstoned');
      expect(rebuilt.layer0.getEffectiveStatus(freshObs)).toBe('accepted');
      expect(rebuilt.searchIndex.searchObservations('stale', ACME)).toHaveLength(0);
      const retracted = [...iterAllClaimVersions(fx.dataDir)].filter(record => record.scope === ACME);
      expect(retracted.some(record => record.state === 'forgotten')).toBe(true);
    } finally {
      rebuilt.layer0.close();
      rebuilt.store.close();
      rebuilt.searchIndex.close();
    }
  });

  it('C2 · reversible offboarding: every lane silent, grants revoked same commit, REVIVE restores recall', async () => {
    const fx = await newBrain();
    const obs = await observe(fx, GIGI, ACME, 'Acme prefers email over phone');
    const claimId = persistClaim(fx, { scope: ACME, subject: 'Acme', predicate: 'prefers_contact', value: 'email', evidence: [obs] });
    await refreshSemantic(fx, ACME);
    expect((await fx.core.query({ actor: GIGI, query: 'prefers email', scope: ACME })).results.length).toBeGreaterThan(0);

    const operationId = `op_${ulid()}`;
    const offboard = await fx.core.forgetScope({
      actor: OWNER, scope: ACME, reason: 'offboarding',
      owner_pointer: 'client since 2023, 4 jobs, no disputes', operation_id: operationId,
    });
    expect(offboard.claims_retracted).toBe(1);
    expect(offboard.observations_retracted).toBeGreaterThanOrEqual(1);
    expect(offboard.scope_entry_removed).toBe(false);
    expect(offboard.grants_revoked).not.toHaveLength(0);

    // Grant revocation is part of THIS operation (config already saved).
    const reloaded = loadConfig(fx.dataDir);
    expect(reloaded.grants.filter(grant => grant.actor_id === GIGI.id).every(grant => grant.status === 'revoked')).toBe(true);
    expect(reloaded.grants.filter(grant => grant.actor_id === NOAH.id).every(grant => grant.status === 'active')).toBe(true);
    expect(reloaded.scopes.some(scope => scope.id === ACME)).toBe(true);
    await expect(fx.core.query({ actor: GIGI, query: 'prefers email', scope: ACME })).rejects.toBeInstanceOf(ProtocolError);

    // Every lane is silent for the owner too (tombstoned = terminal).
    const silent = await probeLanes(fx, OWNER, ACME, 'prefers');
    expect(silent.claimLane).toBe(0);
    expect(silent.rawWindow).toBe(0);
    expect(silent.contextSeeds).toBe(0);
    expect(silent.hybrid).toBe(0);
    expect(fx.core.readObservationEvidence({ actor: OWNER, observation_id: obs })?.status).toBe('tombstoned');

    // ONE ops entry, replay-safe.
    expect(opsEntries(fx, operationId)).toHaveLength(1);
    const replay = await fx.core.forgetScope({
      actor: OWNER, scope: ACME, reason: 'offboarding',
      owner_pointer: 'client since 2023, 4 jobs, no disputes', operation_id: operationId,
    });
    expect(replay).toEqual(offboard);

    // Reversibility: REVIVE restores the claim in canonical state. Recall stays
    // evidence-suppressed while the scope's observations are terminal (the
    // byte-clean view rule, v050-rebuild-forget-provenance): re-engagement runs
    // through a fresh #2 marker, never silent resurrection (§10).
    const revive = await fx.core.revive({
      actor: OWNER, tombstone_id: `tomb_${claimId.slice(6)}`, reason: 'client re-engaged', operation_id: `op_${ulid()}`,
    });
    expect(revive.status).toBe('revived');
    expect(fx.store.getClaim(claimId)?.status).toBe('active');
    expect(isEffectiveCurrent(claimId, fx.store.getDB())).toBe(false);
    const afterRevive = await probeLanes(fx, OWNER, ACME, 'prefers');
    expect(afterRevive.rawWindow).toBe(0);
    expect(afterRevive.hybrid).toBe(0);

    // The offboarding audit marker carries the owner-pointer for the return flow.
    const marker = [...fs.readFileSync(path.join(fx.dataDir, 'evidence', dayFile(fx)), 'utf8')
      .split('\n').filter(Boolean)
      .map(line => JSON.parse(line))].find(obs => obs.type === 'erasure' && obs.operation_id === operationId);
    expect(marker.content.body.owner_pointer).toBe('client since 2023, 4 jobs, no disputes');

    // Observations stay terminal (offboarding tombstones evidence, spec §10).
    expect(fx.core.readObservationEvidence({ actor: OWNER, observation_id: obs })?.status).toBe('tombstoned');
  });

  it('C3 · erasure after the hold lane: the pre-erasure export survives, and nothing survives the wipe', async () => {
    const fx = await newBrain();
    const obs = await observe(fx, GIGI, ACME, 'Acme dispute timeline');
    persistClaim(fx, { scope: ACME, subject: 'Acme', predicate: 'dispute_note', value: 'timeline', evidence: [obs] });
    await refreshSemantic(fx, ACME);

    // F1: export snapshot BEFORE any mutation.
    const snapshot = await fx.core.exportScope({ actor: OWNER, scope: ACME, operation_id: `op_${ulid()}` });
    const snapshotBytes = {
      manifest: fs.readFileSync(path.join(snapshot.path, 'manifest.json'), 'utf8'),
      observations: fs.readFileSync(path.join(snapshot.path, 'observations.jsonl'), 'utf8'),
      claims: fs.readFileSync(path.join(snapshot.path, 'claims.jsonl'), 'utf8'),
    };

    const eraseOp = `op_${ulid()}`;
    const erased = await fx.core.forgetScope({
      actor: OWNER, scope: ACME, reason: 'erasure', export_id: snapshot.export_id, operation_id: eraseOp,
    });
    expect(erased.scope_entry_removed).toBe(true);
    expect(fx.core.readObservationEvidence({ actor: OWNER, observation_id: obs })?.status).toBe('erased');

    // The package is untouched by the erasure — it is the portable proof.
    expect(fs.readFileSync(path.join(snapshot.path, 'manifest.json'), 'utf8')).toBe(snapshotBytes.manifest);
    expect(fs.readFileSync(path.join(snapshot.path, 'observations.jsonl'), 'utf8')).toBe(snapshotBytes.observations);
    expect(fs.readFileSync(path.join(snapshot.path, 'claims.jsonl'), 'utf8')).toBe(snapshotBytes.claims);

    // The erasure receipt links the snapshot.
    const entry = opsEntries(fx, eraseOp);
    expect(entry).toHaveLength(1);
    expect(entry[0]!.details?.['export_id']).toBe(snapshot.export_id);

    // Every lane silent, including the vector lane.
    const silent = await probeLanes(fx, OWNER, ACME, 'dispute');
    expect(silent).toEqual({ claimLane: 0, claimLaneWithForgotten: 0, rawWindow: 0, contextSeeds: 0, hybrid: 0 });

    // Post-erasure export = empty package + deletion certificate pointing at the marker.
    const certificate = await fx.core.exportScope({ actor: OWNER, scope: ACME });
    expect(certificate.counts.observations).toBe(0);
    expect(certificate.counts.claims).toBe(0);
    expect(certificate.manifest.deletion_certificate?.audit_observation_id).toBe(erased.audit_observation_id);
    expect(certificate.manifest.deletion_certificate?.operation_id).toBe(eraseOp);

    // Wipe-and-rebuild equivalence from the canonical log alone.
    const rebuilt = rebuildIndexes(fx);
    try {
      expect(rebuilt.layer0.getEffectiveStatus(obs)).toBe('erased');
      expect(rebuilt.searchIndex.searchClaims('dispute', ACME)).toHaveLength(0);
      expect(rebuilt.searchIndex.search('acme', ACME)).toHaveLength(0);
      expect(rebuilt.searchIndex.searchObservations('dispute', ACME)).toHaveLength(0);
    } finally {
      rebuilt.layer0.close();
      rebuilt.store.close();
      rebuilt.searchIndex.close();
    }
  });

  it('C4 · grant revocation is the same operation — staff access dies with the offboard', async () => {
    const fx = await newBrain();
    const obs = await observe(fx, GIGI, ACME, 'Acme design review notes');
    persistClaim(fx, { scope: ACME, subject: 'Acme', predicate: 'review_note', value: 'notes', evidence: [obs] });

    // Gigi can read before the offboard; Noah's peer-client grant is independent.
    expect((await fx.core.query({ actor: GIGI, query: 'review', scope: ACME })).total_found).toBeGreaterThan(0);
    expect(checkGrant(GIGI.id, 'query', ACME, loadConfig(fx.dataDir))).toBe(true);
    expect(checkGrant(NOAH.id, 'query', BCAU, loadConfig(fx.dataDir))).toBe(true);

    const offboard = await fx.core.forgetScope({ actor: OWNER, scope: ACME, reason: 'offboarding', operation_id: `op_${ulid()}` });
    expect(offboard.grants_revoked).toHaveLength(1);

    // The revocation is visible in the SAME commit as the retraction: config on
    // disk is already revoked, and the grant id that was revoked matches.
    const reloaded = loadConfig(fx.dataDir);
    const gigiGrant = reloaded.grants.find(grant => grant.actor_id === GIGI.id)!;
    expect(offboard.grants_revoked).toContain(gigiGrant.id);
    expect(gigiGrant.status).toBe('revoked');
    await expect(fx.core.query({ actor: GIGI, query: 'review', scope: ACME })).rejects.toBeInstanceOf(ProtocolError);
    // A revoked grant does not bleed into the peer client.
    expect((await fx.core.query({ actor: NOAH, query: 'review', scope: BCAU })).total_found).toBe(0);
  });

  it('C5 · export → restore equivalence: live history AND a retained scope come back identical — even into a busier brain', async () => {
    // Source: one client with a mixed lifecycle (one expired observation, one
    // live one), exported canonically.
    const source = await newBrain({
      retention: {
        default: { policy: 'forever', duration_days: null },
        scope_overrides: { [ACME]: { policy: 'duration', duration_days: 1 } },
      },
    });
    const expiredObs = await observe(source, GIGI, ACME, 'Acme stale billing note', '2026-08-01T00:00:00.000Z');
    const liveObs = await observe(source, GIGI, ACME, 'Acme current billing note', '2026-09-10T00:00:00.000Z');
    persistClaim(source, { scope: ACME, subject: 'Acme', predicate: 'billing_note', value: 'stale', evidence: [expiredObs] });
    const liveClaim = persistClaim(source, { scope: ACME, subject: 'Acme', predicate: 'billing_note', value: 'current', evidence: [liveObs] });
    await source.core.expireRetention({ actor: OWNER, scope: ACME, as_of: '2026-09-10T00:00:00.000Z' });

    const exported = await source.core.exportScope({ actor: OWNER, scope: ACME, operation_id: `op_${ulid()}` });
    expect(exported.counts.claims).toBeGreaterThan(0);

    // Target holds ANOTHER client with MORE evidence history than the source, so
    // the restored records carry sequences below the target's replay watermark —
    // restore must still bring every record across (no silent skip), and must not
    // disturb the existing tenant data.
    const target = await newBrain();
    let lastBcauObs = '';
    for (let day = 1; day <= 5; day += 1) {
      lastBcauObs = await observe(target, NOAH, BCAU, `Bcau note ${day}`, `2026-06-0${day}T00:00:00.000Z`);
    }
    persistClaim(target, { scope: BCAU, subject: 'Bcau', predicate: 'note', value: 'busy history', evidence: [lastBcauObs] });

    const restored = await target.core.restoreScope({ actor: OWNER, package_dir: exported.path, operation_id: `op_${ulid()}` });
    expect(restored.status).toBe('restored');
    expect(restored.counts.observations).toBe(exported.counts.observations);

    // Lane-for-lane equivalence with the source — including the expired record.
    const inSource = await probeLanes(source, OWNER, ACME, 'billing');
    const inTarget = await probeLanes(target, OWNER, ACME, 'billing');
    expect(inTarget).toEqual(inSource);
    expect(inTarget.claimLane).toBe(1);
    expect(inTarget.rawWindow).toBe(1);
    expect(target.core.readObservationEvidence({ actor: OWNER, observation_id: expiredObs })?.status).toBe('tombstoned');
    expect(target.core.readObservationEvidence({ actor: OWNER, observation_id: liveObs })?.status).toBe('accepted');

    // Claim identity and provenance survive the round trip.
    const liveRows = await target.core.query({ actor: OWNER, query: 'billing', scope: ACME });
    expect(liveRows.results.map(hit => hit.claim?.id)).toContain(liveClaim);

    // The target's own client is untouched.
    expect((await target.core.query({ actor: NOAH, query: 'Bcau note', scope: BCAU })).total_found).toBeGreaterThan(0);

    // (b) The offboarded case: the scope-level tombstone travels with the package,
    // so a retained scope restores as retained (silent), not as resurrected.
    const retained = await newBrain();
    const retainedObs = await observe(retained, GIGI, ACME, 'Acme retained evidence');
    persistClaim(retained, { scope: ACME, subject: 'Acme', predicate: 'retained_note', value: 'retained', evidence: [retainedObs] });
    await retained.core.forgetScope({ actor: OWNER, scope: ACME, reason: 'offboarding', owner_pointer: 'held for review', operation_id: `op_${ulid()}` });
    const retainedPackage = await retained.core.exportScope({ actor: OWNER, scope: ACME, operation_id: `op_${ulid()}` });

    const fresh = await newBrain();
    const restoredHeld = await fresh.core.restoreScope({ actor: OWNER, package_dir: retainedPackage.path, operation_id: `op_${ulid()}` });
    expect(restoredHeld.status).toBe('restored');
    const sourceHeld = await probeLanes(retained, OWNER, ACME, 'retained');
    const targetHeld = await probeLanes(fresh, OWNER, ACME, 'retained');
    expect(targetHeld).toEqual(sourceHeld);
    expect(targetHeld.rawWindow).toBe(0);
    expect(fresh.core.readObservationEvidence({ actor: OWNER, observation_id: retainedObs })?.status).toBe('tombstoned');

    // Rebuilt indexes in the restored brains agree with the live ones.
    const rebuilt = rebuildIndexes(fresh);
    try {
      expect(rebuilt.layer0.getEffectiveStatus(retainedObs)).toBe('tombstoned');
      expect(rebuilt.searchIndex.searchObservations('retained', ACME)).toHaveLength(0);
      const versions = [...iterAllClaimVersions(fresh.dataDir)].filter(record => record.scope === ACME);
      expect(versions.some(record => record.state === 'forgotten')).toBe(true);
    } finally {
      rebuilt.layer0.close();
      rebuilt.store.close();
      rebuilt.searchIndex.close();
    }
  });

  it('C6 · returning client: #2 inherits nothing; grants are exact-id', async () => {
    const fx = await newBrain();
    const obs = await observe(fx, GIGI, ACME, 'Acme legacy renewal note');
    persistClaim(fx, { scope: ACME, subject: 'Acme', predicate: 'renewal_note', value: 'legacy', evidence: [obs] });
    await fx.core.forgetScope({ actor: OWNER, scope: ACME, reason: 'erasure', operation_id: `op_${ulid()}` });

    // The host mints the returned client's fresh marker and repoints the grant.
    const returned = 'client:acme#2';
    fx.core.ensureScopes([{ id: returned, parent: 'workspace', visibility_default: 'scope' }]);
    const granted = await fx.core.grant({
      actor: OWNER, grant_actor_id: GIGI.id, grant_actor_type: 'person',
      capabilities: { observe: [returned], query: [returned], compile: [], correct: [], forget: [], read: [returned] },
    });
    expect(granted.status).toBe('granted');

    // The registry knows the new scope and its hierarchy.
    expect(new ScopeRegistry(loadConfig(fx.dataDir)).getAncestors(returned)).toEqual([returned, 'workspace']);

    // New content in #2 is live for its grantee.
    const newObs = await observe(fx, GIGI, returned, 'Acme returned — new renewal date 2027-01-15', '2026-09-01T00:00:00.000Z');
    persistClaim(fx, { scope: returned, subject: 'Acme', predicate: 'renewal_date', value: '2027-01-15', evidence: [newObs] });
    const inReturned = await fx.core.query({ actor: GIGI, query: 'renewal', scope: returned });
    expect(inReturned.results.length).toBeGreaterThan(0);

    // Nothing from #1 is visible in #2 — no lane inherits tombstoned history.
    const legacyLanes = await probeLanes(fx, OWNER, ACME, 'legacy');
    expect(legacyLanes).toEqual({ claimLane: 0, claimLaneWithForgotten: 0, rawWindow: 0, contextSeeds: 0, hybrid: 0 });
    const returnedLanes = await probeLanes(fx, OWNER, returned, 'legacy');
    expect(returnedLanes.rawWindow).toBe(0);
    expect(returnedLanes.contextSeeds).toBe(0);

    // Exact-id grant matching: the #2 grant never reaches #1 (and vice versa).
    const reloaded = loadConfig(fx.dataDir);
    expect(checkGrant(GIGI.id, 'query', returned, reloaded)).toBe(true);
    expect(checkGrant(GIGI.id, 'query', ACME, reloaded)).toBe(false);
    expect(checkGrant(GIGI.id, 'query', '*', reloaded)).toBe(false);

    // The returned client's export is exactly #2 — no #1 bytes leak into it.
    const exported = await fx.core.exportScope({ actor: OWNER, scope: returned });
    const pkg = fs.readFileSync(path.join(exported.path, 'observations.jsonl'), 'utf8')
      + fs.readFileSync(path.join(exported.path, 'claims.jsonl'), 'utf8');
    expect(pkg).not.toContain(ACME);
    expect(exported.manifest.scope_exclusive).toBe(true);
  });

  it('C7 · consolidation preserves the correction path and the evidence lineage', async () => {
    const fx = await newBrain();
    const e1 = await observe(fx, GIGI, ACME, 'Acme uses Stripe for billing');
    const e2 = await observe(fx, GIGI, ACME, 'Acme switched its billing cycle');
    const idA = persistClaim(fx, { scope: ACME, subject: 'Acme', predicate: 'billing_provider', value: 'stripe', evidence: [e1] });
    const idB = persistClaim(fx, { scope: ACME, subject: 'Acme', predicate: 'billing_cycle', value: 'monthly', evidence: [e2] });
    await refreshSemantic(fx, ACME);

    const consolidated = await fx.core.consolidate({
      actor: OWNER, claim_ids: [idA, idB], scope: ACME,
      summary: 'Acme bills through Stripe on a monthly cycle.',
      subject_name: 'Acme', predicate: 'billing_summary',
      operation_id: `op_${ulid()}`,
    });
    expect(consolidated.inputs_consolidated).toBe(2);
    // Lineage is a superset of the inputs' evidence — the audit trail survives.
    expect(consolidated.derived_from).toEqual(expect.arrayContaining([idA, idB, e1, e2]));

    const afterConsolidate = await fx.core.query({ actor: OWNER, query: 'billing', scope: ACME });
    expect(afterConsolidate.results.map(hit => hit.claim?.id)).toContain(consolidated.claim_id);
    expect(afterConsolidate.results.map(hit => hit.claim?.id)).not.toContain(idA);
    expect(afterConsolidate.results.map(hit => hit.claim?.id)).not.toContain(idB);

    // Correction path: a user correction of the consolidated claim is allowed and
    // becomes the effective current version, carrying the lineage forward.
    const corrected = await fx.core.correct({
      actor: OWNER, target_claim_id: consolidated.claim_id,
      corrected_object: { type: 'text', value: 'Acme bills through Stripe on a quarterly cycle.' },
      reason: 'billing_cycle_changed',
    });
    expect(corrected.status).toBe('corrected');
    const effective = await fx.core.query({ actor: OWNER, query: 'stripe', scope: ACME });
    const values = effective.results.map(hit => String((hit.claim?.object as { value?: unknown } | undefined)?.value ?? ''));
    expect(values.some(value => value.includes('quarterly'))).toBe(true);

    // The inputs' tombstone snapshots survive the whole path (auditable, revivable).
    const versions = [...iterAllClaimVersions(fx.dataDir)].filter(record => record.scope === ACME);
    for (const inputId of [idA, idB]) {
      expect(versions.some(record => record.claim_id === inputId && record.state === 'forgotten')).toBe(true);
    }

    // Wipe-and-rebuild: the corrected understanding is still the effective answer.
    const rebuilt = rebuildIndexes(fx);
    try {
      const live = [...iterAllClaimVersions(fx.dataDir)].filter(record => record.scope === ACME);
      expect(live.some(record => record.state === 'active' && record.content.includes('quarterly'))).toBe(true);
    } finally {
      rebuilt.layer0.close();
      rebuilt.store.close();
      rebuilt.searchIndex.close();
    }
  });

  it('C8 · legal hold (v1 composition): dispute → offboarding + snapshot; erasure only after attestation', async () => {
    const fx = await newBrain();
    const obs = await observe(fx, GIGI, ACME, 'Acme dispute evidence — invoice 41');
    const claimId = persistClaim(fx, { scope: ACME, subject: 'Acme', predicate: 'dispute_note', value: 'invoice 41', evidence: [obs] });

    // 1. The dispute triggers the HOLD LANE, never erasure: snapshot + offboarding.
    const snapshot = await fx.core.exportScope({ actor: OWNER, scope: ACME });
    expect(snapshot.manifest.deletion_certificate).toBeNull();
    const hold = await fx.core.forgetScope({
      actor: OWNER, scope: ACME, reason: 'offboarding',
      owner_pointer: 'dispute hold — do not erase', operation_id: `op_${ulid()}`,
    });
    expect(hold.scope_entry_removed).toBe(false);

    // The defense record survives: claims revivable, evidence retained, marker intact.
    expect(fx.core.readObservationEvidence({ actor: OWNER, observation_id: obs })?.status).toBe('tombstoned');
    const revived = await fx.core.revive({
      actor: OWNER, tombstone_id: `tomb_${claimId.slice(6)}`, reason: 'hold review', operation_id: `op_${ulid()}`,
    });
    expect(revived.status).toBe('revived');

    // 2. Retention expiry is tombstone-only and cannot destroy the hold lane:
    //    the sweep over a held scope finds nothing new and removes nothing.
    const evidenceBefore = evidenceBytes(fx);
    const sweep = await fx.core.expireRetention({ actor: OWNER, scope: ACME, as_of: '2030-01-01T00:00:00.000Z' });
    expect(sweep.observations_expired).toBe(0);
    expect(evidenceBytes(fx)).toBe(evidenceBefore);

    // 3. Hold releases — the owner attests and the erasure records it.
    const eraseOp = `op_${ulid()}`;
    const erased = await fx.core.forgetScope({
      actor: OWNER, scope: ACME, reason: 'erasure',
      attestation: 'no pending dispute / hold released',
      export_id: snapshot.export_id, operation_id: eraseOp,
    });
    expect(erased.scope_entry_removed).toBe(true);
    const entry = opsEntries(fx, eraseOp);
    expect(entry).toHaveLength(1);
    expect(entry[0]!.details?.['attestation']).toBe('no pending dispute / hold released');
    expect(entry[0]!.details?.['export_id']).toBe(snapshot.export_id);

    // Terminal after erasure, certifiable, and lane-silent.
    expect(fx.core.readObservationEvidence({ actor: OWNER, observation_id: obs })?.status).toBe('erased');
    const certificate = await fx.core.exportScope({ actor: OWNER, scope: ACME });
    expect(certificate.manifest.deletion_certificate?.operation_id).toBe(eraseOp);
    const silent = await probeLanes(fx, OWNER, ACME, 'dispute');
    expect(silent).toEqual({ claimLane: 0, claimLaneWithForgotten: 0, rawWindow: 0, contextSeeds: 0, hybrid: 0 });

    // 4. The DSR lane is not gated on a dispute: an erasure without an attestation
    //    is still the owner's terminal act (v1 = composition, §10c.3).
    const fx2 = await newBrain();
    await observe(fx2, NOAH, BCAU, 'Bcau erasure request');
    const dsr = await fx2.core.forgetScope({ actor: OWNER, scope: BCAU, reason: 'erasure', operation_id: `op_${ulid()}` });
    expect(dsr.scope_entry_removed).toBe(true);
  });
});
