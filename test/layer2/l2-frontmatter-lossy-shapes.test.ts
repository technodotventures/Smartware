// L2 page frontmatter — the serialiser's remaining shapes (decided + pinned as t_cf744a8e).
//
// `src/layer2/frontmatter.ts` is a hand-rolled, deliberately minimal YAML writer/reader. Its
// contract: everything it writes reads back unchanged for the page vocabulary
// (`schemas/v0.5.0/page-frontmatter.schema.json` — strings, string arrays, and arrays of notice
// objects whose values are scalars). t_4d84ff6b closed the `notices` array; this file pins the
// decision on the shapes around it, each measured on the probe
// `attachments/t_cf744a8e/probe-roundtrip-shapes.mjs` against built dists of `5a1c58c` (pre-fix),
// `6d70dee` (t_4d84ff6b tip) and the fix:
//
//   SUPPORTED (writer and reader agree; pinned here)
//   - multi-line string, top level: `toYAML` writes `key: |` + indented lines; the reader's block
//     branch only looked for an array item next, so the key vanished (summary/title are bare
//     `type: string` in the published contract — the strongest argument to carry it, not guard it).
//   - multi-line string in a notice item (`message: |`): same writer shape, dropped inside the item.
//   - the empty string: written `key: ` (and as a bare element in an inline array), which read
//     back as a dropped key / YAML null; now written `""`.
//   - comma inside an inline array element: `aliases` is `array of string` with no pattern, so
//     `["a, b"]` is contract-legal, but the split ran before the unquote and produced two
//     malformed values. The splitter is now quote-aware. A comma-bearing `tags` entry is refused
//     one layer up by the published `Tag` pattern — the serialiser must not corrupt it either way.
//   - quoted scalar block item (`- "a: b"`): `isMappingItem` was quote-blind, so the t_4d84ff6b
//     reader decoded it as `{'"a': 'b"'}` where real YAML reads the string `a: b`.
//   - block scalar as a block-array item (`- |` + lines): the reader kept the marker and dropped
//     the content.
//   - bare `key:` (hand-authored, YAML null): the key used to vanish from the parse; it now reads
//     as null, which the contract's required/typed fields surface as a validation error instead of
//     a silent no-field.
//
//   GUARDED (refused at the write boundary, pinned here)
//   - nested object values, top level and inside a notice item: no page field admits one
//     (`additionalProperties: false`; the notice item's declared properties are scalars), the
//     reader is one-line-per-key with no indentation model, and the measured outcome was the
//     nested key flattening into the parent — the value is lost. `serialiseFrontmatter` throws
//     with the offending page field in the message instead.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, test } from 'vitest';

import { parseFrontmatter, serialiseFrontmatter } from '../../src/layer2/frontmatter.js';

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

const CLAIM_ID = 'claim_01M2NAFHDJRTHH8K1BWTN65XZG';
const BODY = '# Graphiti API\n\nProse.\n';

/** A complete page frontmatter in the published shape (`page-frontmatter.schema.json` required set). */
function pageFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Graphiti API',
    page_id: 'page_graphiti-api',
    category: 'concept',
    author: 'user',
    sources: [CLAIM_ID],
    supporting_claims: [],
    created: '2026-09-01',
    updated: '2026-09-12',
    scope: 'workspace',
    confidence: 'medium',
    epistemic_tag: 'inference',
    summary: 'Graphiti API is deployed.',
    tags: ['graphiti'],
    aliases: ['Graphiti'],
    notices: [],
    ...overrides,
  };
}

/** A hand-authored page carrying `block` as its frontmatter lines. */
function rawPage(block: string): string {
  return `---\n${block}---\n${BODY}`;
}

describe('L2 page frontmatter — the serialiser\'s remaining shapes (t_cf744a8e)', () => {
  test('a top-level multi-line string round-trips as a block scalar (summary, title)', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    const variants: Array<Record<string, unknown>> = [
      { summary: 'line one\nline two' },
      { summary: 'para one\n\npara two' }, // a blank line inside the block must stay
      { summary: 'trailing\n' }, // a trailing newline is content
      { summary: '  indented\nplain' }, // the content's own leading spaces survive
      { summary: '- item\nmore' }, // a content line that looks like a block item
      { title: 'a\ntwo-line title', summary: 'still readable' },
    ];

    for (const variant of variants) {
      const fm = pageFrontmatter(variant);
      const serialised = serialiseFrontmatter(fm, BODY);
      assert.ok(
        serialised.includes('|'),
        `a multi-line value must be written as a block scalar: ${JSON.stringify(serialised)}`,
      );

      const parsed = parseFrontmatter(serialised);
      assert.ok(parsed, 'the serialised page is readable');
      assert.deepEqual(
        parsed.frontmatter,
        fm,
        `a multi-line string must survive parse(serialise(fm)): ${JSON.stringify(variant)}`,
      );
      assert.deepEqual(
        Object.keys(parsed.frontmatter).sort(),
        Object.keys(fm).sort(),
        'no key may vanish or appear when a multi-line value is written',
      );
      assert.equal(
        serialiseFrontmatter(parsed.frontmatter, BODY),
        serialised,
        'serialise → parse → serialise is idempotent for a block scalar',
      );
    }

    // `summary`/`title` are bare `type: string` in the published contract, so a multi-line value
    // is contract-legal — that asymmetry is why this shape is supported, not guarded.
    assert.deepEqual(
      errorKeys(validate, pageFrontmatter({ summary: 'line one\nline two' })),
      [],
      'a multi-line summary is a legal page',
    );
  });

  test('a multi-line notice message round-trips', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    const notices = [
      { type: 'staleness', message: 'line one\nline two', posted_at: '2026-09-10T00:00:00.000Z' },
      { type: 'contradiction', message: 'a\n\nb' },
    ];
    const fm = pageFrontmatter({ notices });

    const serialised = serialiseFrontmatter(fm, BODY);
    assert.ok(
      serialised.includes('    message: |'),
      `the item's multi-line value must be a block scalar at the item content column:\n${serialised}`,
    );

    const parsed = parseFrontmatter(serialised);
    assert.ok(parsed, 'the serialised page is readable');
    assert.deepEqual(parsed.frontmatter['notices'], notices, 'the notice messages survive the write');
    assert.deepEqual(
      Object.keys(parsed.frontmatter).sort(),
      Object.keys(fm).sort(),
      'no item key leaks out of a notice item',
    );
    assert.deepEqual(parsed.frontmatter, fm, 'the whole frontmatter survives a write');
    assert.equal(
      serialiseFrontmatter(parsed.frontmatter, BODY),
      serialised,
      'serialise → parse → serialise is idempotent for a multi-line notice message',
    );
    assert.deepEqual(
      errorKeys(validate, parsed.frontmatter),
      [],
      'the round-tripped page satisfies the published contract',
    );

    // The item's first key is the multi-line one: the item block's content column (dash + space)
    // has to be re-established for the block branch to find the item's other keys after it.
    const messageFirst = pageFrontmatter({
      notices: [{ message: 'first\nsecond', type: 'staleness' }],
    });
    assert.deepEqual(
      parseFrontmatter(serialiseFrontmatter(messageFirst, BODY))!.frontmatter,
      messageFirst,
      'a multi-line value as the item\'s first key must not swallow the keys after it',
    );
  });

  test('the empty string is written as `""` and reads back as an empty string', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    const fm = pageFrontmatter({
      summary: '',
      aliases: [''],
      notices: [{ type: 'staleness', message: '' }],
    });

    const serialised = serialiseFrontmatter(fm, BODY);
    assert.ok(
      serialised.includes('summary: ""') && serialised.includes('message: ""'),
      `an empty string must be written quoted, not as a bare key:\n${serialised}`,
    );

    const parsed = parseFrontmatter(serialised);
    assert.ok(parsed, 'the serialised page is readable');
    assert.deepEqual(parsed.frontmatter, fm, 'the empty strings survive (key and array element alike)');
    assert.deepEqual(
      errorKeys(validate, parsed.frontmatter),
      [],
      'empty strings are contract-legal — they must not degrade into a missing key',
    );
  });

  test('a comma inside an inline array element survives the split', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    const fm = pageFrontmatter({ aliases: ['Graphiti, the API', 'plain'] });

    const serialised = serialiseFrontmatter(fm, BODY);
    assert.ok(serialised.includes('["Graphiti, the API", plain]'), `emitted inline array:\n${serialised}`);
    assert.deepEqual(
      parseFrontmatter(serialised)!.frontmatter['aliases'],
      ['Graphiti, the API', 'plain'],
      'a quoted element may contain the separator character',
    );
    assert.deepEqual(
      errorKeys(validate, parseFrontmatter(serialised)!.frontmatter),
      [],
      'a comma-bearing alias is contract-legal (aliases items are bare strings)',
    );

    // `tags` is the one place the published contract refuses a comma (`Tag` = `^[a-z][a-z0-9-]*$`).
    // The serialiser must still not corrupt the value: it round-trips, and the SCHEMA is what says
    // no — not a silent split into two malformed tags.
    const tagged = pageFrontmatter({ tags: ['alpha,beta'] });
    const roundTripped = parseFrontmatter(serialiseFrontmatter(tagged, BODY))!;
    assert.deepEqual(roundTripped.frontmatter['tags'], ['alpha,beta'], 'the serialiser carries it');
    assert.ok(
      errorKeys(validate, roundTripped.frontmatter).includes('/tags/0:pattern'),
      'the contract, not the serialiser, is where a comma-bearing tag is refused',
    );
  });

  test('a quoted block item is a scalar, not a mapping', () => {
    // Real YAML reads `- "a: b"` as the string `a: b`; the quote is exactly what makes the `: `
    // non-structural. The t_4d84ff6b reader (quote-blind `isMappingItem`) decoded it as
    // `{'"a': 'b"'}`; the pre-fix reader and the fix read the string.
    const double = parseFrontmatter(rawPage('sources:\n  - "a: b"\n'))!;
    assert.deepEqual(double.frontmatter['sources'], ['a: b'], 'a double-quoted item is one string');

    const single = parseFrontmatter(rawPage("sources:\n  - 'a: b'\n"))!;
    assert.deepEqual(single.frontmatter['sources'], ['a: b'], 'a single-quoted item is one string');

    // The unquoted form is still the mapping YAML says it is (the t_4d84ff6b behaviour kept).
    const unquoted = parseFrontmatter(rawPage('sources:\n  - a: b\n'))!;
    assert.deepEqual(unquoted.frontmatter['sources'], [{ a: 'b' }], 'an unquoted `key: value` item stays a mapping');
  });

  test('a hand-authored block scalar is read — top level and as a block item', () => {
    // What a page author writes (deeper than the serialiser's own two-space block).
    const topLevel = parseFrontmatter(rawPage('summary: |\n    line one\n    line two\n'))!;
    assert.equal(topLevel.frontmatter['summary'], 'line one\nline two');

    // A block-style string array item.
    const item = parseFrontmatter(rawPage('sources:\n  - |\n    claim one\n    claim two\n'))!;
    assert.deepEqual(item.frontmatter['sources'], ['claim one\nclaim two']);

    // A block scalar inside a hand-authored notice item.
    const notice = parseFrontmatter(rawPage(
      'notices:\n  - type: staleness\n    message: |\n      line one\n      line two\n    posted_at: 2026-09-10T00:00:00.000Z\n',
    ))!;
    assert.deepEqual(notice.frontmatter['notices'], [
      { type: 'staleness', message: 'line one\nline two', posted_at: '2026-09-10T00:00:00.000Z' },
    ]);
  });

  test('a bare hand-authored key reads as null instead of vanishing', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    const parsed = parseFrontmatter(rawPage('summary:\ntags:\n'))!;

    // YAML's bare `key:` is null. The parser used to drop the key from the parse entirely; it now
    // carries null, so a required/typed field surfaces as a validation error rather than as a
    // silently missing page field. (The writer spells its own two relatives explicitly:
    // `key: null` for null and `key: ""` for the empty string.)
    assert.ok('summary' in parsed.frontmatter, 'the key must not vanish from the parse');
    assert.equal(parsed.frontmatter['summary'], null);
    assert.deepEqual(
      errorKeys(validate, parsed.frontmatter).filter(key => key.startsWith('/summary')),
      ['/summary:type'],
      'the contract reports it as the wrong type rather than as a missing field',
    );
  });

  test('a nested object value is refused at the write boundary, naming the page field', () => {
    // Top level: `{meta: {a: b}}` used to write `meta:` + `a: b`, which read back with `a`
    // promoted to a stray top-level page key (`additionalProperties: false` rejects the page).
    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter({ meta: { a: 'b' } }), BODY),
      /page field "meta" holds a nested object/,
      'a top-level nested object must be refused, naming the field',
    );

    // Inside a notice item: the nested key used to flatten into the item (`{type, message, a}`),
    // losing `meta` and inventing `a`.
    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter({
        notices: [{ type: 'staleness', message: 'x', meta: { a: 'b' } }],
      }), BODY),
      /page field "notices\[0\]\.meta" holds a nested object/,
      'a nested object inside a notice item must be refused, naming the item path',
    );

    // The guard is about object values only: everything the page vocabulary admits still writes.
    assert.doesNotThrow(
      () => serialiseFrontmatter(pageFrontmatter({
        notices: [{ type: 'staleness', message: 'm', claim_id: CLAIM_ID }],
        aliases: ['Graphiti, the API'],
      }), BODY),
      'the admitted vocabulary is unaffected by the guard',
    );
  });
});
