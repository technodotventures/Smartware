// L2 page frontmatter: a populated `notices` array survives a write (defect carded as t_4d84ff6b).
//
// `page-frontmatter.schema.json` (v0.5.0) and spec §9 declare `notices` as an array of objects
// (`{type, message, claim_id?, tombstone_id?, posted_at?}`) — the slot a *user-authored* page
// carries its staleness / contradiction / guardian notice in. The hand-rolled serialiser emitted
// that array-of-objects branch with the item's own indent left inside the dash line:
//
//   notices:
//     -     type: staleness
//         message: reviewer probe notice
//
// and the parser's array branch consumed only `-`-prefixed lines as *strings*. So
// `parseFrontmatter(serialiseFrontmatter(fm))` returned `notices: ["type: staleness"]` and
// promoted the item's remaining keys (`message`, `posted_at`) to stray TOP-LEVEL frontmatter keys,
// which then fail the published contract's `additionalProperties: false` as well.
//
// Measured on the pre-fix tip (`5a1c58c`) by the t_8d6f4a5c reviewer: 5/7 checks, the two failures
// being `round-trip: notices survives — got ["type: staleness"]` and
// `round-trip: no stray top-level keys`. Evidence:
// `attachments/t_8d6f4a5c/review-notices-tags-probe.out`.
//
// Both L2 writers reach this serialiser — COMPILE's user-page branch (`src/layer2/compiler.ts`) and
// the ENDORSE cascade (`endorsedPageFrontmatter`) — so the shape is pinned here (unit) and the
// carry-forward is pinned end-to-end in the last test.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ulid } from 'ulid';
import { afterEach, describe, test } from 'vitest';

import { SmartwareCore } from '../../src/core.js';
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CLAIM_ID = 'claim_01M2NAFHDJRTHH8K1BWTN65XZG';
const TOMBSTONE_ID = 'tomb_01M2NAFHDJRTHH8K1BWTN65XZH';

const NOTICES = [
  {
    type: 'staleness',
    message: 'reviewer probe notice',
    claim_id: CLAIM_ID,
    posted_at: '2026-09-10T00:00:00.000Z',
  },
  {
    type: 'contradiction',
    message: 'a later observation contradicts this claim',
    tombstone_id: TOMBSTONE_ID,
    posted_at: '2026-09-11T08:15:00.000Z',
  },
];

/** A complete page frontmatter in the published shape (`page-frontmatter.schema.json` required set). */
function pageFrontmatter(notices: unknown[]): Record<string, unknown> {
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
    notices,
  };
}

const BODY = '# Graphiti API\n\nProse.\n';

/** The block the fixed serialiser must emit: standard YAML, item keys at the item's content column. */
const EXPECTED_NOTICES_BLOCK =
  'notices:\n'
  + `  - type: staleness\n    message: reviewer probe notice\n    claim_id: ${CLAIM_ID}\n`
  + '    posted_at: "2026-09-10T00:00:00.000Z"\n'
  + '  - type: contradiction\n    message: a later observation contradicts this claim\n'
  + `    tombstone_id: ${TOMBSTONE_ID}\n    posted_at: "2026-09-11T08:15:00.000Z"\n`;

/**
 * The exact bytes the *pre-fix* serialiser produced for the same input — copied verbatim from the
 * reviewer's probe output (`attachments/t_8d6f4a5c/review-notices-tags-probe.out`), i.e. real
 * on-disk state a page written by the broken writer carries today.
 */
const PREFIX_SERIALISED_NOTICES_BLOCK =
  'notices:\n'
  + '  -     type: staleness\n'
  + '      message: reviewer probe notice\n'
  + `      claim_id: ${CLAIM_ID}\n`
  + '      posted_at: "2026-09-10T00:00:00.000Z"\n';

const PREFIX_PAGE = `---\ntitle: Graphiti API\npage_id: page_graphiti-api\ncategory: concept\nauthor: user\nsources: [${CLAIM_ID}]\nsupporting_claims: []\ncreated: 2026-09-01\nupdated: 2026-09-12\nscope: workspace\nconfidence: medium\nepistemic_tag: inference\nsummary: Graphiti API is deployed.\ntags: [graphiti]\naliases: [Graphiti]\n${PREFIX_SERIALISED_NOTICES_BLOCK}---\n${BODY}`;

describe('L2 page frontmatter — `notices` round-trips the hand-rolled serialiser', () => {
  test('parse(serialise(fm)) is deep-equal for a populated notices array, with no stray top-level keys', () => {
    const fm = pageFrontmatter(NOTICES);

    const serialised = serialiseFrontmatter(fm, BODY);
    const parsed = parseFrontmatter(serialised);
    assert.ok(parsed, 'the serialised frontmatter is readable');

    // The defect: `notices` came back as `["type: staleness"]` and `message`/`posted_at` were
    // promoted to top-level keys.
    assert.deepEqual(
      parsed.frontmatter['notices'],
      NOTICES,
      'the notice objects must survive a write; a string item means the parser consumed the item '
      + 'line as a scalar and dropped the rest of the mapping',
    );
    assert.deepEqual(
      Object.keys(parsed.frontmatter).sort(),
      Object.keys(fm).sort(),
      'the item keys must not leak out of the array as stray top-level frontmatter keys',
    );
    assert.deepEqual(parsed.frontmatter, fm, 'the whole frontmatter survives a write');

    // A rewrite of the parsed shape is byte-stable (the format a page file converges to).
    assert.equal(
      serialiseFrontmatter(parsed.frontmatter, BODY),
      serialised,
      'serialise → parse → serialise is idempotent',
    );
  });

  test('the emitted item lines are standard block YAML (the pre-fix `-     type:` shape is gone)', () => {
    const serialised = serialiseFrontmatter(pageFrontmatter(NOTICES), BODY);

    assert.ok(
      serialised.includes(EXPECTED_NOTICES_BLOCK),
      `the notices block must be standard YAML with the item keys at the item's content column:\n`
      + `${serialised}`,
    );
    // A dash followed by two or more spaces is the pre-fix signature (the item's own indent was
    // left inside the dash line, so every continuation line was mis-aligned).
    assert.equal(
      /^\s*- {2,}\S/m.test(serialised),
      false,
      'no serialised item may carry extra padding between the dash and its content',
    );
    // The item's continuation lines align with its first key (`- ` + content column).
    const noticeLines = serialised.split('\n').filter(line => /^\s*[-a-z_]+(:| )/.test(line) && line.includes('type:'));
    assert.ok(noticeLines.length > 0, 'the fixture must emit notice items');
    for (const line of noticeLines) {
      assert.match(line, /^ {2}- \S/, `item line is not \`  - key: value\`: ${JSON.stringify(line)}`);
    }
  });

  test('a hand-authored page in canonical YAML is read (the §9 notice slot is for user pages)', () => {
    // What a user writes by hand: block-style arrays, `- key: value` mapping items.
    const raw = `---
title: Graphiti API
page_id: page_graphiti-api
category: concept
author: user
sources:
  - ${CLAIM_ID}
supporting_claims: []
created: 2026-09-01
updated: 2026-09-12
scope: workspace
confidence: medium
epistemic_tag: inference
summary: Graphiti API is deployed.
tags: [graphiti]
aliases: [Graphiti]
notices:
  - type: staleness
    message: reviewer probe notice
    posted_at: "2026-09-10T00:00:00.000Z"
---
${BODY}`;

    const parsed = parseFrontmatter(raw);
    assert.ok(parsed, 'the hand-authored page is readable');
    assert.deepEqual(parsed.frontmatter['sources'], [CLAIM_ID], 'scalar block items stay strings');
    assert.deepEqual(parsed.frontmatter['notices'], [
      { type: 'staleness', message: 'reviewer probe notice', posted_at: '2026-09-10T00:00:00.000Z' },
    ]);
    assert.deepEqual(
      Object.keys(parsed.frontmatter).sort(),
      Object.keys(pageFrontmatter([])).sort(),
      'reading canonical YAML leaks no stray top-level keys',
    );
    assert.deepEqual(
      errorKeys(validator(createAjv(), 'page-frontmatter.schema.json'), parsed.frontmatter),
      [],
      'the hand-authored page satisfies the published contract',
    );
  });

  test('a page written by the broken writer is recovered, not dropped (the mis-indented shape is read)', () => {
    const parsed = parseFrontmatter(PREFIX_PAGE);
    assert.ok(parsed, 'the page is readable');
    assert.deepEqual(
      parsed.frontmatter['notices'],
      [NOTICES[0]],
      'the pre-fix bytes still decode to the notice object they were written from',
    );
    assert.equal(parsed.frontmatter['message'], undefined, '`message` is not a page key');
    assert.equal(parsed.frontmatter['posted_at'], undefined, '`posted_at` is not a page key');
    assert.deepEqual(
      Object.keys(parsed.frontmatter).sort(),
      Object.keys(pageFrontmatter([])).sort(),
      'the recovered read has no stray keys either',
    );
  });

  test('the page contract accepts a frontmatter carrying a notice — the pre-fix parse result it must not accept', () => {
    const validate = validator(createAjv(), 'page-frontmatter.schema.json');

    const roundTripped = parseFrontmatter(serialiseFrontmatter(pageFrontmatter(NOTICES), BODY))!;
    assert.deepEqual(
      errorKeys(validate, roundTripped.frontmatter),
      [],
      'a page carrying a populated notices array must satisfy page-frontmatter.schema.json '
      + '(additionalProperties: false — this is what the stray keys cost)',
    );

    // The pre-fix parse result, transcribed from the reviewer's probe output: the stray keys are
    // exactly what the frozen contract rejects, which is why the round trip is load-bearing.
    const preFixParseResult = {
      ...pageFrontmatter([]),
      notices: ['type: staleness'],
      message: 'reviewer probe notice',
      posted_at: '2026-09-10T00:00:00.000Z',
    };
    const preFixErrors = errorKeys(validate, preFixParseResult);
    assert.ok(
      preFixErrors.includes('/:additionalProperties:message')
      && preFixErrors.includes('/:additionalProperties:posted_at'),
      `the measured pre-fix parse result is rejected on its stray keys: ${preFixErrors.join(', ')}`,
    );
  });

  test('a user page carrying a notice keeps it through the next compile (both writers use this serialiser)', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-l2-notices-'));
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

      const wikiDir = path.join(dataDir, 'wiki');
      // `smartware.md` is the instance manifest and `_index.md` files are generated indexes:
      // neither carries page frontmatter (same exclusion as the L2 boundary pin).
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith('.md') && entry.name !== 'smartware.md' && entry.name !== '_index.md'
          ? [full]
          : [];
      });
      pagePath = walk(wikiDir)[0]!;
      assert.ok(pagePath, 'the flow compiles one page');

      await core.endorse({
        actor,
        page_id: String(parseFrontmatter(readFileSync(pagePath, 'utf8'))!.frontmatter['page_id']),
        page_path: pagePath,
        dry_run: false,
        reason: 'the owner confirms this page',
        operation_id: `op_${ulid()}`,
      });
    } finally {
      core.close();
    }

    // The owner (or a host verb) attaches a notice to their own page — §9's notice slot.
    const ended = parseFrontmatter(readFileSync(pagePath, 'utf8'))!;
    assert.equal(ended.frontmatter['author'], 'user', 'ENDORSE makes the page user-authored');
    writeFileSync(
      pagePath,
      serialiseFrontmatter({ ...ended.frontmatter, notices: NOTICES }, ended.body),
      'utf8',
    );

    const core2 = await SmartwareCore.open({ dataDir });
    try {
      await core2.compile({
        actor: { type: 'person' as const, id: 'user:local', display_name: 'Owner' },
        scope: 'workspace',
        use_llm: false,
      });
    } finally {
      core2.close();
    }

    const after = parseFrontmatter(readFileSync(pagePath, 'utf8'))!;
    assert.deepEqual(
      after.frontmatter['notices'],
      NOTICES,
      'a recompile of a user-authored page must carry the notices array through, not corrupt it',
    );
    assert.deepEqual(
      Object.keys(after.frontmatter).sort(),
      Object.keys(pageFrontmatter([])).sort(),
      'the recompiled page has no stray top-level keys',
    );
    assert.deepEqual(
      errorKeys(validator(createAjv(), 'page-frontmatter.schema.json'), after.frontmatter),
      [],
      'the recompiled page still satisfies the published contract',
    );
  }, 180_000);
});
