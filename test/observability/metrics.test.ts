// Observability — latency histograms and recovery events (P1-3).
//
// The health contract promises two things this suite pins down:
//
//   1. recall/write latency is reported as a *histogram* (samples + bucket
//      counts + upper-bound quantiles), not as an average — an average hides
//      the tail a trial actually fails on;
//   2. the samples are durable operational state: they survive a process
//      restart (flushed at report/close), and a wipe costs only history, never
//      canonical memory.
//
// TDD: written before src/observability/latency.ts and the metrics-store
// additions it exercises.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig } from '../../src/config.js';
import { MetricsStore, defaultMetricsPath } from '../../src/observability/metrics.js';
import { quantileUpperBoundMs, LATENCY_BUCKETS_MS } from '../../src/observability/latency.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };

function scaffold(dataDir: string): void {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = 'user:owner';
  cfg.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
  ];
  saveConfig(dataDir, cfg);
}

describe('latency histograms (P1-3)', () => {
  const dirs: string[] = [];
  const cores: SmartwareCore[] = [];

  function makeBrain(): string {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-latency-'));
    dirs.push(dataDir);
    scaffold(dataDir);
    return dataDir;
  }

  async function openCore(dataDir: string): Promise<SmartwareCore> {
    const core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
    cores.push(core);
    return core;
  }

  afterEach(() => {
    for (const core of cores.splice(0)) {
      try { core.close(); } catch { /* already closed */ }
    }
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('L0: bucket quantiles are upper bounds — the smallest bucket at or above the quantile', () => {
    // 9 samples in the 5 ms bucket, 1 in the 250 ms bucket.
    const histogram = new Map<number, number>([[5, 9], [250, 1]]);
    expect(quantileUpperBoundMs(histogram, 0.5, 10)).toBe(5);
    // The 0.9 quantile is still inside the 5 ms bucket (cumulative 9 ≥ 9).
    expect(quantileUpperBoundMs(histogram, 0.9, 10)).toBe(5);
    // The 0.95 quantile needs the next bucket.
    expect(quantileUpperBoundMs(histogram, 0.95, 10)).toBe(250);
    // No samples: no claim.
    expect(quantileUpperBoundMs(new Map(), 0.95, 0)).toBeNull();
  });

  it('L1: recall and observe samples are reported as histograms with bucket counts that sum to samples', async () => {
    const core = await openCore(makeBrain());

    await core.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'Atlas update: spec at https://atlas.example.com/v2' },
      scope: 'workspace',
    });
    await core.recall({ actor: OWNER, query: 'atlas', scope: 'workspace' });
    await core.recall({ actor: OWNER, query: 'atlas spec', scope: 'workspace' });

    const report = await core.health({ actor: OWNER });

    const observe = report.latency.observe;
    expect(observe.samples).toBe(1);
    expect(observe.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
    expect(observe.p95_ms_upper_bound).not.toBeNull();

    const recall = report.latency.recall;
    expect(recall.samples).toBe(2);
    expect(recall.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(2);
    expect(recall.p50_ms_upper_bound).not.toBeNull();
    // Bounds are ordered, and every reported bound is a real bucket edge.
    expect(recall.p50_ms_upper_bound!).toBeLessThanOrEqual(recall.p95_ms_upper_bound!);
    expect(LATENCY_BUCKETS_MS).toContain(recall.p50_ms_upper_bound!);
    // Max is an observation, never a bound — it is the slowest sample seen.
    expect(recall.max_ms).toBeGreaterThanOrEqual(0);
  });

  it('L2: latency history is durable across a reopen, and only host-facing data ops are sampled', async () => {
    const dir = makeBrain();
    const first = await openCore(dir);
    for (let i = 0; i < 3; i += 1) {
      await first.recall({ actor: OWNER, query: 'atlas', scope: 'workspace' });
    }
    // Control calls are not data ops: they must not appear in the histograms.
    await first.status('user:owner');
    const before = await first.health({ actor: OWNER });
    expect(before.latency.recall.samples).toBe(3);
    expect(Object.keys(before.latency)).not.toContain('status');
    expect(Object.keys(before.latency)).not.toContain('health');
    first.close();

    const second = await openCore(dir);
    const after = await second.health({ actor: OWNER });
    expect(after.latency.recall.samples).toBe(3);
    expect(after.latency.recall.max_ms).toBe(before.latency.recall.max_ms);
  });

  it('L3: the metrics store is deletable operational state, not canonical memory', async () => {
    const dir = makeBrain();
    const core = await openCore(dir);
    await core.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'Atlas update: spec at https://atlas.example.com/v2' },
      scope: 'workspace',
    });
    await core.recall({ actor: OWNER, query: 'atlas', scope: 'workspace' });
    await core.health({ actor: OWNER });
    core.close();

    fs.rmSync(defaultMetricsPath(dir), { force: true });
    fs.rmSync(`${defaultMetricsPath(dir)}-wal`, { force: true });
    fs.rmSync(`${defaultMetricsPath(dir)}-shm`, { force: true });

    const reopened = await openCore(dir);
    const report = await reopened.health({ actor: OWNER });
    // Latency history is gone, and the report says so by ABSENCE — an op with no
    // samples is never rendered as a zero-latency pass (an SLO over it is
    // 'unknown', not 'ok'). The brain's memory is untouched.
    expect(report.latency.recall).toBeUndefined();
    expect(report.counts.lanes!.layer0.total).toBe(1);
    expect(report.counts.lanes!.layer3.observation_index_rows).toBe(1);
  });

  it('R1: every open records a recovery event, and the count grows with each open', async () => {
    const dir = makeBrain();
    const first = await openCore(dir);
    const one = await first.health({ actor: OWNER });
    expect(one.recovery.events).toBe(1);
    expect(one.recovery.last).not.toBeNull();
    expect(one.recovery.last!.opened_at).toBe(one.opened_at);
    expect(one.recovery.last!.pending_operations).toBe(0);
    expect(one.recovery.last!.requires_manual_review).toBe(0);
    first.close();

    const second = await openCore(dir);
    const two = await second.health({ actor: OWNER });
    expect(two.recovery.events).toBe(2);
    expect(two.recovery.last!.at >= one.recovery.last!.at).toBe(true);
  });

  it('R2: recovery events are durable operational rows with counts only — no tenant content', () => {
    const store = MetricsStore.open(':memory:');
    store.recordRecovery({
      at: '2026-09-15T08:00:00.000Z',
      opened_at: '2026-09-15T08:00:00.000Z',
      committed_operations: 12,
      orphans: 0,
      pending_operations: 0,
      intent_errors: 0,
      requires_manual_review: 0,
      completed: 2,
      quarantined: 0,
      aborted: 1,
    });
    const summary = store.recovery();
    expect(summary.events).toBe(1);
    expect(summary.last).toMatchObject({ completed: 2, aborted: 1, committed_operations: 12 });
    store.close();
  });
});
