// Company-brain health contract (P1-3): lease, ingestion lag, receipts, storage,
// backup freshness and drift records.
//
// Every field here answers a question a host operator actually asks during a
// trial ("is my write epoch still the current one?", "how stale is the Gmail
// stream?", "did the retention sweep actually run?", "how big is this brain?",
// "is the backup fresh?", "has any projection drifted from canonical state?").
// The contract is counts, states and time — never tenant content.
//
// TDD: written before the report fields it pins down.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig } from '../../src/config.js';
import { appendOpLogEntry } from '../../src/ops_log/log.js';

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

const op = () => `op_${ulid()}`;

describe('company-brain health contract — lease, ingestion, receipts, storage, backup, drift', () => {
  const dirs: string[] = [];
  const cores: SmartwareCore[] = [];

  function makeBrain(): string {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-health-contract-'));
    dirs.push(dataDir);
    scaffold(dataDir);
    return dataDir;
  }

  async function openCore(dataDir?: string, fencingToken?: number): Promise<SmartwareCore> {
    const dir = dataDir ?? makeBrain();
    const core = await SmartwareCore.open({ dataDir: dir, ownerId: 'user:owner', fencingToken });
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

  it('S1: ownership reports the writer role, the current holder epoch and whose TTL it is', async () => {
    const dir = makeBrain();
    const writer = await openCore(dir, 7);
    const report = await writer.health({ actor: OWNER });

    expect(report.ownership.role).toBe('writer');
    expect(report.ownership.holder).not.toBeNull();
    expect(report.ownership.holder!.epoch).toBe(7);
    expect(report.ownership.holder!.claimed_at).toBeTruthy();
    expect(report.ownership.holder!.age_seconds).toBeGreaterThanOrEqual(0);
    // The brain knows the epoch; it does not know who holds it. Saying so is
    // part of the contract — identity lives in the host's arbiter.
    expect(report.ownership.holder!.identity).toBeNull();
    // No lease expiry is enforced inside the brain: the host arbiter owns the TTL
    // and refusal is by epoch comparison, so the field is explicitly null + owner.
    expect(report.ownership.ttl_seconds).toBeNull();
    expect(report.ownership.ttl_owner).toBe('host');

    // A process that opened the same brain without presenting an epoch cannot
    // write: it is an observer, not a writer.
    const observer = await openCore(dir);
    const observed = await observer.health({ actor: OWNER });
    expect(observed.ownership.role).toBe('observer');
    expect(observed.ownership.presented_token).toBeNull();
    expect(observed.ownership.holder!.epoch).toBe(7);

    // A brain nobody has fenced yet is still in legacy single-writer mode.
    const legacy = await openCore(makeBrain());
    const legacyReport = await legacy.health({ actor: OWNER });
    expect(legacyReport.ownership.role).toBe('unfenced_writer');
    expect(legacyReport.ownership.holder).toBeNull();
  });

  it('S2: ingestion reports per-stream cursor lag for a synced source, and names never-synced ones', async () => {
    const core = await openCore();
    core.registerSource({ actor: OWNER, id: 'src_gmail', kind: 'connector', display_name: 'Gmail' });
    core.registerSource({ actor: OWNER, id: 'src_calendar', kind: 'connector', display_name: 'Calendar' });

    await core.ingest({
      actor: OWNER, source_id: 'src_gmail', scope: 'workspace', cursor: 'history/100', operation_id: op(),
      items: [
        { external_id: 'msg_1', type: 'message', content: { format: 'text/plain', body: 'Acme asked about invoicing.' } },
        { external_id: 'msg_2', type: 'message', content: { format: 'text/plain', body: 'Acme renewed the contract.' } },
      ],
    });

    const report = await core.health({ actor: OWNER });
    expect(report.ingestion.registered_sources).toBe(2);
    expect(report.ingestion.sources_never_synced).toEqual(['src_calendar']);
    expect(report.ingestion.streams).toHaveLength(1);
    expect(report.ingestion.streams[0]).toMatchObject({
      source_id: 'src_gmail',
      scope: 'workspace',
      cursor: 'history/100',
      cursor_before: null,
      batches: 1,
      accepted: 2,
    });
    expect(report.ingestion.streams[0]!.lag_seconds).toBeGreaterThanOrEqual(0);
    expect(report.ingestion.max_lag_seconds).toBeGreaterThanOrEqual(0);
  });

  it('S3: retention and forget receipts are folded from the ops log with numeric details only', async () => {
    const core = await openCore();
    appendOpLogEntry(core.opsDir, {
      operation_id: op(), actor_id: 'user:owner', timestamp: new Date().toISOString(),
      op: 'retention.expire',
      details: { scope: 'client:acme#1', observations_expired: 3, claims_retracted: 1 },
    });
    appendOpLogEntry(core.opsDir, {
      operation_id: op(), actor_id: 'user:owner', timestamp: new Date().toISOString(),
      op: 'forget.scope',
      details: { scope: 'client:beta#2', observations_expired: 9, claims_retracted: 4 },
    });
    appendOpLogEntry(core.opsDir, {
      operation_id: op(), actor_id: 'user:owner', timestamp: new Date().toISOString(),
      op: 'forget',
      details: { scope: 'workspace', observation_id: 'obs_x' },
    });

    const report = await core.health({ actor: OWNER });
    expect(report.receipts.retention_expiries.total).toBe(1);
    expect(report.receipts.retention_expiries.last).toMatchObject({
      operation_id: expect.stringMatching(/^op_/),
      details_counts: { observations_expired: 3, claims_retracted: 1 },
    });
    expect(report.receipts.forgets.total).toBe(2);
    expect(report.receipts.forgets.scope_forgets).toBe(1);
    expect(report.receipts.forgets.last!.op).toBe('forget');

    // Receipts never carry tenant structure: no scope ids, no observation ids.
    const serialized = JSON.stringify(report.receipts);
    expect(serialized).not.toContain('client:acme');
    expect(serialized).not.toContain('client:beta');
    expect(serialized).not.toContain('obs_x');
  });

  it('S4: storage size is reported by area, and the areas sum to the total', async () => {
    const core = await openCore();
    await core.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'Atlas update: spec at https://atlas.example.com/v2' },
      scope: 'workspace',
    });

    const report = await core.health({ actor: OWNER });
    const { storage } = report;
    expect(storage.total_bytes).toBeGreaterThan(0);
    expect(storage.files).toBeGreaterThan(0);
    expect(storage.by_area.canonical).toBeGreaterThan(0); // evidence JSONL exists
    expect(storage.by_area.canonical + storage.by_area.derived + storage.by_area.other).toBe(storage.total_bytes);
  });

  it('S5: backup freshness is honest — not configured is stated, never guessed', async () => {
    const core = await openCore();
    const none = await core.health({ actor: OWNER });
    expect(none.backup).toMatchObject({ configured: false, dir: null, artifacts: 0, newest_at: null, age_seconds: null });

    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-backup-'));
    dirs.push(backupDir);
    fs.writeFileSync(path.join(backupDir, '20260915T0800Z'), 'backup artifact');

    const configured = await core.health({ actor: OWNER, backup_dir: backupDir });
    expect(configured.backup.configured).toBe(true);
    expect(configured.backup.artifacts).toBe(1);
    expect(configured.backup.newest_at).toBeTruthy();
    expect(configured.backup.age_seconds).toBeGreaterThanOrEqual(0);
  });

  it('S6: drift records compare each projection with its substrate and report real drift, not vibes', async () => {
    const core = await openCore();
    await core.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'Atlas update: spec at https://atlas.example.com/v2' },
      scope: 'workspace',
    });
    await core.drainCompileQueue();
    // The wiki manifest is written by STATUS/REFLECT, not by the compile drain
    // itself: run it so both drift checks have a projection to compare against.
    await core.status('user:owner');

    const fresh = await core.health({ actor: OWNER });
    expect(fresh.drift.in_sync).toBe(true);
    const surfaces = fresh.drift.records.map(record => record.surface).sort();
    expect(surfaces).toEqual(['observation_fts', 'wiki_manifest']);
    for (const record of fresh.drift.records) {
      expect(record.state).toBe('in_sync');
      expect(record.delta).toBe(0);
      expect(record.rule.length).toBeGreaterThan(0);
    }

    // Drop a page into the wiki that the projection does not know about: the
    // manifest promises N pages, the substrate holds N+1, and the record says so.
    const stray = path.join(core.wikiDir, 'workspace', 'stray-page.md');
    fs.writeFileSync(stray, '# Stray page\n\nWritten outside the compiler.\n');

    const drifted = await core.health({ actor: OWNER });
    expect(drifted.drift.in_sync).toBe(false);
    const wiki = drifted.drift.records.find(record => record.surface === 'wiki_manifest')!;
    expect(wiki.state).toBe('drift');
    expect(wiki.expected).toBe(0);
    expect(wiki.observed).toBe(1);
    expect(wiki.delta).toBe(wiki.observed - wiki.expected!);
    // The other projection still agrees with its substrate.
    expect(drifted.drift.records.find(record => record.surface === 'observation_fts')!.state).toBe('in_sync');
  });

  it('S7: a FORGET.SCOPE leaves the raw-observation projection in sync — the audit marker is indexed exactly as a rebuild does', async () => {
    const dir = makeBrain();
    const core = await openCore(dir);
    core.ensureScopes([{ id: 'client:acme#1', parent: 'workspace', visibility_default: 'scope' }]);
    await core.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'Acme beta note' },
      scope: 'client:acme#1',
    });
    const before = await core.health({ actor: OWNER });
    expect(before.drift.records.find(record => record.surface === 'observation_fts')!.state).toBe('in_sync');

    await core.forgetScope({ actor: OWNER, scope: 'client:acme#1', reason: 'offboarding', operation_id: op() });

    // The scope's raw rows leave the window. The audit marker is an accepted
    // Layer-0 observation in the pod scope, and a rebuilt index holds it (the
    // rebuild indexes every accepted observation) — so the live projection must
    // hold it too, or health reports drift and the trial SLO breaches after every
    // FORGET.SCOPE until the process restarts.
    const after = await core.health({ actor: OWNER });
    const afterFts = after.drift.records.find(record => record.surface === 'observation_fts')!;
    expect(afterFts.expected).toBe(afterFts.observed);
    expect(afterFts.state).toBe('in_sync');
    expect(after.drift.in_sync).toBe(true);

    // Live state and rebuilt state answer the same count: reopen (which rebuilds
    // derived indexes from the canonical logs) and compare.
    core.close();
    const reopened = await openCore(dir);
    const rebuilt = await reopened.health({ actor: OWNER });
    const rebuiltFts = rebuilt.drift.records.find(record => record.surface === 'observation_fts')!;
    expect(rebuiltFts.observed).toBe(afterFts.observed);
    expect(rebuilt.drift.in_sync).toBe(true);
  });
});
