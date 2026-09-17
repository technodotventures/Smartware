// Fencing token at the brain mutation boundary (ADR-0007).
//
// A host arbitrates brain ownership with a lease and issues a monotonic epoch token per
// ownership term. The brain persists the highest epoch it has seen and refuses any mutation
// carrying an older epoch — BEFORE any canonical artifact is written (evidence JSONL, claim
// version, ops entry). A brain that never adopted fencing behaves exactly as before.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig } from '../../src/config.js';
import { ProtocolError } from '../../src/auth/middleware.js';
import { readAll } from '../../src/layer0/log.js';
import { readAllOpLogEntries } from '../../src/ops_log/index.js';
import { iterAllClaimVersions } from '../../src/layer1/jsonl.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { makeClaim } from '../helpers.js';

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

const evidenceCount = (d: string): number => [...readAll(path.join(d, 'evidence'))].length;
const opsCount = (d: string): number => readAllOpLogEntries(path.join(d, 'operations')).length;
const versionCount = (d: string): number => [...iterAllClaimVersions(d)].length;

/** Every canonical surface a mutation can touch, as a comparable snapshot. */
function snapshot(d: string): { evidence: number; ops: number; versions: number } {
  return { evidence: evidenceCount(d), ops: opsCount(d), versions: versionCount(d) };
}

describe('fencing token at the brain mutation boundary (ADR-0007)', () => {
  const dirs: string[] = [];
  const cores: SmartwareCore[] = [];
  const extraStores: ClaimStore[] = [];

  function makeBrain(prefix = 'sw-fence-'): string {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dataDir);
    scaffold(dataDir);
    return dataDir;
  }

  async function openCore(dataDir: string, fencingToken?: number): Promise<SmartwareCore> {
    const core = await SmartwareCore.open({
      dataDir,
      ownerId: 'user:owner',
      ...(fencingToken === undefined ? {} : { fencingToken }),
    });
    cores.push(core);
    return core;
  }

  afterEach(() => {
    for (const store of extraStores.splice(0)) {
      try { store.close(); } catch { /* already closed */ }
    }
    for (const core of cores.splice(0)) {
      try { core.close(); } catch { /* already closed */ }
    }
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const observeParams = (body: string, operationId?: string) => ({
    actor: OWNER,
    type: 'message' as const,
    content: { format: 'text/plain', body },
    scope: 'workspace',
    ...(operationId ? { operation_id: operationId } : {}),
  });

  it('unfenced brain: legacy writes are unchanged, state says disabled', async () => {
    const dir = makeBrain();
    const core = await openCore(dir);
    expect(core.fencingState()).toMatchObject({ enabled: false, token: null, high_water: 0, refusals: 0 });

    const result = await core.observe(observeParams('legacy write, no fence configured'));
    expect(result.status).toBe('accepted');
    expect(evidenceCount(dir)).toBe(1);
  });

  it('claiming an epoch at open enables fencing and fresh-token writes pass', async () => {
    const dir = makeBrain();
    const core = await openCore(dir, 7);
    expect(core.fencingState()).toMatchObject({ enabled: true, token: 7, high_water: 7 });

    const result = await core.observe(observeParams('first write under epoch 7'));
    expect(result.status).toBe('accepted');
    expect(evidenceCount(dir)).toBe(1);
  });

  it('a stale token is refused before any canonical artifact is written, and the refusal is auditable', async () => {
    const dir = makeBrain();
    const oldOwner = await openCore(dir, 5);
    await oldOwner.observe(observeParams('written while epoch 5 was current'));

    const before = snapshot(dir);

    // Takeover: a second writer (the new owner's process) claims a higher epoch.
    const newOwner = await openCore(dir, 6);
    expect(newOwner.fencingState().high_water).toBe(6);

    // The old owner's process resumed and attempts a mutation, but its frozen brain handle
    // still presents epoch 5. Everything a stale owner could try on a real write path:
    const err = await oldOwner
      .observe(observeParams('stale write that must not land', `op_${'0'.repeat(26)}`))
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('fencing_token_stale');
    expect((err as ProtocolError).details).toMatchObject({ op: 'observe', token: 5, high_water: 6 });

    // Zero canonical artifacts: evidence JSONL, ops entry, claim versions all untouched.
    expect(snapshot(dir)).toEqual(before);

    // Observable / auditable: the refusal is recorded in the brain, not just thrown.
    const state = oldOwner.fencingState();
    expect(state.refusals).toBe(1);
    expect(state.last_refusal).toMatchObject({ op: 'observe', token: 5, high_water: 6 });
    expect(typeof state.last_refusal?.at).toBe('string');

    // The fresh owner is unaffected by the refusal.
    const fresh = await newOwner.observe(observeParams('written by the current epoch'));
    expect(fresh.status).toBe('accepted');
  });

  it('fail-closed once fenced: a writer with no token is refused (fencing_token_missing)', async () => {
    const dir = makeBrain();
    await openCore(dir, 4);
    const tokenless = await openCore(dir); // a host that adopted fencing on the lock service but not on this replica

    const before = snapshot(dir);
    const err = await tokenless.observe(observeParams('tokenless write must not land')).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('fencing_token_missing');
    expect(snapshot(dir)).toEqual(before);
  });

  it('claim is monotonic: below high-water refused, equal is idempotent, higher advances', async () => {
    const dir = makeBrain();
    const core = await openCore(dir, 10);

    let staleErr: unknown = null;
    try { core.claimFence(9); } catch (e) { staleErr = e; }
    expect((staleErr as ProtocolError).code).toBe('fencing_token_stale');

    const equal = core.claimFence(10); // equal: no-op, still current
    expect(equal).toMatchObject({ token: 10, high_water: 10 });
    core.claimFence(11);
    expect(core.fencingState()).toMatchObject({ token: 11, high_water: 11 });

    // Non-tokens are rejected as invalid input, not silently coerced.
    let invalid: unknown = null;
    try { core.claimFence(0); } catch (e) { invalid = e; }
    expect((invalid as ProtocolError).code).toBe('invalid_parameter');
  });

  it('a claim-writing mutation (correct) with a stale token leaves claim versions, evidence and ops untouched', async () => {
    const dir = makeBrain();
    const oldOwner = await openCore(dir, 1);

    // Seed one active claim directly (canonical L1), the way a host's extractor does.
    const store = new ClaimStore(path.join(dir, 'smartware.db'));
    store.setDataDir(dir);
    extraStores.push(store);
    const entityId = 'entity_alice_fence';
    store.insertEntity({ id: entityId, canonical_name: 'Alice', aliases: [], type: 'person', scope: 'workspace', created_at: new Date().toISOString() });
    const seeded = makeClaim({ subject_id: entityId, subject_name: 'Alice', scope: 'workspace', confidence: 0.8 });
    store.insertClaim(seeded);

    const before = snapshot(dir);

    const newOwner = await openCore(dir, 2);
    expect(newOwner.fencingState().high_water).toBe(2);

    const err = await oldOwner
      .correct({ actor: OWNER, target_claim_id: seeded.id, corrected_object: { type: 'text', value: 'inactive' }, reason: 'stale writer attempt' })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('fencing_token_stale');
    expect(snapshot(dir)).toEqual(before);
    expect(store.getClaim(seeded.id)?.status).toBe('active');
  });
});
