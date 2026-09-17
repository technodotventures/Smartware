// Tests: Layer 1 — which schema covers the canonical claim record, and the EXPORT.SCOPE copy of it
// (ADR-0013 → *Delta 2026-09-16 — the L1 claims record*, kanban t_11fed5bb)
//
// Why these exist: `<dataDir>/claims/<yyyy-mm>.jsonl` is the canonical L1 surface, and EXPORT.SCOPE
// ships the same lines verbatim as `claims.jsonl` in a package whose `manifest.json` names a schema
// set (`manifest.schemas`). Two artifacts are easy to confuse here — a *wire/intent* view of a claim
// and the *record* the writer appends — and the packaged release the Coffee gate reviewed
// (`wt/t_9740ae98` @ `e937fab`, kanban t_66f1dd7d) emitted records that failed the published schema
// in exactly two ways: an undeclared `semantic` block (present on the ordinary write path, declared
// in no set) and `op_LEGACY00000000000000000000`, which the published `OperationId` pattern rejects.
//
// The boundary decided there (ADR-0013 → Delta; ADR-0011 for the block, ADR-0014 for the version
// field) is pinned here in BOTH directions:
//
//   * the record — canonical and exported — is covered by `claim.schema.json` (the file, not just
//     "some schema in the set"), and no other schema may claim it;
//   * the record envelope is exactly the schema's enumerated property set, and the schema stays
//     closed at the root and inside `semantic`: a new writer field, or a relaxed schema, fails;
//   * the two divergences the gate measured are asserted CLOSED, so neither can reopen silently;
//   * the still-open, carded half — a `version >= 2` or born-forgotten record omitting `supersedes`
//     (kanban t_3ba3ee39, ADR-0014) — is asserted as its EXACT residual error list, so this file
//     fails loudly when that fix composes rather than letting the answer drift.
//
// Measurements behind these numbers (raw JSONL off disk, Ajv 2020 complete error list):
// `attachments/t_11fed5bb/l1-record-boundary.probe.test.ts` on the kanban board — the instrument is a
// card attachment, not a repo file (it ran from this card's workspace, `workspaces/t_11fed5bb/`); the
// report it wrote is `attachments/t_11fed5bb/probe-report.json`, same directory.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { SmartwareCore } from '../../src/core.js';
import { saveConfig, type SmartwareConfig } from '../../src/config.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex } from '../../src/layer3/search.js';
import { knownTime, nullTime, type Claim } from '../../src/layer1/types.js';

/** The L1 record's published validator lives in the v0.5.0 set; v0.5.1 is that set plus one file. */
const RECORD_SCHEMA_SET = 'v0.5.0';
const RECORD_SCHEMA_FILE = 'claim.schema.json';
const SCHEMA_SETS = ['v0.5.0', 'v0.5.1'];

/** The literal `insertClaim` stamped before kanban t_85817375 — 26 chars, one of them an `L`. */
const PRE_FIX_PLACEHOLDER = 'op_LEGACY00000000000000000000';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const GIGI = { type: 'person' as const, id: 'user:gigi', display_name: 'Gigi' };
const ACME = 'client:acme#1';
const REAL_OP = 'op_01J8ZQK7V5P8M2N4R6T9W3XYBD';
const AT = '2026-01-05T09:00:00.000Z';

function schemaDir(set: string): string {
  return path.join(process.cwd(), 'schemas', set);
}

function readSchema(set: string, filename: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(schemaDir(set), filename), 'utf8')) as Record<string, any>;
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  for (const set of SCHEMA_SETS) {
    const dir = schemaDir(set);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.schema.json')).sort()) {
      ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as AnySchema);
    }
  }
  return ajv;
}

function validator(ajv: Ajv2020, set: string, filename: string): ValidateFunction {
  const id = `https://smartware.dev/schemas/${set}/${filename}`;
  const validate = ajv.getSchema(id);
  assert.ok(validate, `schema not registered: ${id}`);
  return validate;
}

/** The complete error list as sorted `instancePath:keyword[:property]` keys — nothing filtered out. */
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
 * The set a package's manifest names, resolved to the file that covers its `claims.jsonl` lines.
 * v0.5.0 holds `claim.schema.json` itself; v0.5.1 is documented as that set plus the L0 record
 * schema, so the claim record is still covered by the v0.5.0 file.
 */
function recordSchemaForManifestSet(set: string): { set: string; file: string } {
  if (fs.existsSync(path.join(schemaDir(set), RECORD_SCHEMA_FILE))) {
    return { set, file: RECORD_SCHEMA_FILE };
  }
  assert.ok(
    fs.existsSync(path.join(schemaDir(RECORD_SCHEMA_SET), RECORD_SCHEMA_FILE)),
    `manifest names schema set '${set}', which holds no ${RECORD_SCHEMA_FILE}`,
  );
  return { set: RECORD_SCHEMA_SET, file: RECORD_SCHEMA_FILE };
}

function coffeeConfig(dataDir: string): SmartwareConfig {
  return {
    instance_id: `smartware_${ulid()}`,
    owner_id: 'user:owner',
    writer_id: `writer_local_${ulid()}`,
    version: '0.6.3',
    data_dir: dataDir,
    scopes: [
      { id: 'self', parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: ACME, parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [
      {
        id: `grant_${ulid()}`,
        actor_type: 'person',
        actor_id: 'user:gigi',
        capabilities: { observe: [ACME], query: [ACME], compile: [ACME], correct: [], forget: [], read: [ACME] },
        trusted: false,
        quarantine: false,
        created_at: '2026-08-29T09:00:00.000Z',
        expires_at: null,
        status: 'active',
      },
    ],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
}

interface Fixture {
  dataDir: string;
  core: SmartwareCore;
  store: ClaimStore;
  searchIndex: SearchIndex;
}

const fixtures: Fixture[] = [];

async function newFixture(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-l1-boundary-'));
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  saveConfig(dataDir, coffeeConfig(dataDir));
  const core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);
  const fx = { dataDir, core, store, searchIndex };
  fixtures.push(fx);
  return fx;
}

afterAll(() => {
  for (const fx of fixtures.splice(0)) {
    fx.store.close();
    fx.searchIndex.close();
    fx.core.close();
    fs.rmSync(fx.dataDir, { recursive: true, force: true });
  }
});

/** The Coffee fixture's canonical claim shape (kanban t_1489413 pattern): a real, typed assertion. */
function claimFor(overrides: Partial<Claim> = {}): Claim {
  return {
    id: `claim_${ulid()}`,
    subject_id: 'entity_acme_boundary',
    subject_name: 'Acme',
    predicate: 'deadline_is',
    object: { type: 'date', value: '2026-02-01' },
    scope: ACME,
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
    operation_id: REAL_OP,
    actor_id: 'user:gigi',
    relations: [],
    ...overrides,
  };
}

function seedSubject(fx: Fixture): void {
  fx.store.insertEntity({
    id: 'entity_acme_boundary',
    canonical_name: 'Acme',
    aliases: [],
    type: 'organization',
    scope: ACME,
    created_at: AT,
  });
}

interface RawLine {
  file: string;
  line: number;
  record: Record<string, any>;
  raw: string;
}

/** The canonical surface, read as bytes — no library reader between the disk and the assertion. */
function canonicalLines(dataDir: string): RawLine[] {
  const dir = path.join(dataDir, 'claims');
  if (!fs.existsSync(dir)) return [];
  const out: RawLine[] = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).forEach((raw, i) => {
      out.push({ file, line: i + 1, record: JSON.parse(raw) as Record<string, any>, raw });
    });
  }
  return out;
}

describe('which schema covers the canonical L1 claim record, and the copy EXPORT.SCOPE ships', () => {
  let fx: Fixture;
  let ajv: Ajv2020;
  let validate: ValidateFunction;
  /** Every line the ordinary write path appended, read as bytes, written once for the whole file. */
  let lines: RawLine[];

  /**
   * Every record the ordinary write path appends: a caller-supplied OperationId (the normal case), a
   * demoted copy (the §1e duplicate resolution), the legacy marker when the caller mints none, and
   * the claim `reflect.auto` itself creates end to end.
   */
  function writeOrdinaryRecords(): void {
    seedSubject(fx);
    fx.store.insertClaim(claimFor());
    fx.store.insertClaim(claimFor({
      id: `claim_${ulid()}`,
      status: 'superseded',
      superseded_by: `claim_${ulid()}`,
      t_invalidated: knownTime('2026-01-06T09:00:00.000Z'),
    }));
    fx.store.insertClaim(claimFor({ id: `claim_${ulid()}`, operation_id: null, actor_id: null }));
  }

  // One heavy setup for the file (a Core open + a Coffee config + Ajv over both sets) and one flow:
  // the per-test budget on this host is 30 s and the default hook budget 10 s.
  beforeAll(async () => {
    fx = await newFixture();
    ajv = createAjv();
    validate = validator(ajv, RECORD_SCHEMA_SET, RECORD_SCHEMA_FILE);
    writeOrdinaryRecords();
    await fx.core.observe({
      actor: GIGI,
      type: 'message',
      scope: ACME,
      observed_at: '2026-01-09T09:00:00Z',
      content: { format: 'text/plain', body: 'Acme status is active.' },
    });
    await fx.core.reflect({ actor: GIGI, scope: ACME, use_llm: false });
    lines = canonicalLines(fx.dataDir);
  }, 180_000);

  test('the ordinary write path emits records claim.schema.json accepts, whole list empty', () => {
    expect(lines.length).toBeGreaterThanOrEqual(4); // 3 seeded + whatever reflect claimed
    for (const line of lines) {
      // The whole list, not a filtered slice: a second divergence cannot hide behind a known one.
      expect({ line: `${line.file}:${line.line}`, errors: errorKeys(validate, line.record) })
        .toEqual({ line: `${line.file}:${line.line}`, errors: [] });
      expect(line.record.state).toBe('active');
      // The block the gate found present on the ordinary path and declared in no schema (t_66f1dd7d §3 B2).
      expect('semantic' in line.record).toBe(true);
    }
  });

  test('the record envelope is exactly the schema\'s enumerated property set', () => {
    const claimSchema = readSchema(RECORD_SCHEMA_SET, RECORD_SCHEMA_FILE);
    const declared = new Set(Object.keys(claimSchema.properties as Record<string, unknown>));
    const required = claimSchema.required as string[];

    for (const line of lines) {
      const undeclared = Object.keys(line.record).filter(key => !declared.has(key));
      expect({ claim: line.record.claim_id, undeclared }).toEqual({ claim: line.record.claim_id, undeclared: [] });
      const missing = required.filter(key => !(key in line.record));
      expect({ claim: line.record.claim_id, missing }).toEqual({ claim: line.record.claim_id, missing: [] });
    }
  });

  test('the schema stays closed — at the root and inside the materialization block', () => {
    const record = lines[0]!.record;
    const claimSchema = readSchema(RECORD_SCHEMA_SET, RECORD_SCHEMA_FILE);

    // Root: the envelope cannot be widened by a writer that adds a field.
    expect(claimSchema.additionalProperties).toBe(false);
    expect(errorKeys(validate, { ...record, invented_field: true }))
      .toEqual(['/:additionalProperties:invented_field']);

    // The block is declared (ADR-0011) and closed, and it is optional: a pre-v0.6 record omits it.
    const block = (claimSchema.properties as Record<string, any>).semantic as Record<string, any>;
    expect(block).toBeDefined();
    expect(block.additionalProperties).toBe(false);
    expect(errorKeys(validate, { ...record, semantic: { ...record.semantic, invented_field: true } }))
      .toEqual(['/semantic:additionalProperties:invented_field']);
    const { semantic: _block, ...withoutBlock } = record;
    expect(errorKeys(validate, withoutBlock)).toEqual([]);
  });

  test('no other schema in the published sets claims the L1 record — one artifact, one schema', () => {
    const claiming: string[] = [];
    for (const set of SCHEMA_SETS) {
      const dir = schemaDir(set);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.schema.json'))) {
        if (file === RECORD_SCHEMA_FILE) continue;
        if (fs.readFileSync(path.join(dir, file), 'utf8').includes(RECORD_SCHEMA_FILE)) {
          claiming.push(`${set}/${file}`);
        }
      }
    }
    expect(claiming).toEqual([]);
  });

  test('every emitted record carries an OperationId the published pattern accepts', () => {
    const pattern = new RegExp(readSchema(RECORD_SCHEMA_SET, 'common.schema.json').$defs.OperationId.pattern as string);
    for (const line of lines) {
      expect(String(line.record.operation_id)).toMatch(pattern);
      expect(errorKeys(validate, line.record).filter(key => key.startsWith('/operation_id'))).toEqual([]);
    }
    // The literal the packaged build stamped (kanban t_66f1dd7d §3 B2) fails the pattern it had to satisfy.
    expect(PRE_FIX_PLACEHOLDER).toHaveLength(29);
    expect(PRE_FIX_PLACEHOLDER).not.toMatch(pattern);
    // A record with no caller OperationId is still a record the contract accepts (t_85817375).
    expect(lines.some(line => line.record.operation_id === 'op_000000000000000000000000A3')).toBe(true);
  });

  test('EXPORT.SCOPE ships those lines verbatim, under a manifest set that covers them', async () => {
    const exported = await fx.core.exportScope({ actor: OWNER, scope: ACME, operation_id: REAL_OP });
    const packageLines = fs.readFileSync(path.join(exported.path, 'claims.jsonl'), 'utf8').split('\n').filter(Boolean);

    expect(packageLines).toHaveLength(exported.manifest.counts.claims);
    expect(exported.manifest.counts.claims).toBe(lines.length);
    for (const raw of packageLines) {
      // Byte-identical: the package carries the canonical record, not a projection of it.
      expect(lines.map(line => line.raw)).toContain(raw);
    }

    const resolved = recordSchemaForManifestSet(exported.manifest.schemas);
    const packageValidator = validator(ajv, resolved.set, resolved.file);
    for (const raw of packageLines) {
      expect(errorKeys(packageValidator, JSON.parse(raw) as Record<string, unknown>)).toEqual([]);
    }
  });

  /**
   * The one half this lane cannot close: `insertClaim` omits `supersedes` on a `version >= 2` record
   * and on a born-forgotten (version 1, state forgotten) record, while the schema's `if version >= 2`
   * branch requires it in every state. Decided and fixed on kanban t_3ba3ee39 (ADR-0014, branch
   * `wip/smarty/l1-forgotten-supersedes`) — not composed on this lane. Asserted as the EXACT residual,
   * so a third divergence cannot hide behind it and this file fails loudly when the fix lands: invert
   * it to an empty list then.
   */
  test('carded residual (t_3ba3ee39): a version >= 2 or born-forgotten record omits `supersedes`', async () => {
    const extra = await newFixture();
    seedSubject(extra);
    const first = claimFor();
    extra.store.insertClaim(first);
    extra.store.insertClaim(claimFor({ id: first.id, object: { type: 'date', value: '2026-03-01' } }));
    extra.store.insertClaim(claimFor({ id: `claim_${ulid()}`, status: 'retracted', state: 'forgotten' }));

    const written = canonicalLines(extra.dataDir);
    const v2 = written.find(line => line.record.version === 2);
    const forgotten = written.find(line => line.record.state === 'forgotten');
    assert.ok(v2, 'the second version was written');
    assert.ok(forgotten, 'the forgotten version was written');

    const CARDED = ['/:if', '/:required:supersedes'];
    expect({ v2: errorKeys(validate, v2.record) }).toEqual({ v2: CARDED });
    expect({ forgotten: errorKeys(validate, forgotten.record) }).toEqual({ forgotten: CARDED });
    // The version rule itself is not in question: once the writer names the version it replaces, the
    // record validates (asserted on the hand-built shape here, so this stays true after the fix lands).
    expect(errorKeys(validate, { ...v2.record, supersedes: 1 })).toEqual([]);
  }, 120_000);
});
