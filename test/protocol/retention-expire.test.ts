// Retention expiry sweep (ADR-0001) — tombstone + claim retraction + idempotency.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig, type SmartwareConfig } from '../../src/config.js';
import { parseDurationDays, isRetentionExpired } from '../../src/protocol/retention.js';
import { readAll } from '../../src/layer0/log.js';
import { readLatestVersion } from '../../src/layer1/jsonl.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { OPERATION_ID_PATTERN, readAllOpLogEntries } from '../../src/ops_log/index.js';
import { runRecovery } from '../../src/ops_log/recovery.js';
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

// ADR-0013: the sweep always commits under an OperationId — the caller's when one
// is supplied, otherwise one the substrate mints for the invocation — and always
// writes exactly one `retention.expire` entry carrying it with the exact counts.
// Before ADR-0013 a sweep with no `operation_id` wrote NO entry while still
// stamping an OperationId on every forgotten version (required by
// `schemas/v0.5.0/claim.schema.json`), which put the sweep's own canonical writes
// into the orphan/manual-review class of `ops_log/recovery.ts`.
describe('expireRetention commit identity (ADR-0013)', () => {
  let dataDir = '';
  let core: SmartwareCore | null = null;

  const AS_OF = '2026-09-10T00:00:00.000Z';
  const SUPPLIED = 'op_01J8ZQK7V5P8M2N4R6T9W3XYBD';

  afterEach(() => {
    core?.close();
    core = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function open(): Promise<SmartwareCore> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-expire-id-'));
    scaffold(dataDir, makeConfig(dataDir, retention1d));
    core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
    return core;
  }

  function opsDir(): string {
    return path.join(dataDir, 'operations');
  }

  function retentionEntries(): Array<Record<string, unknown>> {
    return [...readAllOpLogEntries(opsDir())]
      .filter(entry => entry.op === 'retention.expire') as unknown as Array<Record<string, unknown>>;
  }

  /** Raw L0 tombstone mutations written by a sweep. */
  function tombstones(): Array<Record<string, unknown>> {
    return [...readAll(path.join(dataDir, 'evidence'))]
      .filter(observation => observation.type === 'tombstone') as unknown as Array<Record<string, unknown>>;
  }

  function orphansFor(operationId: string): string[] {
    const report = runRecovery({
      opsDir: opsDir(),
      evidenceDir: path.join(dataDir, 'evidence'),
      claimsDir: dataDir,
      wikiDir: path.join(dataDir, 'wiki'),
      quarantineDir: path.join(dataDir, 'quarantine', 'operations'),
    });
    return report.orphans
      .filter(orphan => orphan.operation_id === operationId)
      .map(orphan => `${orphan.surface}:${orphan.locator}`);
  }

  /** One elapsed observation in ACME, plus one active claim whose sole evidence is it. */
  async function seedExpiredWithClaim(c: SmartwareCore): Promise<{ obsId: string; claimId: string }> {
    const obsId = (await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'Acme prefers email' },
      scope: ACME, observed_at: '2026-08-01T00:00:00.000Z',
    })).id;

    const dbPath = path.join(dataDir, 'smartware.db');
    const store = new ClaimStore(dbPath);
    store.setDataDir(dataDir);
    const searchIndex = new SearchIndex(dbPath);
    const subjectId = `entity_${ulid()}`;
    store.insertEntity({
      id: subjectId, canonical_name: 'Acme', aliases: [], type: 'organization',
      scope: ACME, created_at: new Date().toISOString(),
    });
    const claim = makeClaim({
      subject_id: subjectId, subject_name: 'Acme', scope: ACME,
      predicate: 'prefers_contact', object: { type: 'text', value: 'email' },
      confidence: 0.8, supporting_evidence: [obsId], status: 'active', epistemic: 'observed',
      extraction: {
        method: 'deterministic', model: null, compiler_version: '0.6.3',
        prompt_hash: null, extracted_at: new Date().toISOString(),
      },
    });
    store.insertClaim(claim);
    syncSearchFromClaims(store, searchIndex, ACME);
    store.close();
    searchIndex.close();
    return { obsId, claimId: claim.id };
  }

  it('bare sweep writes exactly one entry with exact counts, a valid id, and no orphaned artifact', async () => {
    const c = await open();
    const { claimId } = await seedExpiredWithClaim(c);

    const result = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF });

    expect(result.observations_expired).toBe(1);
    expect(result.claims_retracted).toBe(1);

    // The id the sweep committed under is returned and is a published-shape OperationId.
    expect(typeof result.operation_id).toBe('string');
    expect(OPERATION_ID_PATTERN.test(result.operation_id)).toBe(true);

    const entries = retentionEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry['operation_id']).toBe(result.operation_id);
    expect(entry['actor_id']).toBe('user:owner');
    expect(entry['op']).toBe('retention.expire');
    expect(entry['timestamp']).toBe(new Date(entry['timestamp'] as string).toISOString());
    // Exact shape (ADR-0013 records it): counts nested under `details`, and NO top-level
    // `reason` — the `retention_expiry` marker lives in the tombstone observation's body.
    expect(Object.keys(entry).sort()).toEqual(['actor_id', 'details', 'op', 'operation_id', 'timestamp']);
    // `details` carries the counts; `payload_hash` is permitted on top (the payload-strict
    // replay of kanban t_06db00ce / spec v1.6.16:126 adds it to this same entry).
    const detailKeys = Object.keys(entry['details'] as Record<string, unknown>).sort();
    expect(detailKeys).toEqual(expect.arrayContaining(['as_of', 'claims_retracted', 'observations_expired', 'scope']));
    expect(detailKeys.filter(key => !['as_of', 'claims_retracted', 'observations_expired', 'scope', 'payload_hash'].includes(key))).toEqual([]);
    expect(entry['details']).toMatchObject({
      scope: ACME, observations_expired: 1, claims_retracted: 1, as_of: AS_OF,
    });

    // The artifacts the sweep wrote carry the same committed id: L0 tombstone and
    // the forgotten L1 version (which the schema requires an OperationId on).
    const tombstone = tombstones()[0]!;
    expect(tombstone['operation_id']).toBe(result.operation_id);
    expect((tombstone['content'] as { body: { reason: string } }).body.reason).toBe('retention_expiry');
    const forgotten = readLatestVersion(dataDir, claimId);
    expect(forgotten?.state).toBe('forgotten');
    expect(forgotten?.operation_id).toBe(result.operation_id);

    // Nothing the sweep wrote is an orphan: startup recovery finds no artifact
    // holding the sweep's id without a commit.
    expect(orphansFor(result.operation_id)).toEqual([]);
  });

  it('a caller-supplied id remains the idempotency key: one entry, retry replays, no duplicate', async () => {
    const c = await open();
    await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'old note' },
      scope: ACME, observed_at: '2026-08-01T00:00:00.000Z',
    });

    const first = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: SUPPLIED });
    expect(first.operation_id).toBe(SUPPLIED);
    expect(first.observations_expired).toBe(1);
    expect(retentionEntries()).toHaveLength(1);

    const retry = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: SUPPLIED });
    expect(retry.operation_id).toBe(SUPPLIED);
    expect(retry.observations_expired).toBe(1);
    expect(retry.claims_retracted).toBe(first.claims_retracted);
    expect(retentionEntries()).toHaveLength(1);
  });

  it('a bare retry is idempotent by effect and commits its own zero-count entry', async () => {
    const c = await open();
    await c.observe({
      actor: OWNER, type: 'message', content: { format: 'text/plain', body: 'old note' },
      scope: ACME, observed_at: '2026-08-01T00:00:00.000Z',
    });

    const first = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF });
    const second = await c.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF });

    expect(first.observations_expired).toBe(1);
    expect(second.observations_expired).toBe(0);
    expect(second.operation_id).not.toBe(first.operation_id);

    const entries = retentionEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]!['operation_id']).toBe(first.operation_id);
    expect(entries[1]!['operation_id']).toBe(second.operation_id);
    expect((entries[1]!['details'] as Record<string, unknown>)['observations_expired']).toBe(0);
  });
});
