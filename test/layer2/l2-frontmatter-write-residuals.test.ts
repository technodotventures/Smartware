// L2 page frontmatter — the write boundary at array positions (t_0e19036e).
//
// `src/layer2/frontmatter.ts` is a hand-rolled, deliberately minimal YAML writer/reader. Its
// contract (t_cf744a8e, extended by t_5768425d): everything it writes reads back unchanged for the
// page vocabulary (`schemas/v0.5.0/page-frontmatter.schema.json` — strings, string arrays, and
// arrays of notice objects whose values are scalars); a shape the writer cannot carry is refused
// at the write boundary, naming the field path, rather than emitted in a form the reader silently
// flattens or drops. The independent VERIFY t_5708fed6 (§4 of its evidence) measured six shapes
// still below that line at `c740511` — all pre-existing, all latent in-tree. DECIDED here:
//
//   R1/R4 — a non-string scalar as an array item (`meta: [1, 2]`, `['b', true]`, `[null]`,
//   `[null, 'a']`) was written through `String(item)` and read back as a string ("1", "true",
//   "null"); a null FIRST item additionally went down the block branch and raised a raw
//   `TypeError: Cannot convert undefined or null to object` with no field name. REFUSED now,
//   naming `path[index]`: the inline array form carries strings only, and a bare refusal beats a
//   silent type change.
//
//   R3 — an array as an array item (`['b', []], ['b', ['x']]`, and the pure nested sequence
//   `[['x','y']]`) was never refused: `assertArrayCarriable` filtered on `isObjectValue`, and the
//   writer mangled the item (`String([])` → `''`; `Object.entries` → `0: …` lines) into bytes the
//   reader cannot reconstruct. REFUSED now — including the pure nested sequence, which supersedes
//   the t_cf744a8e "still written, still garbled, documented" carve-out on the write side: the
//   value is uncarriable and contract-legal only at undeclared notice-item keys, which is exactly
//   the class t_5768425d decided to refuse rather than flatten.
//
//   R5 — an empty object item (`notices: [{}]`, `payload: [{}]`) degraded to `''`. REFUSED now
//   (a block item is written from its `key: value` lines).
//
//   R2 — a multi-line string as an inline-array element (`aliases: ['a\nb']`) is CONTRACT-LEGAL
//   (`aliases.items` is a plain string) and was silently destroyed: the writer's quote branch
//   emits a literal newline inside the inline array, so the whole array read back as one string.
//   SUPPORTED now when the element's minimum indentation over its non-blank lines is 0 — some
//   line's content starts at column 0 (every spelling pinned below, and the whole 5569-row probe
//   corpus): an all-string array with such a multi-line element is written in the block form the
//   reader already decodes (`- <str>` items, `- |` + indented lines for the multi-line ones — the
//   t_cf744a8e shape-6 reader support, which the writer never emitted). This also repairs a
//   re-serialise hazard: a hand-authored `aliases:\n  - |\n    a\n    b` page read as `['a\nb']`
//   used to be re-emitted corrupted.
//
//   The all-indented sub-class is a REMAINING LOSS, disclosed and pinned below rather than left
//   implied (independent VERIFY t_6012c8ca Finding 1): when every non-blank line of the element is
//   indented, the writer's fixed 4-space prefix and the reader's minimum-indent strip take the
//   element's own minimum indentation with them, silently — `' a\n b'` reads back `'a\nb'`,
//   `'  a\n b'` reads back `' a\nb'`. Pre-existing on both arms (pre-fix these rows were lost too,
//   garbled rather than de-indented), contract-legal (`aliases.items` is a plain string) and
//   deliberately NOT refused — refusing a plain string would be an over-refusal — and not reachable
//   on the compile/endorse re-serialise path (a hand-authored all-indented block already loses the
//   indent at *read*; it is the host-constructed-value path that does).
//
// See the task's DECISION.md (board attachment) for the full rationale and measurements.
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

describe('L2 page frontmatter — the write boundary at array positions (t_0e19036e)', () => {
  test('a non-string scalar as an array item is refused, naming the item', () => {
    const spellings: Array<[unknown, string]> = [[1, 'a number'], [true, 'a boolean'], [null, 'null']];
    for (const [value, kind] of spellings) {
      assert.throws(
        () => serialiseFrontmatter(pageFrontmatter({ aliases: ['b', value] }), BODY),
        new RegExp(`page field "aliases\\[1\\]" holds ${kind}, which the page YAML vocabulary cannot carry as an array item`),
        `a ${kind} array item must be refused, naming path[index]`,
      );
    }

    // The same check at the two other array positions the walk reaches: a top-level field and a
    // notice item's property (the position the probe's P1/P2/P3/P4 rows measure).
    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter({ meta: [1, 2] }), BODY),
      /page field "meta\[0\]" holds a number, which the page YAML vocabulary cannot carry as an array item/,
    );
    assert.throws(
      () => serialiseFrontmatter(
        pageFrontmatter({ notices: [{ type: 'staleness', message: 'x', payload: ['a', 2] }] }), BODY),
      /page field "notices\[0\]\.payload\[1\]" holds a number/,
    );
  });

  test('an array whose first item is null is refused by name, not by a raw TypeError', () => {
    // Pre-fix: `typeof null === 'object'` sent `[null, …]` down the writer's block branch, where
    // `Object.entries(null)` threw `TypeError: Cannot convert undefined or null to object` — loud
    // but unnamed (probe X.null_first_item_array / THREW_UNNAMED rows).
    for (const meta of [[null], [null, 'a']]) {
      assert.throws(
        () => serialiseFrontmatter(pageFrontmatter({ meta }), BODY),
        /page field "meta\[0\]" holds null, which the page YAML vocabulary cannot carry as an array item/,
      );
    }

    try {
      serialiseFrontmatter(pageFrontmatter({ meta: [null, 'a'] }), BODY);
      assert.fail('a null array item must be refused');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(
        !/Cannot convert/.test(error.message),
        'the raw TypeError must be replaced by a named refusal',
      );
    }
  });

  test('an array item is refused — the nested-sequence carve-out is superseded on the write side', () => {
    // Scalar-first: the inline form stringified the item (`String([])` → `''`).
    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter({ aliases: ['b', []] }), BODY),
      /page field "aliases\[1\]" holds an array item \(a nested sequence\)/,
      'an empty array item must be refused',
    );
    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter({ aliases: ['b', ['x']] }), BODY),
      /page field "aliases\[1\]" holds an array item \(a nested sequence\)/,
      'a non-empty array item must be refused',
    );

    // Pure nested sequence — the shape t_cf744a8e left "written, still garbled": now refused, at
    // a top-level field and inside a notice item (contract-legal there: notices items carry no
    // `additionalProperties: false`, which is exactly why the writer must not garble it).
    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter({ meta: [['x', 'y']] }), BODY),
      /page field "meta\[0\]" holds an array item/,
      'a pure nested sequence must be refused too',
    );
    assert.throws(
      () => serialiseFrontmatter(
        pageFrontmatter({ notices: [{ type: 'staleness', message: 'x', payload: [['x']] }] }), BODY),
      /page field "notices\[0\]\.payload\[0\]" holds an array item/,
      'a nested sequence inside a notice item must be refused, naming the path',
    );
    assert.throws(
      () => serialiseFrontmatter(
        pageFrontmatter({ notices: [{ type: 'staleness', message: 'x', payload: [[{ a: { b: 'c' } }]] }] }), BODY),
      /page field "notices\[0\]\.payload\[0\]" holds an array item/,
      'an object nested inside an array inside an array is refused at the array item (the W boundary)',
    );
  });

  test('an empty object item is refused, naming the item', () => {
    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter({ notices: [{}] }), BODY),
      /page field "notices\[0\]" is an object item with no properties/,
      'an empty notice item must be refused',
    );
    assert.throws(
      () => serialiseFrontmatter(
        pageFrontmatter({ notices: [{ type: 'staleness', message: 'x', payload: [{}] }] }), BODY),
      /page field "notices\[0\]\.payload\[0\]" is an object item with no properties/,
      'an empty object item at a property array must be refused too',
    );
    assert.throws(
      () => serialiseFrontmatter(
        pageFrontmatter({ notices: [{ type: 'staleness', message: 'x', payload: [{ a: 'b' }, {}] }] }), BODY),
      /page field "notices\[0\]\.payload\[1\]" is an object item with no properties/,
      'the empty item is named at its own index, not the array',
    );
  });

  test('a multi-line string as an array element round-trips in the block form when a line starts at column 0 (all-indented elements: a pinned, disclosed loss)', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    const spellings = [
      'line one\nline two',
      'a\n',
      '\n',
      'a\n\nb',
      ' a\nb',
      'a\n---\nb',
      'trail \nend',
    ];

    for (const spelling of spellings) {
      const fm = pageFrontmatter({ aliases: ['Graphiti', spelling] });
      const serialised = serialiseFrontmatter(fm, BODY);
      assert.ok(
        serialised.includes('  - |'),
        `a multi-line element is written in the block form:\n${serialised}`,
      );
      assert.ok(
        serialised.includes('  - Graphiti'),
        'the single-line elements keep the plain block item form',
      );

      const parsed = parseFrontmatter(serialised);
      assert.ok(parsed, 'the serialised page is readable');
      assert.deepEqual(
        parsed.frontmatter,
        fm,
        `parse(serialise(fm)) must bring the array back: ${JSON.stringify(spelling)}`,
      );
      assert.deepEqual(
        errorKeys(validate, parsed.frontmatter),
        [],
        `the input is contract-legal and must stay so: ${JSON.stringify(spelling)}`,
      );
      assert.equal(
        serialiseFrontmatter(parsed.frontmatter, BODY),
        serialised,
        `serialise → parse → serialise is idempotent: ${JSON.stringify(spelling)}`,
      );
    }

    // The all-indented sub-class (every non-blank line indented) does NOT round-trip: the writer
    // prefixes every content line with 4 spaces and the reader's `readBlockScalar` strips the
    // block's *minimum* indent, so the element's own minimum indentation is stripped with it. The
    // string is contract-legal and is deliberately not refused; the measured reset is asserted
    // here so the boundary is pinned instead of implied (VERIFY t_6012c8ca Finding 1).
    const allIndented: Array<[string, string]> = [
      [' a\n b', 'a\nb'],
      ['  a\n b', ' a\nb'],
      ['  a\n  b', 'a\nb'],
      ['\ta\n\tb', 'a\nb'],
    ];
    for (const [spelling, measured] of allIndented) {
      const fm = pageFrontmatter({ aliases: ['Graphiti', spelling] });
      const serialised = serialiseFrontmatter(fm, BODY);
      assert.ok(serialised.includes('  - |'), 'the all-indented element still takes the block form');
      const parsed = parseFrontmatter(serialised);
      assert.ok(parsed, 'the serialised page is readable — the loss is silent, not a throw');
      assert.deepEqual(
        parsed.frontmatter['aliases'],
        ['Graphiti', measured],
        `an all-indented element reads back de-indented (this is the measured reset, not the value written): ${JSON.stringify(spelling)}`,
      );
      assert.deepEqual(
        errorKeys(validate, parsed.frontmatter),
        [],
        'and the de-indented read-back is still contract-legal (a plain string) — the loss is silent',
      );
    }

    // The same form inside a notice item's array property (an undeclared key, contract-legal).
    const nested = pageFrontmatter({
      notices: [{ type: 'staleness', message: 'x', payload: ['a\nb', 'c'] }],
    });
    assert.deepEqual(
      parseFrontmatter(serialiseFrontmatter(nested, BODY))!.frontmatter,
      nested,
      'an array of strings inside a notice item round-trips its multi-line element',
    );

    // The re-serialise hazard this closes: a hand-authored block-array page parses to the array it
    // spells, and the writer re-emits it without destroying it (pre-fix it came back as
    // `aliases: ["line one` → the whole array degraded to one string on the next read).
    const handAuthored = rawPage('aliases:\n  - Graphiti\n  - |\n    line one\n    line two\n');
    const parsedHand = parseFrontmatter(handAuthored);
    assert.ok(parsedHand, 'the hand-authored page is readable');
    assert.deepEqual(parsedHand.frontmatter['aliases'], ['Graphiti', 'line one\nline two']);
    assert.deepEqual(
      parseFrontmatter(serialiseFrontmatter(parsedHand.frontmatter, BODY))!.frontmatter,
      parsedHand.frontmatter,
      'a parsed page carrying a block-array multi-line element re-serialises unchanged',
    );
  });

  test('the carriable array vocabulary still round-trips (no over-refusal)', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    const fm = pageFrontmatter({
      aliases: ['Graphiti', ''],
      tags: ['a', 'b'],
      notices: [
        { type: 'staleness', message: 'm1', refs: ['a', 'b'], links: [{ url: 'https://example.com' }] },
        { type: 'contradiction', message: 'm2', links: [{ url: 'u', refs: [{ x: 'a' }, { y: 'b' }] }] },
      ],
    });

    const serialised = serialiseFrontmatter(fm, BODY);
    assert.ok(
      serialised.includes('aliases: [Graphiti, ""]'),
      'an all-string array without a newline keeps the inline form, byte-identical to before',
    );
    assert.deepEqual(parseFrontmatter(serialised)!.frontmatter, fm, 'the admitted vocabulary survives');
    assert.deepEqual(errorKeys(validate, parseFrontmatter(serialised)!.frontmatter), [], 'and stays contract-legal');
    assert.equal(
      serialiseFrontmatter(parseFrontmatter(serialised)!.frontmatter, BODY),
      serialised,
      'serialise → parse → serialise is idempotent',
    );

    // Property-position scalars the reader can carry are NOT refused: `key: 5` reads back as 5
    // (readBareScalar), so there is no loss for the writer to guard against.
    const typed = pageFrontmatter({
      notices: [{ type: 'staleness', message: 'x', posted_at: 5, tombstone_id: 'tombstone_x' }],
    });
    assert.deepEqual(
      parseFrontmatter(serialiseFrontmatter(typed, BODY))!.frontmatter,
      typed,
      'number/boolean/null values at property positions stay carriable',
    );
  });

  test('a parsed page re-serialises — the new refusals cannot fire on the compile/endorse path', () => {
    // compile.ts / endorse.ts re-serialise *parsed* frontmatter. The THREE refusals this lane
    // adds (a non-string scalar item, an array item, an empty object item) cannot fire there: the
    // reader's line model cannot produce them (its arrays come from `splitInlineArray` — strings —
    // and `parseBlockArray` — strings, strings-only arrays, and objects with at least one
    // `key: value` line); measured 0/4000 fuzzed hand-authored blocks, plus that structural
    // argument, on both arms of the t_6012c8ca VERIFY. Scope matters here: the *pre-existing*
    // mixed scalar/object refusal is NOT unreachable — `parseBlockArray` yields a mixed array
    // whenever a block-array item is not a mapping (`notices:` with a bare dash, or a `|-` item,
    // next to a mapping item; 12/4000 fuzzed blocks) and the real COMPILE path re-throws
    // end-to-end on it, identically on both arms (t_6012c8ca Finding 2; behavioural follow-up
    // carded as t_5742162f, not this lane).
    const parsed = parseFrontmatter(rawPage(
      'notices:\n  - type: staleness\n    message: x\n    links:\n      - url: u\n        refs:\n          - x: a\n',
    ))!;
    assert.ok(Array.isArray(parsed.frontmatter['notices']), 'the hand-authored page parses');
    assert.deepEqual(
      parseFrontmatter(serialiseFrontmatter(parsed.frontmatter, BODY))!.frontmatter,
      parsed.frontmatter,
      'a parsed page re-serialises unchanged',
    );
  });
});
