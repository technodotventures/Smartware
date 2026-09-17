// Tests: Protocol — REVISE `repick_survivor` (releasing a mechanical demotion)
//
// Why these exist: `t_742e31f9` decided that every flow preserves a mechanical demotion (a
// resolved duplicate recorded by `resolveFactMatches`, §1e), and `t_30732060` measured the
// consequence — a bare release is *unstable* (the next §1e write re-demotes the earliest-minted
// copy), so releasing a demotion cannot be a claim-adjudication side effect. The gap this suite
// closes (ADR-0003 → *Releasing a demotion*, protocol v0.5.0): a user who believes the duplicate
// is the copy that should surface has no path, and if the survivor is forgotten the fact leaves
// default recall entirely.
//
// The act is a user-only re-pick: `REVISE { repick_survivor: true, target: <demoted claim> }`
// atomically releases the target and demotes the fact's current active copy, with
// `superseded_by_origin: 'user'` as the warrant. These tests pin:
//
//   - swap: one commit, one operation_id, two version records (release first, demotion second,
//     one version_at), the released claim's pointer cleared, the demoted copy warranted;
//   - stability: the next §1e write touching the fact corroborates the released copy — no
//     re-demotion (the property `t_30732060` measured as *absent* for a bare release);
//   - rescue: a forgotten survivor still lets the fact return (release alone, demoted: []);
//   - the rejections: not-demoted (nothing to re-pick) and combination with other actions, both
//     writing nothing;
//   - crash boundaries: intent-before-append (retry completes with the prepared artifacts),
//     commit-before-finalisation (recovery finalises; replay is idempotent), and a partially
//     written artifact set (fails closed to manual review);
//   - rebuild-equivalence: a compile-path sync and a full canonical replay agree on the
//     recall-eligible set.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { ClaimStore } from '../../src/layer1/store.js';
import { computeConfidence } from '../../src/layer1/confidence.js';
import { resolveFactMatches } from '../../src/layer1/corroboration.js';
import {
  appendClaimVersion,
  iterAllClaimVersions,
  readLatestVersion,
  type ActiveClaimVersion,
} from '../../src/layer1/jsonl.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import type { Claim } from '../../src/layer1/types.js';
import type { TypedValue } from '../../src/layer0/types.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { createDefaultConfig, saveConfig, type SmartwareConfig } from '../../src/config.js';
import { handleRevise, type ReviseCommitHooks, type ReviseParams } from '../../src/protocol/revise.js';
import { handleForget } from '../../src/protocol/forget.js';
import { persistOperationIntent, readOperationIntent, type ReviseOperationIntent } from '../../src/ops_log/intent.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';
import { runRecovery } from '../../src/ops_log/recovery.js';

let dataDir: string;
let store: ClaimStore;

// Claim ids are ULIDs in production (time-ordered): the smaller id is the earliest-minted claim,
// so `claim_0001…` is the §1e survivor and `claim_0002…` the duplicate it demotes.
const SURVIVOR = 'claim_0001HOSTHOSTHOSTHOSTHOSTHOST';
const DUPLICATE = 'claim_0002AUTOAAAAUTOAUTOAUTOAUTO';
const ENTITY_ID = 'entity_acme_scope';
const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const FACT = {
  scope: 'client:acme#1',
  subjectName: 'Acme',
  predicate: 'deadline_is',
  object: { type: 'date', value: '2026-09-01' } as TypedValue,
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-repick-'));
  store = new ClaimStore(path.join(dataDir, 'smartware.db'));
  store.setDataDir(dataDir);
  store.insertEntity({
    id: ENTITY_ID,
    canonical_name: FACT.subjectName,
    aliases: [],
    type: 'organization',
    scope: FACT.scope,
    created_at: new Date().toISOString(),
  });
});

afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** The claim row a host writes: confidence derived by the library, never hand-set. */
function buildClaim(claimId: string, observationId: string, from: string): Claim {
  const claim: Claim = {
    id: claimId,
    subject_id: ENTITY_ID,
    subject_name: FACT.subjectName,
    predicate: FACT.predicate,
    object: FACT.object,
    scope: FACT.scope,
    validity: { from, to: null },
    t_ingested: knownTime(from),
    t_invalidated: nullTime(),
    t_valid_from: knownTime(from),
    t_valid_to: nullTime(),
    source_event_id: observationId,
    extraction_event_id: observationId,
    supporting_evidence: [observationId],
    extraction: {
      method: 'deterministic',
      model: null,
      compiler_version: '0.7.0',
      prompt_hash: null,
      extracted_at: from,
    },
    status: 'active',
    epistemic: 'observed',
    confidence: 0,
    sensitive: false,
    superseded_by: null,
    contested_by: [],
    state: 'active',
  };
  claim.confidence = computeConfidence(claim);
  return claim;
}

/** Seed the two-active-claims-for-one-fact shape and run the §1e sweep on it. */
function seedAndSweep(): void {
  const t0 = new Date().toISOString();
  store.insertClaim(buildClaim(SURVIVOR, 'obs_host', t0));
  store.insertClaim(buildClaim(DUPLICATE, 'obs_auto', new Date(Date.now() + 1).toISOString()));
  const matches = store.findActiveFactMatches(ENTITY_ID, {
    predicate: FACT.predicate,
    scope: FACT.scope,
    object: FACT.object,
  });
  const resolution = resolveFactMatches({ store, matches, observationId: 'obs_sweep' });
  expect(resolution.superseded_claims).toEqual([DUPLICATE]);
}

/** Directories the protocol handlers need; the rest of the fixture is the shared `dataDir`. */
function scaffold(): { evidenceDir: string; opsDir: string } {
  const evidenceDir = path.join(dataDir, 'evidence');
  const opsDir = path.join(dataDir, 'operations');
  for (const dir of [evidenceDir, opsDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { evidenceDir, opsDir };
}

function protocolConfig(): SmartwareConfig {
  const config = createDefaultConfig(dataDir);
  config.owner_id = OWNER.id;
  config.scopes = [{ id: FACT.scope, parent: null, visibility_default: 'scope' }];
  saveConfig(dataDir, config);
  return config;
}

/** The recall-eligible set for this fact, as the substrate defines it: `status === 'active'`. */
function recallEligible(claimStore: ClaimStore): string[] {
  return claimStore.getAllClaims(FACT.scope)
    .filter(claim =>
      claim.predicate === FACT.predicate
      && claim.validity.to === null
      && claim.status === 'active')
    .map(claim => claim.id)
    .sort();
}

/** Replay every L1 version of this pod into a fresh projection. */
function replayIntoFreshStore(replayDbPath: string): ClaimStore {
  const replay = new ClaimStore(replayDbPath);
  for (const version of iterAllClaimVersions(dataDir)) replay.syncFromJsonlVersion(version);
  return replay;
}

function repickParams(operationId: string): ReviseParams {
  return {
    actor: OWNER,
    target: DUPLICATE,
    expected_base_version: 2,
    repick_survivor: true,
    reason: 'the duplicate is the claim that should surface',
    operation_id: operationId,
  };
}

function versionsWithOperation(operationId: string) {
  return [...iterAllClaimVersions(dataDir)].filter(version => version.operation_id === operationId);
}

describe('REVISE repick_survivor · swap and rescue', () => {
  it('swap: releases the demoted duplicate and demotes the survivor in one commit (two records)', async () => {
    seedAndSweep();
    const { opsDir } = scaffold();
    const config = protocolConfig();
    const releasedBefore = readLatestVersion(dataDir, DUPLICATE)!;
    const demotedBefore = readLatestVersion(dataDir, SURVIVOR)!;
    const relationsBefore = demotedBefore.relations;
    const operationId = `op_${ulid()}`;

    const result = await handleRevise(repickParams(operationId), dataDir, store, config, { opsDir });
    expect(result).toEqual({
      claim_id: DUPLICATE,
      new_version: releasedBefore.version + 1,
      epistemic_owner: 'user',
      operation_id: operationId,
      status: 'revised',
      demoted: [SURVIVOR],
    });
    // The released claim is no longer demoted, so no `superseded_by` is reported.
    expect(result.superseded_by).toBeUndefined();

    // The release: active again, pointer cleared, user-owned (the adjudication), and the
    // audit-only marker records the act.
    const released = readLatestVersion(dataDir, DUPLICATE)!;
    expect(released.version).toBe(releasedBefore.version + 1);
    expect(released.state).toBe('active');
    expect(released.superseded_by).toBeUndefined();
    expect(released.superseded_at).toBeUndefined();
    expect(released.epistemic_owner).toBe('user');
    expect(released.reinstated_by).toBe('user');

    // The demotion: the mechanical channel (`superseded_by` pointer, no admitted edge) plus the
    // user warrant, and the demoted copy's relations are untouched.
    const demoted = readLatestVersion(dataDir, SURVIVOR)!;
    expect(demoted.version).toBe(demotedBefore.version + 1);
    expect(demoted.superseded_by).toBe(DUPLICATE);
    expect(demoted.superseded_by_origin).toBe('user');
    expect(typeof demoted.superseded_at).toBe('string');
    expect(demoted.relations).toEqual(relationsBefore);

    // Rows: exactly one recall-eligible copy; pointer and status agree on both claims.
    const demotedRow = store.getClaim(SURVIVOR)!;
    expect(demotedRow.status).toBe('superseded');
    expect(demotedRow.superseded_by).toBe(DUPLICATE);
    expect(store.getClaim(DUPLICATE)!.status).toBe('active');
    expect(recallEligible(store)).toEqual([DUPLICATE]);

    // One commit: same operation_id, same version_at, release first then the demotion.
    const artifacts = versionsWithOperation(operationId);
    expect(artifacts.map(version => `${version.claim_id}@${version.version}`))
      .toEqual([`${DUPLICATE}@${releasedBefore.version + 1}`, `${SURVIVOR}@${demotedBefore.version + 1}`]);
    expect(new Set(artifacts.map(version => version.version_at)).size).toBe(1);

    // The ops-log entry names the whole commit, so a replay verifies both artifacts.
    const entries = [...readAllOpLogEntries(opsDir)].filter(entry => entry.operation_id === operationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details?.['repick_survivor']).toBe(true);
    expect(entries[0]!.details?.['demoted']).toEqual([SURVIVOR]);
    const demotedRecords = entries[0]!.details?.['demoted_records'] as Array<Record<string, unknown>>;
    expect(demotedRecords.map(record => record['claim_id'])).toEqual([SURVIVOR]);

    // Idempotent replay: same result, no second commit, intent removed.
    const replayed = await handleRevise(repickParams(operationId), dataDir, store, config, { opsDir });
    expect(replayed).toEqual(result);
    expect(versionsWithOperation(operationId)).toHaveLength(2);
    expect(readOperationIntent(opsDir, operationId)).toBeNull();

    // Rebuild-equivalence: the compile-path sync and a full canonical replay agree.
    store.syncFromJsonlVersionsBatch(artifacts, new Set(), undefined);
    expect(recallEligible(store)).toEqual([DUPLICATE]);
    const replay = replayIntoFreshStore(path.join(dataDir, 'replay.db'));
    try {
      expect(recallEligible(replay)).toEqual([DUPLICATE]);
      expect(replay.getClaim(SURVIVOR)!.status).toBe('superseded');
      expect(replay.getClaim(SURVIVOR)!.superseded_by).toBe(DUPLICATE);
      expect(replay.getClaim(DUPLICATE)!.status).toBe('active');
    } finally {
      replay.close();
    }
  });

  it('stability: the next §1e write corroborates the released copy — it is not re-demoted', async () => {
    seedAndSweep();
    const { opsDir } = scaffold();
    const config = protocolConfig();

    await handleRevise(repickParams(`op_${ulid()}`), dataDir, store, config, { opsDir });

    // The write path that follows (a restatement of the same fact) sees exactly one claim.
    const matches = store.findActiveFactMatches(ENTITY_ID, {
      predicate: FACT.predicate,
      scope: FACT.scope,
      object: FACT.object,
    });
    expect(matches.map(claim => claim.id)).toEqual([DUPLICATE]);
    const resolution = resolveFactMatches({ store, matches, observationId: 'obs_after_repick' });
    expect(resolution.claimId).toBe(DUPLICATE);
    expect(resolution.ambiguous_matches).toBe(1);
    expect(resolution.ambiguity_resolved).toBe(false);
    expect(resolution.superseded_claims).toEqual([]);

    // The released claim carries no demotion pointer, and the fact still answers once.
    expect(readLatestVersion(dataDir, DUPLICATE)!.superseded_by).toBeUndefined();
    expect(recallEligible(store)).toEqual([DUPLICATE]);
  });

  it('rescue: when the previous survivor is already forgotten, the re-pick releases the duplicate alone', async () => {
    seedAndSweep();
    const { evidenceDir, opsDir } = scaffold();
    const config = protocolConfig();
    const layer0 = new Layer0Index(path.join(dataDir, 'smartware.db'));
    const forgotten = await handleForget(
      {
        actor: OWNER,
        target_claim_id: SURVIVOR,
        mode: 'tombstone',
        reason: 'the owner forgot the survivor',
      },
      evidenceDir,
      layer0,
      store,
      config,
    );
    expect(forgotten.status).toBe('forgotten');
    const survivorVersionsBefore = [...iterAllClaimVersions(dataDir)]
      .filter(version => version.claim_id === SURVIVOR).length;

    const operationId = `op_${ulid()}`;
    const result = await handleRevise(repickParams(operationId), dataDir, store, config, { opsDir });
    expect(result.demoted).toEqual([]);
    expect(result.superseded_by).toBeUndefined();

    const released = readLatestVersion(dataDir, DUPLICATE)!;
    expect(released.superseded_by).toBeUndefined();
    expect(released.reinstated_by).toBe('user');
    expect(recallEligible(store)).toEqual([DUPLICATE]);

    // Rescue demotes nothing: the forgotten survivor is untouched by the re-pick.
    expect([...iterAllClaimVersions(dataDir)]
      .filter(version => version.claim_id === SURVIVOR)).toHaveLength(survivorVersionsBefore);
    expect(readLatestVersion(dataDir, SURVIVOR)!.state).toBe('forgotten');

    // Idempotent replay of the rescue.
    const replayed = await handleRevise(repickParams(operationId), dataDir, store, config, { opsDir });
    expect(replayed).toEqual(result);
  });

  it('a store that still holds a second active copy: the re-pick demotes every active copy', async () => {
    seedAndSweep();
    const { opsDir } = scaffold();
    const config = protocolConfig();

    // A host-side insert that bypassed §1e left another active copy of the same fact behind.
    const LATE = 'claim_0003LATELATELATELATELATELATE';
    store.insertClaim(buildClaim(LATE, 'obs_late', new Date().toISOString()));
    expect(store.getClaim(LATE)!.status).toBe('active');

    const result = await handleRevise(repickParams(`op_${ulid()}`), dataDir, store, config, { opsDir });
    expect(result.demoted).toEqual([SURVIVOR, LATE]);
    expect(recallEligible(store)).toEqual([DUPLICATE]);
    for (const claimId of [SURVIVOR, LATE]) {
      const latest = readLatestVersion(dataDir, claimId)!;
      expect(latest.superseded_by).toBe(DUPLICATE);
      expect(latest.superseded_by_origin).toBe('user');
    }
  });
});

describe('REVISE repick_survivor · rejections write nothing', () => {
  it('target that is not a demoted duplicate → not_demoted', async () => {
    seedAndSweep();
    const { opsDir } = scaffold();
    const config = protocolConfig();
    const operationId = `op_${ulid()}`;
    const survivorVersion = readLatestVersion(dataDir, SURVIVOR)!.version;
    const before = [...iterAllClaimVersions(dataDir)]
      .map(version => `${version.claim_id}@${version.version}:${version.operation_id}`);

    await expect(handleRevise(
      { ...repickParams(operationId), target: SURVIVOR, expected_base_version: survivorVersion },
      dataDir,
      store,
      config,
      { opsDir },
    )).rejects.toMatchObject({ code: 'not_demoted' });

    expect([...iterAllClaimVersions(dataDir)]
      .map(version => `${version.claim_id}@${version.version}:${version.operation_id}`)).toEqual(before);
    expect(readOperationIntent(opsDir, operationId)).toBeNull();
    expect([...readAllOpLogEntries(opsDir)].filter(entry => entry.operation_id === operationId)).toEqual([]);
  });

  it('stale expected_base_version → conflict', async () => {
    seedAndSweep();
    const { opsDir } = scaffold();
    const config = protocolConfig();

    await expect(handleRevise(
      { ...repickParams(`op_${ulid()}`), expected_base_version: 1 },
      dataDir,
      store,
      config,
      { opsDir },
    )).rejects.toMatchObject({ code: 'conflict' });
  });

  it('combined with another action → invalid_parameter (one adjudication per commit)', async () => {
    seedAndSweep();
    const { opsDir } = scaffold();
    const config = protocolConfig();
    const operationId = `op_${ulid()}`;
    const before = [...iterAllClaimVersions(dataDir)].length;

    await expect(handleRevise(
      { ...repickParams(operationId), set_confidence: 'high' },
      dataDir,
      store,
      config,
      { opsDir },
    )).rejects.toMatchObject({ code: 'invalid_parameter' });

    expect([...iterAllClaimVersions(dataDir)]).toHaveLength(before);
    expect(readOperationIntent(opsDir, operationId)).toBeNull();
  });
});

describe('REVISE repick_survivor · crash boundaries', () => {
  it('crash after the intent, before the append: nothing commits; the retry completes identically', async () => {
    seedAndSweep();
    const { opsDir } = scaffold();
    const config = protocolConfig();
    const operationId = `op_${ulid()}`;
    const crashAfterIntent: ReviseCommitHooks = {
      afterIntent: () => { throw new Error('simulated crash after intent'); },
    };

    await expect(handleRevise(
      repickParams(operationId), dataDir, store, config, { opsDir }, undefined, crashAfterIntent,
    )).rejects.toThrow('simulated crash after intent');

    // The intent is durable and describes both artifacts; nothing else moved.
    expect(readOperationIntent(opsDir, operationId)).not.toBeNull();
    expect(versionsWithOperation(operationId)).toEqual([]);
    expect([...readAllOpLogEntries(opsDir)].filter(entry => entry.operation_id === operationId)).toEqual([]);
    expect(recallEligible(store)).toEqual([SURVIVOR]);

    // The retry recomputes the prepared artifacts and completes the same commit.
    const result = await handleRevise(repickParams(operationId), dataDir, store, config, { opsDir });
    expect(result.demoted).toEqual([SURVIVOR]);
    expect(versionsWithOperation(operationId)).toHaveLength(2);
    expect(recallEligible(store)).toEqual([DUPLICATE]);
    expect(readOperationIntent(opsDir, operationId)).toBeNull();
  });

  it('crash after the append, before the ops-log entry: recovery finalises with the recorded demotions', async () => {
    seedAndSweep();
    const { opsDir } = scaffold();
    const config = protocolConfig();
    const operationId = `op_${ulid()}`;
    const releasedBefore = readLatestVersion(dataDir, DUPLICATE)!;
    const demotedBefore = readLatestVersion(dataDir, SURVIVOR)!;
    const crashAfterVersion: ReviseCommitHooks = {
      afterClaimVersion: () => { throw new Error('simulated crash after the append'); },
    };

    await expect(handleRevise(
      repickParams(operationId), dataDir, store, config, { opsDir }, undefined, crashAfterVersion,
    )).rejects.toThrow('simulated crash after the append');

    // Both records are durable (one append); the ops-log entry and finalisation are not.
    expect(versionsWithOperation(operationId).map(version => `${version.claim_id}@${version.version}`))
      .toEqual([`${DUPLICATE}@${releasedBefore.version + 1}`, `${SURVIVOR}@${demotedBefore.version + 1}`]);
    expect([...readAllOpLogEntries(opsDir)].filter(entry => entry.operation_id === operationId)).toEqual([]);
    expect(readOperationIntent(opsDir, operationId)).not.toBeNull();

    const report = runRecovery({ opsDir, evidenceDir: '', claimsDir: dataDir, quarantineDir: '' });
    expect(report.completed).toContain(operationId);
    expect(report.requiresManualReview).not.toContain(operationId);
    expect(readOperationIntent(opsDir, operationId)).toBeNull();

    // The recovered entry reports the same shape as the first call — flag, ids, artifact records.
    const entries = [...readAllOpLogEntries(opsDir)].filter(entry => entry.operation_id === operationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details?.['recovered']).toBe(true);
    expect(entries[0]!.details?.['repick_survivor']).toBe(true);
    expect(entries[0]!.details?.['demoted']).toEqual([SURVIVOR]);
    expect((entries[0]!.details?.['demoted_records'] as Array<Record<string, unknown>>)
      .map(record => record['claim_id'])).toEqual([SURVIVOR]);

    // The replay reports the same result and appends nothing.
    const before = [...iterAllClaimVersions(dataDir)].length;
    const replayed = await handleRevise(repickParams(operationId), dataDir, store, config, { opsDir });
    expect(replayed).toMatchObject({
      claim_id: DUPLICATE,
      new_version: releasedBefore.version + 1,
      demoted: [SURVIVOR],
      status: 'revised',
    });
    expect(replayed.superseded_by).toBeUndefined();
    expect([...iterAllClaimVersions(dataDir)]).toHaveLength(before);
  });

  it('crash after the commit entry, before finalisation: recovery retires the intent; replay is idempotent', async () => {
    seedAndSweep();
    const { opsDir } = scaffold();
    const config = protocolConfig();
    const operationId = `op_${ulid()}`;
    const releasedBefore = readLatestVersion(dataDir, DUPLICATE)!;
    const demotedBefore = readLatestVersion(dataDir, SURVIVOR)!;
    const crashAfterCommit: ReviseCommitHooks = {
      afterCommit: () => { throw new Error('simulated crash after commit'); },
    };

    await expect(handleRevise(
      repickParams(operationId), dataDir, store, config, { opsDir }, undefined, crashAfterCommit,
    )).rejects.toThrow('simulated crash after commit');

    // Both records and the ops-log entry are on disk; the intent is still pending finalisation.
    expect(versionsWithOperation(operationId).map(version => `${version.claim_id}@${version.version}`))
      .toEqual([`${DUPLICATE}@${releasedBefore.version + 1}`, `${SURVIVOR}@${demotedBefore.version + 1}`]);
    expect([...readAllOpLogEntries(opsDir)].filter(entry => entry.operation_id === operationId)).toHaveLength(1);
    expect(readOperationIntent(opsDir, operationId)).not.toBeNull();

    const report = runRecovery({ opsDir, evidenceDir: '', claimsDir: dataDir, quarantineDir: '' });
    expect(report.requiresManualReview).not.toContain(operationId);
    expect(readOperationIntent(opsDir, operationId)).toBeNull();

    // The replay reports the same result and appends nothing.
    const before = [...iterAllClaimVersions(dataDir)].length;
    const replayed = await handleRevise(repickParams(operationId), dataDir, store, config, { opsDir });
    expect(replayed).toMatchObject({
      claim_id: DUPLICATE,
      new_version: releasedBefore.version + 1,
      demoted: [SURVIVOR],
      status: 'revised',
    });
    expect(replayed.superseded_by).toBeUndefined();
    expect([...iterAllClaimVersions(dataDir)]).toHaveLength(before);
  });

  it('a partially written artifact set fails closed — recovery and retry both demand manual review', async () => {
    seedAndSweep();
    const { opsDir } = scaffold();
    const config = protocolConfig();
    const operationId = `op_${ulid()}`;
    let capturedIntent: ReviseOperationIntent | null = null;
    let capturedReleased: ActiveClaimVersion | null = null;
    await handleRevise(repickParams(operationId), dataDir, store, config, { opsDir }, undefined, {
      afterIntent: intent => { capturedIntent = intent; },
      afterClaimVersion: record => { capturedReleased = record; },
    });
    expect(capturedIntent).not.toBeNull();
    expect(capturedReleased).not.toBeNull();
    expect(versionsWithOperation(operationId)).toHaveLength(2);

    // Rebuild the torn state in a second pod: the durable intent survived, but only the release
    // record landed (the shape a sudden power loss could leave behind). Nothing may guess the
    // missing demotion into existence.
    const tornDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-repick-torn-'));
    const tornOpsDir = path.join(tornDir, 'operations');
    persistOperationIntent(tornOpsDir, capturedIntent!, true);
    appendClaimVersion(tornDir, capturedReleased!);

    const report = runRecovery({
      opsDir: tornOpsDir,
      evidenceDir: '',
      claimsDir: tornDir,
      quarantineDir: '',
    });
    expect(report.requiresManualReview).toContain(operationId);
    expect(report.completed).not.toContain(operationId);

    const tornStore = new ClaimStore(path.join(tornDir, 'smartware.db'));
    tornStore.setDataDir(tornDir);
    try {
      await expect(handleRevise(
        repickParams(operationId), tornDir, tornStore, config, { opsDir: tornOpsDir },
      )).rejects.toMatchObject({
        code: 'conflict',
        message: expect.stringContaining('manual recovery review'),
      });
    } finally {
      tornStore.close();
      fs.rmSync(tornDir, { recursive: true, force: true });
    }
  });
});
