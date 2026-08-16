import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, test } from 'vitest';

const schemaDir = path.join(process.cwd(), 'schemas', 'v0.4.2');
const schemaFiles = readdirSync(schemaDir)
  .filter(file => file.endsWith('.schema.json'))
  .sort();

function loadSchemas(): AnySchema[] {
  return schemaFiles.map(file =>
    JSON.parse(readFileSync(path.join(schemaDir, file), 'utf8')) as AnySchema);
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    // REVISE declares properties on the enclosing object and selects their
    // required combinations through anyOf. This is valid Draft 2020-12; AJV's
    // optional strictRequired lint expects each branch to redeclare them.
    strictRequired: false,
  });
  addFormats(ajv);
  for (const schema of loadSchemas()) ajv.addSchema(schema);
  return ajv;
}

function validator(ajv: Ajv2020, filename: string): ValidateFunction {
  const id = `https://smartware.dev/schemas/v0.4.2/${filename}`;
  const validate = ajv.getSchema(id);
  assert.ok(validate, `schema not registered: ${id}`);
  return validate;
}

const ULID_A = '0'.repeat(26);
const ULID_B = '1'.repeat(26);
const CLAIM_A = `claim_${ULID_A}`;
const CLAIM_B = `claim_${ULID_B}`;
const OPERATION_A = `op_${ULID_A}`;
const OBSERVATION_A = `obs_${'a'.repeat(16)}`;
const RELATION_A = `rel_${ULID_A}`;
const NOW = '2026-07-24T00:00:00.000Z';

function activeClaim() {
  return {
    claim_id: CLAIM_A,
    version: 1,
    state: 'active',
    content: 'Smartware owns retrieval semantics.',
    scope: 'workspace',
    claim_type: 'decision',
    claim_role: 'memory',
    author: 'agent',
    epistemic_owner: 'agent',
    fingerprint: `fp_${'a'.repeat(8)}`,
    confidence: 'low',
    epistemic_tag: 'inference',
    derived_from: [OBSERVATION_A],
    relations: [],
    created_at: NOW,
    version_at: NOW,
    operation_id: OPERATION_A,
    actor_id: 'agent:researcher',
    tags: ['retrieval'],
  };
}

describe('Smartware v0.4.2 schemas', () => {
  test('all 15 versioned schemas compile together', () => {
    assert.equal(schemaFiles.length, 15);
    assert.doesNotThrow(() => createAjv());
  });

  test('normative positive and negative fixtures enforce the beta boundary', () => {
    const ajv = createAjv();
    const claim = validator(ajv, 'claim.schema.json');
    const relation = validator(ajv, 'relation.schema.json');
    const revise = validator(ajv, 'revise-request.schema.json');
    const contextBundle = validator(ajv, 'context-bundle.schema.json');

    // 1. Active, source-backed bounded hypothesis.
    assert.equal(claim(activeClaim()), true, JSON.stringify(claim.errors));

    // 2. Active claims cannot omit their assertion body.
    const missingContent = activeClaim();
    delete (missingContent as Partial<ReturnType<typeof activeClaim>>).content;
    assert.equal(claim(missingContent), false);

    // 3. A user-warranted epistemic edge is canonical-admissible.
    const warrantedRelation = {
      relation_id: RELATION_A,
      kind: 'corrects',
      target: CLAIM_B,
      valid_at: NOW,
      invalid_at: null,
      provenance: {
        origin: 'user',
        asserted_in_source_version: 1,
        target_claim_version: 1,
        observation_ids: [OBSERVATION_A],
      },
    };
    assert.equal(relation(warrantedRelation), true, JSON.stringify(relation.errors));

    // 4. Model discovery alone never warrants a canonical edge.
    assert.equal(relation({
      ...warrantedRelation,
      provenance: { ...warrantedRelation.provenance, origin: 'model' },
    }), false);

    // 5. Page-endorsement previews are reads and do not consume OperationIds.
    const validPreview = {
      target: 'page_retrieval',
      author: 'user',
      reason: 'Review the endorsement cascade.',
      actor_id: 'user:owner',
      dry_run: true,
    };
    assert.equal(revise(validPreview), true, JSON.stringify(revise.errors));

    // 6. A dry-run carrying an OperationId is rejected by the frozen wire contract.
    assert.equal(revise({ ...validPreview, operation_id: OPERATION_A }), false);

    // 7. An empty but structurally complete context bundle is valid.
    assert.equal(contextBundle({
      seeds: [],
      outbound_relations: [],
      inbound_relations: [],
      provenance: [],
    }), true, JSON.stringify(contextBundle.errors));
  });
});
