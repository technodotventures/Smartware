// L2 page frontmatter — the compile/endorse re-serialise refuses *by page* (t_5742162f).
//
// The defect (measured, independent VERIFY `t_6012c8ca` Finding 2; pre-existing on both arms —
// identical at `c740511` and `a415578`): the reader turns a hand-authored `notices` block array
// with a non-mapping item into a *mixed* object/scalar array — a bare `- ` item → `[{…}, ""]`, a
// `|-` item → `[{…}, "|-"]`, a nested sequence → `["", {…}]` — and the pre-existing mixed-array
// refusal (`t_cf744a8e`/`t_5768425d`) then fires on the *next* re-serialise. Both page writers
// carry the parsed array into that re-serialise unfiltered (`compiler.ts`'s user-page branch and
// `endorsedPageFrontmatter`), so a page on disk could make a compile *and* an endorse throw —
// with an unnamed base `Error` naming only the field, not the page to fix.
//
// DECIDED (option 3 of the card; see the task's board comment for the measurements and the
// rejected alternatives — normalising would drop or stringify the user's bytes, against this
// lane's "loud refusal, not silent flattening" doctrine, and reader semantics for `-` nested
// sequences / `|-` are `t_cf744a8e`/`t_6fc254cd` territory): keep the loud refusal and make it
// explicit. Both call sites now serialise through `serialisePageFrontmatter`, which raises a
// named `PageRefusalError` (`page_refused: "<path>" cannot be re-serialised — <writer reason>`)
// naming the page *and* the field. No semantic change to what compiles, nothing dropped or
// stringified, no published schema byte moves — the page's own bytes stay exactly as authored and
// the remedy is to make the array homogeneous. Pinned here:
//
//   1. the helper's contract (unit): page named, writer's field reason kept verbatim;
//   2. ENDORSE: a hand-edited mixed page refuses the endorsement by name, bytes untouched;
//   3. COMPILE: each of the three reader-producible mixed shapes refuses the next compile by
//      name, bytes untouched;
//   4. controls: a homogeneous object array and a bare string array both compile and are carried
//      (the guard is the *mixed* shape only), a fixed page compiles again, and the writer's own
//      refusal is unchanged.
//
// Non-tautological: the fix-absent check runs this same file in a worktree at `a415578` — the
// two feature tests fail there (`Error` instead of `PageRefusalError`, no page named; the wrapper
// not exported) and the write-boundary control passes on both arms; the same flows' unnamed-error
// behaviour is also recorded first-party with `probes/probe-compile-reachability.mjs` and
// `probes/probe-endorse-reachability.mjs` in the task's evidence bundle.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ulid } from 'ulid';
import { afterEach, describe, test } from 'vitest';

import { SmartwareCore } from '../../src/core.js';
import { parseFrontmatter, serialiseFrontmatter } from '../../src/layer2/frontmatter.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CLAIM_ID = 'claim_01M2NAFHDJRTHH8K1BWTN65XZG';
const ACTOR = { type: 'person' as const, id: 'user:local', display_name: 'Owner' };
const BODY = '# Graphiti API\n\nProse.\n';

/**
 * The three hand-authored blocks the reader produces a mixed array from, with the parse each one
 * yields (all three measured first-party; the same rows as the VERIFY's `N1.notices-*`).
 */
const MIXED_NOTICE_BLOCKS: Array<{ label: string; block: string; parsed: unknown[] }> = [
  {
    label: 'a bare dash item',
    block: 'notices:\n  - type: staleness\n    message: x\n  -\n',
    parsed: [{ type: 'staleness', message: 'x' }, ''],
  },
  {
    label: 'a `|-` item',
    block: 'notices:\n  - type: staleness\n    message: x\n  - |-\n    text\n',
    parsed: [{ type: 'staleness', message: 'x' }, '|-'],
  },
  {
    label: 'a nested sequence',
    block: 'notices:\n  -\n    - type: staleness\n',
    parsed: ['', { type: 'staleness' }],
  },
];

/** A carriable homogeneous array — the over-refusal control. */
const CLEAN_NOTICE_BLOCK = 'notices:\n  - type: staleness\n    message: x\n  - type: contradiction\n    message: y\n';
/** A bare string array: contract-illegal per the published schema, but carriable — not this guard's call. */
const STRING_NOTICE_BLOCK = 'notices:\n  - alpha\n  - beta\n';

/** The published-shape frontmatter the unit cases serialise (same helper shape as the sibling pins). */
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

/** `smartware.md` is the instance manifest and `_index.md` files are generated indexes (sibling-pin exclusion). */
function walkWiki(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkWiki(full);
    return entry.name.endsWith('.md') && entry.name !== 'smartware.md' && entry.name !== '_index.md'
      ? [full]
      : [];
  });
}

/**
 * Assert a refusal is the named page refusal. String-level on purpose (name, stable marker, page,
 * field): this is the contract a caller sees, and the check has to give a *clean* failure on the
 * fix-absent arm, where the class is not exported yet. The class identity itself is asserted in
 * the unit case below.
 */
function assertPageRefusal(refusal: unknown, pagePath: string, what: string): void {
  const seen = refusal instanceof Error ? `${refusal.name}: ${refusal.message}` : String(refusal);
  assert.ok(refusal instanceof Error, `${what}: expected the named page refusal as an Error, got ${seen}`);
  assert.equal(refusal.name, 'PageRefusalError', `${what}: the refusal is the named class — got ${seen}`);
  assert.match(refusal.message, /^page_refused: "/, `${what}: the message carries the stable marker — got ${seen}`);
  assert.ok(refusal.message.includes(pagePath), `${what}: the refusal names the page to fix — got ${seen}`);
  assert.match(refusal.message, /page field "notices" mixes object and non-object items/, `${what}: the refusal names the field and keeps the writer's reason — got ${seen}`);
  assert.match(refusal.message, /schemas\/v0\.5\.0\/page-frontmatter\.schema\.json/, `${what}: the remedy is kept — got ${seen}`);
}

describe('L2 page frontmatter — the re-serialise refuses by page, not by serialiser stack trace (t_5742162f)', () => {
  test('the write-boundary refusal itself is unchanged: the writer refuses the mixed array, and carriable pages serialise', () => {
    // This is the pre-existing rule (`t_cf744a8e`/`t_5768425d`) the lane surfaces — it must pass on
    // both arms of the fix-absent check, so the pin does not re-open the refusal itself.
    assert.throws(
      () => serialiseFrontmatter(pageFrontmatter([{ type: 'staleness', message: 'x' }, '']), BODY),
      /page field "notices" mixes object and non-object items/,
      'the writer still refuses the mixed array, naming the field',
    );
    const serialised = serialiseFrontmatter(pageFrontmatter([{ type: 'staleness', message: 'x' }]), BODY);
    assert.deepEqual(
      parseFrontmatter(serialised)!.frontmatter['notices'],
      [{ type: 'staleness', message: 'x' }],
      'a carriable page still serialises and reads back',
    );
  });

  test('serialisePageFrontmatter names the page and keeps the writer\'s field reason', async () => {
    const frontmatter = await import('../../src/layer2/frontmatter.js');
    assert.equal(
      typeof frontmatter.serialisePageFrontmatter,
      'function',
      'the page-named wrapper is exported (t_5742162f)',
    );
    assert.equal(typeof frontmatter.PageRefusalError, 'function', 'the named refusal class is exported');

    const mixed = pageFrontmatter([{ type: 'staleness', message: 'x' }, '']);
    assert.throws(
      () => frontmatter.serialisePageFrontmatter('/data/wiki/concepts/graphiti-api.md', mixed, BODY),
      (error: unknown) => {
        assertPageRefusal(error, '/data/wiki/concepts/graphiti-api.md', 'the mixed array');
        assert.ok(
          error instanceof frontmatter.PageRefusalError,
          'the refusal is the exported class (identity, not only the name)',
        );
        return true;
      },
    );

    // The wrapper is a pass-through for a carriable page: same output as `serialiseFrontmatter`.
    const carriable = pageFrontmatter([{ type: 'staleness', message: 'x' }]);
    assert.equal(
      frontmatter.serialisePageFrontmatter('/data/wiki/concepts/graphiti-api.md', carriable, BODY),
      serialiseFrontmatter(carriable, BODY),
      'a carriable page serialises through the wrapper byte-identically',
    );
  });

  test('a hand-authored mixed notices array refuses the next compile/endorse by page name; the page bytes stay as authored', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-l2-page-refusal-'));
    tempDirs.push(dataDir);

    // ── The real flow up to the first compile (use_llm false, as the sibling pins). ───────────
    let pagePath = '';
    let pageId = '';
    {
      const core = await SmartwareCore.open({ dataDir });
      try {
        core.ensureTrustedClientGrant('user:local', 'person', ['self', 'workspace']);
        await core.observe({
          actor: ACTOR,
          type: 'message',
          scope: 'workspace',
          observed_at: '2026-11-01T10:30:00Z',
          content: { format: 'text/plain', body: 'Graphiti API is deployed.' },
        });
        await core.reflect({ actor: ACTOR, scope: 'workspace', use_llm: false });
        await core.compile({ actor: ACTOR, scope: 'workspace', use_llm: false });
        pagePath = walkWiki(path.join(dataDir, 'wiki'))[0]!;
        assert.ok(pagePath, 'the flow compiles one page');
        pageId = String(parseFrontmatter(readFileSync(pagePath, 'utf8'))!.frontmatter['page_id']);
      } finally {
        core.close();
      }
    }
    assert.ok(
      readFileSync(pagePath, 'utf8').includes('notices: []\n'),
      'fixture: the compiled page carries the empty notices slot',
    );
    const agentBytes = readFileSync(pagePath, 'utf8');

    // ── ENDORSE half: the same bytes make an endorsement refuse — by page, and untouched. ─────
    const mixedEndorseBytes = agentBytes.replace('notices: []\n', MIXED_NOTICE_BLOCKS[0]!.block);
    assert.ok(mixedEndorseBytes.includes(MIXED_NOTICE_BLOCKS[0]!.block), 'fixture: the block was spliced in');
    writeFileSync(pagePath, mixedEndorseBytes, 'utf8');
    {
      const core = await SmartwareCore.open({ dataDir });
      let refusal: unknown;
      try {
        await core.endorse({
          actor: ACTOR,
          page_id: pageId,
          page_path: pagePath,
          dry_run: false,
          reason: 'the owner confirms this page',
          operation_id: `op_${ulid()}`,
        });
      } catch (error) {
        refusal = error;
      } finally {
        core.close();
      }
      assertPageRefusal(refusal, pagePath, 'endorse');
      assert.equal(readFileSync(pagePath, 'utf8'), mixedEndorseBytes, 'the refused endorse leaves the page bytes untouched');
    }

    // The refusal is actionable: fix the value and the same flow proceeds (this is the remedy the
    // error and the docs state — no reader change is needed for a page like this).
    writeFileSync(pagePath, agentBytes, 'utf8');
    {
      const core = await SmartwareCore.open({ dataDir });
      try {
        await core.endorse({
          actor: ACTOR,
          page_id: pageId,
          page_path: pagePath,
          dry_run: false,
          reason: 'the owner confirms this page',
          operation_id: `op_${ulid()}`,
        });
      } finally {
        core.close();
      }
    }
    const afterEndorse = readFileSync(pagePath, 'utf8');
    assert.equal(parseFrontmatter(afterEndorse)!.frontmatter['author'], 'user', 'ENDORSE makes the page user-authored');
    assert.ok(afterEndorse.includes('notices: []\n'), 'fixture: the endorsed page still carries the empty notices slot');

    // ── COMPILE half: each reader-producible mixed shape refuses the next compile by page. ────
    for (const shape of MIXED_NOTICE_BLOCKS) {
      const bytes = afterEndorse.replace('notices: []\n', shape.block);
      assert.ok(bytes.includes(shape.block), `fixture (${shape.label}): the block was spliced in`);
      writeFileSync(pagePath, bytes, 'utf8');
      assert.deepEqual(
        parseFrontmatter(readFileSync(pagePath, 'utf8'))!.frontmatter['notices'],
        shape.parsed,
        `${shape.label}: the reader yields the mixed array (the reachable half)`,
      );

      const core = await SmartwareCore.open({ dataDir });
      let refusal: unknown;
      try {
        await core.compile({ actor: ACTOR, scope: 'workspace', use_llm: false });
      } catch (error) {
        refusal = error;
      } finally {
        core.close();
      }
      assertPageRefusal(refusal, pagePath, `compile (${shape.label})`);
      assert.equal(
        readFileSync(pagePath, 'utf8'),
        bytes,
        `${shape.label}: the refused page's bytes are untouched — nothing dropped or stringified`,
      );
    }

    // ── Controls: the refusal is the mixed shape, not hand-authored notices as such. ──────────
    const controls: Array<{ label: string; block: string; want: unknown[] }> = [
      {
        label: 'a homogeneous object array',
        block: CLEAN_NOTICE_BLOCK,
        want: [{ type: 'staleness', message: 'x' }, { type: 'contradiction', message: 'y' }],
      },
      { label: 'a bare string array', block: STRING_NOTICE_BLOCK, want: ['alpha', 'beta'] },
    ];
    for (const control of controls) {
      const bytes = afterEndorse.replace('notices: []\n', control.block);
      writeFileSync(pagePath, bytes, 'utf8');
      const core = await SmartwareCore.open({ dataDir });
      try {
        await core.compile({ actor: ACTOR, scope: 'workspace', use_llm: false });
      } finally {
        core.close();
      }
      const after = parseFrontmatter(readFileSync(pagePath, 'utf8'))!;
      assert.deepEqual(
        after.frontmatter['notices'],
        control.want,
        `${control.label}: compiles and is carried (no over-refusal on the compile path)`,
      );
      assert.equal(after.frontmatter['author'], 'user', `${control.label}: the page stays user-authored`);
    }
  }, 180_000);
});
