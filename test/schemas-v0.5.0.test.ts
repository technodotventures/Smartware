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
const TOMBSTONE_A = `tomb_${ULID_A}`;
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

  test('tombstone-frontmatter: the snapshot carries the claim record envelope', () => {
    const ajv = createAjv();
    const tombstone = validator(ajv, 'tombstone-frontmatter.schema.json');

    const tombstoneFor = (snapshot: Record<string, unknown>) => ({
      tombstone_id: TOMBSTONE_A,
      claim_id: CLAIM_A,
      forgotten_at: NOW,
      forgotten_by: 'user:owner',
      operation_id: OPERATION_A,
      reason: 'the client asked us to stop keeping this.',
      snapshot,
      blast_radius_summary: {
        pages_affected: 0,
        agent_blocks_marked: 0,
        user_pages_notified: 0,
      },
      affected_pages: [],
    });

    // Control: a snapshot of an ordinary active version — the envelope fields absent, not
    // merely falsy — still validates. The fields are additive; nothing written before this
    // change stops validating.
    assert.equal(tombstone(tombstoneFor(activeClaim())), true, JSON.stringify(tombstone.errors));

    // 1. A demoted duplicate can be forgotten: the snapshot keeps the demotion pair, so the
    //    forgotten version is still reconstructible from the tombstone alone.
    assert.equal(tombstone(tombstoneFor({
      ...activeClaim(),
      superseded_by: CLAIM_B,
      superseded_at: NOW,
    })), true, JSON.stringify(tombstone.errors));

    // 2. ...and a user-warranted demotion keeps its warrant (REVISE repick_survivor).
    assert.equal(tombstone(tombstoneFor({
      ...activeClaim(),
      superseded_by: CLAIM_B,
      superseded_at: NOW,
      superseded_by_origin: 'user',
    })), true, JSON.stringify(tombstone.errors));

    // 3. A version that released a demotion keeps its audit-only marker.
    assert.equal(tombstone(tombstoneFor({
      ...activeClaim(),
      version: 2,
      supersedes: 1,
      reinstated_by: 'user',
    })), true, JSON.stringify(tombstone.errors));

    // 4. Both warrants are closed enums, not free text — a tombstone cannot launder a
    //    mechanical ('model') demotion into a user warrant, or vice versa.
    assert.equal(tombstone(tombstoneFor({ ...activeClaim(), superseded_by_origin: 'model' })), false);
    assert.equal(tombstone(tombstoneFor({ ...activeClaim(), reinstated_by: 'agent' })), false);

    // 5. The snapshot block stays closed: an unenumerated field is still rejected.
    assert.equal(tombstone(tombstoneFor({ ...activeClaim(), invented_field: true })), false);
  });

  test('tombstone-frontmatter snapshot mirrors the claim schema envelope field-for-field', () => {
    const readSchema = (file: string): Record<string, unknown> =>
      JSON.parse(readFileSync(path.join(schemaDir, file), 'utf8')) as Record<string, unknown>;
    const claimProperties = readSchema('claim.schema.json').properties as Record<string, unknown>;
    const tombstoneProperties = readSchema('tombstone-frontmatter.schema.json')
      .properties as Record<string, unknown>;
    const snapshotProperties = (tombstoneProperties.snapshot as Record<string, unknown>)
      .properties as Record<string, unknown>;

    // Same definitions, same descriptions: the snapshot is a claim version, so the two blocks
    // must not drift apart as the envelope grows.
    for (const field of ['superseded_by', 'superseded_at', 'superseded_by_origin', 'reinstated_by']) {
      assert.ok(claimProperties[field], `claim.schema.json does not define ${field}`);
      assert.deepEqual(
        snapshotProperties[field],
        claimProperties[field],
        `${field} must mirror claim.schema.json`,
      );
    }

    // Every field the claim schema requires is enumerated (the block's own promise), and the
    // forget-only fields stay out (the snapshot is of an active version).
    const claimRequired = readSchema('claim.schema.json').required as string[];
    for (const field of claimRequired) {
      assert.ok(snapshotProperties[field], `snapshot does not enumerate required field ${field}`);
    }
    for (const field of ['tombstone_id', 'forgotten_at', 'forgotten_by']) {
      assert.equal(snapshotProperties[field], undefined);
    }
  });

  test('claim.schema.json: a forgotten version names the version it replaces only when there is one', () => {
    // ADR-0012. The forgotten branch used to require `supersedes` unconditionally, which made a
    // version-1 forgotten record unrepresentable — but a claim can be *born* forgotten: the legacy /
    // migration shape (`status: 'retracted'`, no prior canonical line) is what `ClaimStore.insertClaim`
    // appends on the retraction paths, what `src/layer1/tombstone-backfill.ts` reads, and what LC-04
    // reconstruction rebuilds from a backfilled tombstone. Measured on kanban t_3ba3ee39: the writer
    // has no valid value to write there (`supersedes: 0` violates `minimum: 1`), so the branch, not the
    // writer, was the wrong side. The version rule is untouched: every version > 1 still names its
    // predecessor, in every state.
    const ajv = createAjv();
    const claim = validator(ajv, 'claim.schema.json');
    const readClaimSchema = (): Record<string, any> =>
      JSON.parse(readFileSync(path.join(schemaDir, 'claim.schema.json'), 'utf8')) as Record<string, any>;

    const forgottenOf = (version: number, extra: Record<string, unknown> = {}) => ({
      ...activeClaim(),
      version,
      state: 'forgotten',
      tombstone_id: TOMBSTONE_A,
      forgotten_at: NOW,
      forgotten_by: 'user:owner',
      ...extra,
    });
    const withoutContent = (record: Record<string, unknown>) => {
      const { content: _content, ...rest } = record;
      return rest;
    };

    // 1. A version-1 forgotten record is conformant with and without the field...
    assert.equal(claim(withoutContent(forgottenOf(1))), true, JSON.stringify(claim.errors));
    assert.equal(claim(withoutContent(forgottenOf(1, { supersedes: 1 }))), true,
      JSON.stringify(claim.errors));
    // ...and the field keeps its published domain when it is present: `supersedes: 0` is not a way to
    // satisfy the old requirement, which is why the writer could not have fixed this half.
    assert.equal(claim(withoutContent(forgottenOf(1, { supersedes: 0 }))), false);

    // 2. Every version > 1 still requires it — forgotten or not (the third branch).
    assert.equal(claim(withoutContent(forgottenOf(2))), false,
      'a v2 forgotten record must name the version it replaced');
    assert.equal(claim(withoutContent(forgottenOf(2, { supersedes: 1 }))), true,
      JSON.stringify(claim.errors));
    assert.equal(claim({ ...activeClaim(), version: 2 }), false, 'a v2 active record must name it too');
    assert.equal(claim({ ...activeClaim(), version: 2, supersedes: 1 }), true,
      JSON.stringify(claim.errors));

    // 3. The branch relaxed exactly one entry: the forget-specific fields stay required, and the
    //    published property description still states the version rule the branches enforce.
    const branches = readClaimSchema().allOf as Array<Record<string, any>>;
    const forgottenBranch = branches.find(
      branch => branch.if?.properties?.state?.const === 'forgotten')!;
    assert.ok(forgottenBranch, 'the forgotten branch must still exist');
    assert.deepEqual(forgottenBranch.then.required, ['tombstone_id', 'forgotten_at', 'forgotten_by']);
    for (const field of ['tombstone_id', 'forgotten_at', 'forgotten_by']) {
      const incomplete = withoutContent(forgottenOf(1));
      delete (incomplete as Record<string, unknown>)[field];
      assert.equal(claim(incomplete), false, `${field} must stay required on a forgotten version`);
    }
    const described = (readClaimSchema().properties as Record<string, any>)
      .supersedes.description as string;
    assert.match(described, /Required for version > 1/);
  });
});
