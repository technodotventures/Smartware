// Tests: Protocol — EXPORT.SCOPE handler (spec §10c.4, G3.1)
//
// Oracle behaviors:
//   - ONE scope = exactly ONE boundary: every content record has
//     scope === target; cross-scope allowed ONLY for ops entries in the
//     operation closure (they reference ids, never content) and forget.scope
//     audit markers for the target (pod scope by design).
//   - Canonical records only; derived indexes never included.
//   - all statuses portable (active + forgotten/tombstoned claim versions).
//   - operation closure complete: every referenced operation_id resolves.
//   - post-erasure export = empty package + deletion certificate reference.
//   - owner-only; idempotent per operation_id; export_id surfaces in the
//     erasure ops entry details (export-before-erasure audit).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';

import type { Observation } from '../../src/layer0/types.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex } from '../../src/layer3/search.js';
import { appendObservation, readAll } from '../../src/layer0/log.js';
import { assignIntegrity } from '../../src/layer0/integrity.js';
import { handleExportScope, exportIdForOperationId } from '../../src/protocol/export_scope.js';
import { handleForgetScope } from '../../src/protocol/forget_scope.js';
import { appendOpLogEntry, readAllOpLogEntries } from '../../src/ops_log/log.js';
import { iterAllClaimVersions } from '../../src/layer1/jsonl.js';
import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';
import { makeClaim } from '../helpers.js';
import { SMARTWARE_VERSION } from '../../src/version.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-export-scope-'));
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

function insertObservation(
  scope: string,
  body: string,
  operationId?: string,
): Observation {
  const now = new Date().toISOString();
  const obs: Observation = {
    id: `obs_${ulid()}`,
    version: SMARTWARE_VERSION,
    ...(operationId ? { operation_id: operationId, actor_id: OWNER.id } : {}),
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
  return withIntegrity;
}

function pushOpsEntry(operationId: string, op: string, scope: string): void {
  appendOpLogEntry(opsDir, {
    operation_id: operationId,
    actor_id: OWNER.id,
    timestamp: new Date().toISOString(),
    op: op as never,
    details: { scope },
  });
}

function insertEntity(scope: string, name: string): string {
  const entityId = `entity_${ulid()}`;
  store.insertEntity({ id: entityId, canonical_name: name, aliases: [], type: 'organization', scope, created_at: new Date().toISOString() });
  return entityId;
}

function insertClaimForObs(
  obs: Observation,
  scope: string,
  name: string,
  operationId?: string,
): ReturnType<typeof makeClaim> {
  const entityId = insertEntity(scope, name);
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
    operation_id: operationId,
  });
  store.insertClaim(claim);
  return claim;
}

function exportScope(scope: string, operationId?: string) {
  return handleExportScope(
    { actor: OWNER, scope, operation_id: operationId },
    { evidenceDir, dataDir, opsDir, store, config },
  );
}

function readFileLines(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
}

function packageLines(packageDir: string, name: string): Array<Record<string, unknown>> {
  return readFileLines(path.join(packageDir, `${name}.jsonl`)).map(line => JSON.parse(line));
}

describe('handleExportScope — one-scope boundary (spec §10c.4)', () => {
  it('exports exact scope content; other-scope data NEVER appears (seed 2+ scopes)', async () => {
    // SCOPE: observed once; claim c1 references o1; entity Acme.
    const o1 = insertObservation(SCOPE, 'Acme beta status is active', `op_${ulid()}`);
    const o1b = insertObservation(SCOPE, 'Acme beta kickoff notes', `op_${ulid()}`);
    const opObs1 = o1.operation_id!;
    const opObs1b = o1b.operation_id!;
    pushOpsEntry(opObs1, 'observe', SCOPE);
    pushOpsEntry(opObs1b, 'observe', SCOPE);
    const opClaim1 = `op_${ulid()}`;
    const c1 = insertClaimForObs(o1, SCOPE, 'Acme', opClaim1);
    pushOpsEntry(opClaim1, 'reflect.auto', SCOPE);
    // c1 references two supporting observations — both in-scope evidence.
    // (Claim already derived_from [o1.id]; add o1b via a revise-free direct
    // record append is unnecessary — closure only needs referenced ids.)

    // OTHER_SCOPE: completely separate content.
    const o2 = insertObservation(OTHER_SCOPE, 'Bcau beta status is active', `op_${ulid()}`);
    pushOpsEntry(o2.operation_id!, 'observe', OTHER_SCOPE);
    const opClaim2 = `op_${ulid()}`;
    const c2 = insertClaimForObs(o2, OTHER_SCOPE, 'Bcau', opClaim2);
    pushOpsEntry(opClaim2, 'reflect.auto', OTHER_SCOPE);

    const result = await exportScope(SCOPE);

    // Result shape per contract.
    expect(result.export_id).toMatch(/^exp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.counts).toEqual({
      observations: 2,
      claims: 1,
      evidence: 1, // o1 only; o1b is NOT referenced by c1's derived_from
      operations: 3, // opObs1 + opObs1b + opClaim1 (every referenced id)
      entities: 1,
    });
    expect(result.manifest.export_id).toBe(result.export_id);
    expect(result.manifest.scope).toBe(SCOPE);
    expect(result.manifest.protocol).toBe('v0.5.0');
    expect(result.manifest.schemas).toBe('v0.5.0');
    expect(result.manifest.scope_exclusive).toBe(true);

    // One-scope rule: every content record has scope === SCOPE.
    const observations = packageLines(result.path, 'observations');
    expect(observations).toHaveLength(2);
    expect(observations.every(r => r['scope'] === SCOPE)).toBe(true);
    expect(observations.map(r => r['id'])).toEqual(expect.arrayContaining([o1.id, o1b.id]));
    expect(observations.some(r => r['id'] === o2.id)).toBe(false);

    const claims = packageLines(result.path, 'claims');
    expect(claims).toHaveLength(1);
    expect(claims[0]!['scope']).toBe(SCOPE);
    expect(claims[0]!['claim_id']).toBe(c1.id);
    expect(claims[0]!['derived_from']).toEqual([o1.id]);

    const evidence = packageLines(result.path, 'evidence');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!['id']).toBe(o1.id);
    expect(evidence[0]!['scope']).toBe(SCOPE);
    expect(evidence.some(r => r['id'] === o2.id)).toBe(false);

    const entities = packageLines(result.path, 'entities');
    expect(entities).toHaveLength(1);
    expect(entities[0]!['scope']).toBe(SCOPE);
    expect(entities[0]!['non_canonical']).toBe(true); // derived projection marker

    // operations closure: only referenced ids + no other-scope entries.
    const operations = packageLines(result.path, 'operations');
    const opIds = operations.map(r => r['operation_id']);
    expect(opIds.sort()).toEqual([opObs1, opObs1b, opClaim1].sort());
    expect(opIds.includes(opClaim2)).toBe(false);
    expect(opIds.includes(o2.operation_id!)).toBe(false);

    // No derived indexes — exactly the 6 package files.
    const files = fs.readdirSync(result.path).sort();
    expect(files).toEqual([
      'claims.jsonl', 'entities.jsonl', 'evidence.jsonl',
      'manifest.json', 'observations.jsonl', 'operations.jsonl',
    ]);
  });

  it('includes all claim statuses — active AND forgotten/tombstoned versions (post-offboarding)', async () => {
    // Seed one live claim, then offboard the scope: forgetting writes a
    // forgotten version (v2) on the canonical JSONL; raw observations stay.
    const o1 = insertObservation(SCOPE, 'Acme beta status is active', `op_${ulid()}`);
    pushOpsEntry(o1.operation_id!, 'observe', SCOPE);
    const opClaim = `op_${ulid()}`;
    insertClaimForObs(o1, SCOPE, 'Acme', opClaim);
    pushOpsEntry(opClaim, 'reflect.auto', SCOPE);

    const offboardOp = `op_${ulid()}`;
    await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'offboarding', operation_id: offboardOp },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );

    const result = await exportScope(SCOPE);

    // Exactly 2 claim version records for the claim: v1 active + v2 forgotten.
    const claims = packageLines(result.path, 'claims');
    expect(claims).toHaveLength(2);
    expect(claims.map(r => r['state']).sort()).toEqual(['active', 'forgotten']);
    expect(claims[0]!['scope']).toBe(SCOPE);
    expect(claims[1]!['scope']).toBe(SCOPE);

    // Raw observations still exported (tombstoned records are canonical).
    const observations = packageLines(result.path, 'observations');
    expect(observations).toHaveLength(1);
    expect(observations[0]!['id']).toBe(o1.id);

    // Deleted/erased marker is NOT an erase marker (offboarding) → full history.
    expect(result.manifest.deletion_certificate).toBeNull();
  });

  it('operation closure is complete: every referenced operation_id resolves; forget.scope audit for target present', async () => {
    const o1 = insertObservation(SCOPE, 'Acme beta status is active', `op_${ulid()}`);
    const opObs = o1.operation_id!;
    pushOpsEntry(opObs, 'observe', SCOPE);
    const opClaim = `op_${ulid()}`;
    insertClaimForObs(o1, SCOPE, 'Acme', opClaim);
    pushOpsEntry(opClaim, 'reflect.auto', SCOPE);

    const offboardOp = `op_${ulid()}`;
    await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'offboarding', operation_id: offboardOp },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );

    const result = await exportScope(SCOPE);
    const operations = packageLines(result.path, 'operations');
    const opIds = operations.map(r => r['operation_id']);

    for (const record of packageLines(result.path, 'claims')) {
      expect(opIds).toContain(record['operation_id']);
    }
    for (const record of packageLines(result.path, 'observations')) {
      if (record['operation_id']) expect(opIds).toContain(record['operation_id']);
    }
    for (const record of packageLines(result.path, 'evidence')) {
      if (record['operation_id']) expect(opIds).toContain(record['operation_id']);
    }
    // The forget.scope audit entry for the target is always included.
    const forgetEntries = operations.filter(r => r['op'] === 'forget.scope');
    expect(forgetEntries).toHaveLength(1);
    expect(forgetEntries[0]!['details']).toMatchObject({ scope: SCOPE, reason: 'offboarding' });
  });

  it('manifest hashes verify against files (per-file sha256 + aggregate recompute)', async () => {
    const o1 = insertObservation(SCOPE, 'Acme beta status is active', `op_${ulid()}`);
    pushOpsEntry(o1.operation_id!, 'observe', SCOPE);
    const opClaim = `op_${ulid()}`;
    insertClaimForObs(o1, SCOPE, 'Acme', opClaim);
    pushOpsEntry(opClaim, 'reflect.auto', SCOPE);

    const result = await exportScope(SCOPE);
    const sha = result.manifest.sha256;
    const order = ['observations', 'claims', 'evidence', 'operations', 'entities'];
    let aggregate = '';
    for (const name of order) {
      const bytes = fs.readFileSync(path.join(result.path, `${name}.jsonl`));
      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(sha[name]).toBe(digest);
      aggregate += digest;
    }
    expect(sha['aggregate']).toBe(createHash('sha256').update(aggregate).digest('hex'));
    // Per-file counts equal manifest counts.
    expect(packageLines(result.path, 'observations')).toHaveLength(result.manifest.counts.observations);
    expect(packageLines(result.path, 'claims')).toHaveLength(result.manifest.counts.claims);
    expect(packageLines(result.path, 'operations')).toHaveLength(result.manifest.counts.operations);
  });

  it('post-erasure export → empty package + deletion-certificate reference', async () => {
    const o1 = insertObservation(SCOPE, 'Acme beta status is active', `op_${ulid()}`);
    pushOpsEntry(o1.operation_id!, 'observe', SCOPE);
    const opClaim = `op_${ulid()}`;
    insertClaimForObs(o1, SCOPE, 'Acme', opClaim);
    pushOpsEntry(opClaim, 'reflect.auto', SCOPE);

    const eraseOp = `op_${ulid()}`;
    const erase = await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: eraseOp },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );

    // The erased scope's raw evidence records STILL exist on disk (audit) but
    // must NOT be exported — effective status is 'erased'.
    expect([...readAll(evidenceDir)].some(o => o.scope === SCOPE)).toBe(true);

    const result = await exportScope(SCOPE);

    expect(result.counts).toEqual({
      observations: 0,
      claims: 0,
      evidence: 0,
      operations: 1, // the forget.scope erasure audit entry
      entities: 0,
    });
    expect(packageLines(result.path, 'observations')).toHaveLength(0);
    expect(packageLines(result.path, 'claims')).toHaveLength(0);
    expect(packageLines(result.path, 'evidence')).toHaveLength(0);
    expect(packageLines(result.path, 'entities')).toHaveLength(0);

    // Deletion certificate: marker obs id + erasure operation_id.
    expect(result.manifest.deletion_certificate).toEqual({
      operation_id: eraseOp,
      audit_observation_id: erase.audit_observation_id,
    });
    expect(result.manifest.scope_exclusive).toBe(true);
    // The audit entry is the portable proof-of-erasure.
    const operations = packageLines(result.path, 'operations');
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ op: 'forget.scope', operation_id: eraseOp });
    expect(operations[0]!['details']).toMatchObject({ scope: SCOPE, reason: 'erasure' });
  });

  it('rejects non-owner actors (owner-only gate, same as FORGET.SCOPE)', async () => {
    insertObservation(SCOPE, 'Acme beta status is active');
    await expect(handleExportScope(
      { actor: STAFF, scope: SCOPE },
      { evidenceDir, dataDir, opsDir, store, config },
    )).rejects.toMatchObject({ code: 'owner_required' });
  });

  it('is idempotent per operation_id — retry returns same export_id + stable manifest; conflict on reuse with different payload', async () => {
    insertObservation(SCOPE, 'Acme beta status is active', `op_${ulid()}`);
    const opId = `op_${ulid()}`;
    const first = await exportScope(SCOPE, opId);
    const second = await exportScope(SCOPE, opId);

    expect(first.export_id).toBe(second.export_id);
    expect(first.export_id).toBe(exportIdForOperationId(opId));
    expect(first.path).toBe(second.path);
    expect(first.manifest).toEqual(second.manifest);

    // No duplicate artifact: exactly one package dir for the retry.
    const exportsDir = fs.readdirSync(path.join(dataDir, 'exports'));
    expect(exportsDir.filter(name => name === first.export_id)).toHaveLength(1);

    // Same operation_id + different scope → conflict.
    await expect(exportScope(OTHER_SCOPE, opId))
      .rejects.toMatchObject({ code: 'conflict' });

    // Different operation_id → different export_id.
    const secondOp = await exportScope(SCOPE, `op_${ulid()}`);
    expect(secondOp.export_id).not.toBe(first.export_id);

    // Missing package dir (crash simulation) → regenerated under same export_id.
    fs.rmSync(first.path, { recursive: true, force: true });
    const regenerated = await exportScope(SCOPE, opId);
    expect(regenerated.export_id).toBe(first.export_id);
    expect(fs.existsSync(regenerated.path)).toBe(true);
  });

  it('export_id links into the erasure ops entry details when provided; offboarding rejects it', async () => {
    const o1 = insertObservation(SCOPE, 'Acme beta status is active', `op_${ulid()}`);
    const exportOp = `op_${ulid()}`;
    const exported = await exportScope(SCOPE, exportOp);

    const eraseOp = `op_${ulid()}`;
    await handleForgetScope(
      {
        actor: OWNER,
        scope: SCOPE,
        reason: 'erasure',
        operation_id: eraseOp,
        export_id: exported.export_id,
      },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );

    const entries = [...readAllOpLogEntries(opsDir)].filter(e => e.operation_id === eraseOp);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['details']?.['export_id']).toBe(exported.export_id);
    expect(entries[0]!['details']?.['scope']).toBe(SCOPE);
    expect(entries[0]!['details']?.['reason']).toBe('erasure');

    // offboarding + export_id is rejected (DSR/hold lanes, §10c.3).
    await expect(handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'offboarding', operation_id: `op_${ulid()}`, export_id: exported.export_id },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    )).rejects.toMatchObject({ code: 'invalid_parameter' });

    // Malformed export_id rejected.
    await expect(handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: `op_${ulid()}`, export_id: 'not-an-export' },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    )).rejects.toMatchObject({ code: 'invalid_parameter' });
  });

  it('is read-only to pod data — evidence/claims/operations unchanged, config untouched', async () => {
    const o1 = insertObservation(SCOPE, 'Acme beta status is active', `op_${ulid()}`);
    pushOpsEntry(o1.operation_id!, 'observe', SCOPE);
    const opClaim = `op_${ulid()}`;
    insertClaimForObs(o1, SCOPE, 'Acme', opClaim);
    pushOpsEntry(opClaim, 'reflect.auto', SCOPE);

    const snapshot = fs.readdirSync(evidenceDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .map(f => {
        const p = path.join(evidenceDir, f);
        return `${f}:${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
      });
    const claimsSnapshot = [...iterAllClaimVersions(dataDir)].length;
    const opSnapshot = [...readAllOpLogEntries(opsDir)].length;
    const configBefore = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');

    await exportScope(SCOPE, `op_${ulid()}`);

    const snapshotAfter = fs.readdirSync(evidenceDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .map(f => {
        const p = path.join(evidenceDir, f);
        return `${f}:${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
      });
    expect(snapshotAfter).toEqual(snapshot);
    expect([...iterAllClaimVersions(dataDir)].length).toBe(claimsSnapshot);
    expect([...readAllOpLogEntries(opsDir)].length).toBe(opSnapshot);
    expect(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).toBe(configBefore);
  });
});
