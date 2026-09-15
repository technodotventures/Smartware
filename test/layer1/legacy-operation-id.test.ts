// Tests: Layer 1 — the OperationId a legacy insert carries on the canonical L1 record (kanban t_85817375)
//
// Why these exist: `schemas/v0.5.0/claim.schema.json` requires `operation_id`, typed by the published
// `$defs/OperationId` pattern `^op_[0-9A-HJKMNP-TV-Z]{26}$` (Crockford base32 — no I, L, O, U), and
// `insertClaim` is the writer that puts it on every L1 JSONL line. When the caller supplies no
// operation id (legacy/migration inserts; hosts that mint none) it stamped the literal
// `op_LEGACY00000000000000000000`, whose `L` the pattern rejects — measured on t_9e124fe6, fixed here.
//
// These tests drive the real writer, validate what lands on disk against the published schema, and
// pin the shared convention: the marker is the same value `src/layer1/tombstone-backfill.ts` stamps
// on backfilled tombstones (t_9e124fe6), so one value identifies every record the library had to
// write without a real OperationId.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ClaimStore, LEGACY_OPERATION_ID } from '../../src/layer1/store.js';
import { readLatestVersion } from '../../src/layer1/jsonl.js';
import { backfillTombstones } from '../../src/layer1/tombstone-backfill.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import type { Claim } from '../../src/layer1/types.js';

const schemaDir = path.join(process.cwd(), 'schemas', 'v0.5.0');

/** The marker `insertClaim` stamped before this fix — 26 chars after `op_`, one of them an `L`. */
const PRE_FIX_PLACEHOLDER = 'op_LEGACY00000000000000000000';

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

/** The writer emits `key: <json>` lines between `---` fences; parse them back. */
function parseFrontmatter(markdown: string): Record<string, unknown> {
  const block = markdown.split('---\n')[1] ?? '';
  const out: Record<string, unknown> = {};
  for (const line of block.split('\n').filter(Boolean)) {
    const idx = line.indexOf(': ');
    assert.ok(idx > 0, `unparsable frontmatter line: ${line}`);
    out[line.slice(0, idx)] = JSON.parse(line.slice(idx + 2));
  }
  return out;
}

const AT = '2026-01-05T09:00:00.000Z';
const CLAIM_A = 'claim_0000000000000000000000AAAA';

let dataDir: string;
let store: ClaimStore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-l1-legacy-opid-'));
  store = new ClaimStore(path.join(dataDir, 'smartware.db'));
  store.setDataDir(dataDir);
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** `insertClaim` has an FK on the subject entity; seed it like any real pod would. */
function seedSubjectEntity(): void {
  store.insertEntity({
    id: 'entity_acme_scope',
    canonical_name: 'Acme',
    aliases: [],
    type: 'organization',
    scope: 'client:acme#1',
    created_at: AT,
  });
}

/** A claim with no operation id/actor — the legacy/migration shape `insertClaim` falls back on. */
function claimWithoutOperationId(overrides: Partial<Claim> = {}): Claim {
  return {
    id: CLAIM_A,
    subject_id: 'entity_acme_scope',
    subject_name: 'Acme',
    predicate: 'deadline_is',
    object: { type: 'date', value: '2026-02-01' },
    scope: 'client:acme#1',
    validity: { from: AT, to: null },
    t_ingested: knownTime(AT),
    t_invalidated: nullTime(),
    t_valid_from: knownTime(AT),
    t_valid_to: nullTime(),
    source_event_id: 'obs_aaaaaaaaaaaaaaaa',
    extraction_event_id: 'obs_bbbbbbbbbbbbbbbb',
    supporting_evidence: ['obs_aaaaaaaaaaaaaaaa'],
    extraction: {
      method: 'deterministic',
      model: null,
      compiler_version: '0.5.1',
      prompt_hash: null,
      extracted_at: AT,
    },
    status: 'active',
    epistemic: 'observed',
    confidence: 0.5,
    sensitive: false,
    superseded_by: null,
    contested_by: [],
    state: 'active',
    author: 'agent',
    epistemic_owner: 'agent',
    claim_type: 'finding',
    claim_role: 'memory',
    version_at: AT,
    created_at: AT,
    operation_id: null,
    actor_id: null,
    relations: [],
    ...overrides,
  };
}

/** The single line the writer appended for a claim. */
function writtenRecord(claimId: string): Record<string, any> {
  const record = readLatestVersion(dataDir, claimId);
  assert.ok(record, `no L1 record written for ${claimId}`);
  return record as unknown as Record<string, any>;
}

describe('the L1 record writer stamps an OperationId the published contract accepts', () => {
  test('a legacy insert (no caller operation id) writes a marker the published pattern accepts', () => {
    seedSubjectEntity();
    store.insertClaim(claimWithoutOperationId());

    const record = writtenRecord(CLAIM_A);
    console.log('[t_85817375] L1 record operation_id:', JSON.stringify(record.operation_id));

    expect(record.operation_id).toBe(LEGACY_OPERATION_ID);
    expect(record.operation_id).toMatch(publishedOperationIdPattern());
    // The marker travels with the ActorId the same legacy path defaults to.
    expect(record.actor_id).toBe('substrate:legacy');
    expect(record.actor_id).toMatch(/^(user|agent|sidecar|substrate):[a-z0-9-]+$/);
  });

  test('a caller-supplied operation id is untouched', () => {
    seedSubjectEntity();
    const supplied = 'op_01J8ZQK7V5P8M2N4R6T9W3XYBD';
    expect(supplied).toMatch(publishedOperationIdPattern()); // fixture sanity
    store.insertClaim(claimWithoutOperationId({ operation_id: supplied, actor_id: 'user:owner' }));

    const record = writtenRecord(CLAIM_A);
    expect(record.operation_id).toBe(supplied);
    expect(record.actor_id).toBe('user:owner');
  });

  test('the written record carries no OperationId error against claim.schema.json', () => {
    seedSubjectEntity();
    store.insertClaim(claimWithoutOperationId());

    const record = writtenRecord(CLAIM_A);
    const claim = validator(createAjv(), 'claim.schema.json');
    const valid = claim(record) as boolean;
    const errors = (claim.errors ?? []) as Array<{ instancePath: string; keyword: string }>;
    console.log('[t_85817375] claim.schema.json:', valid, JSON.stringify(errors));

    expect(errors.filter(e => e.instancePath === '/operation_id')).toEqual([]);

    // The one error left is the carded `semantic` divergence (see the test below): an active
    // record carries the internal materialization block, which the published claim schema does
    // not enumerate. Pinned here so it cannot silently become two errors, or hide a new one.
    expect(errors.map(e => `${e.instancePath}:${e.keyword}`)).toEqual([':additionalProperties']);
  });

  test('the marker is the one the tombstone backfill stamps — one convention, not two', () => {
    seedSubjectEntity();
    // The legacy pre-A3 row shape the backfill handles: retracted, operation_id/actor_id NULL.
    store.insertClaim(claimWithoutOperationId({ status: 'retracted', state: 'forgotten' }));

    const report = backfillTombstones(store, path.join(dataDir, 'wiki'));
    expect(report.tombstones_written).toBe(1);

    const tombstonePath = path.join(dataDir, 'wiki', 'tombstones', `${CLAIM_A.replace(/^claim_/, '')}.md`);
    const frontmatter = parseFrontmatter(readFileSync(tombstonePath, 'utf8'));

    expect(LEGACY_OPERATION_ID).toBe('op_000000000000000000000000A3');
    expect(frontmatter.operation_id).toBe(LEGACY_OPERATION_ID);
  });

  test('the pre-fix placeholder is exactly what the published pattern rejects', () => {
    const pattern = publishedOperationIdPattern();
    expect(PRE_FIX_PLACEHOLDER).toHaveLength(29); // op_ + 26
    expect(PRE_FIX_PLACEHOLDER).not.toMatch(pattern); // the `L` — Crockford base32 excludes I/L/O/U
    expect(LEGACY_OPERATION_ID).toHaveLength(29);
    expect(LEGACY_OPERATION_ID).toMatch(pattern);
  });

  test('known divergence: claim.schema.json does not enumerate the record’s internal semantic block', () => {
    seedSubjectEntity();
    store.insertClaim(claimWithoutOperationId());

    const record = writtenRecord(CLAIM_A);
    expect(Object.keys(record)).toContain('semantic');

    const claimSchema = readSchema('claim.schema.json');
    expect(claimSchema.additionalProperties).toBe(false);
    expect(Object.keys(claimSchema.properties as Record<string, unknown>)).not.toContain('semantic');

    // Whether the published claim schema describes the L1 record or the spec §6 claim version is a
    // separate, carded question — not this card's ask. When it is answered (the schema gains the
    // block, or the writer stops emitting it) this test fails in the same change and gets updated.
  });
});
