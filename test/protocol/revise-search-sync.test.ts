// REVISE keeps the claim-FTS lane equal to the durable surface (kanban t_336ba0b9;
// the CORRECT half of the same class was t_8ddfa350, PR #25).
//
// `SmartwareCore.revise` appends a claim version through the store
// (`store.syncFromJsonlVersion`) and, before this fix, re-synced nothing: the
// claim-granular FTS lane is rebuilt from the derived rows, so the process that
// performed the revision kept answering without the revised claim while every
// restart — `SmartwareCore.open` re-derives the derived rows from the canonical
// surface and re-syncs the index — answered with it. A warranted user revision
// that answers *nothing* is indistinguishable from data loss.
//
// The invariant pinned here is deliberately semantics-neutral: after a REVISE,
// the live process must serve exactly what a fresh open of the same brain
// serves. That holds whether the revised claim comes back active (this base) or
// stays superseded (the demotion carry-forward decision, t_742e31f9) — either
// way the live lane and the durable surface must agree, and this test is what
// noticed when they did not (RED: in-process ['<replacement>'] vs fresh open
// ['<original>', '<replacement>']).

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { admitClaim } from '../../src/layer1/conflicts.js';
import { iterAllClaimVersions } from '../../src/layer1/jsonl.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import { makeClaim } from '../helpers.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const SCOPE = 'client:acme#1';
const T1 = '2026-08-01T00:00:00.000Z';
const T2 = '2026-09-01T00:00:00.000Z';
const SUBJECT = 'Revise Sync Probe Co';
const PREDICATE = 'revise_sync_date';
const QUERY = 'Revise Sync Probe';

interface Fixture {
  dataDir: string;
  core: SmartwareCore;
  store: ClaimStore;
  searchIndex: SearchIndex;
}

const liveFixtures: Array<{ core: SmartwareCore | null; store?: ClaimStore; searchIndex?: SearchIndex; dataDir: string }> = [];

function probeConfig(dataDir: string): SmartwareConfig {
  return {
    instance_id: `smartware_${ulid()}`,
    owner_id: OWNER.id,
    writer_id: `writer_local_${ulid()}`,
    version: '0.7.0',
    data_dir: dataDir,
    scopes: [
      { id: 'self', parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: SCOPE, parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
}

async function newFixture(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-revise-sync-'));
  for (const sub of ['wiki/personal', 'wiki/workspace', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  saveConfig(dataDir, probeConfig(dataDir));
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);
  const fx = { dataDir, core, store, searchIndex };
  liveFixtures.push(fx);
  return fx;
}

afterEach(() => {
  for (const entry of liveFixtures.splice(0)) {
    entry.store?.close();
    entry.searchIndex?.close();
    entry.core?.close();
    fs.rmSync(entry.dataDir, { recursive: true, force: true });
  }
});

/** The fact the drill asserts about, written as the host extractor would. */
function buildProbeClaim(opts: {
  entityId: string;
  value: string;
  validFrom: string;
  ingestedAt: string;
}) {
  const claim = makeClaim({
    id: `claim_${ulid()}`,
    subject_id: opts.entityId,
    subject_name: SUBJECT,
    predicate: PREDICATE,
    object: { type: 'text', value: opts.value },
    scope: SCOPE,
    validity: { from: opts.validFrom, to: null },
    t_ingested: knownTime(opts.ingestedAt),
    t_invalidated: nullTime(),
    t_valid_from: knownTime(opts.validFrom),
    t_valid_to: nullTime(),
    supporting_evidence: [`obs_${ulid()}`],
  });
  return claim;
}

function latestVersionOf(dataDir: string, claimId: string): number {
  return [...iterAllClaimVersions(dataDir)]
    .filter(version => version.claim_id === claimId)
    .reduce((max, version) => Math.max(max, version.version), 0);
}

async function recallIds(core: SmartwareCore): Promise<string[]> {
  const result = await core.recall({ actor: OWNER, query: QUERY, scope: SCOPE });
  return result.results.flatMap(entry => (entry.claim ? [entry.claim.id] : [])).sort();
}

describe('REVISE and the claim-FTS lane', () => {
  it('the process that revised a claim serves what a fresh open of the same brain serves', async () => {
    const fx = await newFixture();
    const entityId = `entity_${ulid()}`;
    fx.store.insertEntity({
      id: entityId, canonical_name: SUBJECT, aliases: [], type: 'organization', scope: SCOPE, created_at: T1,
    });

    // A fact, indexed the way the write path indexes it.
    const original = buildProbeClaim({ entityId, value: '2031-01-01', validFrom: T1, ingestedAt: T1 });
    fx.store.insertClaim(original);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);
    expect(await recallIds(fx.core)).toEqual([original.id]);

    // A later event-valid window supersedes it; the write path re-syncs the
    // scope, so the superseded row leaves the claim lane (check 3h's state).
    const replacement = buildProbeClaim({ entityId, value: '2031-02-02', validFrom: T2, ingestedAt: T2 });
    expect(admitClaim(replacement, fx.store).outcome).toBe('superseded');
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);
    expect(await recallIds(fx.core)).toEqual([replacement.id]);

    // The warranted user revision of the superseded claim.
    await fx.core.revise({
      actor: OWNER,
      target: original.id,
      expected_base_version: latestVersionOf(fx.dataDir, original.id),
      set_confidence: 'high',
      reason: 'the earlier window was still in force',
      operation_id: `op_${ulid()}`,
    });

    // Live view vs the durable surface: a fresh open re-derives the derived
    // rows from the canonical claim log and re-syncs the claim lane. Before the
    // fix these disagreed by exactly the revised claim (RED, t_336ba0b9).
    const inProcess = await recallIds(fx.core);
    const fresh = await SmartwareCore.open({ dataDir: fx.dataDir, ownerId: OWNER.id });
    try {
      expect(await recallIds(fresh)).toEqual(inProcess);
    } finally {
      fresh.close();
    }
  });

  it('control: adjudicating an ACTIVE claim keeps it findable in-process (no re-sync needed for the plain case)', async () => {
    const fx = await newFixture();
    const entityId = `entity_${ulid()}`;
    fx.store.insertEntity({
      id: entityId, canonical_name: SUBJECT, aliases: [], type: 'organization', scope: SCOPE, created_at: T1,
    });
    const claim = buildProbeClaim({ entityId, value: '2031-03-03', validFrom: T1, ingestedAt: T1 });
    fx.store.insertClaim(claim);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);

    await fx.core.revise({
      actor: OWNER,
      target: claim.id,
      expected_base_version: latestVersionOf(fx.dataDir, claim.id),
      set_confidence: 'high',
      reason: 'verified with the client',
      operation_id: `op_${ulid()}`,
    });

    const inProcess = await recallIds(fx.core);
    expect(inProcess).toEqual([claim.id]);
    const served = (await fx.core.recall({ actor: OWNER, query: QUERY, scope: SCOPE }))
      .results.flatMap(entry => (entry.claim ? [entry.claim] : []));
    // The adjudication is visible on the served row: the user's high-confidence
    // warrant, not the pre-REVISE value.
    expect(served[0]?.confidence).toBe(0.9);
  });
});
