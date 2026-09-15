// Conformance Suite J — Operations Log & Idempotency (§5, §17)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import { runCommitSync, IdempotencyConflictError, type CommitContext, type CommitDescriptor } from '../../src/ops_log/commit.js';
import { OPERATION_ID_PATTERN } from '../../src/ops_log/index.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';
import { runDefaultDream } from '../../src/dream/phases.js';
import { runRecovery } from '../../src/ops_log/recovery.js';
import { appendClaimVersion, readLatestVersion, type ActiveClaimVersion } from '../../src/layer1/jsonl.js';
import { computeFingerprint } from '../../src/layer1/fingerprint.js';
import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig } from '../../src/config.js';
import { readAll } from '../../src/layer0/log.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { makeClaim } from '../helpers.js';

let tmpDir: string;
let ctx: CommitContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ops-'));
  ctx = { opsDir: path.join(tmpDir, 'operations') };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ADR-0013 conformance: the retention sweep is a mutating operation, so it must
// commit an operations-log entry even when the caller does NOT supply an
// `operation_id` — the case the suite previously never exercised (it only ever
// drove surfaces that already carried ids), which is how the unconditional
// claim in ADR-0001 Tier-1 invariant 5 stayed unmeasured.
describe('Suite J — retention sweep commit identity (ADR-0013)', () => {
  let dataDir = '';
  let core: SmartwareCore | null = null;

  const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
  const ACME = 'client:acme#1';
  const AS_OF = '2026-09-10T00:00:00.000Z';

  afterEach(() => {
    core?.close();
    core = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function openScoped(): Promise<SmartwareCore> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ops-retention-'));
    for (const sub of ['wiki/personal', 'wiki/workspace', 'evidence', 'claims', 'operations']) {
      fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
    }
    const config = createDefaultConfig(dataDir);
    config.owner_id = 'user:owner';
    config.scopes = [
      { id: 'self', parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: ACME, parent: 'workspace', visibility_default: 'scope' },
    ];
    config.retention = {
      default: { policy: 'forever', duration_days: null },
      scope_overrides: { [ACME]: { policy: 'duration', duration_days: 1 } },
    };
    saveConfig(dataDir, config);
    core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
    return core;
  }

  it('J8: retention_sweep_without_caller_id_commits_entry_and_leaves_no_orphan', async () => {
    const c = await openScoped();

    // One elapsed observation plus one active claim whose sole evidence is it.
    const obsId = (await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'Acme prefers email' },
      scope: ACME, observed_at: '2026-08-01T00:00:00.000Z',
    })).id;

    const dbPath = path.join(dataDir, 'smartware.db');
    const store = new ClaimStore(dbPath);
    store.setDataDir(dataDir);
    const searchIndex = new SearchIndex(dbPath);
    const subjectId = `entity_${ulid()}`;
    store.insertEntity({
      id: subjectId, canonical_name: 'Acme', aliases: [], type: 'organization',
      scope: ACME, created_at: new Date().toISOString(),
    });
    const claim = makeClaim({
      subject_id: subjectId, subject_name: 'Acme', scope: ACME,
      predicate: 'prefers_contact', object: { type: 'text', value: 'email' },
      confidence: 0.8, supporting_evidence: [obsId], status: 'active', epistemic: 'observed',
      extraction: {
        method: 'deterministic', model: null, compiler_version: '0.6.3',
        prompt_hash: null, extracted_at: new Date().toISOString(),
      },
    });
    store.insertClaim(claim);
    syncSearchFromClaims(store, searchIndex, ACME);
    store.close();
    searchIndex.close();

    // The natural host-scheduler call: NO operation_id.
    const opsDir = path.join(dataDir, 'operations');
    const evidenceDir = path.join(dataDir, 'evidence');
    const result = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF });

    expect(result.observations_expired).toBe(1);
    expect(result.claims_retracted).toBe(1);
    expect(OPERATION_ID_PATTERN.test(result.operation_id)).toBe(true);

    // 1. Exactly one entry, and it is committed under the id the sweep reports.
    const entries = [...readAllOpLogEntries(opsDir)].filter(entry => entry.op === 'retention.expire');
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.operation_id).toBe(result.operation_id);
    expect(entry.details).toMatchObject({
      scope: ACME, observations_expired: 1, claims_retracted: 1, as_of: AS_OF,
    });
    // No top-level `reason`: the `retention_expiry` audit marker lives in the
    // tombstone observation's body (ADR-0013, correcting ADR-0001 §2.5).
    expect(Object.prototype.hasOwnProperty.call(entry, 'reason')).toBe(false);

    // 2. Every artifact the sweep wrote carries that committed id.
    const tombstone = [...readAll(evidenceDir)].find(observation => observation.type === 'tombstone');
    expect(tombstone?.operation_id).toBe(result.operation_id);
    expect(readLatestVersion(dataDir, claim.id)?.operation_id).toBe(result.operation_id);

    // 3. Nothing the sweep wrote is an orphan: no artifact holds its id without a commit.
    const report = runRecovery({
      opsDir,
      evidenceDir,
      claimsDir: dataDir,
      wikiDir: path.join(dataDir, 'wiki'),
      quarantineDir: path.join(dataDir, 'quarantine', 'operations'),
    });
    expect(report.orphans.filter(orphan => orphan.operation_id === result.operation_id)).toEqual([]);
    expect(report.requiresManualReview).not.toContain(result.operation_id);
  });
});

function makeDescriptor(overrides: Partial<CommitDescriptor> = {}): CommitDescriptor {
  return {
    operation_id: `op_${ulid()}`,
    actor_id: 'user:test',
    op: 'observe',
    details: { test: true },
    ...overrides,
  };
}

describe('Operations Log & Idempotency', () => {
  it('J1: every_mutation_has_ops_log_entry', () => {
    const desc = makeDescriptor();
    runCommitSync(ctx, desc, () => 'result');
    const entries = [...readAllOpLogEntries(ctx.opsDir)];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.operation_id).toBe(desc.operation_id);
    expect(entries[0]!.actor_id).toBe(desc.actor_id);
    expect(entries[0]!.op).toBe(desc.op);
  });

  it('J2: ops_log_timestamp_equals_version_at', () => {
    const desc = makeDescriptor();
    const result = runCommitSync(ctx, desc, (commit_ts) => ({ version_at: commit_ts }));
    const entries = [...readAllOpLogEntries(ctx.opsDir)];
    expect(entries[0]!.timestamp).toBe(result.commit_ts);
    expect(result.value.version_at).toBe(result.commit_ts);
  });

  it('J3: same_id_same_payload_is_idempotent', () => {
    const desc = makeDescriptor();
    const first = runCommitSync(ctx, desc, () => 'first');
    const second = runCommitSync(ctx, desc, () => 'should not run');
    expect(second.commit_ts).toBe(first.commit_ts);
    const entries = [...readAllOpLogEntries(ctx.opsDir)];
    expect(entries).toHaveLength(1);
  });

  it('J4: same_id_different_payload_is_conflict', () => {
    const opId = `op_${ulid()}`;
    const desc1 = makeDescriptor({ operation_id: opId, details: { a: 1 } });
    runCommitSync(ctx, desc1, () => 'first');
    const desc2 = makeDescriptor({ operation_id: opId, details: { a: 2 } });
    expect(() => runCommitSync(ctx, desc2, () => 'conflict')).toThrow(IdempotencyConflictError);
  });

  it('J5: dream_phase_outcome_logged', () => {
    const result = runDefaultDream(ctx, 'substrate:test', 'personal');
    expect(result.phases).toHaveLength(6);
    const entries = [...readAllOpLogEntries(ctx.opsDir)];
    expect(entries).toHaveLength(6);
    const ops = entries.map(e => e.op);
    expect(ops).toContain('dream.verify');
    expect(ops).toContain('dream.extract_relations');
    expect(ops).toContain('dream.detect_conflicts');
    expect(ops).toContain('dream.recompile_pages');
    expect(ops).toContain('dream.check_capacity');
    expect(ops).toContain('dream.find_orphans');
    for (const entry of entries) {
      expect(entry.actor_id).toBe('substrate:test');
    }
  });

  it('J6: reads_do_not_consume_operation_ids', () => {
    const entries = [...readAllOpLogEntries(ctx.opsDir)];
    expect(entries).toHaveLength(0);
  });

  it('J7: recovery_detects_orphan_artifacts', () => {
    const claimsDir = path.join(tmpDir, 'claims');
    const orphanRecord: ActiveClaimVersion = {
      claim_id: 'claim_ORPHAN01',
      version: 1,
      state: 'active',
      content: 'Orphan claim',
      claim_type: 'finding',
      claim_role: 'memory',
      author: 'agent',
      epistemic_owner: 'agent',
      fingerprint: computeFingerprint('Orphan claim', 'personal', 'finding'),
      confidence: 'low',
      epistemic_tag: 'inference',
      scope: 'personal',
      derived_from: [],
      relations: [],
      created_at: '2026-01-01T00:00:00Z',
      version_at: '2026-01-01T00:00:00Z',
      operation_id: 'op_ORPHAN0100000000000000000000',
      actor_id: 'substrate:test',
      tags: [],
    };
    appendClaimVersion(tmpDir, orphanRecord);

    const report = runRecovery({
      opsDir: ctx.opsDir,
      evidenceDir: path.join(tmpDir, 'evidence'),
      claimsDir: tmpDir,
      quarantineDir: path.join(tmpDir, 'quarantine'),
    });
    expect(report.orphans.length).toBeGreaterThan(0);
    expect(report.orphans[0]!.operation_id).toBe('op_ORPHAN0100000000000000000000');
  });
});
