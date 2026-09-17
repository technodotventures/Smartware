// Company-brain SLOs (P1-3): the Coffee-trial objectives, evaluated against a
// health report.
//
// An SLO is only useful if it can say "not proven". Every objective therefore
// lands in exactly one of three states:
//
//   pass    — measured and inside the threshold;
//   breach  — measured and outside it;
//   unknown — not enough evidence (too few latency samples, nothing synced,
//             no backup configured, a drift check that could not run).
//
// The overall status is `breach` if any objective breached, else `unknown` if
// any objective is unknown, else `ok`. A trial with unmeasured objectives is
// never reported as `ok` — that is the whole point of the third state.
//
// TDD: written before src/observability/slo.ts.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig } from '../../src/config.js';
import { CompileQueue, defaultCompileQueuePath } from '../../src/compile_queue/queue.js';
import { COFFEE_TRIAL_SLO, evaluateCoffeeTrialSlo } from '../../src/observability/slo.js';

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

describe('Coffee-trial SLOs (P1-3)', () => {
  const dirs: string[] = [];
  const cores: SmartwareCore[] = [];

  function makeBrain(): string {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-slo-'));
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

  it('SL1: an unmeasured brain is `unknown`, never `ok` — and every objective says why', async () => {
    const core = await openCore(makeBrain());
    const report = await core.health({ actor: OWNER });

    const slo = report.slo!;
    expect(slo.trial).toBe('coffee-trial');
    expect(slo.policy).toEqual(COFFEE_TRIAL_SLO);
    expect(slo.status).toBe('unknown');

    const byId = Object.fromEntries(slo.objectives.map(objective => [objective.id, objective]));
    // Latency objectives demand a minimum sample count before claiming anything.
    expect(byId.recall_p95_ms!.state).toBe('unknown');
    expect(byId.recall_p95_ms!.observed).toBeNull();
    expect(byId.recall_p95_ms!.samples).toBe(0);
    expect(byId.recall_p95_ms!.threshold).toBe(COFFEE_TRIAL_SLO.recall_p95_ms);
    // Nothing has synced and no backup directory is configured: unknown, stated.
    expect(byId.ingestion_lag_s!.state).toBe('unknown');
    expect(byId.backup_age_s!.state).toBe('unknown');
    // These are measurable on an empty brain and are genuinely fine.
    expect(byId.compile_queue_age_s!.state).toBe('pass');
    expect(byId.compile_failures!.state).toBe('pass');
    expect(byId.stale_writer_refusals!.state).toBe('pass');
  });

  it('SL2: a measured, healthy brain reports `ok` — all objectives have real evidence', async () => {
    const dir = makeBrain();
    const core = await openCore(dir);
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-slo-backup-'));
    dirs.push(backupDir);
    fs.writeFileSync(path.join(backupDir, 'snapshot-1'), 'backup');

    core.registerSource({ actor: OWNER, id: 'src_gmail', kind: 'connector', display_name: 'Gmail' });
    await core.ingest({
      actor: OWNER, source_id: 'src_gmail', scope: 'workspace', cursor: 'history/1', operation_id: `op_${'0'.repeat(26)}`,
      items: [{ external_id: 'msg_1', type: 'message', content: { format: 'text/plain', body: 'Acme asked about invoicing.' } }],
    });

    // Enough samples for the latency objectives to speak.
    for (let i = 0; i < COFFEE_TRIAL_SLO.min_latency_samples; i += 1) {
      await core.recall({ actor: OWNER, query: 'acme', scope: 'workspace' });
      await core.observe({
        actor: OWNER, type: 'message',
        content: { format: 'text/plain', body: `sample observation ${i}` },
        scope: 'workspace',
      });
    }
    // The wiki manifest is a projection: write it so the drift check can run.
    await core.status('user:owner');

    const report = await core.health({ actor: OWNER, backup_dir: backupDir });
    const slo = report.slo!;
    expect(slo.objectives.find(o => o.id === 'recall_p95_ms')!.state).toBe('pass');
    expect(slo.objectives.find(o => o.id === 'recall_p95_ms')!.observed).not.toBeNull();
    expect(slo.objectives.find(o => o.id === 'write_p95_ms')!.state).toBe('pass');
    expect(slo.objectives.find(o => o.id === 'ingestion_lag_s')!.state).toBe('pass');
    expect(slo.objectives.find(o => o.id === 'backup_age_s')!.state).toBe('pass');
    expect(slo.objectives.find(o => o.id === 'drift')!.state).toBe('pass');
    expect(slo.status).toBe('ok');
  });

  it('SL3: a real breach (terminal compile failures) wins over everything else', async () => {
    const dir = makeBrain();
    const core = await openCore(dir);
    const observed = await core.observe({
      actor: OWNER, type: 'message',
      content: { format: 'text/plain', body: 'Atlas update: spec at https://atlas.example.com/v2' },
      scope: 'workspace',
    });
    const failed = new CompileQueue(defaultCompileQueuePath(dir));
    failed.fail(observed.id, 'provider down');
    failed.close();

    const report = await core.health({ actor: OWNER });
    expect(report.slo!.status).toBe('breach');
    const objective = report.slo!.objectives.find(o => o.id === 'compile_failures')!;
    expect(objective.state).toBe('breach');
    expect(objective.observed).toBe(1);
    expect(objective.threshold).toBe(0);
  });

  it('SL4: the evaluator ignores nothing — a report missing a block makes the objective unknown', () => {
    // A read-granted actor's report has no owner-only blocks; evaluating it must
    // not crash and must not invent evidence. Absent block = unknown, not zero.
    const partial = {
      generated_at: '2026-09-15T08:00:00.000Z',
      counts: { by_scope: [] },
    } as unknown as Parameters<typeof evaluateCoffeeTrialSlo>[0];
    const slo = evaluateCoffeeTrialSlo(partial, new Date('2026-09-15T08:00:00.000Z'));
    expect(slo.objectives.map(objective => objective.state)).toEqual(
      slo.objectives.map(() => 'unknown'),
    );
    expect(slo.objectives.every(objective => objective.state !== 'pass')).toBe(true);
    expect(slo.status).toBe('unknown');
  });
});
