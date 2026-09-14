// Legal-hold composition, pinned (ADR-0008; spec §10c.3 / §10c.7).
//
// Why this file exists: C8 of `q_lifecycle_composition.test.ts` asserts "the
// sweep over a held scope expires/purges nothing", but the evidence it observes
// carries the default `forever` retention — no observation in that scenario was
// ever time-bound, so the assertion could not have failed. These tests rerun the
// held-scope case on a live core with an ELAPSED `duration` observation and pin
// exactly what the composition does and does not guarantee:
//
//   R1  the hold lane IS the sweep's skip — by construction (a held scope has no
//       `accepted` observations), not by a hold flag the sweep consults.
//   R2  evidence written into a held scope AFTER the hold lane is not skipped:
//       an elapsed sweep tombstones it — non-destructively (bytes appended, never
//       removed) and the held scope stays exportable in full, so the defense
//       record survives every non-erasure lifecycle act.
//   R3  erasure is the owner's terminal act, RECORDED not gated: on a scope that
//       took the hold lane it succeeds with an explicit `attestation: null`, and
//       the only substrate-side refusal is `requireOwner`.
//
// ADR-0008 is the decision; this file is its executable half. If a hold marker is
// ever adopted (trigger list in ADR-0008 §3), R2 and R3 are the assertions that
// must change first.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, loadConfig, saveConfig, type SmartwareConfig } from '../../src/config.js';
import { readAll } from '../../src/layer0/log.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';
import type { Actor } from '../../src/layer0/types.js';

const OWNER: Actor = { type: 'person', id: 'user:owner', display_name: 'Owner' };
const STRANGER: Actor = { type: 'person', id: 'user:stranger', display_name: 'Stranger' };
const ACME = 'client:acme#1';
const ELAPSED = '2026-08-01T00:00:00.000Z';
const AS_OF = '2030-01-01T00:00:00.000Z';

function scaffold(dataDir: string, config: SmartwareConfig): void {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  saveConfig(dataDir, config);
}

function makeConfig(dataDir: string): SmartwareConfig {
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = OWNER.id;
  cfg.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    { id: ACME, parent: 'workspace', visibility_default: 'scope' },
  ];
  // A time-bound scope: every observation below is elapsed at AS_OF.
  cfg.retention = {
    default: { policy: 'forever', duration_days: null },
    scope_overrides: { [ACME]: { policy: 'duration', duration_days: 1 } },
  };
  return cfg;
}

function evidenceBytes(dataDir: string): number {
  const dir = path.join(dataDir, 'evidence');
  return fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
}

/** Every observation id present in the canonical log (append-only; nothing removed). */
function logIds(dataDir: string): Set<string> {
  return new Set([...readAll(path.join(dataDir, 'evidence'))].map(obs => obs.id));
}

/** Observation rows carried by an F1 export package — the defense record. */
function exportRowIds(exportPath: string): Set<string> {
  return new Set(
    fs.readFileSync(path.join(exportPath, 'observations.jsonl'), 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => (JSON.parse(line) as { id: string }).id),
  );
}

function opsEntries(dataDir: string, operationId: string) {
  return [...readAllOpLogEntries(path.join(dataDir, 'operations'))]
    .filter(entry => entry.operation_id === operationId);
}

describe('legal-hold composition (ADR-0008)', () => {
  let dataDir = '';
  let core: SmartwareCore | null = null;

  afterEach(() => {
    core?.close();
    core = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function open(): Promise<SmartwareCore> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-hold-'));
    scaffold(dataDir, makeConfig(dataDir));
    core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
    return core;
  }

  async function observe(c: SmartwareCore, body: string): Promise<string> {
    const result = await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body },
      scope: ACME, observed_at: ELAPSED,
    });
    return result.id;
  }

  async function enterHoldLane(c: SmartwareCore, operationId: string): Promise<string> {
    const snapshot = await c.exportScope({ actor: OWNER, scope: ACME });
    await c.forgetScope({
      actor: OWNER, scope: ACME, reason: 'offboarding',
      owner_pointer: 'dispute hold — do not erase', operation_id: operationId,
    });
    return snapshot.export_id;
  }

  it('R1 · the hold lane IS the sweep skip: an elapsed observation in a held scope expires nothing', async () => {
    const c = await open();
    const elapsedId = await observe(c, 'Acme dispute evidence — invoice 41');

    // Non-vacuity pin: this observation really is time-bound (P1D) and elapsed at AS_OF.
    const persisted = [...readAll(path.join(dataDir, 'evidence'))].find(obs => obs.id === elapsedId);
    expect(persisted?.policy.retention).toBe('duration');
    expect(persisted?.policy.retention_duration).toBe('P1D');

    await enterHoldLane(c, `op_${ulid()}`);
    // The hold lane tombstoned it in the same act — that, not a flag, is the skip.
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: elapsedId })?.status).toBe('tombstoned');

    const bytesBefore = evidenceBytes(dataDir);
    const sweepOp = `op_${ulid()}`;
    const sweep = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: sweepOp });
    expect(sweep.observations_expired).toBe(0);
    expect(sweep.claims_retracted).toBe(0);
    expect(evidenceBytes(dataDir)).toBe(bytesBefore);

    // Receipt: the sweep ran over the held scope and wrote its zero counts.
    const entries = opsEntries(dataDir, sweepOp);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.op).toBe('retention.expire');
    expect(entries[0]!.details?.['observations_expired']).toBe(0);
    expect(entries[0]!.details?.['scope']).toBe(ACME);
  });

  it('R2 · post-hold evidence is tombstone-only: nothing is destroyed and the held scope stays exportable', async () => {
    const c = await open();
    const beforeHold = await observe(c, 'Acme evidence observed before the hold');
    await enterHoldLane(c, `op_${ulid()}`);

    // The owner may still write into the held scope (the owner bypasses grants) —
    // this is the write that reaches the sweep, because the hold lane already ran.
    const afterHold = await observe(c, 'Acme dispute email received after the hold');
    const idsBeforeSweep = logIds(dataDir);
    const bytesBefore = evidenceBytes(dataDir);

    const sweep = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: `op_${ulid()}` });
    expect(sweep.observations_expired).toBe(1);
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: afterHold })?.status).toBe('tombstoned');

    // Append-only: the sweep wrote a tombstone and removed nothing at all.
    expect(evidenceBytes(dataDir)).toBeGreaterThan(bytesBefore);
    const idsAfterSweep = logIds(dataDir);
    for (const id of idsBeforeSweep) expect(idsAfterSweep.has(id)).toBe(true);
    expect(idsAfterSweep.has(afterHold)).toBe(true);

    // The defense record survives: a full-history F1 export of the held scope
    // still carries every observation row, and no deletion certificate exists.
    const post = await c.exportScope({ actor: OWNER, scope: ACME });
    const rows = exportRowIds(post.path);
    expect(rows.has(beforeHold)).toBe(true);
    expect(rows.has(afterHold)).toBe(true);
    expect(post.manifest.deletion_certificate).toBeNull();

    // And the hold lane is still reversible: the scope entry was never removed.
    expect(loadConfig(dataDir).scopes.map(entry => entry.id)).toContain(ACME);
  });

  it('R3 · erasure is the owner act, recorded not gated: no attestation ⇒ an explicit null in the receipt', async () => {
    const c = await open();
    const obsId = await observe(c, 'Acme dispute evidence — invoice 41');
    await enterHoldLane(c, `op_${ulid()}`);

    // The only substrate-side refusal on this lane is the owner gate.
    await expect(
      c.forgetScope({ actor: STRANGER, scope: ACME, reason: 'erasure', operation_id: `op_${ulid()}` }),
    ).rejects.toThrow(/owner/i);

    // An erasure with no hold-release statement still runs — and says so, in the
    // canonical record (ADR-0008: the guarantee is "never silent", not "refuse").
    const eraseOp = `op_${ulid()}`;
    const erased = await c.forgetScope({ actor: OWNER, scope: ACME, reason: 'erasure', operation_id: eraseOp });
    expect(erased.scope_entry_removed).toBe(true);

    const entries = opsEntries(dataDir, eraseOp);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details?.['reason']).toBe('erasure');
    expect(entries[0]!.details?.['attestation']).toBeNull();
    expect(entries[0]!.details?.['export_id']).toBeNull();

    // Terminal, and the deletion certificate is the post-erasure export.
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: obsId })?.status).toBe('erased');
    const certificate = await c.exportScope({ actor: OWNER, scope: ACME });
    expect(certificate.manifest.deletion_certificate?.operation_id).toBe(eraseOp);

    // The statement, when the flow does make one, is what the record keeps.
    const firstDir = dataDir;
    core?.close();
    core = null;
    fs.rmSync(firstDir, { recursive: true, force: true });
    const c2 = await open();
    await observe(c2, 'Bcau-style second scope');
    const attestedOp = `op_${ulid()}`;
    await c2.forgetScope({
      actor: OWNER, scope: ACME, reason: 'erasure',
      attestation: 'no pending dispute / hold released', operation_id: attestedOp,
    });
    expect(opsEntries(dataDir, attestedOp)[0]!.details?.['attestation'])
      .toBe('no pending dispute / hold released');
  });
});
