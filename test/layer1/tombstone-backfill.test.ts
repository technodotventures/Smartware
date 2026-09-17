// Tests: Layer 1 — tombstone backfill (the only in-tree writer of `wiki/tombstones/*.md`)
//
// Why these exist: `t_2bba749f` fixed the *schema* side of the tombstone snapshot contract and
// measured that the writer did not match it. `src/layer1/tombstone-backfill.ts` emitted frontmatter
// the published `schemas/v0.5.0/tombstone-frontmatter.schema.json` rejects — four required snapshot
// fields omitted (`claim_id`, `state`, `epistemic_owner`, `fingerprint`) and `confidence` written as
// the raw numeric claim confidence instead of a `ConfidenceBucket`. The tombstone's whole purpose is
// that a lost L1 version is reconstructible from it (Conformance Test LC-04), so "the only writer
// emits what the published schema rejects" is the defect this suite closes (kanban `t_9e124fe6`).
//
// These tests drive the real `backfillTombstones(store, wikiDir)` over legacy-shaped rows
// (`status: 'retracted'`, `operation_id`/`actor_id` NULL — a pre-A3 row as `rowToClaim`
// materialises it), parse the written frontmatter back, and validate it against the published
// schema. They pin, in order: the four envelope fields and the bucketed confidence; the demotion
// pointer's carry-forward; and the backfill's idempotence.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ClaimStore } from '../../src/layer1/store.js';
import { backfillTombstones } from '../../src/layer1/tombstone-backfill.js';
import { computeFingerprint } from '../../src/layer1/fingerprint.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import type { Claim } from '../../src/layer1/types.js';

const schemaDir = path.join(process.cwd(), 'schemas', 'v0.5.0');

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
const LATER = '2026-03-01T12:00:00.000Z';
const CLAIM_A = 'claim_0000000000000000000000AAAA';
const CLAIM_B = 'claim_0000000000000000000000BBBB';

let dataDir: string;
let store: ClaimStore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-tombstone-backfill-'));
  store = new ClaimStore(path.join(dataDir, 'smartware.db'));
  store.setDataDir(dataDir);
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * A legacy pre-A3 row: `status: 'retracted'`, the A3 columns at their migration defaults, and
 * `operation_id`/`actor_id` NULL (the columns were added with no backfill for existing rows) —
 * i.e. the shape `rowToClaim` hands the backfill in a real pod.
 */
function legacyRetractedClaim(overrides: Partial<Claim> = {}): Claim {
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
    status: 'retracted',
    epistemic: 'observed',
    confidence: 0.5,
    sensitive: false,
    superseded_by: null,
    contested_by: [],
    state: 'forgotten',
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

function tombstonePath(claimId: string): string {
  return path.join(dataDir, 'wiki', 'tombstones', `${claimId.replace(/^claim_/, '')}.md`);
}

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

describe('tombstone backfill writes frontmatter the published schema accepts', () => {
  test('the four envelope fields are present, confidence is bucketed, and it validates', () => {
    seedSubjectEntity();
    store.insertClaim(legacyRetractedClaim());

    const report = backfillTombstones(store, path.join(dataDir, 'wiki'));
    expect(report).toEqual({
      retracted_found: 1,
      tombstones_written: 1,
      tombstones_skipped_existing: 0,
    });

    const frontmatter = parseFrontmatter(readFileSync(tombstonePath(CLAIM_A), 'utf8'));

    const ajv = createAjv();
    const tombstone = validator(ajv, 'tombstone-frontmatter.schema.json');
    assert.equal(tombstone(frontmatter), true, JSON.stringify(tombstone.errors));

    const snapshot = frontmatter.snapshot as Record<string, unknown>;

    // ...and the validator is not vacuous: dropping a required envelope field fails closed.
    const { claim_id: omitted, ...tamperedSnapshot } = snapshot;
    void omitted;
    assert.equal(tombstone({ ...frontmatter, snapshot: tamperedSnapshot }), false);

    // The envelope fields, as the schema's `required` list names them.
    expect(frontmatter.claim_id).toBe(CLAIM_A);
    expect(snapshot.claim_id).toBe(CLAIM_A);
    // The snapshot is of the claim's prior *active* version; the forgetting lives in the
    // tombstone's top-level fields (schema: snapshot.state is `const: 'active'`).
    expect(snapshot.state).toBe('active');
    expect(snapshot.epistemic_owner).toBe('agent');
    expect(snapshot.author).toBe('agent');

    // A legacy row carries no stored fingerprint, so it is recomputed from the snapshot's own
    // normalised content + scope + claim_type (the schema's definition of the field, and the Q8
    // legacy-backfill rule in `migration.ts`).
    expect(snapshot.fingerprint).toBe(
      computeFingerprint('2026-02-01', 'client:acme#1', 'finding'),
    );
    expect(snapshot.fingerprint).toMatch(/^fp_[a-f0-9]{16}$/);

    // Numeric confidence (0.5) is not a ConfidenceBucket; the writer uses the library's mapping.
    expect(snapshot.confidence).toBe('medium');
    // `epistemic: 'observed'` maps to `fact` through the library's epistemic mapping, not the
    // writer's old blanket `inference` default.
    expect(snapshot.epistemic_tag).toBe('fact');

    // A pre-A3 row has no operation_id/actor_id; the placeholders the writer stamps satisfy the
    // schema's Crockford-base32 OperationId / ActorId patterns (they did not before this fix).
    expect(frontmatter.operation_id).toBe('op_000000000000000000000000A3');
    expect(frontmatter.forgotten_by).toBe('substrate:legacy-migration');
    expect(snapshot.operation_id).toBe('op_000000000000000000000000A3');
    expect(snapshot.actor_id).toBe('substrate:legacy-migration');
    // The prior active version's own metadata, not the backfill's, defaults the rest.
    expect(snapshot.created_at).toBe(AT);
    expect(snapshot.version_at).toBe(AT);
  });

  test('a demoted duplicate keeps its demotion pointer in the snapshot', () => {
    seedSubjectEntity();
    store.insertClaim(legacyRetractedClaim({
      id: CLAIM_B,
      superseded_by: CLAIM_A,
      t_invalidated: knownTime(LATER),
    }));

    const report = backfillTombstones(store, path.join(dataDir, 'wiki'));
    expect(report.tombstones_written).toBe(1);

    const frontmatter = parseFrontmatter(readFileSync(tombstonePath(CLAIM_B), 'utf8'));
    const snapshot = frontmatter.snapshot as Record<string, unknown>;

    // §11 carry-forward / ADR-0003: a reconstruction from the tombstone alone must not release a
    // demotion and return the duplicate to the recall-eligible set.
    expect(snapshot.superseded_by).toBe(CLAIM_A);
    expect(snapshot.superseded_at).toBe(LATER);

    const tombstone = validator(createAjv(), 'tombstone-frontmatter.schema.json');
    assert.equal(tombstone(frontmatter), true, JSON.stringify(tombstone.errors));
  });

  test('re-running the backfill skips existing tombstones and rewrites nothing', () => {
    seedSubjectEntity();
    store.insertClaim(legacyRetractedClaim());
    const wikiDir = path.join(dataDir, 'wiki');

    expect(backfillTombstones(store, wikiDir).tombstones_written).toBe(1);
    const first = readFileSync(tombstonePath(CLAIM_A), 'utf8');

    const second = backfillTombstones(store, wikiDir);
    expect(second).toEqual({
      retracted_found: 1,
      tombstones_written: 0,
      tombstones_skipped_existing: 1,
    });
    expect(readFileSync(tombstonePath(CLAIM_A), 'utf8')).toBe(first);
  });
});
