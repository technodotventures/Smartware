// Tests: Layer 0 — JSONL Log

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Observation } from '../../src/layer0/types.js';
import { appendObservation, readAll, readFile, listDates } from '../../src/layer0/log.js';
import { assignIntegrity } from '../../src/layer0/integrity.js';
import { ulid } from 'ulid';

function makeObs(seq: number, scope = 'personal'): Observation {
  return {
    id: `obs_${ulid()}`,
    version: '0.5.1',
    type: 'message',
    status: 'accepted',
    source: {
      app: 'test',
      app_version: '1.0',
      source_id: null,
      actor: { type: 'person', id: 'user_1', display_name: 'Test User' },
      captured_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
    },
    scope,
    visibility: 'private',
    content: { format: 'text/plain', body: `Test message ${seq}` },
    provenance: { parent_ids: [], supersedes: [], context: '' },
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: 'writer_1', sequence: seq, previous_hash: null },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('appendObservation / readAll', () => {
  it('appends observations and reads them back in order', () => {
    const obs1 = assignIntegrity(makeObs(1), 'writer_1', 1, null);
    const obs2 = assignIntegrity(makeObs(2), 'writer_1', 2, obs1.integrity.hash);
    const obs3 = assignIntegrity(makeObs(3), 'writer_1', 3, obs2.integrity.hash);

    appendObservation(tmpDir, obs1);
    appendObservation(tmpDir, obs2);
    appendObservation(tmpDir, obs3);

    const all = [...readAll(tmpDir)];
    expect(all).toHaveLength(3);
    expect(all[0]!.id).toBe(obs1.id);
    expect(all[1]!.id).toBe(obs2.id);
    expect(all[2]!.id).toBe(obs3.id);
  });

  it('each line is independent JSON (not modified)', () => {
    const obs = assignIntegrity(makeObs(1), 'writer_1', 1, null);
    appendObservation(tmpDir, obs);

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(tmpDir, `${today}.jsonl`);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.id).toBe(obs.id);
  });

  it('listDates returns sorted date files', () => {
    const obs = assignIntegrity(makeObs(1), 'writer_1', 1, null);
    appendObservation(tmpDir, obs);
    const dates = listDates(tmpDir);
    expect(dates.length).toBeGreaterThanOrEqual(1);
    expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
