// Survey (kanban t_12c79071): which SmartwareCore verbs mutate claim rows
// without re-syncing the claim-FTS lane.
//
// The class was measured twice before: CORRECT (t_8ddfa350, PR #25) and REVISE
// (t_336ba0b9, PR #29). Both fixes re-sync the affected scope in the core
// wrapper, because `store.syncFromJsonlVersion` moves the derived claim row
// while the claim-granular FTS lane is rebuilt only by `syncSearchFromClaims`:
// after such a mutation the live process and every restart disagreed about what
// recall serves (`SmartwareCore.open` re-derives the rows from the canonical
// surface and re-syncs the index).
//
// This file is the one-pass survey for the remaining mutating verbs. Every
// `it` is one measurement of the same invariant:
//
//     after a claim-row mutation, in-process recall == what a fresh open of
//     the same brain serves
//
// A test that passes at the pre-fix revision is the measured negative
// ("already fine", with the mechanism that makes it fine asserted rather than
// assumed); a test that fails there is the RED half of a RED/GREEN pair.
//
// Run with `PROBE_OUT=<path>` to get the raw signatures as JSON lines (vitest
// prints console.log only for failing runs, so the report goes to a file).

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig, type SmartwareConfig } from '../../src/config.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import { serialiseFrontmatter } from '../../src/layer2/frontmatter.js';
import type { Frontmatter } from '../../src/layer2/types.js';
import { makeClaim } from '../helpers.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const UNTRUSTED = { type: 'agent' as const, id: 'agent:untrusted', display_name: 'Untrusted' };
const SCOPE = 'client:acme#1';
const T1 = '2026-08-01T00:00:00.000Z';
const T2 = '2026-09-01T00:00:00.000Z';
const AS_OF = '2026-09-10T00:00:00.000Z';

/** What recall serves for one query: the rows, and the counters around them. */
interface Sig {
  ids: string[];
  total_found: number;
  filtered_out: number;
}

interface Fixture {
  dataDir: string;
  core: SmartwareCore;
  store: ClaimStore;
  searchIndex: SearchIndex;
}

const live: Array<{ core?: SmartwareCore; store?: ClaimStore; searchIndex?: SearchIndex; dataDir: string }> = [];

function record(label: string, payload: unknown): void {
  const out = process.env.PROBE_OUT;
  if (!out) return;
  fs.appendFileSync(out, `${JSON.stringify({ label, ...(payload as object) })}\n`);
}

function stage(dataDir: string, retention: boolean): void {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/entities', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = OWNER.id;
  cfg.llm = { provider: 'none', model: '' };
  cfg.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    { id: SCOPE, parent: 'workspace', visibility_default: 'scope' },
  ];
  cfg.grants = [];
  if (retention) {
    cfg.retention = {
      default: { policy: 'forever', duration_days: null },
      scope_overrides: { [SCOPE]: { policy: 'duration', duration_days: 1 } },
    };
  }
  saveConfig(dataDir, cfg);
}

async function newFixture(retention = false): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-mutation-sync-'));
  stage(dataDir, retention);
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);
  const fx = { dataDir, core, store, searchIndex };
  live.push(fx);
  return fx;
}

afterEach(() => {
  for (const entry of live.splice(0)) {
    entry.store?.close();
    entry.searchIndex?.close();
    entry.core?.close();
    fs.rmSync(entry.dataDir, { recursive: true, force: true });
  }
});

function insertEntity(fx: Fixture, name: string): string {
  const id = `entity_${ulid()}`;
  fx.store.insertEntity({
    id, canonical_name: name, aliases: [], type: 'organization', scope: SCOPE, created_at: T1,
  });
  return id;
}

function buildClaim(opts: {
  entityId: string;
  subject: string;
  predicate: string;
  value: string;
  validFrom?: string;
  ingestedAt?: string;
  evidence?: string[];
}) {
  const from = opts.validFrom ?? T1;
  const ingested = opts.ingestedAt ?? from;
  return makeClaim({
    id: `claim_${ulid()}`,
    subject_id: opts.entityId,
    subject_name: opts.subject,
    predicate: opts.predicate,
    object: { type: 'text', value: opts.value },
    scope: SCOPE,
    validity: { from, to: null },
    t_ingested: knownTime(ingested),
    t_invalidated: nullTime(),
    t_valid_from: knownTime(from),
    t_valid_to: nullTime(),
    supporting_evidence: opts.evidence ?? [`obs_${ulid()}`],
  });
}

async function sig(core: SmartwareCore, query: string): Promise<Sig> {
  const result = await core.recall({ actor: OWNER, query, scope: SCOPE });
  return {
    ids: result.results.flatMap(entry => (entry.claim ? [entry.claim.id] : [])).sort(),
    total_found: result.total_found,
    filtered_out: result.filtered_out,
  };
}

/** Leg 2 of the instrument: a fresh open of the same brain dir. */
async function freshSig(dataDir: string, query: string): Promise<Sig> {
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  try {
    return await sig(core, query);
  } finally {
    core.close();
  }
}

function rawWindow(core: SmartwareCore, query: string): string[] {
  return core.searchObservations({ actor: OWNER, query, scope: SCOPE }).map(hit => hit.id).sort();
}

/** A later write in the same scope: CONSOLIDATE re-syncs the scope (core.ts). */
async function interveningWrite(fx: Fixture, tag: string): Promise<void> {
  const a = insertEntity(fx, `${tag} Alpha`);
  const b = insertEntity(fx, `${tag} Beta`);
  const ca = buildClaim({ entityId: a, subject: `${tag} Alpha`, predicate: 'survey_state', value: 'one' });
  const cb = buildClaim({ entityId: b, subject: `${tag} Beta`, predicate: 'survey_state', value: 'two' });
  fx.store.insertClaim(ca);
  fx.store.insertClaim(cb);
  syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);
  const result = await fx.core.consolidate({
    actor: OWNER,
    claim_ids: [ca.id, cb.id],
    summary: `${tag} Alpha and Beta are both under review.`,
    subject_name: `${tag} Review`,
    predicate: 'survey_review',
    scope: SCOPE,
    operation_id: `op_${ulid()}`,
  });
  expect(result.inputs_consolidated).toBe(2);
}

function tombstoneOf(claimId: string): string {
  return `tomb_${claimId.slice(6)}`;
}

describe('1. FORGET (claim target) — the kept claim-FTS row', () => {
  it('what recall SERVES is rebuild-equivalent; the deliberately kept row shows up only in the counters', async () => {
    const fx = await newFixture();
    const subject = 'Forget Kept Row Probe';
    const entityId = insertEntity(fx, subject);
    const claim = buildClaim({ entityId, subject, predicate: 'probe_state', value: 'written-off' });
    fx.store.insertClaim(claim);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);
    expect((await sig(fx.core, subject)).ids).toEqual([claim.id]);

    const forget = await fx.core.forget({
      actor: OWNER, target: { type: 'claim', id: claim.id }, mode: 'tombstone',
      reason: 'survey', operation_id: `op_${ulid()}`,
    });
    expect(forget.claims_retracted).toBe(1);

    const inProcess = await sig(fx.core, subject);
    const fresh = await freshSig(fx.dataDir, subject);
    record('forget-alone', { subject, inProcess, fresh });

    // Served rows: identical, because the authorized snapshot filters the
    // forgotten claim in both processes (assembly.ts: claimsById lookup).
    expect(inProcess.ids).toEqual([]);
    expect(fresh.ids).toEqual([]);

    // The counters are where the two views differ, and by design: `forget`
    // keeps the claim-FTS row (forget_scope.ts:518-527 — "keeping the rows is
    // what makes REVIVE fully reversible"), so the live process still *finds*
    // the row and reports it as filtered, while a rebuild — which drops
    // non-indexable claims from the lane — never sees it at all.
    expect(inProcess.total_found).toBe(1);
    expect(inProcess.filtered_out).toBe(1);
    expect(fresh.total_found).toBe(0);
    expect(fresh.filtered_out).toBe(0);
  });
});

describe('2. FORGET then a later write then REVIVE', () => {
  it('a revived claim is searchable again even after another write closed the lane', async () => {
    const fx = await newFixture();
    const subject = 'Quarry Hill Shipping';
    const entityId = insertEntity(fx, subject);
    const claim = buildClaim({ entityId, subject, predicate: 'probe_state', value: 'pending' });
    fx.store.insertClaim(claim);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);
    expect((await sig(fx.core, subject)).ids).toEqual([claim.id]);

    await fx.core.forget({
      actor: OWNER, target: { type: 'claim', id: claim.id }, mode: 'tombstone',
      reason: 'survey', operation_id: `op_${ulid()}`,
    });
    expect((await sig(fx.core, subject)).ids).toEqual([]);

    // The scope is written again (any re-syncing verb does this): the lane is
    // replaced by the store's indexable set, which no longer contains the
    // forgotten claim — so the row FORGET deliberately kept is now gone.
    await interveningWrite(fx, 'Basalt Ridge Survey');
    expect((await sig(fx.core, subject)).ids).toEqual([]);

    const revived = await fx.core.revive({
      actor: OWNER, tombstone_id: tombstoneOf(claim.id),
      reason: 'the fact stands after all', operation_id: `op_${ulid()}`,
    });
    expect(revived.claim_id).toBe(claim.id);

    const inProcess = await sig(fx.core, subject);
    const fresh = await freshSig(fx.dataDir, subject);
    record('forget-write-revive', { subject, inProcess, fresh });

    // The durable surface serves it — the canonical record is active again.
    expect(fresh.ids).toEqual([claim.id]);
    // RED before the fix: the live process answered nothing at all, because
    // REVIVE re-synced no lane and the row was dropped by the write.
    expect(inProcess.ids).toEqual(fresh.ids);
  });
});

describe('3. RETENTION (expireRetention)', () => {
  it('the sweep alone: served recall and the raw observation window are rebuild-equivalent', async () => {
    const fx = await newFixture(true);
    const subject = 'Retention Probe Co';
    const obs = await fx.core.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'Retention Probe Co retired' },
      scope: SCOPE, observed_at: T1,
    });
    const entityId = insertEntity(fx, subject);
    const claim = buildClaim({
      entityId, subject, predicate: 'probe_state', value: 'retired', evidence: [obs.id],
    });
    fx.store.insertClaim(claim);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);
    expect((await sig(fx.core, subject)).ids).toEqual([claim.id]);

    const sweep = await fx.core.expireRetention({ actor: OWNER, scope: SCOPE, as_of: AS_OF });
    expect(sweep.observations_expired).toBe(1);
    expect(sweep.claims_retracted).toBe(1);

    const inProcess = await sig(fx.core, subject);
    const fresh = await freshSig(fx.dataDir, subject);
    record('retention-alone', { subject, inProcess, fresh });

    // Served rows agree (the retracted claim is filtered by the snapshot in
    // both processes), and the counters differ exactly as in measurement 1 —
    // this sweep keeps its rows too (retention.ts:217-218).
    expect(inProcess.ids).toEqual([]);
    expect(fresh.ids).toEqual([]);
    expect(inProcess.total_found).toBe(fresh.total_found + 1);

    // The raw window is fine WITHOUT a re-sync, and for a different reason:
    // `searchObservations` re-checks Layer 0's effective status per hit
    // (core.ts:1069-1088), so the tombstoned observation is dropped live even
    // though its index row still says `accepted`.
    const freshCore = await SmartwareCore.open({ dataDir: fx.dataDir, ownerId: OWNER.id });
    try {
      expect(rawWindow(fx.core, 'Retention Probe')).toEqual([]);
      expect(rawWindow(freshCore, 'Retention Probe')).toEqual([]);
      record('retention-raw-window', {
        inProcess: rawWindow(fx.core, 'Retention Probe'),
        fresh: rawWindow(freshCore, 'Retention Probe'),
      });
    } finally {
      freshCore.close();
    }
  });

  it('expiry then a later write then REVIVE: the re-admitted claim stays out of every view (evidence lifecycle), and the views agree', async () => {
    const fx = await newFixture(true);
    const subject = 'Tungsten Basin Freight';
    const obs = await fx.core.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'Tungsten Basin Freight contract closed' },
      scope: SCOPE, observed_at: T1,
    });
    const entityId = insertEntity(fx, subject);
    const claim = buildClaim({
      entityId, subject, predicate: 'probe_state', value: 'retired', evidence: [obs.id],
    });
    fx.store.insertClaim(claim);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);

    const sweep = await fx.core.expireRetention({ actor: OWNER, scope: SCOPE, as_of: AS_OF });
    expect(sweep.claims_retracted).toBe(1);
    await interveningWrite(fx, 'Cobalt Ridge Survey');

    const revived = await fx.core.revive({
      actor: OWNER, tombstone_id: tombstoneOf(claim.id),
      reason: 'the note was wrong about the retention window', operation_id: `op_${ulid()}`,
    });
    expect(revived.claim_id).toBe(claim.id);

    const inProcess = await sig(fx.core, subject);
    const fresh = await freshSig(fx.dataDir, subject);
    record('retention-write-revive', {
      subject, inProcess, fresh, rowStatus: fx.store.getClaim(claim.id)?.status ?? null,
    });

    // The two views agree — the invariant holds — but neither serves the
    // re-admitted claim, and neither does a second process (probe leg 3,
    // evidence/logs/*-probe.log): the canonical record is active again and the
    // derived row says so, yet `isEffectiveCurrent` keeps the claim out of the
    // authorized snapshot because its ONLY source observation is still
    // tombstoned (effective_current.ts:36-55 — "Layer 0 tombstones are
    // canonical lifecycle events and must constrain every read interface").
    // So REVIVE does not restore retrievability for a retention retraction; it
    // restores the record. That is an evidence-lifecycle consequence, not a
    // stale FTS row: it is equally true after a restart.
    expect(fx.store.getClaim(claim.id)?.status).toBe('active');
    expect(inProcess.ids).toEqual([]);
    expect(fresh.ids).toEqual([]);
    expect(inProcess.ids).toEqual(fresh.ids);
  });
});

describe('4. ENDORSE', () => {
  it('endorsing a page keeps the claim-FTS lane equal to a fresh open', async () => {
    const fx = await newFixture();
    const subject = 'Endorse Probe Co';
    const entityId = insertEntity(fx, subject);
    const claim = buildClaim({ entityId, subject, predicate: 'probe_state', value: 'endorsed-candidate' });
    fx.store.insertClaim(claim);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);
    expect((await sig(fx.core, subject)).ids).toEqual([claim.id]);

    const pageId = `page_${ulid()}`;
    const pagePath = path.join(fx.dataDir, 'wiki', 'entities', `${pageId}.md`);
    const frontmatter: Frontmatter = {
      entity_id: entityId,
      entity: subject,
      type: 'concept',
      scope: SCOPE,
      epistemic: 'observed',
      sensitive: false,
      sources: [],
      claim_ids: [claim.id],
      sources_claim_ids: [claim.id],
      compiled_at: T1,
      compiled_by: 'smartware',
      confidence: 0.5,
      supersedes: [],
      related: [],
    };
    fs.writeFileSync(pagePath, serialiseFrontmatter(frontmatter, `# ${subject}\n\nBody.\n`), 'utf8');

    const endorsed = await fx.core.endorse({
      actor: OWNER, page_id: pageId, page_path: pagePath, dry_run: false,
      reason: 'survey', operation_id: `op_${ulid()}`,
    });
    expect(endorsed.status).toBe('endorsed');

    const inProcess = await sig(fx.core, subject);
    const fresh = await freshSig(fx.dataDir, subject);
    record('endorse', { subject, inProcess, fresh });

    // Endorsement adopts author/epistemic_owner and appends an ACTIVE version:
    // the indexable set is unchanged, and the claim-FTS content is built from
    // subject/predicate/object (syncSearchFromClaims), so nothing moves.
    expect(inProcess).toEqual(fresh);
    expect(inProcess.ids).toEqual([claim.id]);
  });
});

describe('5. QUARANTINE_REVIEW (approve)', () => {
  it('approving a quarantined observation moves no claim row', async () => {
    const fx = await newFixture();
    const subject = 'Quarantine Probe Co';
    const entityId = insertEntity(fx, subject);
    const claim = buildClaim({ entityId, subject, predicate: 'probe_state', value: 'unaffected' });
    fx.store.insertClaim(claim);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);

    const cfg = fx.core.getConfig();
    cfg.grants = [{
      id: `grant_${ulid()}`,
      actor_id: UNTRUSTED.id,
      actor_type: 'agent',
      capabilities: {
        observe: [SCOPE], query: [SCOPE], read: [SCOPE], compile: [], correct: [], forget: [],
      },
      trusted: false,
      quarantine: true,
      granted_at: T1,
      created_at: T1,
      granted_by: 'user:owner',
      status: 'active',
    }];
    saveConfig(fx.dataDir, cfg);

    const obs = await fx.core.observe({
      actor: UNTRUSTED, type: 'message', content: { format: 'text/plain', body: 'Quarantine Probe Co note' },
      scope: SCOPE, observed_at: T1,
    });
    expect(obs.status).toBe('quarantined');

    const before = fx.store.getAllClaims().map(row => `${row.id}:${row.status}`).sort();
    const review = await fx.core.quarantineReview({
      actor: OWNER, target_obs_id: obs.id, action: 'approve', reason: 'survey',
    });
    expect(review.new_status).toBe('accepted');

    const after = fx.store.getAllClaims().map(row => `${row.id}:${row.status}`).sort();
    const inProcess = await sig(fx.core, subject);
    const fresh = await freshSig(fx.dataDir, subject);
    record('quarantine-approve', { subject, claimsBefore: before, claimsAfter: after, inProcess, fresh });

    // The lead's question: can any claim status move here? Measured — no. The
    // review is observation-level (quarantine_review.ts), and replay skips the
    // parent (its sequence predates the replay watermark), so no claim row is
    // touched and the lane needs no re-sync.
    expect(after).toEqual(before);
    expect(inProcess.ids).toEqual([claim.id]);
    expect(inProcess).toEqual(fresh);
  });
});
