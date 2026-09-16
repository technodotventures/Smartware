// L0 record ↔ wire observation boundary pin (ADR-0013, kanban t_0920aa1d).
//
// Two things are easy to conflate and neither was pinned by a test before this one:
//
//   1. `observation.schema.json` describes the observation OBJECT ON THE WIRE — the
//      v0.5.0 contract's OBSERVE payload plus the server-stamped identity.
//   2. the L0 line in `<dataDir>/evidence/<date>.jsonl` is the append-only RECORD
//      envelope: it carries that same information under different names, plus the
//      canonical state and the integrity chain the wire object has no place for.
//
// So `observation.schema.json` is NOT the validator for the record. That is a
// disclosed divergence (ADR-0013 → D1; the record shape is unpublished in v0.5.0),
// pinned here so it cannot drift in EITHER direction:
//
//   - if the record shape changes, the envelope-set assertion fails;
//   - if someone closes the gap (publishes a record schema, or reshapes the writer),
//     the rejection assertions fail — which is the signal to update the README section
//     "Which schema covers which surface" and invert these assertions, not to relax
//     them.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, test } from 'vitest';

import { SmartwareCore } from '../../src/core.js';

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

/** Error list as sorted `instancePath:keyword[:property]` strings. */
function errorKeys(validate: ValidateFunction, value: unknown): string[] {
  validate(value);
  return (validate.errors ?? [])
    .map(error => {
      const params = error.params as Record<string, unknown>;
      const property = error.keyword === 'additionalProperties'
        ? params['additionalProperty']
        : error.keyword === 'required' ? params['missingProperty'] : undefined;
      const suffix = typeof property === 'string' ? `:${property}` : '';
      return `${error.instancePath || '/'}:${error.keyword}${suffix}`;
    })
    .sort();
}

/**
 * The L0 record's envelope — the keys beyond what the wire observation object
 * carries. This is the documented record shape (ADR-0013 → D1).
 */
const L0_ENVELOPE_KEYS = [
  'id', 'idempotency', 'integrity', 'policy', 'provenance',
  'status', 'type', 'version', 'visibility',
].sort();

const L0_KEYS = [
  'content', 'id', 'idempotency', 'integrity', 'policy', 'provenance',
  'scope', 'source', 'status', 'type', 'version', 'visibility',
].sort();

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Flow {
  dataDir: string;
  core: SmartwareCore;
}

/** Protocol-native lanes only — what a v0.5.0-conformant host writes. */
async function protocolNativeFlow(): Promise<Flow> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-l0-boundary-'));
  tempDirs.push(dataDir);
  const core = await SmartwareCore.open({ dataDir });
  core.ensureTrustedClientGrant('user:local', 'person', ['self', 'workspace']);
  const actor = { type: 'person' as const, id: 'user:local', display_name: 'Owner' };
  await core.observe({
    actor,
    type: 'message',
    scope: 'workspace',
    observed_at: '2026-11-01T10:30:00Z',
    content: { format: 'text/plain', body: 'Graphiti API is deployed.' },
  });
  // One reflect pass so the scope has a claim, which is what puts the observation
  // into the EXPORT.SCOPE evidence closure (derived_from).
  await core.reflect({ actor, scope: 'workspace', use_llm: false });
  return { dataDir, core };
}

function evidenceLines(dataDir: string): Array<Record<string, unknown>> {
  const dir = path.join(dataDir, 'evidence');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()
    .flatMap(f => readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The projection of an L0 record onto the contract's OBSERVE observation object:
 * the wire payload fields plus the server-stamped identity. Pure renaming — no
 * information is added to make it validate.
 */
function wireProjection(record: Record<string, unknown>): Record<string, unknown> {
  const source = (record['source'] ?? {}) as Record<string, unknown>;
  const actor = (source['actor'] ?? {}) as Record<string, unknown>;
  const content = (record['content'] ?? {}) as Record<string, unknown>;
  const idempotency = record['idempotency'] as Record<string, unknown> | null | undefined;
  return {
    observation_id: record['id'],
    source: source['app'],
    scope: record['scope'],
    content: content['body'],
    metadata: { timestamp: source['observed_at'], actor: actor['id'] },
    operation_id: record['operation_id'] ?? 'op_000000000000000000000000A3',
    actor_id: record['actor_id'] ?? actor['id'],
    ...(idempotency ? { idempotency_key: idempotency['key'] } : {}),
  };
}

describe('L0 record vs observation.schema.json — which artifact the schema covers', () => {
  test('the schema accepts the wire observation and rejects the record envelope (disclosed, ADR-0013)', async () => {
    const { dataDir, core } = await protocolNativeFlow();
    try {
      const records = evidenceLines(dataDir);
      assert.equal(records.length, 1, 'the flow writes exactly one L0 record');
      const record = records[0]!;

      // ── The record envelope is the documented shape ──────────────────────
      // This flow pass no `operation_id`, so the record carries no commit-identity
      // keys; delivering one adds exactly `operation_id` and `actor_id`.
      const OPTIONAL_COMMIT_KEYS = ['actor_id', 'operation_id'];
      assert.deepEqual(
        Object.keys(record).sort().filter(key => !OPTIONAL_COMMIT_KEYS.includes(key)),
        L0_KEYS,
        'the L0 record envelope moved — see ADR-0013 → D1 and update the README table',
      );
      const enveloped = Object.keys(record).sort()
        .filter(key => !['content', 'scope', 'source'].includes(key));
      assert.deepEqual(
        enveloped,
        L0_ENVELOPE_KEYS,
        'the state the wire object has no place for (integrity chain, policy, status, visibility, version)',
      );
      // The integrity chain is the reason the record cannot be reshaped to suit the
      // wire schema: it is not decoration, it is the L0 tamper-evidence surface.
      const integrity = record['integrity'] as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(integrity).sort(),
        ['hash', 'previous_hash', 'sequence', 'writer_id'],
      );

      // ── The schema's subject is the wire object ──────────────────────────
      const observation = validator(createAjv(), 'observation.schema.json');
      const wire = wireProjection(record);
      assert.equal(
        observation(wire),
        true,
        `the contract's OBSERVE payload + stamped identity must validate: ${JSON.stringify(observation.errors)}`,
      );

      // ── The record is not that object (the disclosed gap) ────────────────
      assert.deepEqual(
        errorKeys(observation, record),
        [
          '/:additionalProperties:id',
          '/:additionalProperties:idempotency',
          '/:additionalProperties:integrity',
          '/:additionalProperties:policy',
          '/:additionalProperties:provenance',
          '/:additionalProperties:status',
          '/:additionalProperties:type',
          '/:additionalProperties:version',
          '/:additionalProperties:visibility',
          '/:required:actor_id',
          '/:required:metadata',
          '/:required:observation_id',
          '/:required:operation_id',
          '/source:type',
        ].sort(),
        'the record/schema divergence changed — the gap is either closed (update the README '
        + '"Which schema covers which surface" section and this test) or widened (treat it as a regression)',
      );
    } finally {
      core.close();
    }
  }, 120_000);

  test('EXPORT.SCOPE ships the record shape under a v0.5.0 schema label (disclosed gap #1)', async () => {
    const { dataDir, core } = await protocolNativeFlow();
    try {
      const owner = { type: 'person' as const, id: core.getConfig().owner_id, display_name: 'Owner' };
      const exported = await core.exportScope({ actor: owner, scope: 'workspace' });

      const manifest = JSON.parse(
        readFileSync(path.join(exported.path, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(manifest['protocol'], 'v0.5.0');
      assert.equal(manifest['schemas'], 'v0.5.0');

      const observation = validator(createAjv(), 'observation.schema.json');
      const record = evidenceLines(dataDir)[0]!;

      for (const name of ['observations', 'evidence']) {
        const lines = readFileSync(path.join(exported.path, `${name}.jsonl`), 'utf8')
          .split('\n').filter(Boolean);
        assert.equal(lines.length, 1, `${name}.jsonl carries the scope's one record`);
        const exportedRecord = JSON.parse(lines[0]!) as Record<string, unknown>;
        // Byte-shape identical to the canonical line: the portability boundary ships
        // the record, not a wire projection of it.
        assert.deepEqual(
          exportedRecord,
          record,
          `the package's ${name}.jsonl must be the canonical record`,
        );
        assert.equal(
          observation(exportedRecord),
          false,
          `no v0.5.0 schema covers the exported record shape (gap carded from ADR-0013 → D1): `
          + `${name}.jsonl validated, so a record schema has landed — update the README and this test`,
        );
      }
    } finally {
      core.close();
    }
  }, 120_000);
});
