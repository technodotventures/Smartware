// Conformance Suite J — Operations Log & Idempotency (§5, §17)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import { runCommitSync, IdempotencyConflictError, type CommitContext, type CommitDescriptor } from '../../src/ops_log/commit.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';
import { runDefaultDream } from '../../src/dream/phases.js';
import { runRecovery } from '../../src/ops_log/recovery.js';
import { appendClaimVersion, type ActiveClaimVersion } from '../../src/layer1/jsonl.js';
import { computeFingerprint } from '../../src/layer1/fingerprint.js';

let tmpDir: string;
let ctx: CommitContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ops-'));
  ctx = { opsDir: path.join(tmpDir, 'operations') };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
