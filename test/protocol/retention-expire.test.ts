// Retention expiry sweep (ADR-0001) — tombstone + claim retraction + idempotency.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig, type SmartwareConfig } from '../../src/config.js';
import { parseDurationDays, isRetentionExpired } from '../../src/protocol/retention.js';
import { appendOpLogEntry, readAllOpLogEntries } from '../../src/ops_log/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { resolveFactMatches } from '../../src/layer1/corroboration.js';
import { readLatestVersion } from '../../src/layer1/jsonl.js';
import { makeClaim } from '../helpers.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const ACME = 'client:acme#1';
const OTHER = 'client:other#2';

function scaffold(dataDir: string, config: SmartwareConfig): void {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  saveConfig(dataDir, config);
}

function makeConfig(dataDir: string, retention?: SmartwareConfig['retention']): SmartwareConfig {
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = 'user:owner';
  cfg.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    { id: ACME, parent: 'workspace', visibility_default: 'scope' },
    { id: OTHER, parent: 'workspace', visibility_default: 'scope' },
  ];
  if (retention) cfg.retention = retention;
  return cfg;
}

const retention1d: SmartwareConfig['retention'] = {
  default: { policy: 'forever', duration_days: null },
  scope_overrides: { [ACME]: { policy: 'duration', duration_days: 1 } },
};

/** Both client scopes on 1-day retention — the two-scope fixture the reuse probes need. */
const retention1dBoth: SmartwareConfig['retention'] = {
  default: { policy: 'forever', duration_days: null },
  scope_overrides: {
    [ACME]: { policy: 'duration', duration_days: 1 },
    [OTHER]: { policy: 'duration', duration_days: 1 },
  },
};

describe('parseDurationDays', () => {
  it('parses PnD, rejects malformed', () => {
    expect(parseDurationDays('P90D')).toBe(90);
    expect(parseDurationDays('P1D')).toBe(1);
    expect(parseDurationDays('P0D')).toBeNull();
    expect(parseDurationDays('PT1H')).toBeNull();
    expect(parseDurationDays(null)).toBeNull();
    expect(parseDurationDays('')).toBeNull();
  });
});

describe('isRetentionExpired', () => {
  const obs = (observedAt: string, dur: string | null) => ({
    policy: { retention: 'duration' as const, retention_duration: dur },
    source: { observed_at: observedAt },
  }) as never;
  it('true when elapsed, false when not', () => {
    const asOf = new Date('2026-09-10T00:00:00Z');
    expect(isRetentionExpired(obs('2026-09-01T00:00:00Z', 'P7D'), asOf)).toBe(true);
    expect(isRetentionExpired(obs('2026-09-05T00:00:00Z', 'P7D'), asOf)).toBe(false);
  });
});

describe('expireRetention sweep', () => {
  let core: SmartwareCore | null = null;
  let dataDir = '';

  afterEach(() => {
    core?.close();
    core = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function open(): Promise<SmartwareCore> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-expire-'));
    scaffold(dataDir, makeConfig(dataDir, retention1d));
    core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
    return core;
  }

  it('tombstones elapsed observations and leaves future ones accepted', async () => {
    const c = await open();
    const past = await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'old Acme note' },
      scope: ACME, observed_at: '2026-08-01T00:00:00.000Z',
    });
    const fresh = await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'fresh Acme note' },
      scope: ACME, observed_at: '2026-09-10T00:00:00.000Z',
    });

    const result = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: '2026-09-10T00:00:00.000Z' });
    expect(result.observations_expired).toBe(1);

    expect(c.readObservationEvidence({ actor: OWNER, observation_id: past.id })?.status).toBe('tombstoned');
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: fresh.id })?.status).toBe('accepted');

    // Raw search window excludes the tombstoned record.
    const hits = c.searchObservations('Acme', ACME, {});
    expect(hits.map(h => h.id)).not.toContain(past.id);
  });

  it('is idempotent — a second run finds nothing new', async () => {
    const c = await open();
    await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'old note' },
      scope: ACME, observed_at: '2026-08-01T00:00:00.000Z',
    });
    const first = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: '2026-09-10T00:00:00.000Z' });
    const second = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: '2026-09-10T00:00:00.000Z' });
    expect(first.observations_expired).toBe(1);
    expect(second.observations_expired).toBe(0);
  });

  it('retracts claims whose sole evidence is the expired observation', async () => {
    const c = await open();
    const obsId = (await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'Acme prefers email' },
      scope: ACME, observed_at: '2026-08-01T00:00:00.000Z',
    })).id;

    // Deterministic claim insert (the Coffee persistence path, no LLM).
    const dbPath = path.join(dataDir, 'smartware.db');
    const store = new ClaimStore(dbPath);
    store.setDataDir(dataDir);
    const searchIndex = new SearchIndex(dbPath);
    const subjectId = `entity_${ulid()}`;
    store.insertEntity({ id: subjectId, canonical_name: 'Acme', aliases: [], type: 'organization', scope: ACME, created_at: new Date().toISOString() });
    store.insertClaim(makeClaim({
      subject_id: subjectId, subject_name: 'Acme', scope: ACME,
      predicate: 'prefers_contact', object: { type: 'text', value: 'email' },
      confidence: 0.8, supporting_evidence: [obsId], status: 'active', epistemic: 'observed',
      extraction: { method: 'deterministic', model: null, compiler_version: '0.6.3', prompt_hash: null, extracted_at: new Date().toISOString() },
    }));
    syncSearchFromClaims(store, searchIndex, ACME);

    const before = await c.query({ actor: OWNER, query: 'prefers email', scope: ACME });
    expect(before.results.length).toBeGreaterThan(0);

    const result = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: '2026-09-10T00:00:00.000Z' });
    expect(result.claims_retracted).toBe(1);

    const after = await c.query({ actor: OWNER, query: 'prefers email', scope: ACME });
    expect(after.results.length).toBe(0);

    store.close();
    searchIndex.close();
  });

  it('carries a mechanical demotion onto the expired claim\'s forgotten version', async () => {
    const c = await open();
    const obsId = (await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'Acme prefers email' },
      scope: ACME, observed_at: '2026-08-01T00:00:00.000Z',
    })).id;

    const dbPath = path.join(dataDir, 'smartware.db');
    const store = new ClaimStore(dbPath);
    store.setDataDir(dataDir);
    const searchIndex = new SearchIndex(dbPath);
    const subjectId = `entity_${ulid()}`;
    store.insertEntity({ id: subjectId, canonical_name: 'Acme', aliases: [], type: 'organization', scope: ACME, created_at: new Date().toISOString() });
    const fact = {
      subject_id: subjectId, subject_name: 'Acme', scope: ACME,
      predicate: 'prefers_contact', object: { type: 'text' as const, value: 'email' },
      confidence: 0.8, supporting_evidence: [obsId], status: 'active' as const,
      epistemic: 'observed' as const,
      extraction: { method: 'deterministic' as const, model: null, compiler_version: '0.6.3', prompt_hash: null, extracted_at: new Date().toISOString() },
    };
    const survivor = makeClaim({ ...fact });
    // §1e picks the lexicographically smallest claim id as the survivor, so this id is the loser by
    // construction — deterministic, no ULID-ordering race.
    const loser = makeClaim({ ...fact, id: `claim_${'Z'.repeat(26)}` });
    store.insertClaim(survivor);
    store.insertClaim(loser);
    const resolution = resolveFactMatches({
      store,
      matches: store.findActiveFactMatches(subjectId, {
        predicate: 'prefers_contact', scope: ACME, object: { type: 'text', value: 'email' },
      }),
    });
    expect(resolution.superseded_claims).toEqual([loser.id]);

    const result = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: '2026-09-10T00:00:00.000Z' });
    expect(result.claims_retracted).toBe(2);

    // ADR-0003: the demotion is non-content metadata, so the expiry tombstone carries it — the
    // sweep must not read as an event that lifts a duplicate back into the recall-eligible set.
    const forgotten = readLatestVersion(dataDir, loser.id);
    expect(forgotten?.state).toBe('forgotten');
    expect(forgotten?.superseded_by).toBe(survivor.id);

    store.close();
    searchIndex.close();
  });

  it('refuses without a forget grant on the scope', async () => {
    const c = await open();
    await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'old note' },
      scope: ACME, observed_at: '2026-08-01T00:00:00.000Z',
    });
    await expect(
      c.expireRetention({ actor: { type: 'person', id: 'user:stranger', display_name: 'S' }, scope: ACME, as_of: '2026-09-10T00:00:00.000Z' }),
    ).rejects.toThrow();
  });

  it('survives reopen (tombstone replays from JSONL, rebuild-equivalence)', async () => {
    const c = await open();
    const past = await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'old Acme note' },
      scope: ACME, observed_at: '2026-08-01T00:00:00.000Z',
    });
    await c.expireRetention({ actor: OWNER, scope: ACME, as_of: '2026-09-10T00:00:00.000Z' });

    core?.close();
    core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });

    expect(core.readObservationEvidence({ actor: OWNER, observation_id: past.id })?.status).toBe('tombstoned');
  });
});

// --------------------------------------------------------------------------------------------
// OperationId payload identity.
//
// Specification v1.6.16 §Integrity invariants: "OperationId idempotency is strict. Same ID + same
// payload → prior result. Same ID + different payload → `conflict`." Protocol v0.5.0, *Idempotency
// and commit identity*: "Same OperationId plus a different payload returns `conflict`."
//
// Reviewer finding on t_b739c9ec, carded t_06db00ce and measured on `1673d9f`: the sweep's replay
// short-circuit was keyed on the `operation_id` alone, so reusing one id for a second scope returned
// the FIRST sweep's counts under the requested scope's name, echoed a `scope` the recorded entry
// never mentioned, left the second scope unswept, and appended nothing — an integrator could not
// tell from the result that nothing ran.
// --------------------------------------------------------------------------------------------
describe('expireRetention OperationId payload identity', () => {
  const AS_OF = '2026-09-10T00:00:00.000Z';
  const LATER_AS_OF = '2026-09-11T00:00:00.000Z';
  const OLD = '2026-08-01T00:00:00.000Z';
  const OP_1 = 'op_01J8ZQK7V5P8M2N4R6T9W3XYBD';
  const OP_2 = 'op_01J8ZQK7V5P8M2N4R6T9W3XYBE';

  let core: SmartwareCore | null = null;
  let dataDir = '';

  afterEach(() => {
    core?.close();
    core = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Pod with both client scopes on 1-day retention (the two-scope shape the reuse probes need). */
  async function openBothScopes(): Promise<SmartwareCore> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-retention-identity-'));
    scaffold(dataDir, makeConfig(dataDir, retention1dBoth));
    core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
    return core;
  }

  /** The claim-insert path Coffee uses (deterministic, no LLM): one active claim, sole evidence `obsId`. */
  function insertSoleEvidenceClaim(scope: string, obsId: string, text: string): string {
    const dbPath = path.join(dataDir, 'smartware.db');
    const store = new ClaimStore(dbPath);
    store.setDataDir(dataDir);
    const searchIndex = new SearchIndex(dbPath);
    const subjectId = `entity_${ulid()}`;
    store.insertEntity({
      id: subjectId, canonical_name: 'Acme', aliases: [], type: 'organization',
      scope, created_at: new Date().toISOString(),
    });
    const claim = makeClaim({
      subject_id: subjectId, subject_name: 'Acme', scope,
      predicate: 'prefers_contact', object: { type: 'text', value: text },
      confidence: 0.8, supporting_evidence: [obsId], status: 'active', epistemic: 'observed',
      extraction: { method: 'deterministic', model: null, compiler_version: '0.6.3', prompt_hash: null, extracted_at: new Date().toISOString() },
    });
    store.insertClaim(claim);
    syncSearchFromClaims(store, searchIndex, scope);
    store.close();
    searchIndex.close();
    return claim.id;
  }

  /** One elapsed observation in `scope` plus one claim whose sole evidence is that observation. */
  async function seedExpiredClaim(scope: string, text: string): Promise<{ obsId: string; claimId: string }> {
    const obsId = (await core!.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: text },
      scope, observed_at: OLD,
    })).id;
    return { obsId, claimId: insertSoleEvidenceClaim(scope, obsId, text) };
  }

  /** Raw ops-log read (the surface an integrator audits). */
  function opsEntries(): { count: number; details: Record<string, unknown>[] } {
    const entries = [...readAllOpLogEntries(path.join(dataDir, 'operations'))];
    return { count: entries.length, details: entries.map(entry => (entry.details ?? {}) as Record<string, unknown>) };
  }

  it('returns conflict when one id is reused for a different scope — and sweeps nothing', async () => {
    const c = await openBothScopes();
    const acme = await seedExpiredClaim(ACME, 'Acme prefers email');
    const otherA = await seedExpiredClaim(OTHER, 'Other prefers phone');
    const otherB = await seedExpiredClaim(OTHER, 'Other prefers post');

    const first = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: OP_1 });
    expect(first).toMatchObject({ observations_expired: 1, claims_retracted: 1 });
    expect(opsEntries().count).toBe(1);

    // Pre-fix this returned acme's 1/1 under `scope: 'client:other#2'` and left both claims live.
    await expect(
      c.expireRetention({ actor: OWNER, scope: OTHER, as_of: AS_OF, operation_id: OP_1 }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // The requested scope was not swept, and the rejected call appended nothing.
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: otherA.obsId })?.status).toBe('accepted');
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: otherB.obsId })?.status).toBe('accepted');
    expect(readLatestVersion(dataDir, otherA.claimId)?.state).toBe('active');
    expect(readLatestVersion(dataDir, otherB.claimId)?.state).toBe('active');
    expect(opsEntries().count).toBe(1);

    // The recorded sweep is intact, and a retry of the identical payload still replays.
    expect(readLatestVersion(dataDir, acme.claimId)?.state).toBe('forgotten');
    const replay = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: OP_1 });
    expect(replay).toMatchObject({ scope: ACME, observations_expired: 1, claims_retracted: 1 });
    expect(opsEntries().count).toBe(1);
  });

  it('returns conflict when the same id is retried with a corrected as_of', async () => {
    const c = await openBothScopes();
    await seedExpiredClaim(ACME, 'Acme prefers email');
    await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: OP_1 });

    await expect(
      c.expireRetention({ actor: OWNER, scope: ACME, as_of: LATER_AS_OF, operation_id: OP_1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(opsEntries().count).toBe(1);
  });

  it('returns conflict when the retry drops the as_of the recorded call supplied', async () => {
    const c = await openBothScopes();
    await seedExpiredClaim(ACME, 'Acme prefers email');
    await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: OP_1 });

    // A supplied `as_of` is payload; the defaulted instant is not. Supplied ≠ supplied-other ≠ omitted.
    await expect(
      c.expireRetention({ actor: OWNER, scope: ACME, operation_id: OP_1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('replays when neither call supplies as_of (a defaulted instant is not payload)', async () => {
    const c = await openBothScopes();
    await seedExpiredClaim(ACME, 'Acme prefers email');

    const first = await c.expireRetention({ actor: OWNER, scope: ACME, operation_id: OP_2 });
    expect(first).toMatchObject({ observations_expired: 1, claims_retracted: 1 });

    // Each call resolves its own "now"; that resolution must not turn a valid retry into a conflict.
    const second = await c.expireRetention({ actor: OWNER, scope: ACME, operation_id: OP_2 });
    expect(second).toMatchObject({ scope: ACME, observations_expired: 1, claims_retracted: 1 });
    expect(opsEntries().count).toBe(1);
  });

  it('records the payload identity on the ops entry (additive field in free-form details)', async () => {
    const c = await openBothScopes();
    await seedExpiredClaim(ACME, 'Acme prefers email');
    await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: OP_1 });

    const { count, details } = opsEntries();
    expect(count).toBe(1);
    expect(details[0]?.['scope']).toBe(ACME);
    expect(details[0]?.['as_of']).toBe(AS_OF);
    expect(String(details[0]?.['payload_hash'])).toMatch(/^[a-f0-9]{64}$/);
  });

  it('legacy entry (no payload identity recorded): same scope replays, different scope conflicts', async () => {
    const c = await openBothScopes();
    const acme = await seedExpiredClaim(ACME, 'Acme prefers email');
    const other = await seedExpiredClaim(OTHER, 'Other prefers phone');

    // An entry shaped the way builds before this check wrote it: counts + scope + as_of, no identity.
    appendOpLogEntry(path.join(dataDir, 'operations'), {
      operation_id: OP_2,
      actor_id: 'user:owner',
      timestamp: new Date().toISOString(),
      op: 'retention.expire',
      details: { scope: ACME, observations_expired: 7, claims_retracted: 5, as_of: AS_OF },
    });

    // Same scope + same as_of → the recorded counts replay; nothing is swept.
    const replay = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: OP_2 });
    expect(replay).toMatchObject({ observations_expired: 7, claims_retracted: 5 });
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: acme.obsId })?.status).toBe('accepted');
    expect(readLatestVersion(dataDir, acme.claimId)?.state).toBe('active');

    // Same scope, different as_of → conflict.
    await expect(
      c.expireRetention({ actor: OWNER, scope: ACME, as_of: LATER_AS_OF, operation_id: OP_2 }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // Different scope → conflict; the scope is left untouched.
    await expect(
      c.expireRetention({ actor: OWNER, scope: OTHER, as_of: AS_OF, operation_id: OP_2 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: other.obsId })?.status).toBe('accepted');
    expect(readLatestVersion(dataDir, other.claimId)?.state).toBe('active');
    expect(opsEntries().count).toBe(1);
  });

  // ------------------------------------------------------------------------------------------
  // An OperationId is owned globally, not per verb (reviewer finding on t_06db00ce, §7 F1, carded
  // t_598278eb and measured on c39e1cf). The lookup filtered `op === 'retention.expire'` *before* it
  // matched payload identity, so an id a host had already spent on a different op was invisible to
  // the sweep: the sweep ran anyway, tombstoned the elapsed observation, retracted the claim, and
  // appended a second ops entry under the id the host had used for the observe. `observe`, `forget`,
  // `forget.scope` and `reflect` select on the id alone and check `op` as part of the match, so every
  // sibling writer already treats a cross-op reuse as `conflict`. One id identifying two operations in
  // the append-only log is the audit-trail defect class: "did this actually happen" stops being
  // answerable from the log.
  // ------------------------------------------------------------------------------------------

  it('returns conflict when the id was already consumed by a different op — and sweeps nothing', async () => {
    const c = await openBothScopes();
    const acme = await seedExpiredClaim(ACME, 'Acme prefers email');

    // The ordinary way an id gets spent: one accepted observation committed under OP_2.
    await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'Acme called' },
      scope: ACME, observed_at: OLD, operation_id: OP_2,
    });
    expect(opsEntries().count).toBe(1);

    // Pre-fix this returned { observations_expired: 1, claims_retracted: 1 } for the same id and the
    // ops log ended up with TWO operations under OP_2.
    await expect(
      c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: OP_2 }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // The requested scope is left exactly as found: no tombstone, no retraction, no second ops entry.
    expect(c.readObservationEvidence({ actor: OWNER, observation_id: acme.obsId })?.status).toBe('accepted');
    expect(readLatestVersion(dataDir, acme.claimId)?.state).toBe('active');
    const { count, details } = opsEntries();
    expect(count).toBe(1);
    expect(details[0]?.['observations_expired']).toBeUndefined();
  });

  it('a non-sweep entry under this id conflicts even when its details satisfy the legacy fallback', async () => {
    const c = await openBothScopes();
    const acme = await seedExpiredClaim(ACME, 'Acme prefers email');

    // Legacy shape: no `payload_hash`, written by a DIFFERENT op, carrying the same `scope` and
    // `as_of` the sweep call supplies. The scope/as_of fallback exists for pre-identity *sweep*
    // entries only, so it must not be reachable for another verb's entry under the same id.
    appendOpLogEntry(path.join(dataDir, 'operations'), {
      operation_id: OP_1,
      actor_id: 'user:owner',
      timestamp: new Date().toISOString(),
      op: 'observe',
      details: { scope: ACME, as_of: AS_OF },
    });

    await expect(
      c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: OP_1 }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(c.readObservationEvidence({ actor: OWNER, observation_id: acme.obsId })?.status).toBe('accepted');
    expect(readLatestVersion(dataDir, acme.claimId)?.state).toBe('active');
    expect(opsEntries().count).toBe(1);
  });

  it('the reverse direction stays guarded: a swept id cannot then be spent on an observe', async () => {
    const c = await openBothScopes();
    await seedExpiredClaim(ACME, 'Acme prefers email');
    const swept = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: OP_1 });
    expect(swept).toMatchObject({ observations_expired: 1, claims_retracted: 1 });

    // Control: this half of the invariant was already true before the sweep's lookup was aligned
    // with it (`observe` filters on the id alone), so a fix that only touched the sweep must not
    // regress it.
    await expect(
      c.observe({
        actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'late note' },
        scope: ACME, observed_at: OLD, operation_id: OP_1,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(opsEntries().count).toBe(1);
  });
});
