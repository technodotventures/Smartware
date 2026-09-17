// L2 page frontmatter — the reader's block-scalar styles and quoted keys (decided + pinned as
// t_6fc254cd, the follow-up to t_cf744a8e's serialiser shapes).
//
// `src/layer2/frontmatter.ts`'s reader modelled exactly one block-scalar marker (`|`, the shape
// `toYAML` emits) and no chomping/folding/indentation variants, so a hand-authored standard YAML
// header read as the **literal marker string** — `summary: |-` → `'|-'` — with the content dropped.
// Every one of those values is a legal `string` in the published page contract
// (`schemas/v0.5.0/page-frontmatter.schema.json`: `summary`/`message` are bare `type: string`), so
// nothing downstream complained. Measured on the parent tip `b10c77c` and against two independent
// spec readers (`yaml@2.9.0`, `js-yaml@4.3.2`) by the probes attached to the task
// (`probes/probe-unread-constructs.mjs`, `probes/probe-vs-reference.mjs`,
// `probes/probe-indent-indicator.mjs`, `probes/classify-vs-reference.mjs`).
//
//   SUPPORTED (read faithfully; pinned here)
//   - `|-` strip chomping, top level and as a block item — the block's trailing blank lines go.
//   - `|+` keep chomping — kept, which in this reader's line-preserving model is the same as the
//     unmarked style (a spec reader's clip adds one trailing line break; see the note below).
//   - `>` folded, plus `>-`/`>+` — single line breaks fold to spaces, blank lines are paragraph
//     breaks, more-indented lines keep their breaks. Top level, block items, and `>2`.
//   - the explicit indentation indicator `|N`/`>N` (with the chomping indicator in either order):
//     the content is indented `introduceIndent + N`, so extra leading spaces are content. All nine
//     valid shapes measured agree exactly with both spec readers.
//   - a quoted item key (`- "k": v`, `- "a: b": c`, `"message": m`) is decoded — real YAML, and the
//     reader was already quote-aware for *values*.
//
//   UNCHANGED / CONTROLS (pinned so a later edit cannot move them silently)
//   - the unmarked `|` and the bytes `toYAML` emits for a multi-line string (the writer's shape and
//     the t_cf744a8e pins depend on it), content lines that look like markers, and a quoted value
//     that looks like a marker.
//   - a documented deviation, measured not asserted: a spec reader applies clip chomping to a
//     scalar with no chomping indicator, so it returns exactly ONE more trailing line break than
//     this reader; the `-` forms are exact against both spec readers.
//   - the two shapes t_cf744a8e already decided out-of-vocabulary keep their measured read, which is
//     pinned here (nested sequence item; a bare key followed by a deeper block).
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

/** A hand-authored page carrying `block` as its frontmatter lines (as the probes feed the reader). */
function rawPage(block: string): string {
  return `---\n${block}---\n${BODY}`;
}

/** The `.frontmatter` a hand-authored block reads as. */
function readBlock(block: string): Record<string, unknown> {
  const parsed = parseFrontmatter(rawPage(block));
  assert.ok(parsed, `the page is readable:\n${block}`);
  return parsed.frontmatter;
}

describe('L2 page frontmatter — the reader\'s block-scalar styles and quoted keys (t_6fc254cd)', () => {
  test('a strip-chomped literal block (`|-`) is read, not returned as its marker', () => {
    // The value used to be the literal string `|-` (the content was dropped entirely).
    assert.equal(readBlock('summary: |-\n  line one\n  line two\n')['summary'], 'line one\nline two');
    // `-` is what the marker is for: the block's trailing blank lines go.
    assert.equal(readBlock('summary: |-\n  line one\n\n')['summary'], 'line one');
    assert.equal(readBlock('summary: |-\n  line one\n\n\n')['summary'], 'line one');
    // The same marker as a block-array item.
    assert.deepEqual(readBlock('sources:\n  - |-\n    claim one\n')['sources'], ['claim one']);
    assert.deepEqual(readBlock(`sources:\n  - |-\n    ${CLAIM_ID}\n\n`)['sources'], [CLAIM_ID]);
  });

  test('a keep-chomped literal block (`|+`) is read', () => {
    assert.equal(readBlock('summary: |+\n  line one\n')['summary'], 'line one');
    // This reader's line-preserving model keeps the block's trailing blank lines for both the
    // unmarked and the `+` style (a spec reader's clip would drop the third line break).
    assert.equal(readBlock('summary: |+\n  line one\n\n')['summary'], 'line one\n');
    assert.equal(readBlock('summary: |+\n  line one\n\n\n')['summary'], 'line one\n\n');
  });

  test('the unmarked literal block and the writer\'s bytes are unchanged (control)', () => {
    // `toYAML` writes any multi-line string as `key: |`; the t_cf744a8e pins depend on that shape
    // AND on this reader's exact round-trip of it. Both are untouched by t_6fc254cd.
    const serialised = serialiseFrontmatter(pageFrontmatter({ summary: 'line one\nline two' }), BODY);
    assert.ok(
      serialised.includes('summary: |\n'),
      `the writer still emits the unmarked literal style:\n${serialised}`,
    );
    assert.deepEqual(
      parseFrontmatter(serialised)!.frontmatter,
      pageFrontmatter({ summary: 'line one\nline two' }),
      'the writer round-trip is unchanged',
    );

    // Hand-authored, and deeper than the writer's own two-space block.
    assert.equal(readBlock('summary: |\n    line one\n    line two\n')['summary'], 'line one\nline two');
    // Content is content, however much it looks like structure.
    assert.equal(
      readBlock('summary: |\n  |- broken\n  > folded\n')['summary'],
      '|- broken\n> folded',
      'marker-looking content lines are data, not headers',
    );
    assert.deepEqual(
      readBlock('sources:\n  - |\n    claim one\n    claim two\n')['sources'],
      ['claim one\nclaim two'],
      'the item form is unchanged',
    );
  });

  test('a folded block (`>`, `>-`) is read, with paragraphs and more-indented lines', () => {
    assert.equal(readBlock('summary: >\n  line one\n  line two\n')['summary'], 'line one line two');
    assert.equal(readBlock('summary: >\n  para one\n\n  para two\n')['summary'], 'para one\npara two');
    assert.equal(
      readBlock('summary: >\n  para one\n\n\n  para two\n')['summary'],
      'para one\n\npara two',
      'a run of blank lines is a paragraph break of the same length',
    );
    // YAML's "more indented lines are not folded" rule: the break around them is kept.
    assert.equal(readBlock('summary: >\n  plain\n    literal\n  after\n')['summary'], 'plain\n  literal\nafter');
    assert.equal(readBlock('summary: >-\n  one\n  two\n\n')['summary'], 'one two');
    assert.deepEqual(readBlock('sources:\n  - >\n    one\n    two\n')['sources'], ['one two']);

    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    assert.deepEqual(
      errorKeys(validate, pageFrontmatter({ summary: readBlock('summary: >\n  a\n  b\n')['summary'] })),
      [],
      'a folded summary is a legal page — the wrong value was the only reason it was silent',
    );
  });

  test('an explicit indentation indicator (`|N`) is read', () => {
    // The declared indentation is relative to the introducing line, so leading spaces beyond it are
    // content: every shape here was measured identical on `yaml@2.9.0` and `js-yaml@4.3.2`
    // (probes/probe-indent-indicator.mjs).
    assert.equal(readBlock('summary: |2\n    indented\n')['summary'], '  indented');
    assert.equal(readBlock('summary: |1\n x\n')['summary'], 'x');
    assert.equal(readBlock('summary: |3\n     x\n')['summary'], '  x');
    assert.deepEqual(readBlock(`sources:\n  - |2\n    ${CLAIM_ID}\n`)['sources'], [CLAIM_ID]);
    // Chomping and indentation indicators come in either order.
    assert.equal(readBlock('summary: |2-\n    indented\n\n')['summary'], '  indented');
    assert.equal(readBlock('summary: |+2\n    indented\n\n')['summary'], '  indented\n');
    assert.equal(readBlock('summary: >2\n   one\n   two\n')['summary'], ' one\n two');

    // A content line shallower than the declared indentation is a parse error in YAML; this reader
    // has no error channel (a throw inside `parseFrontmatter` is indistinguishable from "no
    // frontmatter"), so it ends the block there and leaves the line where it is. Pinned as the
    // measured boundary rather than documented only.
    assert.deepEqual(
      readBlock('summary: |4\n  two\n')['summary'],
      '',
      'the declared block is empty — nothing survives at the declared indentation',
    );
    assert.equal(
      readBlock('summary: |4\n  two\ntags: [x]\n')['two'],
      undefined,
      'the shallower line is not swallowed into the block',
    );

    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    assert.deepEqual(
      errorKeys(validate, pageFrontmatter({ summary: readBlock('summary: |2\n    a\n    b\n')['summary'] })),
      [],
      'an indentation-indicated summary is a legal page',
    );
  });

  test('a whitespace-only line inside a block scalar keeps its spaces (the C4 caveat)', () => {
    // Raised as a non-blocking caveat by the independent verify t_3e511c55 (C4) and measured against
    // both spec readers here: a whitespace-only line *wider than the block's indentation* is content,
    // and only what is narrower than the indent is the empty line it looks like. The reader used to
    // trim every whitespace-only line, so `'a\n \nb'` came back as `'a\n\nb'`.
    assert.equal(readBlock('summary: |\n  a\n   \n  b\n')['summary'], 'a\n \nb');
    assert.equal(readBlock('summary: |\n  a\n     \n')['summary'], 'a\n   ');
    assert.equal(
      readBlock('summary: |-\n  a\n     \n')['summary'],
      'a\n   ',
      'strip chomping removes empty lines, not content',
    );
    assert.equal(readBlock('summary: >\n  a\n   \n  b\n')['summary'], 'a\n \nb', 'folded: its breaks are kept');
    assert.equal(readBlock('summary: |\n   \n')['summary'], '', 'a block with no content line fixes no indentation');
    // Controls: at or below the block's indentation the line is the blank it looks like.
    assert.equal(readBlock('summary: |\n  a\n \n  b\n')['summary'], 'a\n\nb');
    assert.equal(readBlock('summary: |\n  a\n  \n  b\n')['summary'], 'a\n\nb');

    // The writer emits this shape for any value carrying such a line, so the round-trip is the pin
    // that matters: it was lossy before this change.
    const fm = pageFrontmatter({ summary: 'a\n \nb' });
    const roundTripped = parseFrontmatter(serialiseFrontmatter(fm, BODY))!;
    assert.equal(
      roundTripped.frontmatter['summary'],
      'a\n \nb',
      'a multi-line value with a spaces-only line round-trips exactly',
    );
  });

  test('a quoted item key is decoded, colons and all', () => {
    // Real YAML: `- "k": v` is the mapping `{k: v}`. The reader kept the quotes on the key (and,
    // with a colon inside the quoted key, split the key at that colon as well).
    assert.deepEqual(readBlock('sources:\n  - "k": v\n')['sources'], [{ k: 'v' }]);
    assert.deepEqual(
      readBlock('sources:\n  - "a: b": c\n')['sources'],
      [{ 'a: b': 'c' }],
      'a colon inside the quoted key is part of the key',
    );
    assert.deepEqual(readBlock("sources:\n  - 'k': v\n")['sources'], [{ k: 'v' }]);

    const notices = readBlock('notices:\n  - "type": staleness\n    "message": m\n')['notices'];
    assert.deepEqual(notices, [{ type: 'staleness', message: 'm' }]);

    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    assert.deepEqual(
      errorKeys(validate, pageFrontmatter({ notices })),
      [],
      'the decoded key is what the contract names, so the page validates',
    );

    // Controls: the unquoted forms behave exactly as before.
    assert.deepEqual(readBlock('sources:\n  - a: b\n')['sources'], [{ a: 'b' }], 'unquoted mapping item');
    assert.deepEqual(
      readBlock('sources:\n  - "a: b"\n')['sources'],
      ['a: b'],
      'a quoted scalar item is still one string (t_cf744a8e)',
    );
  });

  test('a value that only looks like a marker stays a string (control)', () => {
    // `yamlString` quotes any string containing `|`, so the writer emits this shape for the literal
    // value `|-`; it must not be read as a header.
    assert.equal(readBlock('summary: "|-"\n')['summary'], '|-');
    const page = parseFrontmatter(serialiseFrontmatter(pageFrontmatter({ summary: '|-' }), BODY))!;
    assert.equal(page.frontmatter['summary'], '|-', 'the writer/reader round-trip of `|-` is exact');
  });

  test('the shapes left unread keep their measured read (documented, not silent)', () => {
    // Both of these were decided out-of-vocabulary on t_cf744a8e; pinned as measured so a future
    // change to the reader has to move them deliberately. Spec readers disagree with both readings
    // (`sources: [['a','b']]` and `meta: {a: b}`).
    const nested = readBlock('sources:\n  - - a\n    - b\n');
    assert.deepEqual(nested['sources'], ['- a', 'b'], 'a nested sequence item is not modelled');

    const deeper = readBlock('summary:\nmeta:\n  a: b\n');
    assert.deepEqual(deeper, { summary: null, a: 'b' }, 'a bare key + deeper block loses the nested key');

    // The residue is contract-visible for these two shapes (the wrong values are not legal fields):
    // `sources` items are ClaimIds and the leaked nested key is not a page field. `|0` is not a legal
    // header either (the indicator is 1-9); this reader returns it as the literal text, which the
    // contract's bare `string` accepts — the one remaining silent shape, and why the marker regex is
    // spelled out where a reader will find it.
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');
    assert.ok(
      errorKeys(validate, pageFrontmatter({ sources: nested['sources'] })).includes('/sources/0:pattern'),
      'a nested sequence read as two strings is refused by the contract',
    );
    assert.ok(
      errorKeys(validate, pageFrontmatter(deeper)).includes('/:additionalProperties:a'),
      'the leaked nested key is refused by additionalProperties: false',
    );
    assert.equal(readBlock('summary: |0\n  x\n')['summary'], '|0', '`|0` is not a header (indicator 1-9)');
  });
});
