// Migration Compatibility — Q8 backfill rule
// Legacy JSONL records without epistemic_owner resolve as epistemic_owner ?? author.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { backfillClaimVersion, auditL1Migration } from '../../src/layer1/migration.js';
import { appendClaimVersion, iterAllClaimVersions, type ActiveClaimVersion } from '../../src/layer1/jsonl.js';
import { computeFingerprint } from '../../src/layer1/fingerprint.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-migrate-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Q8 Migration Compatibility', () => {
  it('backfills epistemic_owner from author when missing', () => {
    const legacy = {
      claim_id: 'claim_LEGACY01',
      version: 1,
      state: 'active',
      content: 'Legacy assertion',
      claim_type: 'finding',
      claim_role: 'memory',
      author: 'agent',
      confidence: 'low',
      epistemic_tag: 'inference',
      scope: 'personal',
      derived_from: [],
      relations: [],
      created_at: '2026-01-01T00:00:00Z',
      version_at: '2026-01-01T00:00:00Z',
      operation_id: 'op_LEGACY0100000000000000000000',
      actor_id: 'substrate:test',
      tags: [],
    };

    const backfilled = backfillClaimVersion(legacy as Record<string, unknown>);
    expect(backfilled.epistemic_owner).toBe('agent');
  });

  it('backfills epistemic_owner as user when author is user', () => {
    const legacy = {
      claim_id: 'claim_LEGACY02',
      version: 1,
      state: 'active',
      content: 'User assertion',
      claim_type: 'finding',
      claim_role: 'memory',
      author: 'user',
      confidence: 'high',
      epistemic_tag: 'fact',
      scope: 'personal',
      derived_from: [],
      relations: [],
      created_at: '2026-01-01T00:00:00Z',
      version_at: '2026-01-01T00:00:00Z',
      operation_id: 'op_LEGACY0200000000000000000000',
      actor_id: 'user:owner',
      tags: [],
    };

    const backfilled = backfillClaimVersion(legacy as Record<string, unknown>);
    expect(backfilled.epistemic_owner).toBe('user');
  });

  it('backfills fingerprint when missing', () => {
    const legacy = {
      claim_id: 'claim_LEGACY03',
      version: 1,
      state: 'active',
      content: 'Test content for fingerprint',
      claim_type: 'finding',
      claim_role: 'memory',
      author: 'agent',
      confidence: 'low',
      epistemic_tag: 'inference',
      scope: 'personal',
      derived_from: [],
      relations: [],
      created_at: '2026-01-01T00:00:00Z',
      version_at: '2026-01-01T00:00:00Z',
      operation_id: 'op_LEGACY0300000000000000000000',
      actor_id: 'substrate:test',
      tags: [],
    };

    const backfilled = backfillClaimVersion(legacy as Record<string, unknown>);
    expect(backfilled.fingerprint).toMatch(/^fp_/);
    expect(backfilled.fingerprint).toBe(computeFingerprint('Test content for fingerprint', 'personal', 'finding'));
  });

  it('does not overwrite existing epistemic_owner', () => {
    const record = {
      claim_id: 'claim_EXISTING',
      version: 1,
      state: 'active',
      content: 'Existing',
      claim_type: 'finding',
      claim_role: 'memory',
      author: 'agent',
      epistemic_owner: 'user',
      fingerprint: 'fp_existing',
      confidence: 'low',
      epistemic_tag: 'inference',
      scope: 'personal',
      derived_from: [],
      relations: [],
      created_at: '2026-01-01T00:00:00Z',
      version_at: '2026-01-01T00:00:00Z',
      operation_id: 'op_EXIST0100000000000000000000',
      actor_id: 'substrate:test',
      tags: [],
    };

    const backfilled = backfillClaimVersion(record as Record<string, unknown>);
    expect(backfilled.epistemic_owner).toBe('user');
    expect(backfilled.fingerprint).toBe('fp_existing');
  });

  it('iterAllClaimVersions applies backfill on read', () => {
    const claimsDir = path.join(tmpDir, 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const legacyLine = JSON.stringify({
      claim_id: 'claim_ITER01',
      version: 1,
      state: 'active',
      content: 'Iterated legacy',
      claim_type: 'finding',
      claim_role: 'memory',
      author: 'agent',
      confidence: 'low',
      epistemic_tag: 'inference',
      scope: 'personal',
      derived_from: [],
      relations: [],
      created_at: '2026-01-01T00:00:00Z',
      version_at: '2026-01-01T00:00:00Z',
      operation_id: 'op_ITER010000000000000000000000',
      actor_id: 'substrate:test',
      tags: [],
    });
    fs.writeFileSync(path.join(claimsDir, '2026-01.jsonl'), legacyLine + '\n');

    const versions = [...iterAllClaimVersions(tmpDir)];
    expect(versions).toHaveLength(1);
    expect(versions[0]!.epistemic_owner).toBe('agent');
    expect(versions[0]!.fingerprint).toMatch(/^fp_/);
  });

  it('audit identifies migration risks', () => {
    const records = [
      { claim_id: 'c1', version: 1, state: 'active', content: 'A', author: 'agent', claim_type: 'finding' },
      { claim_id: 'c2', version: 1, state: 'active', content: 'B', author: 'user', claim_type: 'finding' },
      { claim_id: 'c3', version: 2, state: 'forgotten', author: 'agent', claim_type: 'finding' },
    ];

    const result = auditL1Migration(function* () {
      for (const r of records) yield r as Record<string, unknown>;
    });

    expect(result.total_versions).toBe(3);
    expect(result.missing_epistemic_owner).toBe(3);
    expect(result.missing_fingerprint).toBe(3);
    expect(result.user_corrections).toBe(1);
    expect(result.tombstones).toBe(1);
    expect(result.non_replayable_risk).toHaveLength(1);
    expect(result.non_replayable_risk[0]).toContain('c2');
  });
});
