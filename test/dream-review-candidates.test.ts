import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDefaultDream } from '../src/dream/phases.js';
import { computeFingerprint } from '../src/layer1/fingerprint.js';
import { appendClaimVersion, type ActiveClaimVersion } from '../src/layer1/jsonl.js';

const SCOPE = 'project/dream';

function claim(
  content: string,
  overrides: Partial<ActiveClaimVersion> = {},
): ActiveClaimVersion {
  const now = overrides.version_at ?? new Date().toISOString();
  const claimType = overrides.claim_type ?? 'finding';
  return {
    claim_id: overrides.claim_id ?? `claim_${ulid()}`,
    version: 1,
    state: 'active',
    content,
    claim_type: claimType,
    claim_role: overrides.claim_role ?? 'memory',
    author: 'agent',
    epistemic_owner: 'agent',
    fingerprint: overrides.fingerprint ?? computeFingerprint(content, SCOPE, claimType),
    confidence: 'low',
    epistemic_tag: 'inference',
    scope: SCOPE,
    derived_from: [],
    relations: [],
    created_at: now,
    version_at: now,
    operation_id: `op_${ulid()}`,
    actor_id: 'substrate:test',
    tags: [],
    ...overrides,
  };
}

describe('Dream review candidates', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smartware-dream-review-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('surfaces near duplicates, alternative values, and checkpoint orientation sources without canonical writes', () => {
    const nearLeft = claim('Deploy only after verifying the production bundle checksum');
    const nearRight = claim('Deploy only after verify the production bundle checksum');
    const blue = claim('The release colour is blue', {
      semantic: {
        subject_name: 'Release',
        subject_type: 'project',
        predicate: 'colour_is',
        object: { type: 'text', value: 'blue' },
        t_valid_from: { value: '2026-01-01T00:00:00Z', state: 'known' },
        t_valid_to: { value: null, state: 'null' },
        extracted_epistemic: 'inferred',
        extracted_confidence: 0.5,
        sensitive: false,
        extraction: { method: 'deterministic', model: null, compiler_version: 'test', prompt_hash: null, extracted_at: '2026-01-01T00:00:00Z' },
      },
    });
    const green = claim('The release colour is green', {
      semantic: {
        ...blue.semantic!,
        object: { type: 'text', value: 'green' },
      },
    });
    const checkpointClaim = claim('Checkpoint: migration staged', {
      claim_type: 'checkpoint',
      claim_role: 'checkpoint',
    });
    for (const record of [nearLeft, nearRight, blue, green, checkpointClaim]) {
      appendClaimVersion(tmp, record);
    }

    const result = runDefaultDream(
      { opsDir: path.join(tmp, 'operations') },
      'substrate:test',
      SCOPE,
      { claimsDir: tmp },
    );
    const phase = result.phases.find(candidate => candidate.phase === 'detect_conflicts')!;

    expect(phase.canonical_writes).toEqual([]);
    expect(phase.derived_writes).toEqual(expect.arrayContaining([
      expect.stringMatching(/^near_duplicate_cluster:/),
      expect.stringMatching(/^contradiction_candidate:/),
      expect.stringMatching(/^orientation_card_preview:/),
    ]));
    expect(phase.derived_writes.join('\n')).toContain(nearLeft.claim_id);
    expect(phase.derived_writes.join('\n')).toContain(nearRight.claim_id);
    expect(phase.derived_writes.join('\n')).toContain(blue.claim_id);
    expect(phase.derived_writes.join('\n')).toContain(green.claim_id);
    expect(phase.derived_writes.join('\n')).toContain(checkpointClaim.claim_id);
  });
});
