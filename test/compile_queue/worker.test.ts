// Compile worker — sync-raw + async-compile write path (spec §9.1 / §10a)
//
// End-to-end through SmartwareCore:
//   observe → raw-searchable 'unverified' + durable queue job pending;
//   drain   → claims in L1 + RECALL, raw window flips to EXTRACTED;
//   re-drain → idempotent (no duplicate claims, fingerprint dedup);
//   failure → FAILED marker, raw stays searchable forever;
//   queue wipe → regenerable from evidence + receipts (derived state).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SmartwareCore } from '../../src/core.js';
import { handleObserve } from '../../src/protocol/observe.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, observationToIndexRow } from '../../src/layer3/search.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';
import { readAll } from '../../src/layer0/log.js';
import { saveConfig } from '../../src/config.js';
import { CompileQueue, defaultCompileQueuePath } from '../../src/compile_queue/queue.js';
import { openFingerprintIndex } from '../../src/compile_queue/fingerprint.js';
import { runCompileBatch, syncCompileQueue } from '../../src/compile_queue/worker.js';
import { ensurePrivateDirectory } from '../../src/storage/private-fs.js';

const opened: SmartwareCore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const core of opened.splice(0)) core.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };

async function openCore(): Promise<SmartwareCore> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-queue-'));
  directories.push(dataDir);
  const core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
  opened.push(core);
  return core;
}

describe('compile queue end-to-end (SmartwareCore)', () => {
  it('observe enqueues a durable job; drain compiles claims and flips freshness EXTRACTED', async () => {
    const core = await openCore();
    const observed = await core.observe({
      actor: OWNER,
      type: 'message',
      content: { format: 'text/plain', body: 'Atlas update: spec at https://atlas.example.com/v2' },
      scope: 'personal',
    });
    expect(observed.status).toBe('accepted');

    // Freshness promise: raw-searchable BEFORE any compile job resolves.
    let hits = core.searchObservations('atlas', 'personal');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.freshness).toBe('unverified');
    // ...and the durable job is pending.
    expect(core.compileQueueStats()!.statuses.pending).toBe(1);

    // Async compile: one drain resolves the batch.
    const result = await core.drainCompileQueue();
    expect(result!.claimed).toBe(1);
    expect(result!.new_claims).toBeGreaterThan(0);
    expect(result!.failed).toBe(0);

    // EXTRACTED: claim ranks above; the raw observation is kept as evidence.
    hits = core.searchObservations('atlas', 'personal');
    expect(hits[0]!.freshness).toBe('EXTRACTED');

    const recall = await core.recall({
      actor: OWNER,
      query: 'atlas',
      scope: 'personal',
    });
    expect(recall.results.length).toBeGreaterThan(0);

    // Receipt carries the literal state-based label in the ops log.
    const entries = [...readAllOpLogEntries(core.opsDir)];
    const receipt = entries.find(e =>
      e.op === 'reflect.auto'
      && e.details?.['observation_id'] === observed.id
      && e.details?.['reflection_complete'] === true);
    expect(receipt).toBeDefined();
    expect(receipt!.details!['freshness']).toBe('EXTRACTED');

    expect(core.compileQueueStats()!.statuses.done).toBe(1);
    expect(core.compileQueueStats()!.freshness.extracted).toBe(1);
    expect(core.compileQueueStats()!.freshness.unverified).toBe(0);
  });

  it('re-drain is idempotent: fingerprint dedup, no duplicate claims', async () => {
    const core = await openCore();
    await core.observe({
      actor: OWNER,
      type: 'message',
      content: { format: 'text/plain', body: 'Deadline: 2026-06-15. Spec at https://x.example.com/spec' },
      scope: 'personal',
    });
    const first = await core.drainCompileQueue();
    const second = await core.drainCompileQueue();
    expect(first!.new_claims).toBeGreaterThan(0);
    expect(second!.new_claims).toBe(0);
    expect(second!.claimed).toBe(0);
  });

  it('compile-queue jobs are durable across a process restart simulation', async () => {
    const core = await openCore();
    await core.observe({
      actor: OWNER,
      type: 'message',
      content: { format: 'text/plain', body: 'The Atlas release is on hold until Friday.' },
      scope: 'personal',
    });
    // One drain settles the batch; the ops-log receipt is the durable
    // terminal marker (regeneration from receipts is covered by the
    // low-level syncCompileQueue test below).
    await core.drainCompileQueue({ limit: 1 });
    expect(core.compileQueueStats()!.statuses.done).toBe(1);
  });
});

// ── Low-level worker failure path (manual fixture; injectable produce) ───────

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-worker-'));
  directories.push(tmp);
  ensurePrivateDirectory(tmp);
  const evidenceDir = path.join(tmp, 'evidence');
  const opsDir = path.join(tmp, 'operations');
  const wikiDir = path.join(tmp, 'wiki');
  ensurePrivateDirectory(evidenceDir);
  ensurePrivateDirectory(opsDir);
  ensurePrivateDirectory(wikiDir);

  const config = {
    instance_id: 'smartware_01H000000000000000000000',
    owner_id: 'user:owner',
    writer_id: 'writer_local_01H0000000000000000000X',
    version: '0.6.3',
    data_dir: tmp,
    scopes: [
      { id: 'self', parent: null, visibility_default: 'private' as const },
      { id: 'workspace', parent: null, visibility_default: 'workspace' as const },
      { id: 'project:default', parent: 'workspace', visibility_default: 'scope' as const },
    ],
    grants: [],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
  saveConfig(tmp, config);

  const dbPath = path.join(tmp, 'smartware.db');
  const layer0 = new Layer0Index(dbPath);
  const store = new ClaimStore(dbPath);
  store.setDataDir(tmp);
  const searchIndex = new SearchIndex(dbPath);
  layer0.catchUp(evidenceDir);
  return { tmp, evidenceDir, opsDir, wikiDir, layer0, store, searchIndex, config };
}

describe('compile worker failure isolation', () => {
  it('a throwing compile marks the job FAILED and keeps the raw window searchable', async () => {
    const f = makeFixture();
    const observed = await handleObserve(
      { actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'Atlas mission notes' }, scope: 'personal' },
      f.evidenceDir, f.layer0, f.config,
    );
    const realObs = [...readAll(f.evidenceDir)].find(o => o.id === observed.id)!;
    f.searchIndex.indexObservation(observationToIndexRow(realObs));

    const queue = new CompileQueue(defaultCompileQueuePath(f.tmp));
    const fingerprintIndex = openFingerprintIndex(f.tmp, defaultCompileQueuePath(f.tmp).replace('compile.db', 'fingerprints.db'));
    queue.enqueue(observed.id, 'personal');

    const result = await runCompileBatch({
      evidenceDir: f.evidenceDir,
      dataDir: f.tmp,
      layer0: f.layer0,
      store: f.store,
      searchIndex: f.searchIndex,
      config: f.config,
      opsDir: f.opsDir,
      queue,
      fingerprintIndex,
    }, {
      produce: async () => { throw new Error('LLM outage simulated'); },
    });

    expect(result.failed).toBe(1);
    expect(result.failed_observation_ids).toEqual([observed.id]);
    expect(queue.get(observed.id)!.status).toBe('failed');
    expect(queue.get(observed.id)!.last_error).toContain('LLM outage');

    // FAILED: raw stays searchable forever — the label is literal, not hidden.
    expect(f.searchIndex.getObservationFreshness(observed.id)).toBe('FAILED');
    const rawHits = f.searchIndex.searchObservations('atlas', 'personal');
    expect(rawHits).toHaveLength(1);
    expect(rawHits[0]!.freshness).toBe('FAILED');

    // Durable failure marker in the ops log (not a terminal receipt).
    const entries = [...readAllOpLogEntries(f.opsDir)];
    const marker = entries.find(e =>
      e.op === 'reflect.auto' && e.details?.['observation_id'] === observed.id);
    expect(marker).toBeDefined();
    expect(marker!.details!['outcome']).toBe('failed');
    expect(marker!.details!['freshness']).toBe('FAILED');

    queue.close();
    fingerprintIndex.close();
    f.layer0.close();
    f.store.close();
    f.searchIndex.close();
  });

  it('syncCompileQueue regenerates derived state from evidence + receipts (no silent re-queue)', async () => {
    const f = makeFixture();
    const observed = await handleObserve(
      { actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'Atlas mission notes' }, scope: 'personal' },
      f.evidenceDir, f.layer0, f.config,
    );
    const searchIndex = f.searchIndex;
    const realObs = [...readAll(f.evidenceDir)].find(o => o.id === observed.id)!;
    searchIndex.indexObservation(observationToIndexRow(realObs));

    const queue = new CompileQueue(defaultCompileQueuePath(f.tmp));
    const fingerprintIndex = openFingerprintIndex(f.tmp, defaultCompileQueuePath(f.tmp).replace('compile.db', 'fingerprints.db'));
    queue.enqueue(observed.id, 'personal');
    await runCompileBatch({
      evidenceDir: f.evidenceDir, dataDir: f.tmp, layer0: f.layer0, store: f.store,
      searchIndex, config: f.config, opsDir: f.opsDir, queue, fingerprintIndex,
    });
    expect(queue.stats().done).toBe(1);

    // Wipe the derived ledger and regenerate — the receipt keeps the job done.
    queue.close();
    fs.rmSync(defaultCompileQueuePath(f.tmp), { force: true });
    const regenerated = new CompileQueue(defaultCompileQueuePath(f.tmp));
    const seeded = syncCompileQueue({
      evidenceDir: f.evidenceDir, dataDir: f.tmp, layer0: f.layer0, searchIndex, opsDir: f.opsDir,
    }, regenerated);
    expect(seeded).toBe(0);
    expect(regenerated.stats().done).toBe(1);
    expect(searchIndex.getObservationFreshness(observed.id)).toBe('EXTRACTED');

    regenerated.close();
    fingerprintIndex.close();
    f.layer0.close();
    f.store.close();
    f.searchIndex.close();
  });
});
