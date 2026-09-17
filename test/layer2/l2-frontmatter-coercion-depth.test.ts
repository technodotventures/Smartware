// L2 page frontmatter — the serialiser's coerced scalars and the guard's depth (t_5768425d).
//
// `src/layer2/frontmatter.ts` is a hand-rolled, deliberately minimal YAML writer/reader. Its
// contract: everything it writes reads back unchanged for the page vocabulary
// (`schemas/v0.5.0/page-frontmatter.schema.json` — strings, string arrays, and arrays of notice
// objects whose values are scalars). Two contract-legal shapes still degraded on the t_cf744a8e
// tip b10c77c (measured there by the independent VERIFY t_3e511c55, rows A3a–A3d and A2b, and
// re-measured here by `probe-coercion-depth.mjs`):
//
//   C1 — a numeric / boolean / null-looking STRING at a bare `type: string` (title, summary, a
//   notice message) was written unquoted, and the reader's scalar coercion (`Number(rest)`,
//   `true`, `false`, `null`) then read it back as another type: `summary: "123"` → `123` (number),
//   `"1.50"` → `1.5`, `"true"` → `true`, `"null"` → null, and the `0x10`/`1e3`/`Infinity`/`007`
//   spellings of `Number`. The page then failed its own published contract (`/summary:type`)
//   after a write it made itself. No page field is number/boolean/null-typed, so every coerced
//   scalar is necessarily a string that changed type. DECIDED: supported — the writer quotes the
//   spellings the reader coerces, via `isCoercedScalar`, which the reader shares so the two halves
//   cannot drift.
//
//   C2 — a nested object deeper than one level inside a notice item
//   (`notices[0].links = [{url: 'u', meta: {a: 'b'}}]`) was neither refused nor preserved: the
//   guard only inspected `item[itemKey]`, and the reader flattened `meta` into the links item
//   (`{url: 'u', a: 'b'}` — the mapping lost, its key promoted). The input is contract-legal per
//   the published schema (notice items declare no `additionalProperties: false`), so the
//   serialiser must not corrupt it. DECIDED: extend `assertPageVocabulary` to every value
//   position — an object at a *property* position at any depth is refused, naming the full path
//   (`notices[0].links[0].meta`). The guard is deliberately stricter than the published contract
//   at undeclared item keys: where the contract allows a key the serialiser cannot carry, the
//   honest failure is a loud refusal, not silent flattening. Mixed scalar/object arrays
//   (`['a', {b: 'c'}]`, written through `String(item)` as `[object Object]` / `0: a` lines) are
//   refused for the same reason — contract-illegal input, silent loss before. A nested sequence
//   item (`[["x"]]`) stays the out-of-vocabulary shape t_cf744a8e documented: still written,
//   still garbled on read; no page field admits one.
//
// Pre-fix measurement (b10c77c, `probes/probe-coercion-depth.mjs`): 16/16 C1 spellings
// SILENT_LOSS at `summary`, 4/4 inside a notice `message`, C2a/C2b (the nested object inside the
// array) and C2d/C2e (mixed arrays) SILENT_LOSS; the controls — plain strings, `NaN`, dates,
// claim ids, real number/boolean/null values, links arrays of scalars and of flat objects — PASS.
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

describe('L2 page frontmatter — coerced scalars and guard depth (t_5768425d)', () => {
  test('a numeric/boolean/null-looking string round-trips as the string it was', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    // The spellings `Number()` coerces beyond the plain decimal ones — `0x10` → 16, `1e3` → 1000,
    // `007` → 7, `+5` → 5, `.5` → 0.5, `5.` → 5, `0b101` → 5, `0o17` → 15, `0123` → 123.
    const spellings = ['123', '1.50', 'true', 'false', 'null', '0x10', '1e3', 'Infinity',
      '-Infinity', '007', '+5', '.5', '5.', '0b101', '0o17', '0123'];

    for (const spelling of spellings) {
      const fm = pageFrontmatter({ summary: spelling });
      const serialised = serialiseFrontmatter(fm, BODY);
      assert.ok(
        serialised.includes(`summary: "${spelling}"`),
        `the coerced spelling must be written quoted: ${JSON.stringify(serialised)}`,
      );

      const parsed = parseFrontmatter(serialised);
      assert.ok(parsed, 'the serialised page is readable');
      assert.equal(typeof parsed.frontmatter['summary'], 'string', `typeof must stay string: ${spelling}`);
      assert.deepEqual(
        parsed.frontmatter,
        fm,
        `parse(serialise(fm)) must bring the string back: ${spelling}`,
      );
      assert.deepEqual(errorKeys(validate, fm), [], `the input is contract-legal: ${spelling}`);
      assert.deepEqual(
        errorKeys(validate, parsed.frontmatter),
        [],
        `the round-tripped page must stay contract-legal (was /summary:type): ${spelling}`,
      );
      assert.equal(
        serialiseFrontmatter(parsed.frontmatter, BODY),
        serialised,
        `serialise → parse → serialise is idempotent: ${spelling}`,
      );
    }
  });

  test('a coerced-looking notice message round-trips inside the item', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    for (const spelling of ['123', '1.50', 'true', 'null']) {
      const fm = pageFrontmatter({ notices: [{ type: 'staleness', message: spelling }] });
      const serialised = serialiseFrontmatter(fm, BODY);
      assert.ok(
        serialised.includes(`message: "${spelling}"`),
        `a notice message goes through the same reader and must be quoted too:\n${serialised}`,
      );

      const parsed = parseFrontmatter(serialised);
      assert.ok(parsed, 'the serialised page is readable');
      assert.deepEqual(
        parsed.frontmatter,
        fm,
        `the item's scalar must survive as the string it was: ${spelling}`,
      );
      assert.deepEqual(
        errorKeys(validate, parsed.frontmatter),
        [],
        `and stay contract-legal (was /notices/0/message:type): ${spelling}`,
      );
    }
  });

  test('a hand-authored bare scalar keeps the reader\'s own type; a quoted one is a string', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    // The reader is deliberately untyped and stays that way: a bare `summary: 123` is a number on
    // read (the published contract then reports `/summary:type` loudly — it is not silently lost).
    const bare = parseFrontmatter(rawPage('summary: 123\n'))!;
    assert.equal(typeof bare.frontmatter['summary'], 'number', 'a bare 123 reads as a number');
    assert.deepEqual(
      errorKeys(validate, bare.frontmatter).filter(key => key.startsWith('/summary')),
      ['/summary:type'],
      'the contract reports the wrong type; a hand-authored page must quote its ambiguous scalars',
    );

    // The writer's own output is the quoted form, which reads back as the string it was.
    const quoted = parseFrontmatter(rawPage('summary: "123"\n'))!;
    assert.equal(quoted.frontmatter['summary'], '123', 'a quoted "123" is the string it was');
  });

  test('the guard reaches a nested object inside an array inside a notice item', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');

    // The measured C2 shape: contract-legal input (notice items carry no `additionalProperties:
    // false`, so the undeclared `links` key and its object are allowed by the published schema) —
    // but the reader flattens `meta` into the links item, so the serialiser must refuse it.
    const withLinks = pageFrontmatter({
      notices: [{ type: 'staleness', message: 'x', links: [{ url: 'u', meta: { a: 'b' } }] }],
    });
    assert.deepEqual(
      errorKeys(validate, withLinks),
      [],
      'the refused input is contract-legal — the refusal is the serialiser boundary, not the schema',
    );
    assert.throws(
      () => serialiseFrontmatter(withLinks, BODY),
      /page field "notices\[0\]\.links\[0\]\.meta" holds a nested object/,
      'the nested object at the array position must be refused, naming the full path',
    );

    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter({
        notices: [{ type: 'staleness', message: 'x', links: [{ url: 'u', meta: { a: { b: 'c' } } }] }],
      }), BODY),
      /page field "notices\[0\]\.links\[0\]\.meta" holds a nested object/,
      'the same shape one level deeper is refused at the same path',
    );

    // The top-level item-property half keeps the reach it had before this change.
    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter({ extra: [{ a: { b: 'c' } }] }), BODY),
      /page field "extra\[0\]\.a" holds a nested object/,
      'a top-level array item property that is an object stays refused',
    );
  });

  test('arrays of objects whose values are scalars still round-trip (no over-refusal)', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    const fm = pageFrontmatter({
      notices: [
        { type: 'staleness', message: 'm1', links: [{ url: 'https://example.com' }] },
        {
          type: 'contradiction',
          message: 'm2',
          links: [{ url: 'u', refs: [{ x: 'a' }, { y: 'b' }] }],
          refs: ['a', 'b'],
        },
      ],
    });

    const serialised = serialiseFrontmatter(fm, BODY);
    const parsed = parseFrontmatter(serialised);
    assert.ok(parsed, 'the serialised page is readable');
    assert.deepEqual(parsed.frontmatter, fm, 'the admitted vocabulary survives the write');

    // Links arrays of objects — nested arrays of objects included — are what the writer emits for
    // the shapes that round-trip (measured on t_5768425d, C2ctl1–C2ctl3 and C2f).
    assert.ok(serialised.includes('links:'), `the links block is emitted:\n${serialised}`);
    assert.deepEqual(errorKeys(validate, parsed.frontmatter), [], 'and stays contract-legal');
    assert.equal(
      serialiseFrontmatter(parsed.frontmatter, BODY),
      serialised,
      'serialise → parse → serialise is idempotent',
    );
  });

  test('a mixed scalar/object array is refused', () => {
    // Pre-fix the writer picked its array form from the FIRST item: a scalar first wrote the rest
    // inline through `String(item)` (`[a, [object Object]]`), an object first wrote the scalar as
    // `0: a` lines — both came back as something else (probe C2d/C2e: SILENT_LOSS).
    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter({ aliases: ['a', { b: 'c' }] }), BODY),
      /page field "aliases" mixes scalar and object items/,
      'scalar-then-object must be refused, naming the field',
    );
    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter({ aliases: [{ b: 'c' }, 'a'] }), BODY),
      /page field "aliases" mixes scalar and object items/,
      'object-then-scalar must be refused too',
    );
  });

  test('a parsed page re-serialises — the guard cannot fire on the compile/endorse path', () => {
    // compile.ts / endorse.ts re-serialise *parsed* frontmatter (the carried-forward `notices`).
    // The reader can produce arrays of objects inside an item (`links`), and those must keep
    // re-serialising; only a mapping at a property position is refused, and the reader's line
    // model cannot produce one (t_3e511c55 measured the old guard unreachable the same way).
    const parsed = parseFrontmatter(rawPage(
      'notices:\n  - type: staleness\n    message: x\n    links:\n      - url: u\n        refs:\n          - x: a\n',
    ))!;
    assert.ok(Array.isArray(parsed.frontmatter['notices']), 'the hand-authored page parses');

    const written = serialiseFrontmatter(parsed.frontmatter, BODY);
    assert.deepEqual(
      parseFrontmatter(written)!.frontmatter,
      parsed.frontmatter,
      'a parsed page re-serialises unchanged',
    );
  });
});
