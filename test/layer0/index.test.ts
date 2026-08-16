// Tests: Layer 0 — Derived Index (state transitions)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import type { Observation } from '../../src/layer0/types.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { appendObservation } from '../../src/layer0/log.js';
import { assignIntegrity } from '../../src/layer0/integrity.js';

let tmpDir: string;
let db: Layer0Index;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-idx-'));
  db = new Layer0Index(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeObs(type: Observation['type'], seq: number, extra: Partial<Observation> = {}): Observation {
  const base: Observation = {
    id: `obs_${ulid()}`,
    version: '0.5.1',
    type,
    status: 'accepted',
    source: {
      app: 'test', app_version: '1.0', source_id: null,
      actor: { type: 'person', id: 'user_1', display_name: 'Test' },
      captured_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
    },
    scope: 'personal', visibility: 'private',
    content: { format: 'text/plain', body: 'test' },
    provenance: { parent_ids: [], supersedes: [], context: '' },
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: 'writer_1', sequence: seq, previous_hash: null },
    ...extra,
  };
  return assignIntegrity(base, 'writer_1', seq, null);
}

describe('Layer0Index state transitions', () => {
  it('tombstoning an accepted observation changes effective status', () => {
    const target = makeObs('message', 1);
    db.insertOrSkip(target);

    const tombstone = makeObs('tombstone', 2, {
      content: { format: 'application/json', body: { target_id: target.id, reason: 'test' } },
    });
    db.insertOrSkip(tombstone);
    db.applyMutationEvent(tombstone);

    expect(db.getEffectiveStatus(target.id)).toBe('tombstoned');
  });

  it('tombstoning a tombstoned observation is a no-op (terminal state)', () => {
    const target = makeObs('message', 1);
    db.insertOrSkip(target);

    const tombstone1 = makeObs('tombstone', 2, {
      content: { format: 'application/json', body: { target_id: target.id } },
    });
    db.insertOrSkip(tombstone1);
    db.applyMutationEvent(tombstone1);

    const tombstone2 = makeObs('tombstone', 3, {
      content: { format: 'application/json', body: { target_id: target.id } },
    });
    db.insertOrSkip(tombstone2);
    db.applyMutationEvent(tombstone2);

    // Still tombstoned, not changed
    expect(db.getEffectiveStatus(target.id)).toBe('tombstoned');
  });

  it('quarantine_review approve transitions quarantined → accepted', () => {
    const target = makeObs('message', 1, { status: 'quarantined' });
    const quarObs = assignIntegrity({ ...target, status: 'quarantined' }, 'writer_1', 1, null);
    db.insertOrSkip(quarObs);

    // Simulate it starting as quarantined
    db.getDB().prepare("UPDATE observations SET effective_status = 'quarantined' WHERE id = ?").run(quarObs.id);
    expect(db.getEffectiveStatus(quarObs.id)).toBe('quarantined');

    const review = makeObs('quarantine_review', 2, {
      content: { format: 'application/json', body: { target_id: quarObs.id, action: 'approve' } },
    });
    db.insertOrSkip(review);
    db.applyMutationEvent(review);

    expect(db.getEffectiveStatus(quarObs.id)).toBe('accepted');
  });

  it('quarantine_review reject transitions quarantined → rejected', () => {
    const target = makeObs('message', 1);
    db.insertOrSkip(target);
    db.getDB().prepare("UPDATE observations SET effective_status = 'quarantined' WHERE id = ?").run(target.id);

    const review = makeObs('quarantine_review', 2, {
      content: { format: 'application/json', body: { target_id: target.id, action: 'reject' } },
    });
    db.insertOrSkip(review);
    db.applyMutationEvent(review);

    expect(db.getEffectiveStatus(target.id)).toBe('rejected');
  });

  it('rebuildIndex from JSONL replays state correctly', () => {
    const evidenceDir = path.join(tmpDir, 'evidence');
    fs.mkdirSync(evidenceDir);

    const target = makeObs('message', 1);
    appendObservation(evidenceDir, target);
    const tomb = makeObs('tombstone', 2, {
      content: { format: 'application/json', body: { target_id: target.id } },
    });
    appendObservation(evidenceDir, tomb);

    db.rebuildIndex(evidenceDir);

    expect(db.getEffectiveStatus(target.id)).toBe('tombstoned');
    expect(db.totalCount()).toBeGreaterThanOrEqual(2);
  });
});
