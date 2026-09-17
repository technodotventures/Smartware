// Consent-change lane pin (kanban t_e6fce49a).
//
// GRANT and REVOKE append `consent_change` L0 records; QUARANTINE_REVIEW and FORGET
// append review/mutation records that inherit their target's lane. All four writers
// used to stamp the lane `personal` — a spelling `common.schema.json#/$defs/Scope`
// does not admit and that a Core-opened brain does not register (`self` is the spec's
// personal lane; measured on t_e6fce49a). Each of those records therefore failed the
// published v0.5.1 record schema on `scope` alone (`/scope:pattern`), which puts them
// outside v0.5.0's *Conformance boundary* ("schema validity on every canonical
// write") for a reason that is an implementation literal, not a host's choice.
//
// This file drives the real writers and asserts the appended record's COMPLETE Ajv
// error list against `schemas/v0.5.1/observation-record.schema.json` is empty. The
// pre-fix revision fails the same assertion with exactly `['/scope:pattern']`
// (A/B pair, this repo's mutation-check convention); the A/B control below keeps that
// half alive by re-validating the same record with the pre-fix spelling, so a
// regression to `personal` cannot pass quietly.
//
// It deliberately imports nothing the fix introduces, so the identical file runs
// against the pre-fix revision (the RED arm); the lane it expects is spelled here
// rather than imported from `src/config.ts` (`POD_SELF_SCOPE`) for that reason.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ulid } from 'ulid';
import { afterEach, describe, test } from 'vitest';

import { createGrant } from '../../src/auth/grants.js';
import { ProtocolError } from '../../src/auth/middleware.js';
import { SmartwareCore } from '../../src/core.js';

/** Both sets: the v0.5.1 record schema `$ref`s the shared v0.5.0 `common.schema.json`. */
const SCHEMA_SETS = ['v0.5.0', 'v0.5.1'];
const RECORD_SCHEMA_ID = 'https://smartware.dev/schemas/v0.5.1/observation-record.schema.json';
const SCOPE_DEF_ID = 'https://smartware.dev/schemas/v0.5.0/common.schema.json#/$defs/Scope';

/** The pod's own lane — `POD_SELF_SCOPE` in `src/config.ts`, the writers' one spelling. */
const POD_LANE = 'self';
/** The pre-fix spelling: not in `$defs/Scope`, not registered (kanban t_e6fce49a). */
const PRE_FIX_LANE = 'personal';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const UNTRUSTED = { type: 'system' as const, id: 'substrate:probe', display_name: 'Probe' };
const WORKSPACE_CAPS = {
  observe: ['workspace'], query: ['workspace'], compile: [], correct: [], forget: [], read: ['workspace'],
};

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  for (const set of SCHEMA_SETS) {
    const dir = path.join(process.cwd(), 'schemas', set);
    for (const file of readdirSync(dir).filter(f => f.endsWith('.schema.json')).sort()) {
      ajv.addSchema(JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as AnySchema);
    }
  }
  return ajv;
}

function recordValidator(): ValidateFunction {
  const validate = createAjv().getSchema(RECORD_SCHEMA_ID);
  assert.ok(validate, `schema not registered: ${RECORD_SCHEMA_ID}`);
  return validate;
}

/**
 * The published `Scope` vocabulary itself, reached through the shared v0.5.0
 * definitions the record schema `$ref`s — so the pin cannot drift onto a private
 * copy of the pattern.
 */
function scopeValidator(): ValidateFunction {
  return createAjv().compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: SCOPE_DEF_ID,
  });
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

function evidenceLines(dataDir: string): Array<Record<string, unknown>> {
  const dir = path.join(dataDir, 'evidence');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()
    .flatMap(f => readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function openBrain(): Promise<{ dataDir: string; core: SmartwareCore }> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-consent-lane-'));
  tempDirs.push(dataDir);
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  return { dataDir, core };
}

describe('the lane the substrate writes its own consent-change records in', () => {
  test('GRANT and REVOKE records validate against the published record schema', async () => {
    const { dataDir, core } = await openBrain();
    try {
      const granted = await core.grant({
        actor: OWNER, grant_actor_id: 'agent:probe', grant_actor_type: 'agent',
        capabilities: WORKSPACE_CAPS, trusted: true,
      });
      await core.revoke({ actor: OWNER, grant_id: granted.grant_id, reason: 'pin' });

      const records = evidenceLines(dataDir).filter(line => line['type'] === 'consent_change');
      assert.equal(records.length, 2, 'GRANT + REVOKE append one consent_change record each');

      const validate = recordValidator();
      for (const [index, record] of records.entries()) {
        // The assertion the pre-fix revision fails with exactly ['/scope:pattern'].
        assert.deepEqual(
          errorKeys(validate, record),
          [],
          `consent_change[${index}] (${String(record['id'])}) must validate against ${RECORD_SCHEMA_ID} `
          + 'with an empty error list',
        );
        assert.equal(
          record['scope'],
          POD_LANE,
          `consent_change[${index}] must carry the pod lane '${POD_LANE}'`,
        );
      }

      // The lane is not just vocabulary-valid, it is a lane this brain registers —
      // the pre-fix literal was neither.
      const registered = core.getConfig().scopes.map(entry => entry.id);
      for (const record of records) {
        assert.ok(
          registered.includes(record['scope'] as string),
          `a written lane must be registered; got ${String(record['scope'])} from [${registered.join(', ')}]`,
        );
      }
    } finally {
      core.close();
    }
  }, 120_000);

  test('the review and tombstone records inherit a schema-valid lane from their target', async () => {
    const { dataDir, core } = await openBrain();
    try {
      // An untrusted writer's OBSERVE is quarantined; reviewing it appends the
      // review record, and FORGETing the same observation appends the tombstone.
      createGrant(dataDir, {
        actor_type: 'system', actor_id: UNTRUSTED.id, trusted: false, quarantine: false,
        capabilities: WORKSPACE_CAPS,
      });
      const quarantined = await core.observe({
        actor: UNTRUSTED, type: 'tool_output', scope: 'workspace',
        content: { format: 'application/json', body: { tool: 'pin', ok: true } },
        observed_at: '2026-11-01T10:33:00Z',
      });
      await core.quarantineReview({
        actor: OWNER, target_obs_id: quarantined.id, action: 'approve', reason: 'pin',
      });
      await core.forget({
        actor: OWNER, target_obs_id: quarantined.id, mode: 'tombstone', reason: 'pin',
        operation_id: `op_${ulid()}`,
      });

      const validate = recordValidator();
      const byType = (type: string): Record<string, unknown> => {
        const record = evidenceLines(dataDir).find(line => line['type'] === type);
        assert.ok(record, `no ${type} record was appended`);
        return record;
      };
      for (const type of ['quarantine_review', 'tombstone']) {
        const record = byType(type);
        assert.deepEqual(
          errorKeys(validate, record),
          [],
          `${type} (${String(record['id'])}) must validate against ${RECORD_SCHEMA_ID} with an empty error list`,
        );
        assert.equal(record['scope'], 'workspace', `${type} inherits the target's lane`);
      }
    } finally {
      core.close();
    }
  }, 120_000);

  test('A/B control: the pre-fix spelling fails the same assertion', async () => {
    const { dataDir, core } = await openBrain();
    try {
      const granted = await core.grant({
        actor: OWNER, grant_actor_id: 'agent:probe', grant_actor_type: 'agent',
        capabilities: WORKSPACE_CAPS, trusted: true,
      });
      const record = evidenceLines(dataDir).find(line => line['type'] === 'consent_change');
      assert.ok(record, 'GRANT appends a consent_change record');

      // The pre-fix revision wrote exactly this record with `scope: 'personal'`:
      // the complete error list is the one the card measured. This half keeps the
      // pair non-tautological — if the writers regress, the tests above fail; if
      // this control ever passes on `personal`, the vocabulary changed and the
      // decision (not the record) must be re-litigated.
      assert.deepEqual(
        errorKeys(recordValidator(), { ...record, scope: PRE_FIX_LANE }),
        ['/scope:pattern'],
        `the pre-fix '${PRE_FIX_LANE}' spelling must still fail the record schema on scope alone`,
      );
    } finally {
      core.close();
    }
  }, 120_000);

  test('the lane is the vocabulary value a Core-opened brain registers', async () => {
    const { core } = await openBrain();
    try {
      // The constant the four writers now share (`POD_SELF_SCOPE`, src/config.ts) is
      // the protocol-native lane; a Core-opened brain registers it, and the published
      // vocabulary admits it. A future re-spelling of the constant fails here before
      // a record can be written out of vocabulary.
      assert.ok(
        core.getConfig().scopes.some(entry => entry.id === POD_LANE),
        `the pod lane '${POD_LANE}' must be registered in a Core-opened brain`,
      );
      assert.deepEqual(
        errorKeys(scopeValidator(), POD_LANE),
        [],
        'the pod lane must be admitted by the published Scope vocabulary',
      );
      assert.deepEqual(
        errorKeys(scopeValidator(), PRE_FIX_LANE),
        ['/:pattern'],
        `'${PRE_FIX_LANE}' must stay outside the published Scope vocabulary`,
      );
    } finally {
      core.close();
    }
  }, 120_000);

  test('the fallbacks cannot fire: a missing target is refused before any lane is resolved', async () => {
    const { core } = await openBrain();
    try {
      // Both `?? <lane>` fallbacks (quarantine_review.ts, forget.ts) sit behind a
      // lookup that throws `not_found` first, and `observations.scope` is NOT NULL —
      // so a missing target never reaches the label. The fix is therefore a spelling
      // change, not a behaviour change (measured on t_e6fce49a).
      for (const call of [
        () => core.quarantineReview({ actor: OWNER, target_obs_id: `obs_${'0'.repeat(64)}`, action: 'approve' }),
        () => core.forget({ actor: OWNER, target_obs_id: `obs_${'0'.repeat(64)}`, mode: 'tombstone', reason: 'pin' }),
      ]) {
        await assert.rejects(
          call,
          (error: unknown) => error instanceof ProtocolError && error.code === 'not_found',
          'a missing review/forget target must be refused before any lane is resolved',
        );
      }
    } finally {
      core.close();
    }
  }, 120_000);
});
