// Storage-level fencing (ADR-0010).
//
// The boundary guard (ADR-0007, test/fence/fencing-token.test.ts) runs BEFORE a mutation starts;
// it cannot see a pause INSIDE one. These tests cover the follow-on: the ownership epoch is
// stamped into the intent and the commit signal, the commit signal passes an atomic gate against
// the persisted high-water mark, and recovery rejects — never finalizes, never merges — an
// uncommitted artifact set whose epoch is behind the mark.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig } from '../../src/config.js';
import { ProtocolError } from '../../src/auth/middleware.js';
import { readAll } from '../../src/layer0/log.js';
import { readAllOpLogEntries, readOperationIntent } from '../../src/ops_log/index.js';
import { FenceStore } from '../../src/storage/fence.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };

function scaffold(dataDir: string): void {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = 'user:owner';
  cfg.scopes = [
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    { id: 'client:acme#1', parent: 'workspace', visibility_default: 'scope' },
  ];
  saveConfig(dataDir, cfg);
}

describe('storage-level fencing (ADR-0010)', () => {
  const dirs: string[] = [];
  const cores: SmartwareCore[] = [];

  function makeBrain(prefix = 'sw-storage-fence-'): string {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dataDir);
    scaffold(dataDir);
    return dataDir;
  }

  async function openCore(
    dataDir: string,
    fencingToken?: number,
    commitHooks?: { afterIntent?: (i: unknown) => void | Promise<void>; afterObservation?: (o: unknown) => void | Promise<void>; afterCommit?: () => void | Promise<void> },
  ): Promise<SmartwareCore> {
    const core = await SmartwareCore.open({
      dataDir,
      ownerId: 'user:owner',
      ...(fencingToken === undefined ? {} : { fencingToken }),
      ...(commitHooks === undefined ? {} : { commitHooks: commitHooks as never }),
    });
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

  const opsDirOf = (dir: string): string => path.join(dir, 'operations');
  const newOpId = (): string => `op_${ulid()}`;

  const observeParams = (body: string, operationId?: string) => ({
    actor: OWNER,
    type: 'message' as const,
    content: { format: 'text/plain', body },
    scope: 'workspace',
    ...(operationId ? { operation_id: operationId } : {}),
  });

  const opsEntriesFor = (dir: string, operationId: string) =>
    [...readAllOpLogEntries(opsDirOf(dir))].filter(entry => entry.operation_id === operationId);

  const evidenceFor = (dir: string, operationId: string) =>
    [...readAll(path.join(dir, 'evidence'))].filter(obs => obs.operation_id === operationId);

  it('stamps the ownership epoch into the intent and the commit signal', async () => {
    const dir = makeBrain();
    const operationId = newOpId();
    let intentStamp: unknown = 'not-seen';
    const core = await openCore(dir, 3, {
      afterIntent: (intent) => { intentStamp = (intent as { fence?: unknown }).fence; },
    });

    await core.observe(observeParams('fenced write with an operation id', operationId));

    expect(intentStamp).toMatchObject({ epoch: 3 });
    expect((intentStamp as { writer_id?: string }).writer_id).toBeTruthy();

    const entries = opsEntriesFor(dir, operationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details?.['fence']).toMatchObject({ epoch: 3 });
  });

  it('an unfenced brain writes no stamps (legacy bytes unchanged)', async () => {
    const dir = makeBrain();
    const operationId = newOpId();
    let intentStamp: unknown = 'not-seen';
    const core = await openCore(dir, undefined, {
      afterIntent: (intent) => { intentStamp = (intent as { fence?: unknown }).fence; },
    });

    await core.observe(observeParams('unfenced write', operationId));

    expect(intentStamp).toBeUndefined();
    const entries = opsEntriesFor(dir, operationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details?.['fence']).toBeUndefined();
  });

  it('paused mid-mutation across a handoff, the resumed writer is refused at the commit gate with zero commit signals', async () => {
    const dir = makeBrain();
    const operationId = newOpId();
    let takeover: SmartwareCore | null = null;
    // The pause lands AFTER the boundary check and after the L0 artifact, BEFORE the commit
    // signal. While the writer is paused, a new owner claims a higher epoch (the handoff).
    const paused = await openCore(dir, 5, {
      afterObservation: async () => {
        if (!takeover) takeover = await openCore(dir, 6);
      },
    });

    const err = await paused
      .observe(observeParams('stale-epoch mutation that must not commit', operationId))
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('fencing_token_stale');
    expect((err as ProtocolError).details).toMatchObject({ op: 'observe', token: 5, high_water: 6 });

    // Zero commit signals; the partial artifact is inert on disk and attributable.
    expect(opsEntriesFor(dir, operationId)).toHaveLength(0);
    expect(evidenceFor(dir, operationId)).toHaveLength(1);
    expect(readOperationIntent(opsDirOf(dir), operationId)).not.toBeNull();

    // The refusal is auditable like a boundary refusal.
    expect(paused.fencingState().refusals).toBe(1);
    expect(paused.fencingState().last_refusal).toMatchObject({ op: 'observe', token: 5, high_water: 6 });
  });

  it('a tokenless writer cannot commit once the brain is claimed mid-mutation (fencing_token_missing)', async () => {
    const dir = makeBrain();
    const operationId = newOpId();
    let claimed: SmartwareCore | null = null;
    const legacy = await openCore(dir, undefined, {
      afterObservation: async () => {
        if (!claimed) claimed = await openCore(dir, 1);
      },
    });

    const err = await legacy
      .observe(observeParams('tokenless write raced by a claim', operationId))
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('fencing_token_missing');
    expect(opsEntriesFor(dir, operationId)).toHaveLength(0);
  });

  it('recovery rejects a stale-epoch artifact set as a set — never finalizes, never merges', async () => {
    const dir = makeBrain();
    const operationId = newOpId();

    // A dying writer under epoch 4: intent + L0 artifact land, the commit signal never does.
    const dying = await openCore(dir, 4, {
      afterObservation: () => { throw new Error('simulated process death'); },
    });
    await expect(dying.observe(observeParams('partial set under a superseded epoch', operationId)))
      .rejects.toThrow('simulated process death');
    expect(readOperationIntent(opsDirOf(dir), operationId)).not.toBeNull();
    expect(evidenceFor(dir, operationId)).toHaveLength(1);

    // The new owner (epoch 5) opens: recovery must reject the set, not finalize it.
    const newOwner = await openCore(dir, 5);
    const report = newOwner.lastRecoveryReport();
    expect(report).not.toBeNull();
    expect(report!.staleEpochRejected).toEqual([{
      operation_id: operationId,
      reason: 'epoch_behind_high_water',
      epoch: 4,
      high_water: 5,
      artifacts: 1,
    }]);
    expect(report!.completed).not.toContain(operationId);
    expect(report!.pendingOperations).not.toContain(operationId);
    expect(report!.requiresManualReview).not.toContain(operationId);

    // Zero committed mutations: no commit signal, the intent is retained (never merged), and
    // the artifact is not replayed as committed.
    expect(opsEntriesFor(dir, operationId)).toHaveLength(0);
    expect(readOperationIntent(opsDirOf(dir), operationId)).not.toBeNull();
    expect(evidenceFor(dir, operationId)).toHaveLength(1);
  });

  it('recovery finalizes a same-epoch set (crash before the gate) — the legacy path survives fencing', async () => {
    const dir = makeBrain();
    const operationId = newOpId();

    const dying = await openCore(dir, 4, {
      afterObservation: () => { throw new Error('simulated crash'); },
    });
    await expect(dying.observe(observeParams('complete set, same ownership term', operationId)))
      .rejects.toThrow('simulated crash');

    // Same ownership term restarts (token 4 is still current): finalize as before.
    const restart = await openCore(dir, 4);
    const report = restart.lastRecoveryReport();
    expect(report!.completed).toContain(operationId);
    expect(report!.staleEpochRejected).toEqual([]);

    const entries = opsEntriesFor(dir, operationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details?.['recovered']).toBe(true);
    expect(entries[0]!.details?.['fence']).toMatchObject({ epoch: 4 });
  });

  it('a crash between the gate and the signal is projected from the authorization row (commit not lost)', async () => {
    const dir = makeBrain();
    const operationId = newOpId();

    const dying = await openCore(dir, 4, {
      afterObservation: () => { throw new Error('simulated crash'); },
    });
    await expect(dying.observe(observeParams('authorized commit, signal never landed', operationId)))
      .rejects.toThrow('simulated crash');

    // Simulate the gate having passed at epoch 4 (its authorization row exists), the signal not.
    const store = FenceStore.open(path.join(dir, 'smartware.db'));
    expect(store.authorizeAtEpoch([operationId], 4, 'writer_test')).toBe(true);
    store.close();

    // A later owner claims epoch 5 and opens: the row proves the commit was authorized while
    // current, so recovery projects the missing signal instead of rejecting the set.
    const newOwner = await openCore(dir, 5);
    const report = newOwner.lastRecoveryReport();
    expect(report!.staleEpochRejected).toEqual([]);
    expect(report!.completed).toContain(operationId);

    const entries = opsEntriesFor(dir, operationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details?.['recovered']).toBe(true);
    expect(entries[0]!.details?.['fence']).toMatchObject({ epoch: 4 });
  });

  it('recovery rejects an unstamped set on a fenced brain (unknown epoch, fail closed)', async () => {
    const dir = makeBrain();
    const operationId = newOpId();

    // A legacy (unfenced) writer dies mid-mutation; the brain is fenced afterwards.
    const legacy = await openCore(dir, undefined, {
      afterObservation: () => { throw new Error('simulated crash'); },
    });
    await expect(legacy.observe(observeParams('unstamped set on a brain that later adopted fencing', operationId)))
      .rejects.toThrow('simulated crash');

    const fenced = await openCore(dir, 2);
    const report = fenced.lastRecoveryReport();
    expect(report!.staleEpochRejected).toEqual([{
      operation_id: operationId,
      reason: 'unstamped_on_fenced_brain',
      epoch: null,
      high_water: 2,
      artifacts: 1,
    }]);
    expect(opsEntriesFor(dir, operationId)).toHaveLength(0);
  });

  it('the recovery gate is atomic against claims: authorizeAtEpoch refuses an epoch the mark has passed', async () => {
    const dir = makeBrain();
    await openCore(dir, 2);
    const store = FenceStore.open(path.join(dir, 'smartware.db'));

    expect(store.authorizeAtEpoch([newOpId()], 1, 'writer_late')).toBe(false);
    expect(store.authorizeAtEpoch([newOpId()], 2, 'writer_current')).toBe(true);
    expect(store.highWater()).toBe(2);
    store.close();
  });

  it('the refusal is not recorded as a recovery rejection when the set was authorized', async () => {
    const dir = makeBrain();
    const operationId = newOpId();
    const core = await openCore(dir, 7, {
      afterObservation: () => { throw new Error('simulated crash'); },
    });
    await expect(core.observe(observeParams('same epoch, reopened', operationId))).rejects.toThrow('simulated crash');

    const restart = await openCore(dir, 7);
    const report = restart.lastRecoveryReport();
    expect(report!.staleEpochRejected).toEqual([]);
    expect(report!.requiresManualReview).toEqual([]);
    expect(report!.completed).toEqual([operationId]);
  });
});
