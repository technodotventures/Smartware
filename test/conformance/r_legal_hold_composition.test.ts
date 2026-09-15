// Legal-hold marker, pinned (ADR-0009; supersedes the ADR-0008 composition).
//
// Why this file exists: ADR-0001 (owner-signed, Tier-1) says expiry/purge never
// fires under a legal hold and AC5/AC6 read "erasure … refused under hold" /
// "hold scope is skipped by the sweep". ADR-0008 realized those clauses by
// composition and deferred the explicit marker; ADR-0009 (owner pre-production
// gate, card t_463c1ff9) builds it. These tests run the held-scope case on a
// live core with an ELAPSED time-bound observation and pin the marker:
//
//   R1  the hold lane (offboarding) OPENS the hold in the same commit, and the
//       sweep SKIPS a held scope explicitly: nothing expires, nothing is
//       written, post-hold evidence is preserved, and the skip is receipted.
//   R2  erasure on a held scope is REFUSED (`legal_hold_open`, no mutation, the
//       operation_id is not consumed); release is an audited owner act with a
//       receipt, idempotent per operation_id, refusing `no_open_hold` otherwise.
//   R3  release lifts the gate: the sweep resumes, erasure runs with its
//       attestation + snapshot receipts, the release record survives, and a
//       terminal erasure still replays by operation_id.
//   R4  backward compatibility + payload identity: a scope that never took the
//       hold lane erases as before, fresh configs carry no hold state, the
//       v0.5.0 payload hash formula is unchanged, and replaying a committed
//       hold lane does not re-open a released hold.
//
// ADR-0009 is the decision; this file is its executable half.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import {
  createDefaultConfig,
  isScopeHeld,
  loadConfig,
  saveConfig,
  type SmartwareConfig,
} from '../../src/config.js';
import { readAll } from '../../src/layer0/log.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';
import { computePayloadHash } from '../../src/layer0/idempotency.js';
import type { Actor } from '../../src/layer0/types.js';

const OWNER: Actor = { type: 'person', id: 'user:owner', display_name: 'Owner' };
const STRANGER: Actor = { type: 'person', id: 'user:stranger', display_name: 'Stranger' };
const ACME = 'client:acme#1';
const BCAU = 'client:bcau#1';
const ELAPSED = '2026-08-01T00:00:00.000Z';
const AS_OF = '2030-01-01T00:00:00.000Z';
const RELEASE_STATEMENT = 'no pending dispute / hold released';

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
    { id: BCAU, parent: 'workspace', visibility_default: 'scope' },
  ];
  // Time-bound scopes: every observation below is elapsed at AS_OF.
  cfg.retention = {
    default: { policy: 'forever', duration_days: null },
    scope_overrides: {
      [ACME]: { policy: 'duration', duration_days: 1 },
      [BCAU]: { policy: 'duration', duration_days: 1 },
    },
  };
  return cfg;
}

function evidenceBytes(dataDir: string): number {
  const dir = path.join(dataDir, 'evidence');
  return fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
}

function opsEntries(dataDir: string, operationId: string) {
  return [...readAllOpLogEntries(path.join(dataDir, 'operations'))]
    .filter(entry => entry.operation_id === operationId);
}

describe('legal-hold marker (ADR-0009)', () => {
  let dataDir = '';
  let core: SmartwareCore | null = null;

  afterEach(() => {
    core?.close();
    core = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function open(): Promise<SmartwareCore> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-hold-marker-'));
    scaffold(dataDir, makeConfig(dataDir));
    core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
    return core;
  }

  async function observe(c: SmartwareCore, scope: string, body: string, observedAt = ELAPSED): Promise<string> {
    const result = await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body },
      scope, observed_at: observedAt,
    });
    return result.id;
  }

  /** The hold lane: F1 snapshot + offboarding, exactly as the Coffee dispute flow runs it. */
  async function enterHoldLane(c: SmartwareCore, operationId: string): Promise<string> {
    const snapshot = await c.exportScope({ actor: OWNER, scope: ACME });
    await c.forgetScope({
      actor: OWNER, scope: ACME, reason: 'offboarding',
      owner_pointer: 'dispute hold — do not erase', operation_id: operationId,
    });
    return snapshot.export_id;
  }

  it('R1 · the hold lane opens the hold, and the sweep skips a held scope explicitly', async () => {
    const c = await open();
    const elapsedId = await observe(c, ACME, 'Acme dispute evidence — invoice 41');

    // Non-vacuity pin: this observation really is time-bound (P1D) and elapsed at AS_OF.
    const persisted = [...readAll(path.join(dataDir, 'evidence'))].find(obs => obs.id === elapsedId);
    expect(persisted?.policy.retention).toBe('duration');
    expect(persisted?.policy.retention_duration).toBe('P1D');

    const offboardOp = `op_${ulid()}`;
    await enterHoldLane(c, offboardOp);

    // The lane opened the hold in the same commit — state + receipt.
    const held = loadConfig(dataDir).holds?.[ACME];
    expect(held).toBeDefined();
    expect(held?.opened_by).toBe(OWNER.id);
    expect(held?.operation_id).toBe(offboardOp);
    expect(held?.released_at).toBeNull();
    expect(isScopeHeld(loadConfig(dataDir), ACME)).toBe(true);
    expect(opsEntries(dataDir, offboardOp)[0]!.details?.['hold_opened']).toBe(true);

    // Non-vacuity pin: the hold lane still tombstoned the pre-hold evidence in
    // the same act (composition retained — the scope is recall-silent).
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: elapsedId })?.status).toBe('tombstoned');

    // Post-hold evidence is real evidence (the owner may still write).
    const afterHold = await observe(c, ACME, 'Acme dispute email received after the hold');
    const bytesBefore = evidenceBytes(dataDir);
    const sweepOp = `op_${ulid()}`;
    const sweep = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: sweepOp });

    // The skip is explicit: nothing expires, nothing is written, nothing is destroyed.
    expect(sweep.observations_expired).toBe(0);
    expect(sweep.claims_retracted).toBe(0);
    expect(sweep.skipped_reason).toBe('legal_hold');
    expect(evidenceBytes(dataDir)).toBe(bytesBefore);
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: afterHold })?.status).toBe('accepted');

    // The skip is receipted, not silent.
    const skipEntry = opsEntries(dataDir, sweepOp);
    expect(skipEntry).toHaveLength(1);
    expect(skipEntry[0]!.op).toBe('retention.expire');
    expect(skipEntry[0]!.details?.['skipped']).toBe('legal_hold');
    expect(skipEntry[0]!.details?.['observations_expired']).toBe(0);
    expect(skipEntry[0]!.details?.['scope']).toBe(ACME);
  });

  it('R2 · erasure under the hold is refused; release is the audited owner act', async () => {
    const c = await open();
    const obsId = await observe(c, ACME, 'Acme dispute evidence — invoice 41');
    await enterHoldLane(c, `op_${ulid()}`);

    // The refusal: precise code, no mutation, and the operation_id is NOT consumed.
    const refusedOp = `op_${ulid()}`;
    await expect(
      c.forgetScope({ actor: OWNER, scope: ACME, reason: 'erasure', operation_id: refusedOp }),
    ).rejects.toMatchObject({ code: 'legal_hold_open' });
    expect(loadConfig(dataDir).scopes.map(entry => entry.id)).toContain(ACME);
    expect(opsEntries(dataDir, refusedOp)).toHaveLength(0);
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: obsId })?.status).toBe('tombstoned');

    // Release is owner-only.
    await expect(
      c.releaseHold({ actor: STRANGER, scope: ACME, operation_id: `op_${ulid()}` }),
    ).rejects.toThrow(/owner/i);

    // The owner releases: receipt + config + ops entry.
    const releaseOp = `op_${ulid()}`;
    const released = await c.releaseHold({
      actor: OWNER, scope: ACME, statement: RELEASE_STATEMENT, operation_id: releaseOp,
    });
    expect(released.status).toBe('released');
    expect(released.scope).toBe(ACME);
    expect(released.released_by).toBe(OWNER.id);
    expect(released.statement).toBe(RELEASE_STATEMENT);

    const releasedEntry = loadConfig(dataDir).holds?.[ACME];
    expect(releasedEntry?.released_at).toBe(released.released_at);
    expect(releasedEntry?.release_operation_id).toBe(releaseOp);
    expect(releasedEntry?.release_statement).toBe(RELEASE_STATEMENT);
    expect(isScopeHeld(loadConfig(dataDir), ACME)).toBe(false);

    const entries = opsEntries(dataDir, releaseOp);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.op).toBe('hold.release');
    expect(entries[0]!.details?.['scope']).toBe(ACME);
    expect(entries[0]!.details?.['statement']).toBe(RELEASE_STATEMENT);
    expect(typeof entries[0]!.details?.['payload_hash']).toBe('string');

    // Idempotent replay: same operation_id + payload ⇒ the identical receipt, one entry.
    const replay = await c.releaseHold({
      actor: OWNER, scope: ACME, statement: RELEASE_STATEMENT, operation_id: releaseOp,
    });
    expect(replay).toEqual(released);
    expect(opsEntries(dataDir, releaseOp)).toHaveLength(1);

    // A different payload on a used operation_id conflicts.
    await expect(
      c.releaseHold({ actor: OWNER, scope: ACME, statement: 'a different statement', operation_id: releaseOp }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // Releasing again: nothing is open.
    await expect(
      c.releaseHold({ actor: OWNER, scope: ACME, operation_id: `op_${ulid()}` }),
    ).rejects.toMatchObject({ code: 'no_open_hold' });

    // The erasure the marker refused now runs with the SAME operation_id —
    // the refusal did not burn it.
    const erased = await c.forgetScope({ actor: OWNER, scope: ACME, reason: 'erasure', operation_id: refusedOp });
    expect(erased.scope_entry_removed).toBe(true);
    const certificate = await c.exportScope({ actor: OWNER, scope: ACME });
    expect(certificate.manifest.deletion_certificate?.operation_id).toBe(refusedOp);
  });

  it('R3 · release lifts the gate: the sweep resumes, erasure keeps its receipts, replay outlives the scope', async () => {
    const c = await open();
    const obsId = await observe(c, ACME, 'Acme dispute evidence — invoice 41');
    await enterHoldLane(c, `op_${ulid()}`);
    const afterHold = await observe(c, ACME, 'post-hold evidence');
    await c.releaseHold({ actor: OWNER, scope: ACME, statement: RELEASE_STATEMENT, operation_id: `op_${ulid()}` });

    // The gate lifted: minimization resumes for the held scope.
    const sweep = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: `op_${ulid()}` });
    expect(sweep.observations_expired).toBe(1);
    expect(sweep.skipped_reason).toBeUndefined();
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: afterHold })?.status).toBe('tombstoned');

    // Erasure runs — with the flow's attestation and the snapshot link intact.
    const snapshot = await c.exportScope({ actor: OWNER, scope: ACME, operation_id: `op_${ulid()}` });
    const eraseOp = `op_${ulid()}`;
    const erased = await c.forgetScope({
      actor: OWNER, scope: ACME, reason: 'erasure',
      attestation: RELEASE_STATEMENT, export_id: snapshot.export_id, operation_id: eraseOp,
    });
    expect(erased.scope_entry_removed).toBe(true);
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: obsId })?.status).toBe('erased');

    const eraseEntries = opsEntries(dataDir, eraseOp);
    expect(eraseEntries).toHaveLength(1);
    expect(eraseEntries[0]!.details?.['attestation']).toBe(RELEASE_STATEMENT);
    expect(eraseEntries[0]!.details?.['export_id']).toBe(snapshot.export_id);

    // The release record survives the scope it guarded — content-free, released.
    const holdsAfterErasure = loadConfig(dataDir).holds?.[ACME];
    expect(holdsAfterErasure?.released_at).toBeTruthy();
    expect(holdsAfterErasure?.release_operation_id).toBeTruthy();
    expect(isScopeHeld(loadConfig(dataDir), ACME)).toBe(false);

    // Replay after the terminal state returns the recorded result.
    const replay = await c.forgetScope({
      actor: OWNER, scope: ACME, reason: 'erasure',
      attestation: RELEASE_STATEMENT, export_id: snapshot.export_id, operation_id: eraseOp,
    });
    expect(replay).toEqual(erased);
    expect(opsEntries(dataDir, eraseOp)).toHaveLength(1);
  });

  it('R4 · backward compatibility + payload identity: never-held scopes and fresh configs are untouched', async () => {
    const c = await open();
    await observe(c, BCAU, 'Bcau evidence never held');

    // Fresh configs carry no hold state (additive surface, migration-free).
    expect(createDefaultConfig(dataDir).holds).toBeUndefined();

    // A scope that never took the hold lane erases exactly as before.
    const bcauOp = `op_${ulid()}`;
    const erased = await c.forgetScope({ actor: OWNER, scope: BCAU, reason: 'erasure', operation_id: bcauOp });
    expect(erased.scope_entry_removed).toBe(true);
    expect(opsEntries(dataDir, bcauOp)).toHaveLength(1);

    // Payload identity is the v0.5.0 formula — the hold marker adds no fields
    // to the hashed payload for existing calls.
    await observe(c, ACME, 'Acme evidence');
    const offboardOp = `op_${ulid()}`;
    const pointer = 'client since 2023, 4 jobs, no disputes';
    const offboard = await c.forgetScope({
      actor: OWNER, scope: ACME, reason: 'offboarding', owner_pointer: pointer, operation_id: offboardOp,
    });
    expect(opsEntries(dataDir, offboardOp)[0]!.details?.['payload_hash']).toBe(computePayloadHash({
      actor_id: OWNER.id, scope: ACME, reason: 'offboarding', owner_pointer: pointer,
    }));

    // Replaying the committed hold lane returns the recorded result and does
    // NOT re-open a released hold.
    await c.releaseHold({ actor: OWNER, scope: ACME, statement: RELEASE_STATEMENT, operation_id: `op_${ulid()}` });
    expect(isScopeHeld(loadConfig(dataDir), ACME)).toBe(false);
    const replayed = await c.forgetScope({
      actor: OWNER, scope: ACME, reason: 'offboarding', owner_pointer: pointer, operation_id: offboardOp,
    });
    expect(replayed).toEqual(offboard);
    expect(isScopeHeld(loadConfig(dataDir), ACME)).toBe(false);
  });
});
