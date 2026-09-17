// Scope examples in tool descriptions must be published vocabulary (kanban t_574be8cd).
//
// A tool description is the first contract a host reads, and both MCP surfaces
// spell scope examples into them (`src/index.ts` — the standalone server — and
// `src/mcp.ts` — the adapter `cli.js` actually exposes). The OBSERVE example read
// `e.g. personal, project/foo` until this card: both entries are off-vocabulary
// (`personal` is not a scope at all; the spec form is `project:<id>`), so the
// description taught a host two spellings the schemas reject.
//
// The descriptions are string literals in the two files (index.ts builds its
// server inside a non-exported `start()`, so it cannot be listed in-process the
// way `createSmartwareMcpServer` can), and a source scan is the only check that
// covers both surfaces uniformly. This is the pin: every `e.g.` example in a
// scope description must be admitted by `common.schema.json#/$defs/Scope`, and
// the scan must find them (non-vacuity), so a future edit cannot reintroduce an
// off-vocabulary example in either file.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import Ajv2020, { type AnySchema } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, test } from 'vitest';

const SCOPE_DEF_ID = 'https://smartware.dev/schemas/v0.5.0/common.schema.json#/$defs/Scope';

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const dir = path.join(process.cwd(), 'schemas', 'v0.5.0');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.schema.json')).sort()) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as AnySchema);
  }
  return ajv;
}

function admitsScope(value: string): boolean {
  const validate = createAjv().compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: SCOPE_DEF_ID,
  });
  return validate(value);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

/**
 * Every `describe('…')` literal in `src/`, paired with the file it lives in.
 * Single-quoted literals only: the two surfaces write them that way, and a
 * description is a tool-contract string, never a template.
 */
function descriptionLiterals(): Array<{ file: string; description: string }> {
  const found: Array<{ file: string; description: string }> = [];
  for (const file of sourceFiles(path.join(process.cwd(), 'src'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\.describe\(\s*'([^']*)'\s*\)/g)) {
      found.push({ file: path.relative(process.cwd(), file), description: match[1] as string });
    }
  }
  return found;
}

/**
 * The `e.g.` examples of a description, with trailing prose (`(non-reusable
 * marker)`) and the description's closing punctuation stripped.
 */
function examplesOf(description: string): string[] {
  const match = /e\.g\.\s*(.+)/i.exec(description);
  if (!match) return [];
  return (match[1] as string)
    .split(',')
    .map(part => part.replace(/\(.*$/, '').replace(/[).\s]+$/, '').trim())
    .filter(Boolean);
}

const scopeDescriptions = descriptionLiterals()
  .filter(entry => /scope/i.test(entry.description) && /e\.g\./i.test(entry.description));

describe('scope examples in tool descriptions', () => {
  test('every scope example is admitted by the published vocabulary', () => {
    // Non-vacuity: the scan must actually see the descriptions, in both surfaces.
    assert.ok(
      scopeDescriptions.length >= 3,
      `expected at least 3 scope descriptions carrying examples, found ${scopeDescriptions.length}: `
      + JSON.stringify(scopeDescriptions),
    );
    const files = new Set(scopeDescriptions.map(entry => entry.file));
    for (const expected of ['src/index.ts', 'src/mcp.ts']) {
      assert.ok(files.has(expected), `${expected} must spell scope examples (scan found ${[...files].join(', ')})`);
    }

    const offenders: string[] = [];
    let examples = 0;
    for (const { file, description } of scopeDescriptions) {
      for (const example of examplesOf(description)) {
        examples++;
        if (!admitsScope(example)) offenders.push(`${file}: "${example}" (in "${description}")`);
      }
    }
    assert.equal(
      offenders.length,
      0,
      `tool-description scope examples must be admitted by $defs/Scope:\n${offenders.join('\n')}`,
    );
    assert.ok(examples >= 4, `expected at least 4 scope examples across the tool descriptions, found ${examples}`);
  });

  test('the OBSERVE example the card measured is in vocabulary (was `personal, project/foo`)', () => {
    const observe = scopeDescriptions.find(entry =>
      entry.file === 'src/index.ts' && /Scope identifier/i.test(entry.description));
    assert.ok(observe, 'the OBSERVE scope description must still be documented');

    const examples = examplesOf(observe.description);
    assert.ok(examples.length >= 2, `expected examples in "${observe.description}"`);
    for (const example of examples) {
      assert.ok(admitsScope(example), `'${example}' must be admitted by $defs/Scope`);
    }

    // The A/B control: the two spellings this description carried pre-fix are
    // rejected by the vocabulary today, and the pin above would have failed on
    // them — the assertion is only meaningful while that stays true.
    for (const preFix of ['personal', 'project/foo']) {
      assert.equal(
        admitsScope(preFix),
        false,
        `'${preFix}' must stay outside $defs/Scope (it is the pre-fix example the card measured)`,
      );
    }
  });
});
