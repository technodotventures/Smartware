// Tests: Layer 0 — Idempotency

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import type { Observation } from '../../src/layer0/types.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { checkLegacySourceDedup, checkIdempotency, computePayloadHash } from '../../src/layer0/idempotency.js';
import { assignIntegrity } from '../../src/layer0/integrity.js';

let tmpDir: string;
let index: Layer0Index;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-idem-'));
  index = new Layer0Index(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  index.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeObs(sourceId: string | null): Observation {
  const base: Observation = {
    id: `obs_${ulid()}`,
    version: '0.5.1',
    type: 'message',
    status: 'accepted',
    source: {
      app: 'test-app', app_version: '1.0', source_id: sourceId,
      actor: { type: 'person', id: 'user_1', display_name: 'Test' },
      captured_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
    },
    scope: 'personal', visibility: 'private',
    content: { format: 'text/plain', body: 'hello' },
    provenance: { parent_ids: [], supersedes: [], context: '' },
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: 'writer_1', sequence: 1, previous_hash: null },
  };
  return assignIntegrity(base, 'writer_1', 1, null);
}

describe('checkLegacySourceDedup', () => {
  it('returns not duplicate when source_id is null', () => {
    const result = checkLegacySourceDedup(index, 'test-app', null);
    expect(result.isDuplicate).toBe(false);
    expect(result.existingId).toBeUndefined();
  });

  it('first submission is not a duplicate', () => {
    const result = checkLegacySourceDedup(index, 'test-app', 'msg-001');
    expect(result.isDuplicate).toBe(false);
  });

  it('second submission with same source_id is a duplicate', () => {
    const obs = makeObs('msg-001');
    index.insertOrSkip(obs);

    const result = checkLegacySourceDedup(index, 'test-app', 'msg-001');
    expect(result.isDuplicate).toBe(true);
    expect(result.existingId).toBe(obs.id);
  });

  it('different apps with same source_id are NOT duplicates', () => {
    const obs = makeObs('msg-001');
    index.insertOrSkip(obs);

    const result = checkLegacySourceDedup(index, 'different-app', 'msg-001');
    expect(result.isDuplicate).toBe(false);
  });
});

describe('checkIdempotency (spec-conformant)', () => {
  it('returns none when key is undefined', () => {
    const result = checkIdempotency(index, 'user_1', undefined, 'hash');
    expect(result.kind).toBe('none');
  });

  it('returns none for first submission with a key', () => {
    const result = checkIdempotency(index, 'user_1', 'op_001', computePayloadHash({ foo: 'bar' }));
    expect(result.kind).toBe('none');
  });
});
