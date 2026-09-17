// Brain layout at init and after a compile (kanban t_574be8cd).
//
// `initialiseDataDir` (`src/core.ts`) and `initialize` (`src/index.ts`) used to
// create three directories under the wiki root — `wiki/personal`,
// `wiki/workspace`, `wiki/project` — that appear in no normative layout and that
// nothing in the library reads or writes: spec §9's L2 conventions enumerate the
// categories (`concepts`, `entities`, `decisions`, `synthesis`, `tombstones`,
// `profiles`, plus `_index.md`), the compiler creates its own category directory
// on demand (`layer2/compiler.ts`), and the instance manifest creates the root.
// They were the last trace of the pre-rename lane spelling in the storage layout.
//
// This pin asserts the layout a brain is left in: the wiki root and the manifest
// exist, the three vestigial directories do not, and a compiled page still lands
// under `wiki/<category>/` — so removing the directory creation is shown not to
// have removed the page path. The pre-fix revision fails the second assertion
// (the A/B arm).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { SmartwareCore } from '../../src/core.js';

/** The directories init used to create — in no normative layout. */
const VESTIGIAL = ['personal', 'workspace', 'project'];
/** Spec §9's L2 category directories (`wiki/<category>/`). */
const SPEC_CATEGORIES = ['concepts', 'entities', 'decisions', 'synthesis', 'tombstones', 'profiles'];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function categoryDirs(wikiDir: string): string[] {
  return readdirSync(wikiDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== '.git')
    .map(entry => entry.name)
    .sort();
}

function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        walk(full);
      } else if (entry.name.endsWith('.md') && entry.name !== '_index.md') out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

describe('the layout a brain is left in', () => {
  test('init creates the wiki root and no vestigial lane directory', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-layout-'));
    tempDirs.push(dataDir);
    const core = await SmartwareCore.open({ dataDir });
    try {
      const wikiDir = path.join(dataDir, 'wiki');
      // Non-vacuity: the wiki surface exists (removing the directories must not
      // have removed the root the manifest and the git repo are written into).
      assert.ok(existsSync(wikiDir), 'init creates the wiki root');
      assert.ok(existsSync(path.join(wikiDir, 'smartware.md')), 'the instance manifest is written into the wiki root');

      for (const name of VESTIGIAL) {
        const dir = path.join(wikiDir, name);
        assert.equal(
          existsSync(dir),
          false,
          `'wiki/${name}' is in no normative layout and nothing reads it — init must not create it`,
        );
      }
      assert.deepEqual(
        categoryDirs(wikiDir),
        [],
        'init creates no category directory; the compiler creates the one it writes into',
      );

      // The manifest is what a host reads the layout from — and the root is its home.
      assert.equal(
        readdirSync(wikiDir).filter(name => name === 'smartware.md').length,
        1,
        'exactly one manifest in the wiki root',
      );
    } finally {
      core.close();
    }
  }, 120_000);

  test('a compiled page still lands under wiki/<category>/ after the removal', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-layout-compile-'));
    tempDirs.push(dataDir);
    const core = await SmartwareCore.open({ dataDir });
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
      const pages = markdownFiles(wikiDir).filter(file => path.basename(file) !== 'smartware.md');
      assert.equal(pages.length, 1, `the flow compiles exactly one page: ${JSON.stringify(pages)}`);
      assert.match(
        pages[0] as string,
        /wiki\/[a-z]+\/[a-z0-9-]+\.md$/,
        'the page path is wiki/<category>/<slug>.md',
      );
      assert.ok(
        existsSync(path.join(wikiDir, 'concepts', '_index.md')),
        'the category index (spec §9 `_index.md`) is written by the compiler',
      );

      // The page path is the spec's, so the category directory is the writer's —
      // and the vestigial directories stayed gone through the write path.
      for (const name of categoryDirs(wikiDir)) {
        assert.ok(
          SPEC_CATEGORIES.includes(name),
          `'wiki/${name}' is not a spec §9 category directory (spec: ${SPEC_CATEGORIES.join(', ')})`,
        );
      }
      for (const name of VESTIGIAL) {
        assert.equal(
          existsSync(path.join(wikiDir, name)),
          false,
          `'wiki/${name}' must not exist after a compile either`,
        );
      }
      assert.ok(statSync(pages[0] as string).isFile(), 'the compiled page is a file');
    } finally {
      core.close();
    }
  }, 120_000);
});
