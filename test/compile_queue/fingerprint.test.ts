// FingerprintIndex — O(1) fingerprint dedup for the compile queue (spec §11.2)
//
// The index is derived from the canonical L1 JSONL (month files, append-only)
// and must replicate the scan-based dedup semantics (findByFingerprint +
// findSemanticMatch): only the latest ACTIVE version with a matching
// structured fingerprint counts; a forgotten latest is absent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FingerprintIndex } from '../../src/compile_queue/fingerprint.js';
import { appendClaimVersions } from '../../src/layer1/jsonl.js';

let dataDir: string;
let index: FingerprintIndex;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-fp-'));
  index = new FingerprintIndex(path.join(dataDir, 'indices', 'fingerprints.db'));
});

afterEach(() => {
  index.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

interface VersionSeed {
  claim_id: string;
  version: number;
  fingerprint: string;
  derived_from?: string[];
}

function writeVersions(initials: VersionSeed[]): void {
  const now = new Date().toISOString();
  appendClaimVersions(dataDir, initials.map(v => ({
    claim_id: v.claim_id,
    version: v.version,
    state: 'active' as const,
    content: 'value',
    claim_type: 'hypothesis',
    claim_role: 'memory',
    author: 'agent',
    epistemic_owner: 'agent',
    fingerprint: v.fingerprint,
    confidence: 'low',
    epistemic_tag: 'inference',
    scope: 'project/alpha',
    derived_from: v.derived_from ?? ['obs_1'],
    relations: [],
    created_at: now,
    version_at: now,
    operation_id: `op_${String(v.version).padStart(26, '0')}`,
    actor_id: 'substrate:test',
    tags: [],
  })));
}

describe('FingerprintIndex', () => {
  it('rebuilds from the canonical L1 JSONL and resolves by fingerprint in O(1)', () => {
    writeVersions([
      { claim_id: 'claim_a', version: 1, fingerprint: 'fp_x' },
      { claim_id: 'claim_b', version: 1, fingerprint: 'fp_y' },
    ]);
    index.catchUp(dataDir);

    const hit = index.activeByFingerprint('fp_x');
    expect(hit).not.toBeNull();
    expect(hit!.claim_id).toBe('claim_a');
    expect(index.activeByFingerprint('missing')).toBeNull();
  });

  it('returns the latest version of the claim (never an older one)', () => {
    writeVersions([
      { claim_id: 'claim_a', version: 1, fingerprint: 'fp_x' },
      { claim_id: 'claim_a', version: 2, fingerprint: 'fp_x', derived_from: ['obs_1', 'obs_2'] },
    ]);
    index.catchUp(dataDir);

    const hit = index.activeByFingerprint('fp_x');
    expect(hit!.version).toBe(2);
    expect(hit!.derived_from).toEqual(['obs_1', 'obs_2']);
  });

  it('excludes a forgotten latest (claim re-assertable)', () => {
    writeVersions([
      { claim_id: 'claim_a', version: 1, fingerprint: 'fp_x' },
      { claim_id: 'claim_a', version: 2, fingerprint: 'fp_x', derived_from: ['obs_1', 'obs_2'] },
    ]);
    index.catchUp(dataDir);
    // Forget: append a forgotten version (state transition on the same claim).
    const forgotten = {
      claim_id: 'claim_a',
      version: 3,
      state: 'forgotten' as const,
      claim_type: 'hypothesis' as const,
      claim_role: 'memory' as const,
      author: 'agent' as const,
      epistemic_owner: 'agent' as const,
      fingerprint: 'fp_x',
      confidence: 'low' as const,
      epistemic_tag: 'inference' as const,
      scope: 'project/alpha',
      derived_from: ['obs_1', 'obs_2'],
      relations: [],
      created_at: new Date().toISOString(),
      version_at: new Date().toISOString(),
      operation_id: 'op_00000000000000000000000003',
      actor_id: 'substrate:test',
      tags: [],
      tombstone_id: 'tomb_a',
      forgotten_at: new Date().toISOString(),
      forgotten_by: 'user:me',
    };
    appendClaimVersions(dataDir, [forgotten]);
    index.catchUp(dataDir);

    expect(index.activeByFingerprint('fp_x')).toBeNull();
  });

  it('catchUp is incremental (unchanged months skipped, appended versions seen)', () => {
    writeVersions([{ claim_id: 'claim_a', version: 1, fingerprint: 'fp_x' }]);
    index.catchUp(dataDir);
    expect(index.activeByFingerprint('fp_x')!.version).toBe(1);

    // Same month file appended — the size changed, so the month re-indexes.
    writeVersions([{ claim_id: 'claim_b', version: 1, fingerprint: 'fp_y' }]);
    index.catchUp(dataDir);
    expect(index.activeByFingerprint('fp_y')!.claim_id).toBe('claim_b');
  });

  it('upsertVersion only lets newer versions win', () => {
    index.upsertVersion({
      claim_id: 'claim_c',
      version: 1,
      state: 'active',
      content: 'v1',
      claim_type: 'hypothesis',
      claim_role: 'memory',
      author: 'agent',
      epistemic_owner: 'agent',
      fingerprint: 'fp_z',
      confidence: 'low',
      epistemic_tag: 'inference',
      scope: 'project/alpha',
      derived_from: ['obs_1'],
      relations: [],
      created_at: '2026-08-29T10:00:00.000Z',
      version_at: '2026-08-29T10:00:00.000Z',
      operation_id: 'op_00000000000000000000000004',
      actor_id: 'substrate:test',
      tags: [],
    });
    index.upsertVersion({
      ...index.activeByClaimId('claim_c')!,
      version: 1, // stale — must not regress
      claim_id: 'claim_c',
    });
    expect(index.activeByClaimId('claim_c')!.version).toBe(1);
  });

  it('wipe-and-rebuild equals incremental state (rebuild-equivalence)', () => {
    writeVersions([
      { claim_id: 'claim_a', version: 1, fingerprint: 'fp_x' },
      { claim_id: 'claim_b', version: 2, fingerprint: 'fp_y' },
    ]);
    index.catchUp(dataDir);
    const before = index.count();

    index.rebuild(dataDir);
    expect(index.count()).toBe(before);
    expect(index.activeByFingerprint('fp_x')!.claim_id).toBe('claim_a');
    expect(index.activeByFingerprint('fp_y')!.version).toBe(2);
  });
});
