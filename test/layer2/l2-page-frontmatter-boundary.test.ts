// L2 page frontmatter ↔ page-frontmatter.schema.json boundary pin (ADR-0013 → D2).
//
// Originally written for `t_0920aa1d`, which *measured* the divergence: the compiler writes the
// L2 page spec §5/§9 describes — `wiki/concepts|entities|decisions/<slug>.md`, a `page_<slug>`
// id, the two-region body, voice protection, `notices`/`supporting_claims` semantics — and
// `page-frontmatter.schema.json` is that page's frontmatter contract (the spec §9 field set).
// The writer was the side that was wrong, in the tombstone class (`t_9e124fe6`), and this file
// pinned the exact 19-error rejection so the fix could not land half-done.
//
// **The writer fix landed (`t_8d6f4a5c`), so the pin is INVERTED, not deleted:** the compiled
// page's own frontmatter must now validate against the published contract with an EMPTY error
// list, and the compile envelope must live in the page's derived cached region instead of the
// frozen frontmatter. The inverted assertions fail if either writer (COMPILE or ENDORSE)
// re-introduces a rejected shape, and the page-vocabulary test below still holds the boundary
// against the tombstone/profile schemas.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ulid } from 'ulid';
import { afterEach, describe, test } from 'vitest';

import { SmartwareCore } from '../../src/core.js';
import { parseFrontmatter, serialiseFrontmatter } from '../../src/layer2/frontmatter.js';
import { parseEnvelope, readPageFile } from '../../src/layer2/envelope.js';

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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md') && entry.name !== '_index.md') out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Drive observe → reflect → compile over a protocol-native lane and return the page on disk. */
async function compileOnePage(): Promise<{ dataDir: string; pagePath: string; raw: string }> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-l2-boundary-'));
  tempDirs.push(dataDir);
  const core = await SmartwareCore.open({ dataDir });
  let pagePath = '';
  try {
    core.ensureTrustedClientGrant('user:local', 'person', ['self', 'workspace']);
    const actor = { type: 'person' as const, id: 'user:local', display_name: 'Owner' };
    await core.observe({
      actor,
      type: 'message',
      scope: 'workspace',
      observed_at: '2026-11-01T10:30:00Z',
      content: { format: 'text/plain', body: 'Graphiti API is deployed.' },
    });
    await core.reflect({ actor, scope: 'workspace', use_llm: false });
    await core.compile({ actor, scope: 'workspace', use_llm: false });

    const pages = markdownFiles(path.join(dataDir, 'wiki'))
      .filter(file => path.basename(file) !== 'smartware.md'); // instance manifest, no frontmatter
    assert.equal(pages.length, 1, 'the flow compiles exactly one entity page');
    pagePath = pages[0]!;
    assert.match(pagePath, /wiki\/concepts\/[a-z0-9-]+\.md$/);
  } finally {
    core.close();
  }
  return { dataDir, pagePath, raw: readFileSync(pagePath, 'utf8') };
}

describe('compiled L2 page frontmatter vs page-frontmatter.schema.json', () => {
  test('the compiler now writes the published contract: empty error list (ADR-0013 → D2 fix)', async () => {
    const { raw, pagePath } = await compileOnePage();

    const parsed = parseFrontmatter(raw);
    assert.ok(parsed, 'the compiled page has YAML frontmatter');
    const fm = parsed.frontmatter;

    const pageFrontmatter = validator(createAjv(), 'page-frontmatter.schema.json');

    // ── The inverted assertion: the writer's own bytes validate ────────────
    assert.deepEqual(
      errorKeys(pageFrontmatter, fm),
      [],
      'the compiled page frontmatter must validate against the published contract; a non-empty '
      + 'list here means the writer drifted back into the rejected shape (ADR-0013 → D2)',
    );

    // ── The named deltas the fix closed, asserted in the fixed direction ────
    assert.equal(fm['category'], 'concept', '`category` is the schema\'s singular enum value');
    assert.match(String(fm['created']), /^\d{4}-\d{2}-\d{2}$/, '`created` is present as format: date');
    assert.match(String(fm['updated']), /^\d{4}-\d{2}-\d{2}$/, '`updated` is format: date');
    assert.ok(
      ['high', 'medium', 'low'].includes(String(fm['confidence'])),
      '`confidence` is a bucket, not a number',
    );
    assert.ok(
      ['fact', 'inference', 'opinion', 'stale', 'contested'].includes(String(fm['epistemic_tag'])),
      '`epistemic_tag` carries the spec tag (the bespoke `epistemic` label is gone)',
    );
    assert.ok(
      Array.isArray(fm['sources']) && /^claim_/.test(String((fm['sources'] as unknown[])[0] ?? '')),
      '`sources` now holds the page\'s cited ClaimIds — its published meaning',
    );
    assert.equal(fm['sources_claim_ids'], undefined, 'the third name for the claim list is gone');

    // ── The envelope moved to the derived cached region, not the contract ───
    const file = readPageFile(raw);
    assert.ok(file, 'the page is readable in the published shape');
    assert.equal(file.legacy, false, 'the compiler no longer writes the pre-fix envelope inline');
    const envelope = parseEnvelope(raw);
    assert.ok(envelope, 'the compile envelope is present in the page body');
    assert.match(envelope.entity_id, /^entity_/, 'the envelope carries entity identity');
    assert.equal(envelope.compiled_by, 'smartware-compiler');
    assert.match(envelope.compiled_at, /^\d{4}-\d{2}-\d{2}T/, 'the envelope carries `compiled_at`');
    assert.ok(
      envelope.source_observation_ids.every(id => /^obs_/.test(id)),
      'the envelope carries the source ObservationIds (the pre-fix `sources` list)',
    );
    assert.equal(
      fm['entity_id'], undefined,
      '`entity_id` is not part of the frozen page contract (ADR-0013 → D2, part 3)',
    );
    assert.ok(
      raw.includes('## Evidence Timeline'),
      `the envelope lives in the Evidence Timeline region: ${pagePath}`,
    );

    // ── The writer emits no field the contract does not know ───────────────
    const schema = JSON.parse(readFileSync(path.join(schemaDir, 'page-frontmatter.schema.json'), 'utf8')) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    for (const key of Object.keys(fm)) {
      assert.ok(
        Object.hasOwn(schema.properties, key),
        `the writer emits '${key}', which the published page contract does not declare`,
      );
    }
    for (const key of schema.required) {
      assert.ok(Object.hasOwn(fm, key), `the published contract requires '${key}'`);
    }
  }, 120_000);

  test('the endorsed page is written by the contract too (the cascade is a second writer of this artifact)', async () => {
    const { dataDir, pagePath, raw } = await compileOnePage();
    const pageFrontmatter = validator(createAjv(), 'page-frontmatter.schema.json');
    assert.deepEqual(errorKeys(pageFrontmatter, parseFrontmatter(raw)!.frontmatter), []);

    const core = await SmartwareCore.open({ dataDir });
    try {
      const before = parseFrontmatter(raw)!;
      const pageId = String(before.frontmatter['page_id']);
      // End-to-end through the public verb: REVISE on a `page_` id with `author: user`.
      const result = await core.endorse({
        actor: { type: 'person', id: 'user:local', display_name: 'Owner' },
        page_id: pageId,
        page_path: pagePath,
        dry_run: false,
        reason: 'the owner confirms this page',
        operation_id: `op_${ulid()}`,
      });
      assert.equal(result.status, 'endorsed');
    } finally {
      core.close();
    }

    const endorsedRaw = readFileSync(pagePath, 'utf8');
    const endorsed = parseFrontmatter(endorsedRaw)!;
    assert.deepEqual(
      errorKeys(pageFrontmatter, endorsed.frontmatter),
      [],
      'ENDORSE writes the same artifact, so its output must satisfy the same contract — an '
      + 'inline endorsement envelope would put the endorsed page straight back into the rejected class',
    );
    assert.equal(endorsed.frontmatter['author'], 'user');
    assert.deepEqual(endorsed.frontmatter['sources'], parseFrontmatter(raw)!.frontmatter['sources']);

    const envelope = parseEnvelope(endorsedRaw);
    assert.ok(envelope?.endorsement_operation_id, 'the endorsement recovery metadata is in the cached region');
    assert.equal(envelope.endorsed_by, 'user:local');
  }, 120_000);

  test('the page schema vocabulary excludes the tombstone/profile pages that have their own schemas', async () => {
    const read = (name: string): Record<string, unknown> => JSON.parse(
      readFileSync(path.join(schemaDir, name), 'utf8'),
    ) as Record<string, unknown>;
    const page = read('page-frontmatter.schema.json') as { properties: { category: { enum: string[] } } };
    assert.deepEqual(
      page.properties.category.enum,
      ['concept', 'entity', 'decision', 'synthesis'],
      'tombstone/profile pages publish their own frontmatter schemas (ADR-0013 → README table)',
    );

    const profile = read('profile-frontmatter.schema.json') as {
      properties: { category: { const: string } };
      required: string[];
    };
    const tombstone = read('tombstone-frontmatter.schema.json') as { required: string[] };

    assert.equal(profile.properties.category.const, 'profile');
    assert.ok(profile.required.includes('category'));
    // `category: profile` is what makes a profile page fail the page schema's enum —
    // the two schemas are disjoint by design, not by accident.
    const pageFrontmatter = validator(createAjv(), 'page-frontmatter.schema.json');
    assert.equal(pageFrontmatter({
      title: 'Owner',
      page_id: 'page_owner',
      category: 'profile',
      author: 'agent',
      sources: [],
      supporting_claims: [],
      created: '2026-09-15',
      updated: '2026-09-15',
      scope: 'self',
      confidence: 'medium',
      epistemic_tag: 'inference',
      summary: 'A profile page.',
    }), false);
    assert.ok(tombstone.required.includes('tombstone_id'));

    // The compiler only ever writes the four page categories it routes to; the two categories
    // that carry their own schemas are never emitted by COMPILE (ADR-0013 → D2 part 1).
    const compiled = await compileOnePage();
    const category = parseFrontmatter(compiled.raw)!.frontmatter['category'];
    assert.ok(
      ['concept', 'entity', 'decision', 'synthesis'].includes(String(category)),
      `COMPILE emitted category '${String(category)}', which belongs to another schema`,
    );
  }, 120_000);

  test('a page written before the fix is read, not rejected (migration path)', () => {
    // The L2 surface is git-versioned and pages can be user-authored, so a tree that predates
    // the fix keeps working: the compatibility reader reconstructs the envelope from the inline
    // frontmatter, and `sources` is recovered from the pre-fix name for the claim list.
    const wikiDir = mkdtempSync(path.join(os.tmpdir(), 'sw-l2-legacy-'));
    tempDirs.push(wikiDir);
    const pagePath = path.join(wikiDir, 'acme.md');
    const claimIds = [`claim_${ulid()}`, `claim_${ulid()}`];
    writeFileSync(pagePath, serialiseFrontmatter({
      entity_id: 'entity_01M2NAFHDJRTHH8K1BWTN65XZG',
      entity: 'Acme',
      type: 'organisation',
      scope: 'personal',
      epistemic: 'observed',
      sensitive: true,
      sources: ['obs_ffffffffffffffffffffffffffffffff'],
      claim_ids: claimIds,
      sources_claim_ids: claimIds,
      compiled_at: '2026-09-01T00:00:00.000Z',
      compiled_by: 'smartware-compiler',
      confidence: 0.8,
      supersedes: [],
      related: [],
      page_id: 'page_acme',
      title: 'Acme',
      category: 'entities',
      author: 'user',
      updated: '2026-09-01T00:00:00.000Z',
    }, '\n## Current Understanding\n\nUser prose.\n'), 'utf8');

    const file = readPageFile(readFileSync(pagePath, 'utf8'))!;
    assert.equal(file.legacy, true, 'the inline envelope is detected as the pre-fix shape');
    assert.equal(file.envelope?.entity_id, 'entity_01M2NAFHDJRTHH8K1BWTN65XZG');
    assert.equal(file.envelope?.compiled_at, '2026-09-01T00:00:00.000Z');
    assert.deepEqual(file.envelope?.source_observation_ids, ['obs_ffffffffffffffffffffffffffffffff']);
    assert.equal(file.envelope?.sensitive, true);
    assert.deepEqual(
      Object.keys(file.frontmatter).filter(key => key.startsWith('entity') || key === 'compiled_at'),
      ['entity_id', 'entity', 'compiled_at'],
      'the legacy frontmatter is preserved verbatim until the next write upgrades it',
    );
    rmSync(wikiDir, { recursive: true, force: true });
  });
});
