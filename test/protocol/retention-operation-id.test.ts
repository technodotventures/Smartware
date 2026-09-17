// Tests: Protocol — the OperationId the retention sweep stamps on a forgotten L1 record
// (kanban t_0177d9c3, reviewer finding on t_85817375).
//
// Why these exist: `handleExpireRetention` retracts the claims whose sole evidence is an elapsed
// observation by appending a `state: "forgotten"` version through `appendClaimVersion` — an L1
// record, governed by `schemas/v0.5.0/claim.schema.json`, which requires `operation_id` typed by
// the published `$defs/OperationId` pattern `^op_[0-9A-HJKMNP-TV-Z]{26}$` (Crockford base32 — no
// I, L, O, U) and says so "for all versions (active and forgotten)". The sweep's `operation_id` is
// optional, and when a caller supplied none the writer fell back to
// `op_${computePayloadHash(...)}` — sha256 hex, so 67 characters — the only `op_` + sha256-hex site
// in `src/`, and a value the contract the library publishes rejects. Measured on t_85817375
// (2026-09-15): a sweep with no `operation_id` wrote a forgotten line whose only schema error was
// `/operation_id:pattern`.
//
// These tests drive the real sweep, read the forgotten line back off disk, and validate it against
// the published claim schema. They also pin the decision taken here: mint the fallback the way the
// sibling forget writers do (`op_${ulid()}` — `forget.ts`, `forget_scope.ts`, `session.ts`,
// `dream/phases.ts`), one record at a time, rather than re-encoding the payload hash (see the
// rationale comment on the writer) or making `operation_id` a required parameter.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, test } from 'vitest';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig, type SmartwareConfig } from '../../src/config.js';
import { readLatestVersion } from '../../src/layer1/jsonl.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { makeClaim } from '../helpers.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const ACME = 'client:acme#1';
const AS_OF = '2026-09-10T00:00:00.000Z';

const schemaDir = path.join(process.cwd(), 'schemas', 'v0.5.0');

/** The shape the writer stamped before this fix: `op_` + 64 lowercase hex sha256 = 67 chars. */
const PRE_FIX_FALLBACK_SHAPE = `op_${'0123456789abcdef'.repeat(4)}`;

function readSchema(filename: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(schemaDir, filename), 'utf8')) as Record<string, any>;
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  for (const file of readdirSync(schemaDir).filter(f => f.endsWith('.schema.json')).sort()) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(schemaDir, file), 'utf8')) as AnySchema);
  }
  return ajv;
}

function validator(ajv: Ajv2020, filename: string): ValidateFunction {
  const id = `https://smartware.dev/schemas/v0.5.0/${filename}`;
  const validate = ajv.getSchema(id);
  assert.ok(validate, `schema not registered: ${id}`);
  return validate;
}

function publishedOperationIdPattern(): RegExp {
  return new RegExp(readSchema('common.schema.json').$defs.OperationId.pattern as string);
}

function scaffold(dataDir: string, config: SmartwareConfig): void {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  saveConfig(dataDir, config);
}

const retention1d: SmartwareConfig['retention'] = {
  default: { policy: 'forever', duration_days: null },
  scope_overrides: { [ACME]: { policy: 'duration', duration_days: 1 } },
};

function makeConfig(dataDir: string): SmartwareConfig {
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = 'user:owner';
  cfg.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    { id: ACME, parent: 'workspace', visibility_default: 'scope' },
  ];
  cfg.retention = retention1d;
  return cfg;
}

describe('the retention sweep stamps an OperationId the published contract accepts', () => {
  let core: SmartwareCore | null = null;
  let dataDir = '';

  afterEach(() => {
    core?.close();
    core = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * A pod with a 1-day retention policy on `client:acme#1`, and one already-elapsed observation
   * whose sole supporting claim is registered through the deterministic (no-LLM) persistence path.
   * Returns the claim id so the caller can read its canonical L1 lines back off disk.
   */
  async function scaffoldExpiredClaim(bodyText = 'Acme prefers email'): Promise<{ claimId: string; obsId: string }> {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-retention-opid-'));
    scaffold(dataDir, makeConfig(dataDir));
    core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });

    const obsId = (await core.observe({
      actor: OWNER,
      type: 'message',
      content: { format: 'text/plain', body: bodyText },
      scope: ACME,
      observed_at: '2026-08-01T00:00:00.000Z',
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
      predicate: 'prefers_contact', object: { type: 'text', value: bodyText },
      confidence: 0.8, supporting_evidence: [obsId], status: 'active', epistemic: 'observed',
      extraction: { method: 'deterministic', model: null, compiler_version: '0.6.3', prompt_hash: null, extracted_at: new Date().toISOString() },
    });
    store.insertClaim(claim);
    syncSearchFromClaims(store, searchIndex, ACME);
    store.close();
    searchIndex.close();

    return { claimId: claim.id, obsId };
  }

  /** The latest canonical L1 line for a claim — what the sweep appended, read off disk. */
  function latestLine(claimId: string): Record<string, any> {
    const record = readLatestVersion(dataDir, claimId);
    assert.ok(record, `no L1 record written for ${claimId}`);
    return record as unknown as Record<string, any>;
  }

  test('a sweep with no caller operation_id writes a forgotten line the published schema accepts', async () => {
    const { claimId } = await scaffoldExpiredClaim();
    assert.ok(core);

    // No operation_id: the reachable path for any host that sweeps without minting one
    // (`ExpireRetentionParams.operation_id` and the MCP tool's are both optional).
    const result = await core.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF });
    expect(result.claims_retracted).toBe(1);
    // ADR-0013: the result echoes the minted id — the same id stamped on the record below.
    expect(result.operation_id).toMatch(publishedOperationIdPattern());

    const record = latestLine(claimId);
    console.log('[t_0177d9c3] forgotten record operation_id:', JSON.stringify(record.operation_id));

    expect(record.state).toBe('forgotten');
    expect(record.operation_id).toMatch(publishedOperationIdPattern());
    // House convention: an unminted id is a fresh ULID, exactly like the sibling forget writers.
    expect(record.operation_id).toMatch(/^op_01[0-9A-HJKMNP-TV-Z]{24}$/);
    expect(record.actor_id).toBe(OWNER.id);

    const claim = validator(createAjv(), 'claim.schema.json');
    const valid = claim(record) as boolean;
    const errors = (claim.errors ?? []) as Array<{ instancePath: string; keyword: string; message?: string }>;
    console.log('[t_0177d9c3] claim.schema.json:', valid, JSON.stringify(errors));

    // The forgotten line is a complete record with no `semantic` block, so the published schema
    // accepts it outright — no known divergence is expected here (unlike the active L1 record,
    // kanban t_229601e4).
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  test('a caller-supplied operation id is stamped untouched', async () => {
    const { claimId } = await scaffoldExpiredClaim();
    assert.ok(core);

    const supplied = 'op_01J8ZQK7V5P8M2N4R6T9W3XYBD';
    expect(supplied).toMatch(publishedOperationIdPattern()); // fixture sanity
    const result = await core.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF, operation_id: supplied });
    expect(result.claims_retracted).toBe(1);
    expect(result.operation_id).toBe(supplied);

    const record = latestLine(claimId);
    expect(record.state).toBe('forgotten');
    expect(record.operation_id).toBe(supplied);

    const claim = validator(createAjv(), 'claim.schema.json');
    expect(claim(record) as boolean).toBe(true);
  });

  test('a multi-claim sweep mints one valid id shared by every retracted record', async () => {
    const first = await scaffoldExpiredClaim('Acme prefers email');
    assert.ok(core);
    // A second elapsed observation whose sole evidence is a second claim, swept in the same call.
    const store = new ClaimStore(path.join(dataDir, 'smartware.db'));
    store.setDataDir(dataDir);
    const searchIndex = new SearchIndex(path.join(dataDir, 'smartware.db'));
    const obsId = (await core.observe({
      actor: OWNER,
      type: 'message',
      content: { format: 'text/plain', body: 'Acme prefers phone' },
      scope: ACME,
      observed_at: '2026-08-02T00:00:00.000Z',
    })).id;
    const subjectId = `entity_${ulid()}`;
    store.insertEntity({
      id: subjectId, canonical_name: 'Acme', aliases: [], type: 'organization',
      scope: ACME, created_at: new Date().toISOString(),
    });
    const second = makeClaim({
      subject_id: subjectId, subject_name: 'Acme', scope: ACME,
      predicate: 'prefers_contact', object: { type: 'text', value: 'phone' },
      confidence: 0.8, supporting_evidence: [obsId], status: 'active', epistemic: 'observed',
      extraction: { method: 'deterministic', model: null, compiler_version: '0.6.3', prompt_hash: null, extracted_at: new Date().toISOString() },
    });
    store.insertClaim(second);
    syncSearchFromClaims(store, searchIndex, ACME);
    store.close();
    searchIndex.close();

    const result = await core.expireRetention({ actor: OWNER, scope: ACME, as_of: AS_OF });
    expect(result.claims_retracted).toBe(2);

    const pattern = publishedOperationIdPattern();
    const ids = [latestLine(first.claimId), latestLine(second.id)].map(r => r.operation_id as string);
    for (const id of ids) expect(id).toMatch(pattern);
    // ADR-0013: one sweep, one OperationId — every retracted record shares the sweep's committed
    // id, so the whole sweep replays as one unit on retry.
    expect(new Set(ids).size).toBe(1);
  });

  test('the pre-fix fallback is exactly what the published pattern rejects', () => {
    const pattern = publishedOperationIdPattern();
    expect(PRE_FIX_FALLBACK_SHAPE).toHaveLength(67); // op_ + 64 sha256 hex chars
    expect(PRE_FIX_FALLBACK_SHAPE).not.toMatch(pattern); // 26 Crockford chars expected, not 64 hex
    expect(`op_${ulid()}`).toHaveLength(29);
    expect(`op_${ulid()}`).toMatch(pattern);
  });
});
