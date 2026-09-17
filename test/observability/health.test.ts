// Company-brain observability surface (P1-3): the host-facing health/metrics
// contract and the Coffee-trial SLOs over it.
//
// The contract is deliberately a *counts and states* surface: it must never
// carry tenant content (observation bodies, claim values, actor display
// names). Authority is enforced by scope: the owner sees the whole brain, a
// granted actor sees only the scopes it can read, everybody else is denied.
//
// TDD: this suite is written before the implementation (test/observability
// lands with src/protocol/health.ts + src/observability/*).

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig } from '../../src/config.js';
import { ProtocolError } from '../../src/auth/middleware.js';
import { CompileQueue, defaultCompileQueuePath } from '../../src/compile_queue/queue.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const GIGI = { type: 'person' as const, id: 'user:gigi', display_name: 'Gigi' };
const NOAH = { type: 'person' as const, id: 'user:noah', display_name: 'Noah' };
const GHOST = { type: 'person' as const, id: 'user:ghost', display_name: 'Ghost' };

function grant(
  actorId: string,
  capabilities: Partial<{
    observe: string[];
    query: string[];
    compile: string[];
    correct: string[];
    forget: string[];
    read: string[];
  }>,
): Record<string, unknown> {
  return {
    id: `grant_${actorId.replace(/[^a-z0-9]/g, '_')}`,
    actor_type: 'person',
    actor_id: actorId,
    capabilities: { observe: [], query: [], compile: [], correct: [], forget: [], ...capabilities },
    trusted: false,
    quarantine: false,
    created_at: new Date().toISOString(),
    expires_at: null,
    status: 'active',
  };
}

function scaffold(dataDir: string): void {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = 'user:owner';
  cfg.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    { id: 'client:acme#1', parent: 'workspace', visibility_default: 'scope' },
  ];
  cfg.grants = [
    grant('user:gigi', { read: ['client:acme#1'], observe: ['client:acme#1'], query: ['client:acme#1'] }) as never,
    // Registered, holds capabilities, but no `read` capability anywhere.
    grant('user:noah', { observe: ['client:acme#1'], query: ['client:acme#1'] }) as never,
  ];
  saveConfig(dataDir, cfg);
}

const COMPILABLE_BODY = 'Atlas update: spec at https://atlas.example.com/v2';

describe('company-brain health surface (P1-3)', () => {
  const dirs: string[] = [];
  const cores: SmartwareCore[] = [];

  function makeBrain(prefix = 'sw-health-'): string {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dataDir);
    scaffold(dataDir);
    return dataDir;
  }

  async function openCore(dataDir?: string): Promise<SmartwareCore> {
    const core = await SmartwareCore.open({ dataDir: dataDir ?? makeBrain(), ownerId: 'user:owner' });
    cores.push(core);
    return core;
  }

  async function openCoreFenced(dataDir: string, fencingToken: number): Promise<SmartwareCore> {
    const core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner', fencingToken });
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

  const observe = (core: SmartwareCore, body: string, scope = 'workspace') =>
    core.observe({
      actor: OWNER,
      type: 'message',
      content: { format: 'text/plain', body },
      scope,
    });

  it('A1: fails closed — an unregistered actor and a registered actor without read are denied', async () => {
    const core = await openCore();

    const ghost = await core.health({ actor: GHOST }).then(() => null, (e: unknown) => e);
    expect(ghost).toBeInstanceOf(ProtocolError);
    expect((ghost as ProtocolError).code).toBe('actor_unregistered');

    const noah = await core.health({ actor: NOAH }).then(() => null, (e: unknown) => e);
    expect(noah).toBeInstanceOf(ProtocolError);
    expect((noah as ProtocolError).code).toBe('insufficient_permission');
  });

  it('A2: owner report carries brain state, fencing state and lane-explicit index counts', async () => {
    const core = await openCore();
    await observe(core, COMPILABLE_BODY);
    await core.drainCompileQueue();

    const report = await core.health({ actor: OWNER });

    expect(report.instance_id).toMatch(/^smartware_/);
    expect(report.version).toBe(core.getConfig().version);
    expect(report.brain.open).toBe(true);
    expect(report.ownership).toMatchObject({
      arbitration: 'external',
      enforcement: 'none',
      epoch_high_water: 0,
      refusals: 0,
    });

    const lanes = report.counts.lanes;
    expect(lanes).toBeDefined();
    expect(lanes!.layer0.total).toBe(1);
    expect(lanes!.layer3.observation_index_rows).toBe(1);
    expect(lanes!.layer3.claim_index_rows).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(lanes!.layer3.entity_index_rows)).toBe(true);
    expect(lanes!.layer3.observations_by_freshness.extracted).toBe(1);

    // The scope rows are the per-scope view of the same canonical counts.
    const workspace = report.counts.by_scope.find(row => row.scope === 'workspace');
    expect(workspace).toBeDefined();
    expect(workspace!.observations_recorded).toBe(1);
    expect(workspace!.observations_accepted).toBe(1);
  });

  it('A3: STATUS reports lane-explicit layer3 counts, not the misleading single number', async () => {
    const core = await openCore();
    await observe(core, COMPILABLE_BODY);
    await core.drainCompileQueue();

    const status = await core.status('user:owner');
    expect(status.layer3).not.toHaveProperty('indexed');
    expect(status.layer3.observation_index_rows).toBe(1);
    expect(status.layer3.claim_index_rows).toBeGreaterThanOrEqual(1);
    expect(status.layer3.observations_by_freshness.extracted).toBe(1);
  });

  it('B1: compile queue depth, oldest pending age and drain timestamps are reported', async () => {
    const core = await openCore();
    await observe(core, COMPILABLE_BODY);
    await observe(core, 'Billing cycle note for the Acme account.');

    const queued = await core.health({ actor: OWNER });
    expect(queued.compile_queue.depth).toBe(2);
    expect(queued.compile_queue.pending).toBe(2);
    expect(queued.compile_queue.running).toBe(0);
    expect(queued.compile_queue.oldest_pending_at).toBeTruthy();
    expect(queued.compile_queue.oldest_pending_age_seconds).toBeGreaterThanOrEqual(0);
    expect(queued.compile_queue.last_completed_at).toBeNull();
    expect(queued.compile_queue.last_failed_at).toBeNull();

    await core.drainCompileQueue();
    const drained = await core.health({ actor: OWNER });
    expect(drained.compile_queue.depth).toBe(0);
    expect(drained.compile_queue.done).toBe(2);
    expect(drained.compile_queue.oldest_pending_at).toBeNull();
    expect(drained.compile_queue.oldest_pending_age_seconds).toBeNull();
    expect(drained.compile_queue.last_completed_at).toBeTruthy();
  });

  it('B2: a failed compile is visible as a failure + timestamp; a retry drain clears it', async () => {
    const dir = makeBrain();
    const core = await openCore(dir);
    const observed = await observe(core, COMPILABLE_BODY);

    // The worker's own failure path is covered by test/compile_queue/worker.test.ts;
    // here the ledger is put into the state that path produces (a FAILED job) and
    // health must surface it without reading raw logs.
    const failed = new CompileQueue(defaultCompileQueuePath(dir));
    failed.fail(observed.id, 'provider down');
    failed.close();

    let report = await core.health({ actor: OWNER });
    expect(report.compile_queue.failed).toBe(1);
    expect(report.compile_queue.last_failed_at).toBeTruthy();
    expect(report.compile_queue.depth).toBe(0); // FAILED is terminal, not queued work

    // Retry (the documented recovery from a transient provider outage): the job
    // returns to pending, drains to done, and the failed counter clears.
    const retry = new CompileQueue(defaultCompileQueuePath(dir));
    retry.enqueue(observed.id, 'workspace', { retry: true });
    retry.close();
    await core.drainCompileQueue();

    report = await core.health({ actor: OWNER });
    expect(report.compile_queue.failed).toBe(0);
    expect(report.compile_queue.done).toBe(1);
    expect(report.compile_queue.last_failed_at).toBeNull();
  });

  it('C1: denied access is counted by code and operation, and the report carries no tenant content', async () => {
    const core = await openCore();
    await observe(core, 'Acme payroll runs quarterly, per the signed SOW.');

    // A denial that happens before any scope resolution: unknown identity.
    await core.recall({ actor: GHOST, query: 'acme', scope: 'workspace' }).catch(() => null);
    // A registered actor asking outside the scope its grant covers.
    await core.recall({ actor: GIGI, query: 'acme', scope: 'workspace' }).catch(() => null);

    const report = await core.health({ actor: OWNER });
    expect(report.denied.total).toBe(2);
    expect(report.denied.by_code['actor_unregistered']).toBe(1);
    expect(report.denied.by_code['insufficient_permission']).toBe(1);
    expect(report.denied.recent[0]).toMatchObject({ code: 'insufficient_permission', op: 'recall' });

    // Counts, ids and codes only — never the content that was denied.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('payroll');
    expect(serialized).not.toContain('signed SOW');
    expect(serialized).not.toContain('user:ghost');
  });

  it('C2: a stale-epoch write refusal is counted once, at the boundary the host called', async () => {
    const dir = makeBrain();
    const oldOwner = await openCoreFenced(dir, 5);
    await oldOwner.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'written while epoch 5 was current' },
      scope: 'workspace',
    });

    const newOwner = await openCoreFenced(dir, 6);
    await newOwner.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'written by the new epoch' },
      scope: 'workspace',
    });

    await oldOwner.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'stale write that must not land' },
      scope: 'workspace',
    }).catch(() => null);

    const report = await newOwner.health({ actor: OWNER });
    expect(report.denied.by_code['fencing_token_stale']).toBe(1);
    expect(report.denied.recent.at(-1)).toMatchObject({ code: 'fencing_token_stale', op: 'observe' });
  });
});
