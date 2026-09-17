// Retention expiry sweep (ADR-0001) — tombstone + claim retraction + idempotency.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig, type SmartwareConfig } from '../../src/config.js';
import { parseDurationDays, isRetentionExpired } from '../../src/protocol/retention.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { resolveFactMatches } from '../../src/layer1/corroboration.js';
import { readLatestVersion } from '../../src/layer1/jsonl.js';
import { makeClaim } from '../helpers.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const ACME = 'client:acme#1';

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
  ];
  if (retention) cfg.retention = retention;
  return cfg;
}

const retention1d: SmartwareConfig['retention'] = {
  default: { policy: 'forever', duration_days: null },
  scope_overrides: { [ACME]: { policy: 'duration', duration_days: 1 } },
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
    const hits = c.searchObservations({ actor: OWNER, query: 'Acme', scope: ACME });
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
