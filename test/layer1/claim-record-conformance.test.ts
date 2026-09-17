// Tests: Layer 1 — the L1 record `ClaimStore.insertClaim` appends, per state it can write (ADR-0014)
//
// Why these exist: `schemas/v0.5.0/claim.schema.json` is the contract for one canonical L1 line, and
// `insertClaim` is the writer that puts a line there — for legacy/migration inserts, for the host
// helpers (`updateClaimStatus`, `markContested`, `redactClaim`, …), and for the `replay.ts`
// observation-replay correction paths. Measured on kanban t_3ba3ee39 (Node v26.5.1, lane
// `wip/smarty/l1-forgotten-supersedes` @ 981e5a7) the writer omitted `supersedes` in two shapes the
// schema requires it in:
//
//   * version >= 2 (any state) — the writer derived the number from `nextVersionFor` and dropped it,
//     while every hand-built protocol writer (FORGET, retention, consolidation, FORGET.SCOPE, REVISE)
//     sets `supersedes: latest.version`; and
//   * a version-1 forgotten record — where there is no prior version to name, because a claim can be
//     born forgotten (legacy/migration rows and the replay retraction path). That half was decided on
//     the schema side: the forgotten branch no longer requires the field, and the version rule
//     (`if version >= 2 then required supersedes`) still does.
//
// These tests read the RAW line off disk (no library reader in the path) and assert the COMPLETE Ajv
// error list is empty, so a new divergence cannot hide behind a known one. The probe that produced the
// measurements is `probe/t_3ba3ee39.probe.test.ts`; the decision is `docs/adr/0014-*.md`.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ClaimStore } from '../../src/layer1/store.js';
import { backfillTombstones } from '../../src/layer1/tombstone-backfill.js';
import { replayAll } from '../../src/layer1/replay.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import type { Claim } from '../../src/layer1/types.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { appendObservation } from '../../src/layer0/log.js';
import { assignIntegrity } from '../../src/layer0/integrity.js';
import type { Observation, PreExtractedClaim } from '../../src/layer0/types.js';
import { SMARTWARE_VERSION } from '../../src/version.js';

const schemaDir = path.join(process.cwd(), 'schemas', 'v0.5.0');
const AT = '2026-01-05T09:00:00.000Z';
const CLAIM_A = 'claim_0000000000000000000000AAAA';
const CLAIM_B = 'claim_0000000000000000000000BBBB';

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  for (const file of readdirSync(schemaDir).filter(f => f.endsWith('.schema.json')).sort()) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(schemaDir, file), 'utf8')) as AnySchema);
  }
  return ajv;
}

function claimValidator(ajv: Ajv2020): ValidateFunction {
  const validate = ajv.getSchema('https://smartware.dev/schemas/v0.5.0/claim.schema.json');
  assert.ok(validate, 'claim schema not registered');
  return validate;
}

/** Every raw line in the pod's claims/*.jsonl, parsed — the canonical surface as bytes. */
function rawRecords(dataDir: string): Array<Record<string, any>> {
  const dir = path.join(dataDir, 'claims');
  const out: Array<Record<string, any>> = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean)) {
      out.push(JSON.parse(line) as Record<string, any>);
    }
  }
  return out;
}

/** The single line the writer appended for a claim, asserting it validates whole. */
function expectValidRecord(
  dataDir: string,
  claimId: string,
  version: number,
  validate: ValidateFunction,
): Record<string, any> {
  const record = rawRecords(dataDir).find(r => r.claim_id === claimId && r.version === version);
  assert.ok(record, `no L1 record written for ${claimId} v${version}`);
  const valid = validate(record) as boolean;
  // The whole list, not a filtered slice: a second divergence can never hide behind this assertion.
  expect(validate.errors ?? []).toEqual([]);
  expect(valid).toBe(true);
  return record;
}

/** The writer emits `key: <json>` lines between `---` fences; parse them back. */
function parseFrontmatter(markdown: string): Record<string, any> {
  const block = markdown.split('---\n')[1] ?? '';
  const out: Record<string, any> = {};
  for (const line of block.split('\n').filter(Boolean)) {
    const idx = line.indexOf(': ');
    assert.ok(idx > 0, `unparsable frontmatter line: ${line}`);
    out[line.slice(0, idx)] = JSON.parse(line.slice(idx + 2));
  }
  return out;
}

/** `replay.ts` mints claim ids deterministically from the extraction event — reproduce it. */
function deterministicClaimId(extractionEventId: string, index: number): string {
  const digest = createHash('sha256').update(`${extractionEventId}:${index}`).digest('hex');
  return `claim_${digest.slice(0, 26)}`;
}

/** `insertClaim` has an FK on the subject entity; seed it like any real pod would. */
function seedSubjectEntity(store: ClaimStore): void {
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
function legacyClaim(overrides: Partial<Claim> = {}): Claim {
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

let dataDir: string;
let store: ClaimStore;
let validate: ValidateFunction;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-l1-conformance-'));
  store = new ClaimStore(path.join(dataDir, 'smartware.db'));
  store.setDataDir(dataDir);
  seedSubjectEntity(store);
  validate = claimValidator(createAjv());
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the record insertClaim appends is accepted by the contract it publishes', () => {
  test('v1 active: no supersedes — it replaces nothing', () => {
    store.insertClaim(legacyClaim());

    const record = expectValidRecord(dataDir, CLAIM_A, 1, validate);
    // Absent, not merely falsy: `supersedes: 0` would violate the schema's `minimum: 1`.
    expect('supersedes' in record).toBe(false);
  });

  test('v2 active: supersedes names the version it replaced', () => {
    store.insertClaim(legacyClaim());
    store.insertClaim(legacyClaim());

    const record = expectValidRecord(dataDir, CLAIM_A, 2, validate);
    expect(record.supersedes).toBe(1);
  });

  test('v2 active demoted (superseded): supersedes and the demotion pointer ride together', () => {
    store.insertClaim(legacyClaim());
    store.insertClaim(legacyClaim({
      status: 'superseded', superseded_by: CLAIM_B, t_invalidated: knownTime(AT),
    }));

    const record = expectValidRecord(dataDir, CLAIM_A, 2, validate);
    expect(record.supersedes).toBe(1);
    expect(record.superseded_by).toBe(CLAIM_B);
    expect(record.state).toBe('active');
  });

  test('v1 forgotten: a claim born forgotten validates without naming a prior version', () => {
    store.insertClaim(legacyClaim({ status: 'retracted', state: 'forgotten' }));

    const record = expectValidRecord(dataDir, CLAIM_A, 1, validate);
    expect(record.state).toBe('forgotten');
    expect(record.tombstone_id).toBe('tomb_0000000000000000000000AAAA');
    expect('supersedes' in record).toBe(false);
  });

  test('v2 forgotten: the forgotten version names the active version it replaced', () => {
    store.insertClaim(legacyClaim());
    store.insertClaim(legacyClaim({ status: 'retracted', state: 'forgotten' }));

    const record = expectValidRecord(dataDir, CLAIM_A, 2, validate);
    expect(record.state).toBe('forgotten');
    expect(record.supersedes).toBe(1);
  });

  test('the born-forgotten shape writes one line, and the tombstone backfill still reads it', () => {
    // The alternative reading of the divergence — have the writer synthesise an active v1 line first
    // so the forgotten version is always version 2 — was rejected in ADR-0014: it would put content
    // on the canonical surface for a claim that never had an active version, and change the legacy
    // shape the migration/backfill path (kanban t_9e124fe6) reads. Pin that.
    store.insertClaim(legacyClaim({ status: 'retracted', state: 'forgotten' }));

    const lines = rawRecords(dataDir).filter(r => r.claim_id === CLAIM_A);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.state).toBe('forgotten');

    const wikiDir = path.join(dataDir, 'wiki');
    const report = backfillTombstones(store, wikiDir);
    expect(report.tombstones_written).toBe(1);

    const md = readFileSync(
      path.join(wikiDir, 'tombstones', `${CLAIM_A.replace(/^claim_/, '')}.md`), 'utf8');
    const frontmatter = parseFrontmatter(md);
    // LC-04: the recovery artifact reconstructs the lost line — the snapshot is the prior-active copy
    // (a synthesised v1 for a legacy row), and the forgotten version keeps its own number.
    const reconstructed = {
      ...(frontmatter['snapshot'] as Record<string, unknown>),
      state: 'forgotten',
      tombstone_id: frontmatter['tombstone_id'],
      forgotten_at: frontmatter['forgotten_at'],
      forgotten_by: frontmatter['forgotten_by'],
    };
    const valid = validate(reconstructed) as boolean;
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  test('replay that retracts a claim writes the forgotten version through insertClaim', async () => {
    // The production path the card names (`replay.ts`): a claim_extracted event plus a tombstone that
    // retires the claim, replayed. `handleRetraction` goes through `store.updateClaimStatus`, which is
    // what drives `insertClaim`'s forgotten path with the state the caller means to write. Replay is
    // re-runnable (it deletes the derived rows and re-appends to the JSONL), so a second pass is also
    // the reachable version >= 2 case.
    const evidenceDir = path.join(dataDir, 'evidence');
    const layer0 = new Layer0Index(path.join(dataDir, 'smartware.db'));
    let seq = 0;

    const appendObs = (type: Observation['type'], body: unknown, claims?: PreExtractedClaim[]): Observation => {
      seq += 1;
      const base: Observation = {
        id: `obs_${randomBytes(8).toString('hex')}`,
        version: SMARTWARE_VERSION,
        type,
        status: 'accepted',
        source: {
          app: 'test', app_version: '1.0', source_id: null,
          actor: { type: 'person', id: 'user:owner', display_name: 'Owner' },
          captured_at: AT, observed_at: AT,
        },
        scope: 'client:acme#1', visibility: 'private',
        content: { format: 'application/json', body: body as object },
        claims,
        provenance: { parent_ids: [], supersedes: [], context: '' },
        policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
        integrity: { hash: '', writer_id: 'writer_1', sequence: seq, previous_hash: null },
      };
      const withIntegrity = assignIntegrity(base, 'writer_1', seq, null);
      appendObservation(evidenceDir, withIntegrity);
      layer0.insertOrSkip(withIntegrity);
      return withIntegrity;
    };

    const extracted = appendObs('claim_extracted', {}, [{
      subject_name: 'Acme',
      predicate: 'deadline_is',
      object: { type: 'text', value: '2026-02-01' },
      scope: 'client:acme#1',
      validity: { from: AT, to: null },
      epistemic: 'observed',
      confidence: 0.8,
      sensitive: false,
      extraction: { method: 'deterministic', model: null, compiler_version: '0.5.1', prompt_hash: null },
    }]);

    await replayAll(evidenceDir, layer0, store);
    const claimId = deterministicClaimId(extracted.id, 0);
    expect(store.getClaim(claimId)).toBeDefined();

    appendObs('tombstone', { target_id: claimId, target_kind: 'claim' });
    await replayAll(evidenceDir, layer0, store);
    layer0.close();

    const lines = rawRecords(dataDir).filter(r => r.claim_id === claimId);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // The retraction appended a forgotten version that names the version it replaced.
    const forgotten = lines.filter(r => r.state === 'forgotten');
    expect(forgotten.length).toBeGreaterThanOrEqual(1);
    const last = forgotten[forgotten.length - 1]!;
    expect(last.supersedes).toBe(last.version - 1);

    // Two of the ids `replay.ts` mints are outside their published patterns, and both ride the record:
    // `claim_<lowercase sha256 hex>` vs `^claim_[0-9A-HJKMNP-TV-Z]{26}$` (`deterministicClaimId`), and
    // the `tomb_` id derived from it by `insertClaim`'s forgotten path vs `^tomb_[0-9A-HJKMNP-TV-Z]{26}$`.
    // That is a separate, measured divergence of the same class, carded as t_0b079fbf and not decided
    // here — so the *only* errors a replayed line may carry are those two. Asserted as the exact list,
    // so a third divergence cannot hide behind them.
    for (const line of lines) {
      const valid = validate(line) as boolean;
      expect(validate.errors ?? []).toEqual([
        expect.objectContaining({ instancePath: '/claim_id', keyword: 'pattern' }),
        ...(line.state === 'forgotten'
          ? [expect.objectContaining({ instancePath: '/tombstone_id', keyword: 'pattern' })] : []),
      ]);
      expect(valid).toBe(false);
    }
  });
});

describe('claim.schema.json: supersedes follows the version, not the state', () => {
  // The schema-level half of ADR-0014 lives where the other v0.5.0 fixtures live:
  // `test/schemas-v0.5.0.test.ts` → "claim.schema.json: a forgotten version names the version it
  // replaces only when there is one". These are the writer-level consequences.
  test('a version-1 forgotten record is conformant with and without supersedes (writer side)', () => {
    store.insertClaim(legacyClaim({ status: 'retracted', state: 'forgotten' }));
    const record = expectValidRecord(dataDir, CLAIM_A, 1, validate);
    expect(record.state).toBe('forgotten');
  });
});
