// Tests: Layer 1 — the demotion of a resolved duplicate is durable in canonical state
//
// Why these exist: `resolveFactMatches` demotes a duplicate by writing the derived SQLite row
// (`status: 'superseded'`, `superseded_by`, `t_invalidated`) through `updateClaimStatus`. The
// canonical L1 version record that the same call appends carried no supersession field at all,
// so two things followed:
//
//   1. the compile path re-materialises the row from the canonical record
//      (`syncFromJsonlVersionsBatch` / `syncFromJsonlVersion`) and derives `status` from
//      `state` alone — the demoted duplicate returns to the recall-eligible set; and
//   2. a canonical replay into a fresh projection loses the demotion entirely.
//
// Measured in `t_15bb0cd0` (evidence/23-demotion-durability.txt): after the §1e sweep converged
// recall to one result, one further write put the same row back in the recall-eligible set, and
// nothing in the L1 JSONL said `superseded` anywhere.
//
// The repo's contract is that canonical state is primary and every view over it is regenerable
// (`AGENTS.md`; rebuild-equivalence). A demotion that survives only as a projection write is not
// rebuild-equivalent, so the demotion must be recorded in the canonical record and the row must
// be derived from it on every materialisation. These tests pin exactly that:
//
//   - the demotion appears in the demoted claim's own latest canonical version;
//   - a compile-path sync of that version keeps the row out of the recall-eligible set;
//   - a full canonical replay into a fresh projection does the same;
//   - `status` and `superseded_by` never contradict each other in any row produced along the way;
//   - live and replayed projections agree on the recall-eligible set.
//
// The frozen §1e contract (survivor = earliest-minted ULID, evidence unioned before demotion,
// demote-never-delete, `ambiguous_matches`/`superseded_claims` reported) is asserted by
// `fact-identity.test.ts`; these tests only add durability on top of it and do not restate it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ulid } from 'ulid';
import { ClaimStore } from '../../src/layer1/store.js';
import { computeConfidence } from '../../src/layer1/confidence.js';
import { resolveFactMatches } from '../../src/layer1/corroboration.js';
import {
  iterAllClaimVersions,
  readLatestVersion,
  type ForgottenClaimVersion,
} from '../../src/layer1/jsonl.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import type { Claim, ClaimStatus } from '../../src/layer1/types.js';
import type { TypedValue } from '../../src/layer0/types.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { CascadePreviewStore } from '../../src/preview_store/store.js';
import { serialiseFrontmatter } from '../../src/layer2/frontmatter.js';
import type { Frontmatter } from '../../src/layer2/types.js';
import { createDefaultConfig, saveConfig, type SmartwareConfig } from '../../src/config.js';
import { handleRevise } from '../../src/protocol/revise.js';
import { handleForget, handleRevive } from '../../src/protocol/forget.js';
import { handleConsolidate } from '../../src/protocol/consolidate.js';
import { handleEndorse } from '../../src/protocol/endorse.js';

let dataDir: string;
let store: ClaimStore;

// Claim ids are ULIDs in production (time-ordered): the smaller id is the earliest-minted claim,
// so `claim_0001…` is the §1e survivor and `claim_0002…` the duplicate it demotes.
const SURVIVOR = 'claim_0001HOSTHOSTHOSTHOSTHOSTHOST';
const DUPLICATE = 'claim_0002AUTOAAAAUTOAUTOAUTOAUTO';
const ENTITY_ID = 'entity_acme_scope';
const FACT = {
  scope: 'client:acme#1',
  subjectName: 'Acme',
  predicate: 'deadline_is',
  object: { type: 'date', value: '2026-09-01' } as TypedValue,
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-durability-'));
  store = new ClaimStore(path.join(dataDir, 'smartware.db'));
  store.setDataDir(dataDir);
  store.insertEntity({
    id: ENTITY_ID, canonical_name: FACT.subjectName, aliases: [], type: 'organization',
    scope: FACT.scope, created_at: new Date().toISOString(),
  });
});

afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** The claim row a host writes: confidence derived by the library, never hand-set. */
function buildClaim(claimId: string, observationId: string, from: string): Claim {
  const claim: Claim = {
    id: claimId, subject_id: ENTITY_ID, subject_name: FACT.subjectName,
    predicate: FACT.predicate, object: FACT.object, scope: FACT.scope,
    validity: { from, to: null },
    t_ingested: knownTime(from), t_invalidated: nullTime(),
    t_valid_from: knownTime(from), t_valid_to: nullTime(),
    source_event_id: observationId, extraction_event_id: observationId,
    supporting_evidence: [observationId],
    extraction: {
      method: 'deterministic', model: null, compiler_version: '0.7.0',
      prompt_hash: null, extracted_at: from,
    },
    status: 'active', epistemic: 'observed', confidence: 0, sensitive: false,
    superseded_by: null, contested_by: [], state: 'active',
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
    predicate: FACT.predicate, scope: FACT.scope, object: FACT.object,
  });
  const resolution = resolveFactMatches({ store, matches, observationId: 'obs_sweep' });
  expect(resolution.superseded_claims).toEqual([DUPLICATE]);
}

/**
 * The recall-eligible set for this fact, as the substrate defines it: `status === 'active'`
 * rows with an open validity window. Deliberately scope+predicate based, not subject-id based —
 * a fresh replay resolves entities from the records, so the replayed rows carry their own
 * entity ids and the check must not depend on the live store's id.
 */
function recallEligible(claimStore: ClaimStore): string[] {
  return claimStore.getAllClaims(FACT.scope)
    .filter(claim =>
      claim.predicate === FACT.predicate
      && claim.validity.to === null
      && claim.status === 'active')
    .map(claim => claim.id)
    .sort();
}

/** `status` and `superseded_by` must never contradict each other in any row. */
function assertConsistent(claim: Claim, label: string): void {
  const status: ClaimStatus = claim.status;
  expect(
    status === 'active' && claim.superseded_by !== null,
    `${label}: status='active' with superseded_by='${claim.superseded_by}'`,
  ).toBe(false);
  expect(
    status === 'superseded' && claim.superseded_by === null,
    `${label}: status='superseded' with no superseded_by`,
  ).toBe(false);
}

/** Replay every L1 version of this pod into a fresh projection. */
function replayIntoFreshStore(replayDbPath: string): ClaimStore {
  const replay = new ClaimStore(replayDbPath);
  for (const version of iterAllClaimVersions(dataDir)) replay.syncFromJsonlVersion(version);
  return replay;
}

describe('demotion durability · the demotion is recorded in the canonical record', () => {
  it('the demoted claim\'s own canonical version carries superseded_by and superseded_at', () => {
    seedAndSweep();

    const latest = readLatestVersion(dataDir, DUPLICATE);
    expect(latest).not.toBeNull();
    // The demotion is a fact about this claim; a replay that reads only this record must be
    // able to reconstruct it. These fields are the canonical home of what the row carries.
    expect(latest!.superseded_by).toBe(SURVIVOR);
    expect(typeof latest!.superseded_at).toBe('string');
    expect(Number.isNaN(Date.parse(latest!.superseded_at!))).toBe(false);
    // The demotion does not change `state` (spec §6: supersession is not a state).
    expect(latest!.state).toBe('active');
  });

  it('a later canonical version of the demoted claim carries the demotion forward', () => {
    seedAndSweep();

    // What a restatement/corroboration write against the demoted claim produces: another
    // version appended through `insertClaim`. The demotion must not evaporate with it.
    const loser = store.getClaim(DUPLICATE)!;
    store.updateClaimSupportingEvidence(DUPLICATE, [...loser.supporting_evidence, 'obs_restated']);

    const latest = readLatestVersion(dataDir, DUPLICATE);
    expect(latest!.version).toBeGreaterThan(1);
    expect(latest!.superseded_by).toBe(SURVIVOR);
  });
});

describe('demotion durability · re-materialisation keeps the duplicate out of the eligible set', () => {
  it('(a) a compile-path sync of the demoted claim\'s own canonical version keeps it demoted', () => {
    seedAndSweep();
    expect(recallEligible(store)).toEqual([SURVIVOR]);

    // The compile path re-materialises rows from the canonical records a run committed. Feed it
    // the demoted claim's own latest version — nothing else.
    const latest = readLatestVersion(dataDir, DUPLICATE)!;
    store.syncFromJsonlVersionsBatch([latest], new Set(), undefined);

    const loserAfter = store.getClaim(DUPLICATE)!;
    assertConsistent(loserAfter, 'after compile-path sync');
    expect(loserAfter.status).toBe('superseded');
    expect(loserAfter.superseded_by).toBe(SURVIVOR);
    expect(recallEligible(store)).toEqual([SURVIVOR]);
  });

  it('(a) the serial sync path agrees with the batch path', () => {
    seedAndSweep();

    const latest = readLatestVersion(dataDir, DUPLICATE)!;
    store.syncFromJsonlVersion(latest);

    const loserAfter = store.getClaim(DUPLICATE)!;
    assertConsistent(loserAfter, 'after serial sync');
    expect(loserAfter.status).toBe('superseded');
    expect(recallEligible(store)).toEqual([SURVIVOR]);
  });

  it('(b) a full canonical replay into a fresh projection keeps the duplicate out', () => {
    seedAndSweep();

    const replay = replayIntoFreshStore(path.join(dataDir, 'replay.db'));
    try {
      const loserReplayed = replay.getClaim(DUPLICATE)!;
      assertConsistent(loserReplayed, 'replayed row');
      expect(loserReplayed.status).toBe('superseded');
      expect(loserReplayed.superseded_by).toBe(SURVIVOR);
      expect(recallEligible(replay)).toEqual([SURVIVOR]);
    } finally {
      replay.close();
    }
  });

  it('live and replayed projections agree on the recall-eligible set', () => {
    seedAndSweep();

    // One more write against the demoted claim, the shape that used to flip it back.
    const loser = store.getClaim(DUPLICATE)!;
    store.updateClaimSupportingEvidence(DUPLICATE, [...loser.supporting_evidence, 'obs_restated']);

    const replay = replayIntoFreshStore(path.join(dataDir, 'replay.db'));
    try {
      expect(recallEligible(replay)).toEqual(recallEligible(store));
      expect(recallEligible(store)).toEqual([SURVIVOR]);
    } finally {
      replay.close();
    }
  });

  it('the demotion survives the compile-path sync after a later version was appended', () => {
    seedAndSweep();
    const loser = store.getClaim(DUPLICATE)!;
    store.updateClaimSupportingEvidence(DUPLICATE, [...loser.supporting_evidence, 'obs_restated']);

    const latest = readLatestVersion(dataDir, DUPLICATE)!;
    store.syncFromJsonlVersionsBatch([latest], new Set(), undefined);

    const loserAfter = store.getClaim(DUPLICATE)!;
    assertConsistent(loserAfter, 'after sync of the later version');
    expect(loserAfter.status).toBe('superseded');
    expect(recallEligible(store)).toEqual([SURVIVOR]);
  });
});

describe('demotion durability · every row the flow produces is consistent', () => {
  it('rows stay consistent at every step of the sweep → sync → replay sequence', () => {
    seedAndSweep();
    assertConsistent(store.getClaim(SURVIVOR)!, 'survivor, after sweep');
    assertConsistent(store.getClaim(DUPLICATE)!, 'loser, after sweep');

    const latest = readLatestVersion(dataDir, DUPLICATE)!;
    store.syncFromJsonlVersionsBatch([latest], new Set(), undefined);
    assertConsistent(store.getClaim(DUPLICATE)!, 'loser, after compile-path sync');

    const replay = replayIntoFreshStore(path.join(dataDir, 'replay.db'));
    try {
      assertConsistent(replay.getClaim(DUPLICATE)!, 'loser, replayed');
      assertConsistent(replay.getClaim(SURVIVOR)!, 'survivor, replayed');
    } finally {
      replay.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the flows that hand-build a claim's next version record
//
// A flow that constructs the record literal itself (rather than appending through `insertClaim`) is
// the place the demotion used to evaporate: every materialisation derives `status` from the new
// record alone, so a record without `superseded_by` *is* a release — consistently in live and
// replayed state, and silently.
//
// ADR-0003 → *Carry-forward across hand-built version records* decides per flow that the demotion is
// preserved, because beta has no verb that changes the fact a claim asserts (spec §6: content is
// never rewritten in place). Releasing it could only add a second recall-eligible copy of the same
// fact, which the next §1e write re-demotes. These tests pin the carry-forward, the derived row, the
// recall-eligible set and a canonical replay for every flow that can touch a superseded claim. Run
// against the pre-change tree they are the RED proof that the old boundary released the demotion.
// ---------------------------------------------------------------------------

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };

/** Directories the protocol handlers need; the rest of the fixture is the shared `dataDir`. */
function scaffold(): { evidenceDir: string; opsDir: string; wikiDir: string } {
  const evidenceDir = path.join(dataDir, 'evidence');
  const opsDir = path.join(dataDir, 'operations');
  const wikiDir = path.join(dataDir, 'wiki', 'entities');
  for (const dir of [evidenceDir, opsDir, wikiDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { evidenceDir, opsDir, wikiDir };
}

function protocolConfig(): SmartwareConfig {
  const config = createDefaultConfig(dataDir);
  config.owner_id = OWNER.id;
  config.scopes = [{ id: FACT.scope, parent: null, visibility_default: 'scope' }];
  saveConfig(dataDir, config);
  return config;
}

describe('demotion durability · hand-built version records carry the demotion forward', () => {
  it('REVISE: the user revision keeps the claim demoted — record, row, replay and result', async () => {
    seedAndSweep();
    const { opsDir } = scaffold();
    const config = protocolConfig();

    const params = {
      actor: OWNER,
      target: DUPLICATE,
      expected_base_version: 2,
      set_confidence: 'high' as const,
      reason: 'the owner confirms this deadline',
      operation_id: `op_${ulid()}`,
    };

    const result = await handleRevise(params, dataDir, store, config, { opsDir });
    expect(result.status).toBe('revised');
    // A REVISE changes metadata, never the asserted fact — so the duplicate condition the demotion
    // encodes still holds, and the caller is told rather than left to discover it from recall.
    expect(result.superseded_by).toBe(SURVIVOR);

    const latest = readLatestVersion(dataDir, DUPLICATE)!;
    expect(latest.version).toBe(3);
    expect(latest.confidence).toBe('high');
    expect(latest.superseded_by).toBe(SURVIVOR);
    expect(typeof latest.superseded_at).toBe('string');

    const row = store.getClaim(DUPLICATE)!;
    assertConsistent(row, 'after REVISE');
    expect(row.status).toBe('superseded');
    expect(row.superseded_by).toBe(SURVIVOR);
    expect(recallEligible(store)).toEqual([SURVIVOR]);
    // The write path still sees exactly one claim for the fact: a revise did not create a duplicate.
    expect(store.findActiveFactMatches(ENTITY_ID, {
      predicate: FACT.predicate, scope: FACT.scope, object: FACT.object,
    }).map(claim => claim.id)).toEqual([SURVIVOR]);

    // The compile path re-materialising the revised record, then a full canonical replay.
    store.syncFromJsonlVersionsBatch([latest], new Set(), undefined);
    expect(store.getClaim(DUPLICATE)!.status).toBe('superseded');
    const replay = replayIntoFreshStore(path.join(dataDir, 'replay.db'));
    try {
      expect(recallEligible(replay)).toEqual([SURVIVOR]);
      expect(replay.getClaim(DUPLICATE)!.superseded_by).toBe(SURVIVOR);
    } finally {
      replay.close();
    }

    // Idempotent replay of the same operation_id reports the same thing: the contract does not
    // depend on which path served the call.
    const replayed = await handleRevise(params, dataDir, store, config, { opsDir });
    expect(replayed.superseded_by).toBe(SURVIVOR);
  });

  it('FORGET → REVIVE: the tombstone and the revival both carry it; the duplicate stays out', async () => {
    seedAndSweep();
    const { evidenceDir } = scaffold();
    const config = protocolConfig();
    const layer0 = new Layer0Index(path.join(dataDir, 'smartware.db'));

    try {
      const forgotten = await handleForget(
        { actor: OWNER, target_claim_id: DUPLICATE, mode: 'tombstone', reason: 'the owner asked for it' },
        evidenceDir, layer0, store, config,
      );
      expect(forgotten.status).toBe('forgotten');

      // Spec §11: the forgotten version carries forward all non-content metadata. The demotion is
      // non-content metadata about this claim; losing it here is how a revival would lose it.
      const forgottenVersion = readLatestVersion(dataDir, DUPLICATE)! as ForgottenClaimVersion;
      expect(forgottenVersion.state).toBe('forgotten');
      expect(forgottenVersion.superseded_by).toBe(SURVIVOR);
      expect(typeof forgottenVersion.superseded_at).toBe('string');

      // The derived row for a forgotten claim is retracted, and the pointer only means something
      // while the claim is superseded — so the row's pointer is null by design, not by loss.
      const retracted = store.getClaim(DUPLICATE)!;
      expect(retracted.status).toBe('retracted');
      expect(retracted.superseded_by).toBeNull();

      const revived = await handleRevive(
        {
          actor: OWNER,
          tombstone_id: forgottenVersion.tombstone_id,
          reason: 'the owner brought it back',
          operation_id: `op_${ulid()}`,
        },
        dataDir, store, config,
      );
      expect(revived.status).toBe('revived');

      // Revival restores the claim's assertion. The survivor still asserts the same fact, so the
      // revival must not put the duplicate back into the recall-eligible set.
      const revivedVersion = readLatestVersion(dataDir, DUPLICATE)!;
      expect(revivedVersion.state).toBe('active');
      expect(revivedVersion.superseded_by).toBe(SURVIVOR);
      const row = store.getClaim(DUPLICATE)!;
      assertConsistent(row, 'after REVIVE');
      expect(row.status).toBe('superseded');
      expect(recallEligible(store)).toEqual([SURVIVOR]);

      const replay = replayIntoFreshStore(path.join(dataDir, 'replay.db'));
      try {
        expect(recallEligible(replay)).toEqual([SURVIVOR]);
        expect(replay.getClaim(DUPLICATE)!.superseded_by).toBe(SURVIVOR);
      } finally {
        replay.close();
      }
    } finally {
      layer0.close();
    }
  });

  it('ENDORSE: the cascade version of a demoted claim keeps it demoted', async () => {
    seedAndSweep();
    const { wikiDir } = scaffold();
    const config = protocolConfig();
    const previews = new CascadePreviewStore(':memory:');

    try {
      const frontmatter: Frontmatter = {
        entity_id: ENTITY_ID,
        entity: FACT.subjectName,
        type: 'organization',
        scope: FACT.scope,
        epistemic: 'observed',
        sensitive: false,
        sources: [],
        claim_ids: [DUPLICATE],
        sources_claim_ids: [DUPLICATE],
        compiled_at: new Date().toISOString(),
        compiled_by: 'smartware',
        confidence: 0.5,
        supersedes: [],
        related: [],
        page_id: `page_${ENTITY_ID}`,
      };
      const pagePath = path.join(wikiDir, 'acme.md');
      fs.writeFileSync(pagePath, serialiseFrontmatter(frontmatter, '# Acme'), 'utf8');

      const result = await handleEndorse({
        actor: OWNER,
        page_id: `page_${ENTITY_ID}`,
        page_path: pagePath,
        dry_run: false,
        reason: 'the owner confirms this page',
        operation_id: `op_${ulid()}`,
      }, dataDir, store, previews, config);
      expect(result.status).toBe('endorsed');

      // Endorsement adopts the body as user voice; it does not decide that the claim is no longer a
      // duplicate of the survivor.
      const latest = readLatestVersion(dataDir, DUPLICATE)!;
      expect(latest.state).toBe('active');
      expect(latest.author).toBe('user');
      expect(latest.superseded_by).toBe(SURVIVOR);
      const row = store.getClaim(DUPLICATE)!;
      assertConsistent(row, 'after ENDORSE');
      expect(row.status).toBe('superseded');
      expect(recallEligible(store)).toEqual([SURVIVOR]);
    } finally {
      previews.close();
    }
  });

  it('CONSOLIDATE: a demoted input\'s tombstone carries it; the summary inherits nothing', async () => {
    seedAndSweep();
    const config = protocolConfig();

    const result = await handleConsolidate({
      actor: OWNER,
      claim_ids: [SURVIVOR, DUPLICATE],
      summary: 'One deadline: 2026-09-01',
      subject_name: FACT.subjectName,
      predicate: 'deadline_summary',
      scope: FACT.scope,
      operation_id: `op_${ulid()}`,
    }, dataDir, store, config);
    expect(result.status).toBe('consolidated');

    const forgottenVersion = readLatestVersion(dataDir, DUPLICATE)! as ForgottenClaimVersion;
    expect(forgottenVersion.state).toBe('forgotten');
    expect(forgottenVersion.superseded_by).toBe(SURVIVOR);

    // The "current understanding" claim is a NEW claim (version 1): there is no prior version to
    // carry from, and it inherits none of the input's demotion state.
    const consolidated = readLatestVersion(dataDir, result.claim_id)!;
    expect(consolidated.version).toBe(1);
    expect(consolidated.state).toBe('active');
    expect(consolidated.superseded_by).toBeUndefined();
    expect(store.getClaim(result.claim_id)!.status).toBe('active');
  });
});
