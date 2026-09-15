#!/usr/bin/env node
/**
 * verify-adr-registry — the mechanical half of the numbering rule in
 * docs/adr/README.md ("## Numbering"). Checks, on this tree:
 *   1. every docs/adr/NNNN-slug.md has a registry row with the same number and
 *      slug (add the row in the same commit that adds the file);
 *   2. no two ADR files share a number (a collision must be refiled before the
 *      claim merges);
 *   3. the registry table is sorted by number (so a colliding claim — same
 *      number, same position — collides textually at merge time).
 *
 * Cross-branch claims (unmerged lanes) live in the registry only; this check is
 * per-tree and runs in CI, so the merge commit is what has to be consistent.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const adrDir = join(root, 'docs', 'adr');
const readmePath = join(adrDir, 'README.md');

const problems = [];

const adrs = [];
for (const f of readdirSync(adrDir)) {
  if (!f.endsWith('.md') || f === 'README.md') continue;
  const m = f.match(/^(\d{4})-([a-z0-9-]+)\.md$/);
  if (!m) {
    problems.push(`docs/adr/${f}: file name is not NNNN-slug.md`);
    continue;
  }
  adrs.push({ num: m[1], slug: m[2], file: f });
}

const rows = [];
let lineNo = 0;
for (const line of readFileSync(readmePath, 'utf8').split('\n')) {
  lineNo += 1;
  const m = line.match(/^\|\s*(\d{4})\s*\|\s*([a-z0-9-]+)\s*\|/);
  if (m) rows.push({ num: m[1], slug: m[2], line: lineNo });
}

if (!rows.length) {
  problems.push('docs/adr/README.md: no registry rows found — the "## Numbering" registry is missing');
}

// 1. every ADR file is registered (by number and slug)
for (const a of adrs) {
  if (!rows.some((r) => r.num === a.num && r.slug === a.slug)) {
    problems.push(
      `docs/adr/${a.file}: no registry row for ${a.num}/${a.slug} — add one in the same commit that added the file (docs/adr/README.md, "Numbering")`,
    );
  }
}

// 2. no two files share a number, in this tree
const byNum = new Map();
for (const a of adrs) {
  if (!byNum.has(a.num)) byNum.set(a.num, []);
  byNum.get(a.num).push(a.file);
}
for (const [num, files] of byNum) {
  if (files.length > 1) {
    problems.push(
      `number ${num} is used by ${files.length} files in this tree (${files.join(', ')}) — renumber the later claim before merge, per "Numbering"`,
    );
  }
}

// 3. registry sorted by number
for (let i = 1; i < rows.length; i += 1) {
  if (rows[i].num < rows[i - 1].num) {
    problems.push(
      `docs/adr/README.md:${rows[i].line}: registry is not sorted by number (${rows[i - 1].num} before ${rows[i].num})`,
    );
  }
}

if (problems.length) {
  console.error(`verify-adr-registry: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `verify-adr-registry: OK — ${adrs.length} ADR file(s), ${rows.length} registry row(s); numbers unique and registered`,
);
