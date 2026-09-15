// L2 page frontmatter ↔ page-frontmatter.schema.json boundary pin
// (ADR-0013, kanban t_0920aa1d).
//
// Unlike the L0 line, this is NOT a different artifact: the compiler writes the L2
// page spec §5/§9 describes — `wiki/concepts|entities|decisions/<slug>.md`, a
// `page_<slug>` id, the two-region body, voice protection, `notices`/`supporting_claims`
// semantics — and `page-frontmatter.schema.json` is that page's frontmatter contract
// (the spec §9 field set verbatim). The writer is the side that is wrong, in the same
// class as the tombstone backfill (`t_9e124fe6`): one in-tree writer, one published
// schema for the same artifact, a rejected shape.
//
// This file pins the divergence precisely enough that the carded writer fix cannot land
// half-done, and fails loudly when it lands (which is the signal to invert these
// assertions and update the README section "Which schema covers which surface"):
//
//   - the schema's subject is asserted POSITIVELY — the spec §9 projection of the very
//     frontmatter the compiler just wrote validates, so the contract is this artifact;
//   - the exact rejection list is asserted, so neither side can drift silently.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, test } from 'vitest';

import { SmartwareCore } from '../../src/core.js';
import { parseFrontmatter } from '../../src/layer2/frontmatter.js';
import { confidenceToBucket, epistemicToTag, type ClaimStatus, type EpistemicLabel } from '../../src/layer1/types.js';

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

/**
 * Project the compiler's frontmatter onto the spec §9 field set. Pure renaming and
 * derivation through the library's own mappings (the same `confidenceToBucket` /
 * `epistemicToTag` the tombstone writer already uses) — no new information.
 */
function specProjection(fm: Record<string, unknown>): Record<string, unknown> {
  return {
    title: fm['title'],
    page_id: fm['page_id'],
    category: typeof fm['category'] === 'string' ? (fm['category'] as string).replace(/s$/, '') : fm['category'],
    author: fm['author'],
    sources: fm['sources_claim_ids'] ?? fm['claim_ids'],
    supporting_claims: fm['supporting_claims'],
    created: typeof fm['compiled_at'] === 'string' ? (fm['compiled_at'] as string).slice(0, 10) : undefined,
    updated: typeof fm['updated'] === 'string' ? (fm['updated'] as string).slice(0, 10) : undefined,
    scope: fm['scope'],
    confidence: typeof fm['confidence'] === 'number'
      ? confidenceToBucket(fm['confidence'] as number)
      : fm['confidence'],
    epistemic_tag: typeof fm['epistemic'] === 'string'
      ? epistemicToTag(fm['epistemic'] as EpistemicLabel, 'active' as ClaimStatus)
      : fm['epistemic'],
    summary: fm['summary'],
  };
}

describe('compiled L2 page frontmatter vs page-frontmatter.schema.json', () => {
  test('the schema describes this artifact; the writer emits a rejected shape (disclosed, ADR-0013 → D2)', async () => {
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

    const parsed = parseFrontmatter(readFileSync(pagePath, 'utf8'));
    assert.ok(parsed, 'the compiled page has YAML frontmatter');
    const fm = parsed.frontmatter as unknown as Record<string, unknown>;

    const pageFrontmatter = validator(createAjv(), 'page-frontmatter.schema.json');

    // ── The schema's subject is this artifact ──────────────────────────────
    const projection = specProjection(fm);
    assert.equal(
      pageFrontmatter(projection),
      true,
      `the spec §9 projection of the compiler's own page must validate: ${JSON.stringify(pageFrontmatter.errors)}`,
    );

    // ── The named deltas the writer fix has to close ────────────────────────
    assert.equal(fm['created'], undefined, '`created` is missing entirely (the schema requires it)');
    assert.equal(fm['epistemic_tag'], undefined, '`epistemic_tag` is missing (the writer uses `epistemic`)');
    assert.ok(
      typeof fm['category'] === 'string' && (fm['category'] as string).endsWith('s'),
      '`category` is a plural directory name, the schema enum is singular',
    );
    assert.match(
      String(fm['updated']),
      /T/,
      '`updated` is a full ISO timestamp, the schema requires format: date',
    );
    assert.equal(typeof fm['confidence'], 'number', '`confidence` is numeric, the schema requires a bucket');
    assert.ok(
      Array.isArray(fm['sources']) && /^obs_/.test(String((fm['sources'] as unknown[])[0] ?? '')),
      'the writer\'s `sources` carries ObservationIds; the schema\'s `sources` is a ClaimId list',
    );

    // ── The exact disclosed rejection list ─────────────────────────────────
    assert.deepEqual(
      errorKeys(pageFrontmatter, fm),
      [
        '/:additionalProperties:claim_ids',
        '/:additionalProperties:compiled_at',
        '/:additionalProperties:compiled_by',
        '/:additionalProperties:entity',
        '/:additionalProperties:entity_id',
        '/:additionalProperties:epistemic',
        '/:additionalProperties:model',
        '/:additionalProperties:related',
        '/:additionalProperties:sensitive',
        '/:additionalProperties:sources_claim_ids',
        '/:additionalProperties:supersedes',
        '/:additionalProperties:type',
        '/:required:created',
        '/:required:epistemic_tag',
        '/category:enum',
        '/confidence:enum',
        '/confidence:type',
        '/sources/0:pattern',
        '/updated:format',
      ].sort(),
      'the L2 page frontmatter divergence changed — if the writer fix landed, invert the '
      + 'assertions above and update the README "Which schema covers which surface" section '
      + '(ADR-0013 → D2) rather than relaxing this pin',
    );
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
  }, 120_000);
});
