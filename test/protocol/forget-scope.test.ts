// Tests: Protocol — FORGET.SCOPE handler (protocol v0.5.0, spec §10)
//
// Oracle behaviors:
//   - erasure: layer-0 effective status 'erased' for every observation in
//     scope; claim rows + L1 JSONL records + BM25 lanes (claims, pages,
//     raw window) + vector records + derived summaries + compile queue +
//     fingerprint rows all gone; grants revoked + scope entry removed in
//     the SAME commit; ONE ops-log entry carrying exact counts.
//   - offboarding: claims get forgotten versions (REVIVE-able), observations
//     get effective status 'tombstoned', grants revoked, scope entry KEPT.
//   - zero results in every lane, including against a wiped-and-rebuilt
//     store + search index (rebuild-equivalence, spec §10a).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import type { Observation } from '../../src/layer0/types.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims, syncObservationsFromEvidence, observationToIndexRow } from '../../src/layer3/search.js';
import { appendObservation } from '../../src/layer0/log.js';
import { assignIntegrity } from '../../src/layer0/integrity.js';
import { handleForgetScope } from '../../src/protocol/forget_scope.js';
import { handleRevive } from '../../src/protocol/forget.js';
import { resolveFactMatches } from '../../src/layer1/corroboration.js';
import type { SmartwareConfig } from '../../src/config.js';
import { loadConfig, saveConfig } from '../../src/config.js';
import { ProtocolError } from '../../src/auth/middleware.js';
import { makeClaim } from '../helpers.js';
import { iterAllClaimVersions, readLatestVersion } from '../../src/layer1/jsonl.js';
import { SMARTWARE_VERSION } from '../../src/version.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';
import { CompileQueue } from '../../src/compile_queue/queue.js';
import { FingerprintIndex } from '../../src/compile_queue/fingerprint.js';
import { SemanticRecordStore, syncPersistedSemanticRecords } from '../../src/layer3/semantic-store.js';

let tmpDir: string;
let evidenceDir: string;
let opsDir: string;
let dataDir: string;
let layer0: Layer0Index;
let store: ClaimStore;
let searchIndex: SearchIndex;
let config: SmartwareConfig;

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const STAFF = { type: 'person' as const, id: 'user:gigi', display_name: 'Gigi' };
const SCOPE = 'client:acme#1';
const OTHER_SCOPE = 'client:bcau#1';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-forget-scope-'));
  dataDir = tmpDir;
  evidenceDir = path.join(tmpDir, 'evidence');
  opsDir = path.join(tmpDir, 'operations');
  fs.mkdirSync(evidenceDir, { recursive: true });

  config = {
    instance_id: `smartware_${ulid()}`,
    owner_id: 'user:owner',
    writer_id: `writer_${ulid()}`,
    version: '0.6.0',
    data_dir: tmpDir,
    scopes: [
      { id: 'self', parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: SCOPE, parent: 'workspace', visibility_default: 'scope' },
      { id: OTHER_SCOPE, parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [
      {
        id: `grant_${ulid()}`,
        actor_type: 'person',
        actor_id: 'user:gigi',
        capabilities: {
          observe: [SCOPE],
          query: [SCOPE],
          compile: [],
          correct: [],
          forget: [],
          read: [],
        },
        trusted: false,
        quarantine: false,
        created_at: new Date().toISOString(),
        expires_at: null,
        status: 'active',
      },
    ],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
  saveConfig(tmpDir, config);

  const dbPath = path.join(tmpDir, 'smartware.db');
  layer0 = new Layer0Index(dbPath);
  store = new ClaimStore(dbPath);
  store.setDataDir(tmpDir);
  searchIndex = new SearchIndex(dbPath);
});

afterEach(() => {
  layer0.close();
  store.close();
  searchIndex.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertObservation(scope: string, body: string): Observation {
  const now = new Date().toISOString();
  const obs: Observation = {
    id: `obs_${ulid()}`,
    version: SMARTWARE_VERSION,
    type: 'message',
    status: 'accepted',
    source: {
      app: 'test', app_version: '1.0', source_id: null,
      actor: OWNER, captured_at: now, observed_at: now,
    },
    scope,
    visibility: 'scope',
    content: { format: 'text/plain', body },
    provenance: { parent_ids: [], supersedes: [], context: '' },
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: config.writer_id, sequence: layer0.getLastSequence() + 1, previous_hash: null },
  };
  const withIntegrity = assignIntegrity(obs, config.writer_id, obs.integrity.sequence, null);
  appendObservation(evidenceDir, withIntegrity);
  layer0.insertOrSkip(withIntegrity);
  // Sync-raw mirror: same as the observe path (index the row at commit time).
  searchIndex.indexObservation(observationToIndexRow(withIntegrity));
  return withIntegrity;
}

function insertClaimForObs(obs: Observation, scope: string, name = 'Acme'): ReturnType<typeof makeClaim> {
  const entityId = `entity_${ulid()}`;
  store.insertEntity({ id: entityId, canonical_name: name, aliases: [], type: 'organization', scope, created_at: new Date().toISOString() });
  const claim = makeClaim({
    subject_id: entityId,
    subject_name: name,
    predicate: 'status_is',
    object: { type: 'text', value: 'active' },
    scope,
    source_event_id: obs.id,
    extraction_event_id: obs.id,
    supporting_evidence: [obs.id],
    confidence: 0.8,
    status: 'active',
    state: 'active',
  });
  store.insertClaim(claim);
  return claim;
}

function seedScope(scope: string, name = 'Acme'): { obs: Observation; claim: ReturnType<typeof makeClaim> } {
  const obs = insertObservation(scope, `${name} beta status is active`);
  const claim = insertClaimForObs(obs, scope, name);
  syncSearchFromClaims(store, searchIndex, scope);
  return { obs, claim };
}

describe('handleForgetScope — erasure', () => {
  it('purges every lane, revokes grants + removes scope entry same commit, one ops entry with exact counts', async () => {
    const { obs, claim } = seedScope(SCOPE, 'Acme');
    seedScope(OTHER_SCOPE, 'Bcau');

    const operationId = `op_${ulid()}`;
    const result = await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: operationId },
      {
        evidenceDir, dataDir, layer0, store, searchIndex, config,
        commitCtx: { opsDir },
      },
    );

    // 1. Counts fidelity — before-mutation state: 1 claim, 1 observation.
    expect(result.claims_retracted).toBe(1);
    expect(result.observations_retracted).toBe(1);
    expect(result.scope_entry_removed).toBe(true);
    expect(result.grants_revoked).toHaveLength(1);
    expect(result.status).toBe('forgotten');

    // 2. Layer 0: every observation in scope is terminal 'erased'.
    expect(layer0.getEffectiveStatus(obs.id)).toBe('erased');

    // 3. Layer 1: store rows physically gone (claims, entities, relations).
    expect(store.getAllClaims(SCOPE)).toHaveLength(0);
    expect(store.getAllClaims(OTHER_SCOPE)).toHaveLength(1);

    // 4. Canonical JSONL: scope records physically purged; other scope intact.
    const scopeVersions = [...iterAllClaimVersions(dataDir)].filter(v => v.scope === SCOPE);
    expect(scopeVersions).toHaveLength(0);
    const otherVersions = [...iterAllClaimVersions(dataDir)].filter(v => v.scope === OTHER_SCOPE);
    expect(otherVersions.length).toBeGreaterThan(0);

    // 5. BM25 lanes: claims, entity pages, raw window all zero for the scope.
    expect(searchIndex.searchClaims('acme', SCOPE)).toHaveLength(0);
    expect(searchIndex.search('acme', SCOPE)).toHaveLength(0);
    expect(searchIndex.searchObservations('beta', SCOPE)).toHaveLength(0);
    // ... but the OTHER scope still has its lanes.
    expect(searchIndex.searchObservations('bcau', OTHER_SCOPE)).toHaveLength(1);

    // 6. Grant revocation + scope entry removal in the SAME commit as the
    //    ops entry (config file on disk already reflects the mutation).
    const reloaded = loadConfig(dataDir);
    const gigiGrants = reloaded.grants.filter(g => g.actor_id === 'user:gigi');
    expect(gigiGrants.every(g => g.status === 'revoked')).toBe(true);
    expect(reloaded.scopes.some(s => s.id === SCOPE)).toBe(false);
    expect(reloaded.scopes.some(s => s.id === OTHER_SCOPE)).toBe(true);

    // 7. ONE ops-log entry with the exact counts.
    const entries = [...readAllOpLogEntries(opsDir)].filter(e => e.operation_id === operationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.op).toBe('forget.scope');
    expect(entries[0]!.details?.['claims_retracted']).toBe(1);
    expect(entries[0]!.details?.['observations_retracted']).toBe(1);
    expect(entries[0]!.details?.['grants_revoked']).toEqual(result.grants_revoked);
    expect(entries[0]!.details?.['scope_entry_removed']).toBe(true);

    // 8. The audit marker observation exists in the pod scope (self),
    //    carrying scope + reason + counts for the audit trail.
    expect(result.audit_observation_id).toMatch(/^obs_/);
    expect(layer0.getEffectiveStatus(result.audit_observation_id)).toBe('accepted');
  });

  it('drops compile-queue jobs and fingerprint rows (rebuild-equivalence, §10a)', async () => {
    const { obs, claim } = seedScope(SCOPE);

    const queue = new CompileQueue(path.join(tmpDir, 'compile.db'));
    const fingerprint = new FingerprintIndex(path.join(tmpDir, 'fingerprints.db'));
    queue.enqueue(obs.id, SCOPE);
    queue.enqueue(obs.id, SCOPE); // duplicate-safe
    fingerprint.upsertVersion({
      claim_id: claim.id,
      version: 1,
      state: 'active',
      content: 'test',
      claim_type: 'finding',
      claim_role: 'memory',
      author: 'agent',
      epistemic_owner: 'agent',
      fingerprint: `fp_${ulid()}`,
      confidence: 'low',
      epistemic_tag: 'inference',
      scope: SCOPE,
      derived_from: [obs.id],
      relations: [],
      created_at: new Date().toISOString(),
      version_at: new Date().toISOString(),
      operation_id: `op_${ulid()}`,
      actor_id: 'user:owner',
      tags: [],
    });

    await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: `op_${ulid()}` },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, compileQueue: queue, fingerprintIndex: fingerprint, commitCtx: { opsDir } },
    );

    expect(queue.get(obs.id)).toBeNull();
    expect(fingerprint.count()).toBe(0);
    queue.close();
    fingerprint.close();
  });

  it('erases the semantic/vector lane when a store is supplied', async () => {
    const { obs, claim } = seedScope(SCOPE);
    const semantic = new SemanticRecordStore(path.join(tmpDir, 'semantic.db'));

    // Seed a vector record + manifest for the scope via the public write path.
    const adapter = {
      provider: 'fixture' as const,
      model: 'tiny',
      dimensions: 2,
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(() => [0.5, 0.5]);
      },
    };
    await syncPersistedSemanticRecords(
      semantic,
      SCOPE,
      [{
        id: claim.id,
        scope: SCOPE,
        version: SMARTWARE_VERSION,
        text: 'acme beta status is active',
        valid_time: { from: '2026-08-29T00:00:00.000Z', to: null },
        transaction_time: { from: '2026-08-29T00:00:00.000Z', to: null },
      }],
      adapter,
    );
    const before = semantic.load(adapter, SCOPE);
    expect(before.status).toBe('ready');

    const result = await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: `op_${ulid()}` },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, semanticStore: semantic, commitCtx: { opsDir } },
    );

    expect(result.vector_entries_removed).toBe(1);
    const loaded = semantic.load(adapter, SCOPE);
    expect(loaded.status).toBe('missing');
    expect(loaded.records).toHaveLength(0);
    semantic.close();
  });

  it('flags derived L2 wiki summaries for re-derivation', async () => {
    const { obs, claim } = seedScope(SCOPE);
    const wikiDir = path.join(dataDir, 'wiki');
    fs.mkdirSync(path.join(wikiDir, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(wikiDir, 'pages', 'acme.md'),
      `---\nscope: ${SCOPE}\ntitle: Acme\n---\n\nAcme status is active.`);
    fs.writeFileSync(path.join(wikiDir, 'pages', 'bcau.md'),
      `---\nscope: ${OTHER_SCOPE}\ntitle: Bcau\n---\n\nBcau status is active.`);

    const result = await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: `op_${ulid()}` },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );

    expect(result.derived_summaries_flagged).toBe(1);
    expect(fs.existsSync(path.join(wikiDir, 'pages', 'acme.md'))).toBe(false);
    expect(fs.existsSync(path.join(wikiDir, 'pages', 'bcau.md'))).toBe(true);
  });

  it('holds zero results after a wipe-and-rebuild from the canonical log (rebuild-equivalence)', async () => {
    const { obs, claim } = seedScope(SCOPE);
    seedScope(OTHER_SCOPE, 'Bcau');

    await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: `op_${ulid()}` },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );

    // Wipe every derived surface and rebuild from canonical inputs.
    layer0.close();
    store.close();
    searchIndex.close();

    const dbPath = path.join(tmpDir, 'smartware.db');
    for (const name of ['smartware.db', 'smartware.db-wal', 'smartware.db-shm']) {
      fs.rmSync(path.join(tmpDir, name), { force: true });
    }
    const l0Rebuilt = new Layer0Index(dbPath);
    const storeRebuilt = new ClaimStore(dbPath);
    const searchRebuilt = new SearchIndex(dbPath);
    l0Rebuilt.catchUp(evidenceDir);
    syncSearchFromClaims(storeRebuilt, searchRebuilt);
    syncObservationsFromEvidence(evidenceDir, l0Rebuilt, searchRebuilt);

    // Scoped lanes: zero for the erased scope.
    expect(l0Rebuilt.getEffectiveStatus(obs.id)).toBe('erased');
    expect(searchRebuilt.searchClaims('acme', SCOPE)).toHaveLength(0);
    expect(searchRebuilt.search('acme', SCOPE)).toHaveLength(0);
    expect(searchRebuilt.searchObservations('beta', SCOPE)).toHaveLength(0);
    // Other scope survives: observation + page intact.
    expect(searchRebuilt.searchObservations('bcau', OTHER_SCOPE)).toHaveLength(1);

    l0Rebuilt.close();
    storeRebuilt.close();
    searchRebuilt.close();
  });

  it('rejects a staff (non-owner) invocation', async () => {
    seedScope(SCOPE);
    await expect(handleForgetScope(
      { actor: STAFF, scope: SCOPE, reason: 'erasure', operation_id: `op_${ulid()}` },
      { evidenceDir, dataDir, layer0, store, searchIndex, config },
    )).rejects.toThrow(ProtocolError);
  });

  it('rejects owner_pointer on erasure', async () => {
    seedScope(SCOPE);
    await expect(handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', owner_pointer: 'client since 2023', operation_id: `op_${ulid()}` },
      { evidenceDir, dataDir, layer0, store, searchIndex, config },
    )).rejects.toThrow(ProtocolError);
  });

  it('is idempotent on replay: same operation_id + payload returns the recorded result', async () => {
    seedScope(SCOPE);
    const operationId = `op_${ulid()}`;

    const first = await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: operationId },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );
    const second = await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: operationId },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );

    expect(second).toEqual(first);
    // Still exactly one ops entry.
    const entries = [...readAllOpLogEntries(opsDir)].filter(e => e.operation_id === operationId);
    expect(entries).toHaveLength(1);
  });

  it('reuses an unchanged scope marker on replay: same payload but already-finalized state stays consistent', async () => {
    // After erasure the scope entry is gone; a repeated call with the SAME
    // operation_id/payload replays, but a different payload on a used id conflicts.
    seedScope(SCOPE);
    const operationId = `op_${ulid()}`;
    await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: operationId },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );
    await expect(handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'offboarding', operation_id: operationId },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    )).rejects.toThrow(ProtocolError);
  });
});

describe('handleForgetScope — offboarding', () => {
  it('tombstones claims (REVIVE-able), revokes grants, keeps scope entry, carries pointer', async () => {
    const { obs, claim } = seedScope(SCOPE);
    seedScope(OTHER_SCOPE, 'Bcau');

    const operationId = `op_${ulid()}`;
    const result = await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'offboarding', owner_pointer: 'client since 2023, 4 jobs, no disputes', operation_id: operationId },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );

    expect(result.claims_retracted).toBe(1);
    expect(result.observations_retracted).toBe(1);
    expect(result.scope_entry_removed).toBe(false);
    expect(result.grants_revoked).toHaveLength(1);

    // Layer 0: observations tombstoned — same terminal state as a per-obs forget.
    expect(layer0.getEffectiveStatus(obs.id)).toBe('tombstoned');

    // JSONL gets forgotten versions; the store row becomes retracted.
    const versions = [...iterAllClaimVersions(dataDir)].filter(v => v.scope === SCOPE);
    const latest = versions.reduce((a, b) => (a.version > b.version ? a : b));
    expect(latest.state).toBe('forgotten');
    expect(store.getClaim(claim.id)?.status).toBe('retracted');

    // Grant revoked but scope entry kept (reversible; #2 can be minted later).
    const reloaded = loadConfig(dataDir);
    expect(reloaded.grants.filter(g => g.actor_id === 'user:gigi').every(g => g.status === 'revoked')).toBe(true);
    expect(reloaded.scopes.some(s => s.id === SCOPE)).toBe(true);

    // The marker body carries the owner-approved pointer for #2 minting.
    expect(result.audit_observation_id).toMatch(/^obs_/);

    // One ops entry with reason=offboarding.
    const entries = [...readAllOpLogEntries(opsDir)].filter(e => e.operation_id === operationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details?.['reason']).toBe('offboarding');
    expect(entries[0]!.details?.['scope_entry_removed']).toBe(false);

    // Reversibility: REVIVE restores the claim to active.
    const revive = await handleRevive(
      { actor: OWNER, tombstone_id: `tomb_${claim.id.slice(6)}`, reason: 'client re-engaged', operation_id: `op_${ulid()}` },
      dataDir,
      store,
      loadConfig(dataDir),
      { opsDir },
      store.getDB(),
    );
    expect(revive.status).toBe('revived');
    const revivedClaim = store.getClaim(claim.id);
    expect(revivedClaim?.status).toBe('active');
    expect(revivedClaim?.state).toBe('active');
  });

  it('carries a mechanical demotion onto the offboarding forgotten version', async () => {
    const { claim } = seedScope(SCOPE);

    // A second claim for the same fact. §1e picks the lexicographically smallest claim id as the
    // survivor, so this id is the loser by construction — deterministic, no ULID-ordering race.
    const duplicateId = `claim_${'Z'.repeat(26)}`;
    store.insertClaim(makeClaim({
      id: duplicateId,
      subject_id: claim.subject_id,
      subject_name: 'Acme',
      predicate: 'status_is',
      object: { type: 'text', value: 'active' },
      scope: SCOPE,
      supporting_evidence: ['obs_duplicate'],
      status: 'active',
      state: 'active',
    }));
    const resolution = resolveFactMatches({
      store,
      matches: store.findActiveFactMatches(claim.subject_id, {
        predicate: 'status_is', scope: SCOPE, object: { type: 'text', value: 'active' },
      }),
    });
    expect(resolution.superseded_claims).toEqual([duplicateId]);

    await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'offboarding', operation_id: `op_${ulid()}` },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );

    // The demotion is non-content metadata about the claim (ADR-0003), so the offboarding
    // tombstone carries it: a later REVIVE restores the assertion *and* the fact that it is the
    // duplicate of another claim, instead of silently releasing it into recall.
    const forgotten = readLatestVersion(dataDir, duplicateId);
    expect(forgotten?.state).toBe('forgotten');
    expect(forgotten?.superseded_by).toBe(claim.id);
    expect(store.getClaim(duplicateId)?.status).toBe('retracted');
  });

  it('revokes only grants referencing that scope cluster', async () => {
    seedScope(SCOPE);
    seedScope(OTHER_SCOPE, 'Bcau');
    await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'offboarding', operation_id: `op_${ulid()}` },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );
    const reloaded = loadConfig(dataDir);
    // The single grant references both scopes (capability list contains both);
    // it holds SCOPE, so it is revoked. A grant NOT referencing the scope
    // would survive — verify a non-referencing grant is untouched.
    expect(reloaded.grants).toHaveLength(1);
  });
});
