import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, test } from 'vitest';

const schemaDir = path.join(process.cwd(), 'schemas', 'v0.5.0');
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
  const id = `https://smartware.dev/schemas/v0.5.0/${filename}`;
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

function activeClaim(scope = 'workspace') {
  return {
    claim_id: CLAIM_A,
    version: 1,
    state: 'active',
    content: 'Smartware owns retrieval semantics.',
    scope,
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

describe('Smartware v0.5.0 schemas', () => {
  test('all 16 versioned schemas compile together', () => {
    assert.equal(schemaFiles.length, 16);
    assert.doesNotThrow(() => createAjv());
  });

  test('v0.4.2 normative fixtures still hold (five-verb surface unchanged)', () => {
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

  test('Scope pattern admits client scopes and rejects markers/wildcards (§10b.6)', () => {
    const ajv = createAjv();
    const claim = validator(ajv, 'claim.schema.json');
    const observe = validator(ajv, 'observation.schema.json');
    const common = ajv.getSchema('https://smartware.dev/schemas/v0.5.0/common.schema.json#/$defs/Scope');
    assert.ok(common, 'Scope $def registered');

    const validScopes = [
      'self',
      'workspace',
      'project:retrieval',
      'agent:coffee-assistant',
      'client:acme',
      'client:acme#1',
      'client:bcau#2',
      'client:gate#12',
    ];
    for (const scope of validScopes) {
      assert.equal(common(scope), true, `Scope should accept ${scope}`);
      assert.equal(claim(activeClaim(scope)), true, `claim with scope ${scope} should validate`);
    }

    const invalidScopes = [
      'client:',           // empty id
      'client:acme#',      // no marker number
      'client:acme#0',     // n >= 1 (no leading-zero / zero markers)
      'client:acme#01',    // leading zero
      'client:acme#x',     // non-numeric marker
      'client:*',          // grant wildcard, never a scope id
      'client/*',          // prefix wildcard, never a scope id
      'client:acme#*',     // marker wildcard, never a scope id
      'Client:acme#1',     // uppercase is not a scope slug
    ];
    for (const scope of invalidScopes) {
      assert.equal(common(scope), false, `Scope should reject ${scope}`);
      assert.equal(claim(activeClaim(scope)), false, `claim with scope ${scope} should fail`);
    }

    // observation references the same Scope $def.
    const validObs = {
      observation_id: OBSERVATION_A,
      source: 'coffee',
      scope: 'client:acme#1',
      content: 'Acme moved to a quarterly review cadence.',
      metadata: { timestamp: NOW, actor: 'person' },
      operation_id: OPERATION_A,
      actor_id: 'user:ava',
    };
    assert.equal(observe(validObs), true, JSON.stringify(observe.errors));
    assert.equal(observe({ ...validObs, scope: 'client:acme#0' }), false);
  });

  test('operation-log-entry op enum gains forget.scope', () => {
    const ajv = createAjv();
    const opsEntry = validator(ajv, 'operation-log-entry.schema.json');

    const forgetScopeEntry = {
      operation_id: OPERATION_A,
      actor_id: 'user:ava',
      timestamp: NOW,
      op: 'forget.scope',
      details: {
        payload_hash: 'abc123',
        audit_observation_id: OBSERVATION_A,
        observation_hash: 'def456',
        scope: 'client:gate#1',
        reason: 'erasure',
        claims_retracted: 12,
        observations_retracted: 4,
        grants_revoked: ['grant_01kxw9f2v5'],
        scope_entry_removed: true,
      },
    };
    assert.equal(opsEntry(forgetScopeEntry), true, JSON.stringify(opsEntry.errors));
    assert.equal(opsEntry({ ...forgetScopeEntry, op: 'forget.scope.evil' }), false);
  });

  test('forget-scope-request: reason semantics and owner pointer rules', () => {
    const ajv = createAjv();
    const forgetScope = validator(ajv, 'forget-scope-request.schema.json');

    const base = {
      scope: 'client:acme#1',
      reason: 'erasure',
      operation_id: OPERATION_A,
      actor_id: 'user:ava',
    };

    // 1. erasure (no pointer) is valid.
    assert.equal(forgetScope(base), true, JSON.stringify(forgetScope.errors));

    // 2. offboarding with an owner-approved non-PII pointer is valid.
    assert.equal(forgetScope({
      ...base,
      reason: 'offboarding',
      owner_pointer: 'client since 2023, 4 jobs, no disputes',
    }), true, JSON.stringify(forgetScope.errors));

    // 3. erasure MUST NOT carry a pointer (no silent resurrection).
    assert.equal(forgetScope({ ...base, owner_pointer: 'client since 2023' }), false);

    // 4. reason is a closed enum.
    assert.equal(forgetScope({ ...base, reason: 'archive' }), false);

    // 5. operation_id is required (externally requested mutation).
    const missingOp = { ...base };
    delete (missingOp as Partial<typeof base>).operation_id;
    assert.equal(forgetScope(missingOp), false);

    // 6. client marker ids only — pod-internal scopes are rejected by the
    //    handler and the Scope $def (schema-level: `self` is a valid scope id,
    //    so authority remains a handler rule; spellings that ARE scopes pass).
    // 7. additional properties are rejected (payload is closed).
    assert.equal(forgetScope({ ...base, extra: true }), false);
  });
  test('claim.schema.json enumerates the extraction materialization block the L1 record writer appends', () => {
    const ajv = createAjv();
    const claim = validator(ajv, 'claim.schema.json');

    // Control: a version without the block is fully conformant — the block is optional, and every
    // record written before v0.6 omits it.
    assert.equal(claim(activeClaim()), true, JSON.stringify(claim.errors));

    // The block the record writer appends on an active version (`ClaimSemanticMaterialization`,
    // fixed by kanban t_229601e4): the structured extraction beside the admitted, reduced fields.
    const semantic = {
      subject_name: 'Graphiti API',
      subject_type: 'tool',
      predicate: 'status_is',
      object: { type: 'enum', value: 'deployed' },
      t_valid_from: { value: NOW, state: 'inferred', basis: 'source_observed_at' },
      t_valid_to: { value: null, state: 'null' },
      extracted_epistemic: 'observed',
      extracted_confidence: 0.85,
      sensitive: false,
      extraction: {
        method: 'deterministic',
        model: null,
        compiler_version: '0.6.1',
        prompt_hash: null,
        extracted_at: NOW,
      },
    };
    assert.equal(claim({ ...activeClaim(), semantic }), true, JSON.stringify(claim.errors));

    // The block preserves the raw values the admitted fields reduce: an extraction confidence that
    // is not on the bucket grid (the record writer copies the caller's number verbatim) and a
    // label stronger than the claim's bounded tag both stay valid.
    assert.equal(claim({
      ...activeClaim(),
      confidence: 'high',
      epistemic_tag: 'fact',
      semantic: { ...semantic, extracted_confidence: 1.5, extracted_epistemic: 'user_confirmed' },
    }), true, JSON.stringify(claim.errors));

    // Closed block: an unenumerated subfield is rejected rather than silently carried.
    assert.equal(claim({ ...activeClaim(), semantic: { ...semantic, invented_field: true } }), false);
    // ...and every subfield is required once the block is present.
    const { predicate: _predicate, ...withoutPredicate } = semantic;
    assert.equal(claim({ ...activeClaim(), semantic: withoutPredicate }), false);
    // The typed value and the valid-time shape are closed too.
    assert.equal(claim({
      ...activeClaim(),
      semantic: { ...semantic, object: { type: 'tool', value: 'deployed' } },
    }), false);
    assert.equal(claim({
      ...activeClaim(),
      semantic: { ...semantic, t_valid_to: { value: NOW, state: 'unknown' } },
    }), false);
    // A pass-through extraction date without a time is tolerated (the LLM path copies the model's
    // `validity.from`), but a non-string valid-time value is not.
    assert.equal(claim({
      ...activeClaim(),
      semantic: { ...semantic, t_valid_from: { value: '2026-01-05', state: 'known' } },
    }), true, JSON.stringify(claim.errors));
    assert.equal(claim({
      ...activeClaim(),
      semantic: { ...semantic, t_valid_from: { value: 20260105, state: 'known' } },
    }), false);
    assert.equal(claim({
      ...activeClaim(),
      semantic: { ...semantic, t_valid_from: { value: NOW, state: 'known', basis: 7 } },
    }), false, 'the valid-time basis is a string label, not free data');
  });
});
