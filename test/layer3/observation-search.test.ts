// Tests: raw-observation FTS index (spec §10a raw-searchable window)
//
// Covers the index layer contract: sync-raw indexability, state-based
// freshness labels (unverified/EXTRACTED/FAILED — never time-based), scope
// constraint before limit, sensitivity default-deny, terminal-state exclusion,
// and wipe-and-rebuild equivalence from the JSONL canonical.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Layer0Index } from '../../src/layer0/index.js';
import { appendObservation } from '../../src/layer0/log.js';
import {
  SearchIndex,
  syncObservationsFromEvidence,
  observationToIndexRow,
} from '../../src/layer3/search.js';
import type { Observation } from '../../src/layer0/types.js';

let tmpDir: string;
let searchIndex: SearchIndex;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-obs-fts-'));
  searchIndex = new SearchIndex(path.join(tmpDir, 'search.db'));
});

afterEach(() => {
  searchIndex.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  const now = new Date().toISOString();
  return {
    id: `obs_${Math.random().toString(16).slice(2).padStart(64, '0')}`,
    version: '0.6.1',
    type: 'message',
    status: 'accepted',
    source: {
      app: 'test-app',
      app_version: '1.0.0',
      source_id: null,
      actor: { type: 'person', id: 'user:owner', display_name: 'Owner' },
      captured_at: now,
      observed_at: now,
    },
    scope: 'personal',
    visibility: 'scope',
    content: { format: 'text/plain', body: 'needle alpha beta' },
    provenance: { parent_ids: [], supersedes: [], context: '' },
    policy: {
      retention: 'forever',
      retention_duration: null,
      sensitive: false,
      pii_detected: false,
    },
    integrity: { hash: 'h', writer_id: 'w', sequence: 1, previous_hash: null },
    ...overrides,
  };
}

describe('SearchIndex observation raw window', () => {
  it('indexes a raw observation and returns it for a matching term', () => {
    searchIndex.indexObservation(observationToIndexRow(makeObservation()));
    const hits = searchIndex.searchObservations('needle', 'personal');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.obs_id).toMatch(/^obs_/);
    expect(hits[0]!.freshness).toBe('unverified');
    expect(hits[0]!.status).toBe('accepted');
    expect(hits[0]!.content).toContain('needle');
  });

  it('constrains scope before the result limit (no cross-scope starvation)', () => {
    const db = searchIndex.getDB();
    const insert = db.prepare(`
      INSERT INTO observation_search_index
        (obs_id, scope, type, actor_id, observed_at, captured_at,
         source_app, source_id, sensitive, status, freshness, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const seed = db.transaction(() => {
      for (let i = 0; i < 201; i++) {
        insert.run(
          `obs_other_${i}`, 'project/other', 'message', 'user:owner',
          '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z',
          'test-app', null, 0, 'accepted', 'unverified',
          'needle alpha needle alpha needle alpha',
        );
      }
      insert.run(
        'obs_wanted', 'project/wanted', 'message', 'user:owner',
        '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z',
        'test-app', null, 0, 'accepted', 'unverified',
        'needle alpha',
      );
    });
    seed();

    const hits = searchIndex.searchObservations('needle alpha', 'project/wanted');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.obs_id).toBe('obs_wanted');
  });

  it('defaults to excluding sensitive observations unless included', () => {
    searchIndex.indexObservation(observationToIndexRow(makeObservation({
      id: 'obs_s1'.padEnd(66, '0'),
      policy: { retention: 'forever', retention_duration: null, sensitive: true, pii_detected: true },
    })));
    expect(searchIndex.searchObservations('needle', 'personal')).toHaveLength(0);
    expect(searchIndex.searchObservations('needle', 'personal', { includeSensitive: true })).toHaveLength(1);
  });

  it('filters by temporal range and blank query + range still returns rows', () => {
    searchIndex.indexObservation(observationToIndexRow(makeObservation({
      source: { app: 'a', app_version: '1', source_id: null, actor: { type: 'person', id: 'u', display_name: 'U' }, captured_at: '2026-08-29T10:00:00Z', observed_at: '2026-08-10T10:00:00Z' },
    })));
    searchIndex.indexObservation(observationToIndexRow(makeObservation({
      id: 'obs_2'.padEnd(66, '0'),
      source: { app: 'a', app_version: '1', source_id: null, actor: { type: 'person', id: 'u', display_name: 'U' }, captured_at: '2026-08-29T10:00:00Z', observed_at: '2026-09-01T10:00:00Z' },
    })));
    const hits = searchIndex.searchObservations('', 'personal', {
      temporalRange: { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.observed_at).toBe('2026-08-10T10:00:00Z');
  });

  it('exposes freshness labels and filters by them', () => {
    const first = observationToIndexRow(makeObservation());
    const second = observationToIndexRow(makeObservation({
      id: 'obs_3'.padEnd(66, '0'),
      content: { format: 'text/plain', body: 'needle after compile' },
    }), { freshness: 'EXTRACTED' });
    searchIndex.indexObservation(first);
    searchIndex.indexObservation(second);

    expect(searchIndex.getObservationFreshness(first.obs_id)).toBe('unverified');
    searchIndex.updateObservationFreshness(first.obs_id, 'FAILED');

    expect(searchIndex.searchObservations('needle', 'personal', {
      freshness: ['unverified'],
    })).toHaveLength(0);
    expect(searchIndex.searchObservations('needle', 'personal', {
      freshness: ['FAILED', 'EXTRACTED'],
    })).toHaveLength(2);
    expect(searchIndex.searchObservations('needle', 'personal')).toHaveLength(2);
  });

  it('removes terminal-state observations (matching rebuild semantics)', () => {
    const obs = observationToIndexRow(makeObservation());
    searchIndex.indexObservation(obs);
    expect(searchIndex.searchObservations('needle', 'personal')).toHaveLength(1);

    searchIndex.removeObservation(obs.obs_id);
    expect(searchIndex.searchObservations('needle', 'personal')).toHaveLength(0);
    expect(searchIndex.countObservations()).toBe(0);
  });

  it('purges a whole scope (FORGET.SCOPE erasure lane backing)', () => {
    searchIndex.indexObservation(observationToIndexRow(makeObservation()));
    searchIndex.indexObservation(observationToIndexRow(makeObservation({
      id: 'obs_4'.padEnd(66, '0'),
      scope: 'client:acme#1',
    })));
    const removed = searchIndex.removeObservationsByScope('client:acme#1');
    expect(removed).toBe(1);
    expect(searchIndex.searchObservations('needle', 'personal')).toHaveLength(1);
    expect(searchIndex.searchObservations('needle', 'client:acme#1')).toHaveLength(0);
  });

  it('stays robust on punctuation-only queries (no FTS5 syntax crash)', () => {
    searchIndex.indexObservation(observationToIndexRow(makeObservation()));
    expect(searchIndex.searchObservations('???', 'personal')).toHaveLength(0);
  });
});

describe('syncObservationsFromEvidence wipe-and-rebuild', () => {
  let layer0: Layer0Index;

  beforeEach(() => {
    layer0 = new Layer0Index(path.join(tmpDir, 'layer0.db'));
  });

  afterEach(() => {
    layer0.close();
  });

  it('rebuilds the index from the JSONL canonical and equals live indexing', () => {
    const evidenceDir = path.join(tmpDir, 'evidence');
    fs.mkdirSync(evidenceDir);

    const accepted = makeObservation();
    const sensitive = makeObservation({
      id: 'obs_s3'.padEnd(66, '0'),
      policy: { retention: 'forever', retention_duration: null, sensitive: true, pii_detected: true },
    });
    appendObservation(evidenceDir, accepted);
    appendObservation(evidenceDir, sensitive);

    // Live indexing (as the observe path does)…
    for (const obs of [accepted, sensitive]) {
      layer0.insertOrSkip(obs);
      searchIndex.indexObservation(observationToIndexRow(obs));
    }

    // …then wipe and rebuild. Same content, same effective statuses, so the
    // rebuilt window must be identical to the live one.
    const indexed = syncObservationsFromEvidence(evidenceDir, layer0, searchIndex);
    expect(indexed).toBe(2);
    const rebuilt = searchIndex.searchObservations('needle', 'personal');
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]!.obs_id).toBe(accepted.id);
    // Sensitive stays excluded by default under both paths.
    expect(searchIndex.searchObservations('needle', 'personal', { includeSensitive: true })).toHaveLength(2);
  });

  it('excludes terminal-state observations from the rebuilt window', () => {
    const evidenceDir = path.join(tmpDir, 'evidence2');
    fs.mkdirSync(evidenceDir);

    const tombstoned = makeObservation();
    appendObservation(evidenceDir, tombstoned);
    layer0.insertOrSkip(tombstoned);
    // Simulate a tombstone landing after indexing: effective status changes,
    // then a rebuild must not resurrect it into the raw window.
    const tombstoneEvent = makeObservation({
      id: 'obs_tomb_event'.padEnd(66, '0'),
      type: 'tombstone',
      content: {
        format: 'application/json',
        body: { target_id: tombstoned.id, target_kind: 'observation' },
      },
    });
    appendObservation(evidenceDir, tombstoneEvent);
    layer0.insertOrSkip(tombstoneEvent);
    layer0.applyMutationEvent(tombstoneEvent);

    const indexed = syncObservationsFromEvidence(evidenceDir, layer0, searchIndex);
    // The tombstoned target is excluded; the tombstone event record itself is
    // an accepted observation row, but its payload ('{"target_id": ...}') does
    // not contain the search term — the raw window must not resurrect the
    // tombstoned content.
    expect(indexed).toBe(1);
    expect(searchIndex.countObservations()).toBe(1);
    expect(searchIndex.searchObservations('needle', 'personal')).toHaveLength(0);
  });
});
