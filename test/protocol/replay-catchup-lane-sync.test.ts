// A mid-session `replayCatchUp` materialises claim rows and touches no lane —
// kanban t_a6bf30a8 (the class surveyed by t_12c79071).
//
// `replayCatchUp` runs INSIDE five call sites: FORGET (`forget.ts`, an
// unconditional catch-up), retention expiry (`retention.ts`, when something
// expired), quarantine review (`quarantine_review.ts`), CORRECT
// (`_correct_legacy.ts`) and the compile pipeline (`compiler.ts`, stage 3). It
// writes store rows for events this process has not replayed yet — a
// legacy/host-written `claim_extracted` (OBSERVE itself rejects
// pre-extracted claims, `observe.ts`; this is the retained replay path for
// logs another writer produced), a `correction` from another writer, another
// writer's tombstone — and touches no search lane: the claim-FTS lane is rebuilt
// only by `syncSearchFromClaims`.
//
// The invariant is the survey's:
//
//     after any claim-row mutation, in-process recall == what a fresh open of
//     the same brain serves
//
// Every `it` here appends the foreign event straight to the canonical log (the
// shape a second process / host writer leaves behind) and then drives ONE
// trigger. The foreign fact is NEW — no fact match, no supersession — and is
// self-evidenced, so no flow's retraction or demotion logic can touch it: the
// only variable is whether the catch-up that ran inside the trigger re-synced
// the lane for the scope it materialised the claim in.
//
// RED at the pre-fix revision: in-process recall serves NOTHING for the
// materialised claim while a fresh open serves it (measured with
// `scripts/kept-rows-settle-probe.mjs --arm 4`, which measures the same five
// triggers out of tree).
//
// Run with `PROBE_OUT=<path>` to get the raw signatures as JSON lines (vitest
// prints console.log only for failing runs, so the report goes to a file).

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig, type SmartwareConfig, type ScopeEntry } from '../../src/config.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import { SearchIndex } from '../../src/layer3/search.js';
import { appendObservation } from '../../src/layer0/log.js';
import { assignIntegrity } from '../../src/layer0/integrity.js';
import { Layer0Index } from '../../src/layer0/index.js';
import type { Observation, PreExtractedClaim } from '../../src/layer0/types.js';
import { makeClaim } from '../helpers.js';
import { SMARTWARE_VERSION } from '../../src/version.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const UNTRUSTED = { type: 'agent' as const, id: 'untrusted_agent', display_name: 'Untrusted Agent' };
const SCOPE = 'client:acme#1';
const SCOPE_B = 'client:acme#2';
const T1 = '2026-08-01T00:00:00.000Z';
const AS_OF = '2026-09-10T00:00:00.000Z';

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

function scaffold(dataDir: string, opts: { retention?: boolean; untrustedObserve?: boolean; extraScopes?: string[] } = {}): SmartwareConfig {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/entities', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = OWNER.id;
  cfg.llm = { provider: 'none', model: '' };
  cfg.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' as const },
    { id: 'workspace', parent: null, visibility_default: 'workspace' as const },
    { id: SCOPE, parent: 'workspace', visibility_default: 'scope' as const },
    ...(opts.extraScopes ?? []).map((id): ScopeEntry => ({ id, parent: 'workspace', visibility_default: 'scope' })),
  ];
  cfg.grants = opts.untrustedObserve ? [{
    id: `grant_${ulid()}`,
    actor_id: UNTRUSTED.id,
    actor_type: 'agent' as const,
    capabilities: { observe: [SCOPE, ...(opts.extraScopes ?? [])], query: [], compile: [], correct: [], forget: [], read: [] },
    trusted: false,
    quarantine: true,
    created_at: T1,
    expires_at: null,
    status: 'active' as const,
  }] : [];
  if (opts.retention) {
    cfg.retention = {
      default: { policy: 'forever', duration_days: null },
      scope_overrides: { [SCOPE]: { policy: 'duration', duration_days: 1 } },
    };
  }
  saveConfig(dataDir, cfg);
  return cfg;
}

async function newFixture(opts: Parameters<typeof scaffold>[1] = {}): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-catchup-sync-'));
  scaffold(dataDir, opts);
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

/**
 * Append one `claim_extracted` observation to the canonical evidence log, the
 * way a host that owns extraction (or a second process) persisted claims.
 * `parent_ids` is left empty so the materialised claim is self-evidenced: no
 * other flow's retraction logic can reach it, which is what keeps this test
 * measuring the catch-up's lane effect and nothing else.
 */
function appendForeignClaimObs(
  fx: Fixture,
  fields: { subjectName: string; predicate: string; value: string; scope: string },
): { observation_id: string; entity_id: string } {
  const evidenceDir = path.join(fx.dataDir, 'evidence');
  const dbPath = path.join(fx.dataDir, 'smartware.db');
  const config = createDefaultConfig(fx.dataDir);
  const layer0 = new Layer0Index(dbPath);
  layer0.catchUp(evidenceDir);
  const seq = layer0.getLastSequence() + 1;
  const prevHash = layer0.getLatestHashForWriter(config.writer_id);

  const entityId = `entity_${ulid()}`;
  fx.store.insertEntity({
    id: entityId, canonical_name: fields.subjectName, aliases: [], type: 'concept', scope: fields.scope, created_at: T1,
  });

  const observationId = `obs_${ulid().toLowerCase()}`;
  const claimInput: PreExtractedClaim = {
    subject_id: entityId,
    subject_name: fields.subjectName,
    subject_type: 'concept',
    predicate: fields.predicate,
    object: { type: 'enum', value: fields.value },
    scope: fields.scope,
    validity: { from: T1, to: null },
    t_valid_from: knownTime(T1),
    t_valid_to: nullTime(),
    epistemic: 'observed',
    confidence: 0.8,
    sensitive: false,
    extraction: { method: 'deterministic', model: null, compiler_version: SMARTWARE_VERSION, prompt_hash: null },
  };
  const observation: Omit<Observation, 'integrity'> = {
    id: observationId,
    version: SMARTWARE_VERSION,
    type: 'claim_extracted',
    status: 'accepted',
    source: {
      app: 'catchup-sync-test',
      app_version: SMARTWARE_VERSION,
      source_id: null,
      actor: OWNER,
      captured_at: new Date().toISOString(),
      observed_at: T1,
    },
    scope: fields.scope,
    visibility: 'scope',
    content: { format: 'application/json', body: { claims: [claimInput], source_obs_observed_at: T1 } },
    claims: [claimInput],
    provenance: { parent_ids: [], informed_by: [], supersedes: [], context: '' },
    idempotency: null,
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
  };
  const withIntegrity = assignIntegrity(observation, config.writer_id, seq, prevHash);
  appendObservation(evidenceDir, withIntegrity);
  layer0.insertOrSkip(withIntegrity);
  layer0.close();

  return { observation_id: observationId, entity_id: entityId };
}

/** What recall serves for one query, sorted. */
async function served(core: SmartwareCore, query: string, scope: string): Promise<string[]> {
  const result = await core.recall({ actor: OWNER, query, scope });
  return result.results.flatMap(entry => (entry.claim ? [entry.claim.id] : [])).sort();
}

/**
 * The measurement: the catch-up materialised exactly one claim row for the
 * subject, that claim is served in-process, and the in-process view equals what
 * a fresh open of the same brain serves. The fresh open runs LAST — it replaces
 * the shared claim lane.
 */
async function expectCatchUpClaimServed(fx: Fixture, subject: string, scope: string): Promise<void> {
  const rows = fx.store.getAllClaims(scope).filter(claim => claim.subject_name === subject);
  expect(rows, 'the catch-up must have materialised the foreign claim row').toHaveLength(1);
  const claimId = rows[0]!.id;
  expect(rows[0]!.status).toBe('active');

  const inProcess = await served(fx.core, subject, scope);
  const freshCore = await SmartwareCore.open({ dataDir: fx.dataDir, ownerId: OWNER.id });
  let fresh: string[] = [];
  try {
    fresh = await served(freshCore, subject, scope);
  } finally {
    freshCore.close();
  }
  record('catchup', { subject, scope, claim_id: claimId, in_process: inProcess, fresh });
  expect(inProcess).toEqual([claimId]);
  expect(inProcess).toEqual(fresh);
}

describe('a mid-session replayCatchUp re-syncs the claim-FTS lane it moved', () => {
  it('FORGET: the catch-up admits a claim from a foreign event and the live lane serves it', async () => {
    const fx = await newFixture();
    const carrier = await fx.core.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'carrier note' },
      scope: SCOPE, observed_at: T1,
    });
    const subject = 'Catchup Foreign Forgot Carrier';
    appendForeignClaimObs(fx, { subjectName: subject, predicate: 'probe_state', value: 'admitted', scope: SCOPE });

    await fx.core.forget({
      actor: OWNER, target: { type: 'observation', id: carrier.id }, mode: 'tombstone',
      reason: 'catch-up carrier', operation_id: `op_${ulid()}`,
    });

    await expectCatchUpClaimServed(fx, subject, SCOPE);
  });

  it('retention expiry: the sweep\u2019s catch-up admits a claim from a foreign event and the live lane serves it', async () => {
    const fx = await newFixture({ retention: true });
    const carrier = await fx.core.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'expiring note' },
      scope: SCOPE, observed_at: T1,
    });
    expect(carrier.status).toBe('accepted');
    const subject = 'Catchup Foreign Retention Carrier';
    appendForeignClaimObs(fx, { subjectName: subject, predicate: 'probe_state', value: 'admitted', scope: SCOPE });

    const sweep = await fx.core.expireRetention({ actor: OWNER, scope: SCOPE, as_of: AS_OF });
    expect(sweep.observations_expired).toBeGreaterThan(0);

    await expectCatchUpClaimServed(fx, subject, SCOPE);
  });

  it('quarantine review: the approval\u2019s catch-up admits a claim from a foreign event and the live lane serves it', async () => {
    const fx = await newFixture({ untrustedObserve: true });
    const quarantined = await fx.core.observe({
      actor: UNTRUSTED, type: 'message', content: { format: 'text/plain', body: 'untrusted note' },
      scope: SCOPE, observed_at: T1,
    });
    expect(quarantined.status).toBe('quarantined');
    const subject = 'Catchup Foreign Quarantine Carrier';
    appendForeignClaimObs(fx, { subjectName: subject, predicate: 'probe_state', value: 'admitted', scope: SCOPE });

    await fx.core.quarantineReview({ actor: OWNER, target_obs_id: quarantined.id, action: 'approve' });

    await expectCatchUpClaimServed(fx, subject, SCOPE);
  });

  it('COMPILE re-syncs a scope the catch-up touched outside its own target scope', async () => {
    const fx = await newFixture({ extraScopes: [SCOPE_B] });
    const carrier = await fx.core.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'compile-side note' },
      scope: SCOPE, observed_at: T1,
    });
    expect(carrier.status).toBe('accepted');
    const subject = 'Catchup Foreign Compile Carrier';
    // The foreign event asserts into SCOPE_B while the compile targets SCOPE:
    // the catch-up replays the whole log tail, stage 4.5 re-syncs SCOPE only.
    appendForeignClaimObs(fx, { subjectName: subject, predicate: 'probe_state', value: 'admitted', scope: SCOPE_B });

    await fx.core.compile({ actor: OWNER, scope: SCOPE, use_llm: false });

    await expectCatchUpClaimServed(fx, subject, SCOPE_B);
  });

  it('CORRECT re-syncs a scope the catch-up touched outside the corrected claim\u2019s scope', async () => {
    const fx = await newFixture({ extraScopes: [SCOPE_B] });
    // The claim being corrected lives in SCOPE; the foreign event asserts into
    // SCOPE_B, which the core wrapper's own re-sync (corrected scope only) misses.
    const entityId = `entity_${ulid()}`;
    fx.store.insertEntity({
      id: entityId, canonical_name: 'Correct Carrier', aliases: [], type: 'concept', scope: SCOPE, created_at: T1,
    });
    const target = makeClaim({
      id: `claim_${ulid()}`, subject_id: entityId, subject_name: 'Correct Carrier',
      predicate: 'probe_state', object: { type: 'text', value: 'before' }, scope: SCOPE,
      validity: { from: T1, to: null },
      t_valid_from: knownTime(T1), t_valid_to: nullTime(), t_ingested: knownTime(T1),
    });
    fx.store.insertClaim(target);
    const subject = 'Catchup Foreign Correct Carrier';
    appendForeignClaimObs(fx, { subjectName: subject, predicate: 'probe_state', value: 'admitted', scope: SCOPE_B });

    await fx.core.correct({
      actor: OWNER, target_claim_id: target.id,
      corrected_object: { type: 'text', value: 'after' }, reason: 'changed',
    });

    await expectCatchUpClaimServed(fx, subject, SCOPE_B);
  });
});
