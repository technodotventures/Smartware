// Layer 2 — YAML frontmatter read/write/validate
//
// The parser is deliberately untyped: a page on disk may still carry the pre-ADR-0013 → D2
// envelope inline, and the reader has to accept both shapes. Use `readPageFile`
// (`src/layer2/envelope.ts`) for the shape-aware entry point.
//
// The serialiser is hand-rolled and minimal by design; its contract is that everything it writes
// reads back unchanged for the page vocabulary (`schemas/v0.5.0/page-frontmatter.schema.json`):
// scalars, string arrays, and arrays of notice objects of scalar values. Shapes outside that
// vocabulary are refused at the write boundary (`assertPageVocabulary`) rather than emitted in a
// form the reader would silently flatten or drop (t_cf744a8e).
//
// The reader additionally accepts the block-scalar styles a *page author* plausibly writes even
// though no in-tree writer emits them — `|` and `>` with the `-` (strip) / `+` (keep) chomping
// indicators and the explicit indentation indicator, at the top level and as a block-array item —
// and decodes a quoted key (`- "k": v`). Before t_6fc254cd each of those read as the literal marker
// string (`summary: |-` → `'|-'`), which the contract types as a legal `string`, so nothing
// downstream complained. What is still unread is stated with its measured behaviour at the branches
// below; nothing is left to be discovered.

import { toPageCategory } from './paths.js';

/**
 * Parse YAML frontmatter from a markdown file's string content.
 * Returns { frontmatter, body } or null if no frontmatter found.
 */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } | null {
  if (!raw.startsWith('---\n')) return null;
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return null;

  const yamlBlock = raw.slice(4, end);
  const body = raw.slice(end + 5);

  try {
    const frontmatter = parseYAML(yamlBlock);
    return { frontmatter, body };
  } catch {
    return null;
  }
}

/**
 * Serialise frontmatter + body back to a full markdown string.
 *
 * Refuses (throws on) a value the minimal reader cannot carry — a nested object anywhere in the
 * page vocabulary's value positions (t_cf744a8e) — instead of writing YAML that flattens or drops
 * it on the next read.
 */
export function serialiseFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  assertPageVocabulary(frontmatter);
  return `---\n${toYAML(frontmatter)}---\n${body}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** A value YAML carries as a mapping — the shape the page vocabulary does not admit. */
function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The page vocabulary is scalars, string arrays, and arrays of notice objects whose values are
 * scalars: `schemas/v0.5.0/page-frontmatter.schema.json` declares no object-valued field and the
 * top level is `additionalProperties: false`. `toYAML` writes an object value as `key:` plus
 * indented lines, and `parseYAML` reads one `key: value` per line with no indentation model, so
 * those lines come back flattened into the *parent* — `{meta: {a: b}}` inside a notice item reads
 * as `{meta: …, a: b}`, and at the top level `a` leaks out as a stray page key. The value is lost,
 * not merely re-shaped (measured on t_cf744a8e). Refuse the write and name the offending field.
 */
function assertPageVocabulary(frontmatter: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(frontmatter)) {
    if (isObjectValue(value)) rejectNestedObject(key);
    if (!Array.isArray(value)) continue;
    value.forEach((item, index) => {
      if (!isObjectValue(item)) return;
      for (const [itemKey, itemValue] of Object.entries(item)) {
        if (isObjectValue(itemValue)) rejectNestedObject(`${key}[${index}].${itemKey}`);
      }
    });
  }
}

function rejectNestedObject(field: string): never {
  throw new Error(
    `serialiseFrontmatter: page field "${field}" holds a nested object, which the page YAML `
    + `vocabulary cannot carry (strings, string arrays, and notice objects of scalar values only); `
    + `flatten the value or extend the page contract (schemas/v0.5.0/page-frontmatter.schema.json) first`,
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate that frontmatter carries the **published** page contract — spec §9's field set,
 * which is `schemas/v0.5.0/page-frontmatter.schema.json`. The pre-fix envelope fields
 * (`entity_id`, `compiled_at`, `claim_ids`, …) are not part of it; they live in the page's
 * derived cached region instead (ADR-0013 → D2).
 */
export function validateFrontmatter(fm: Record<string, unknown>): boolean {
  const pageId = fm['page_id'];
  const author = fm['author'];
  const confidence = fm['confidence'];
  return !!(
    typeof fm['title'] === 'string' &&
    typeof pageId === 'string' && /^page_[a-z0-9-]+$/.test(pageId) &&
    toPageCategory(fm['category']) !== null &&
    (author === 'agent' || author === 'user') &&
    isStringArray(fm['sources']) &&
    isStringArray(fm['supporting_claims']) &&
    typeof fm['created'] === 'string' && ISO_DATE.test(fm['created']) &&
    typeof fm['updated'] === 'string' && ISO_DATE.test(fm['updated']) &&
    typeof fm['scope'] === 'string' &&
    (confidence === 'high' || confidence === 'medium' || confidence === 'low') &&
    typeof fm['epistemic_tag'] === 'string' &&
    typeof fm['summary'] === 'string'
  );
}

// ── Minimal YAML serialiser (sufficient for our schema) ──────────────────────

function toYAML(obj: Record<string, unknown>, indent = 0): string {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) {
      lines.push(`${pad}${key}: null`);
    } else if (typeof val === 'boolean') {
      lines.push(`${pad}${key}: ${val}`);
    } else if (typeof val === 'number') {
      lines.push(`${pad}${key}: ${val}`);
    } else if (typeof val === 'string') {
      const escaped = val.includes('\n') ? `|\n${val.split('\n').map(l => `  ${pad}${l}`).join('\n')}` : yamlString(val);
      lines.push(`${pad}${key}: ${escaped}`);
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else if (typeof val[0] === 'object') {
        lines.push(`${pad}${key}:`);
        // Standard block YAML: the item's own lines follow the dash at the item's content column
        // (`- key: value`, continuation keys aligned under the first one). The item indent must
        // NOT be left inside the dash line: that shape (`-     key: value` with the continuation
        // lines at a *shallower* column) is invalid YAML for a real reader and did not survive
        // this file's own parser (t_4d84ff6b).
        for (const item of val) {
          const itemLines = toYAML(item as Record<string, unknown>, indent + 4).split('\n').filter(Boolean);
          const [first = '', ...rest] = itemLines;
          lines.push(`${pad}  - ${first.slice(indent + 4)}`);
          for (const l of rest) lines.push(l);
        }
      } else {
        lines.push(`${pad}${key}: [${(val as unknown[]).map(v => yamlString(String(v))).join(', ')}]`);
      }
    } else if (typeof val === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(toYAML(val as Record<string, unknown>, indent + 2));
    }
  }
  return lines.join('\n') + '\n';
}

function yamlString(s: string): string {
  // The empty scalar is written `""`: `key: ` (or an empty array element) would read back as a
  // dropped key / YAML null instead of the empty string it was (t_cf744a8e).
  if (s === '') return '""';
  if (/[:\[\]{},&*#?|<>=!%@`'"]/.test(s) || s.includes('\n') || s.startsWith(' ') || s.endsWith(' ')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** Minimal YAML parser — handles our specific frontmatter schema */
function parseYAML(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const colonIdx = keyColonIndex(line);
    if (colonIdx === -1) { i++; continue; }

    // A quoted KEY is one scalar however many colons it contains (`- "a: b": c` is the mapping
    // `{'a: b': 'c'}` — real YAML), so the separator is found quote-aware and the key decoded,
    // exactly as a quoted *value* already was (t_6fc254cd).
    const key = unquote(line.slice(0, colonIdx).trim());
    const rest = line.slice(colonIdx + 1).trim();

    const style = blockStyle(rest);
    if (style) {
      // Block scalar — literal (`|`) or folded (`>`), plus the chomping and indentation indicators.
      // `|` is how `toYAML` writes any string containing a newline; every other form is
      // hand-authored (no in-tree writer emits one). Before t_6fc254cd only the exact marker `|` was
      // recognised, so `summary: |-` parsed as the literal string `'|-'` with the content dropped —
      // a silent wrong value the contract accepts (`summary` is a bare `type: string`). Read them all.
      const { text, next } = readBlockScalar(lines, i + 1, leadingSpaces(line), style);
      result[key] = text;
      i = next;
      continue;
    }

    if (rest === '') {
      // `key:` with nothing after it. A `-`-prefixed next line opens an array; a *deeper* next
      // line opens a construct this minimal reader has no model for (a nested object/sequence) and
      // is left where it is; otherwise YAML's value is null — the writer spells a real null
      // `key: null` and an empty string `key: ""` (t_cf744a8e), so this is a hand-authored bare
      // key, and reading it as null beats dropping it silently.
      //
      // Measured, and recorded rather than left to surprise the next reader (t_6fc254cd):
      // `summary:\nmeta:\n  a: b` reads as `{'summary': null, 'a': 'b'}` — `meta` vanishes (its
      // block is deeper than the reader models) and its only key leaks out as a top-level page key,
      // which the contract's `additionalProperties: false` then rejects. No in-tree writer emits it.
      if (i + 1 < lines.length && lines[i + 1]!.match(/^\s*-/)) {
        const { items, next } = parseBlockArray(lines, i + 1);
        result[key] = items;
        i = next;
        continue;
      }
      if (!hasDeeperNonBlankLine(lines, i + 1, leadingSpaces(line))) result[key] = null;
      i++;
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      // Inline array — elements are comma-separated, but a comma inside a quoted element belongs
      // to the element (t_cf744a8e: `["alpha, beta"]` used to split into two malformed values).
      const inner = rest.slice(1, -1).trim();
      result[key] = inner === '' ? [] : splitInlineArray(inner);
    } else if (rest === 'true') {
      result[key] = true;
    } else if (rest === 'false') {
      result[key] = false;
    } else if (rest === 'null') {
      result[key] = null;
    } else if (!isNaN(Number(rest)) && rest !== '') {
      result[key] = Number(rest);
    } else {
      result[key] = unquote(rest);
    }
    i++;
  }
  return result;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

const QUOTE_CHARS = new Set(['"', "'"]);

/**
 * The index of the colon that separates a `key:` from its value, ignoring colons inside a quoted
 * key (`"a: b": c` separates at the colon *after* the closing quote). A line with no colon outside
 * quotes falls back to the first colon it has — a malformed line keeps behaving as it did before
 * (it stays a key) rather than vanishing from the parse entirely (t_6fc254cd).
 */
function keyColonIndex(line: string): number {
  const first = line.indexOf(':');
  if (first === -1) return -1;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote !== null) {
      if (char === '\\' && quote === '"') { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (QUOTE_CHARS.has(char)) { quote = char; continue; }
    if (char === ':') return i;
  }
  return first;
}

/** A block-scalar header's marker: `|` (literal) or `>` (folded), plus an optional chomping
 * indicator (`-` strip / `+` keep) and an optional explicit indentation indicator (`1`-`9`), in
 * either order — every header YAML allows. Anything else — `|0`, a value that merely *looks* like a
 * marker (`summary: "|-"`) — is not a header. */
const BLOCK_MARKER = /^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?$/;

/**
 * Read a block-scalar header (`|`, `|-`, `|+`, `>`, `>-`, `>+`, and the indentation-indicator forms
 * `|2`, `|2-`, `|-2`, `>3+`, …) — null when the text after the colon is not one.
 *
 * The indentation indicator is modelled as YAML defines it: the block's content is indented
 * `introduceIndent + N`, so leading spaces beyond that are *content*. Measured against two
 * independent spec readers (`yaml@2.9.0`, `js-yaml@4.3.2` — `probes/probe-indent-indicator.mjs` in
 * the t_6fc254cd workspace): all nine valid shapes agree exactly, including the block-item and
 * nested-key columns. Before t_6fc254cd such a value read as the literal marker string (`|2`), a
 * legal `string` in the page contract — i.e. silent, not loud.
 */
function blockStyle(rest: string): { folded: boolean; chomp: '' | '-' | '+' ; indent: number } | null {
  const match = BLOCK_MARKER.exec(rest);
  if (!match) return null;
  const chomp = (match[2] ?? match[5] ?? '') as '' | '-' | '+';
  const indent = Number(match[3] ?? match[4] ?? 0);
  return { folded: match[1] === '>', chomp, indent };
}

/**
 * Split the inside of an inline array (`[a, "b, c"]`) into its raw elements: a comma inside a
 * quoted scalar belongs to that scalar, not to the separator set (t_cf744a8e — `["alpha, beta"]`
 * used to decode as two malformed values).
 */
function splitInlineArray(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!;
    if (quote !== null) {
      current += char;
      if (char === '\\' && quote === '"' && i + 1 < inner.length) {
        // Stay inside the element: an escaped character cannot close the scalar.
        current += inner[++i]!;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (QUOTE_CHARS.has(char)) {
      quote = char;
      current += char;
    } else if (char === ',') {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map(part => unquote(part.trim()));
}

/**
 * Read a block scalar introduced on the line before `start` (`key: |`, `key: |-`, `key: >`, or the
 * block-array item form `- |`): the run of lines indented deeper than the introducing line, blank
 * lines in between kept, and the block's common indentation stripped.
 *
 * This is the reader half of `toYAML`'s multi-line-string shape (`|`, t_cf744a8e), extended to the
 * styles a *page author* writes (t_6fc254cd):
 *
 *   `|`   literal, no indicator — the block's lines verbatim, trailing blank lines included. This is
 *         exactly the bytes `toYAML` emits, so the writer's round-trip is untouched by this change.
 *   `|-`  literal, strip — the block's trailing blank lines are removed (that is what the marker is
 *         for). Measured before the fix: the value was the marker string `'|-'`.
 *   `|+`  literal, keep — the same as the unmarked style here. A spec reader distinguishes clip
 *         (one trailing line break) from keep (all of them); this reader never adds the trailing
 *         line terminator to a scalar (the documented deviation below), so both keep the block's
 *         own lines and the marker changes nothing.
 *   `>`   folded — single line breaks between plain lines become spaces, a run of blank lines is a
 *         paragraph break of the same length, and a more-indented line keeps its own line breaks
 *         (YAML's "more indented lines are not folded" rule). `>-`/`>+` chomp as above.
 *   `|N`  explicit indentation indicator — the content is indented `introduceIndent + N`; the block
 *         ends at the first non-blank line indented less than that. Every valid header YAML allows
 *         is now read (measured against two spec readers). A content line *shallower* than the
 *         declared indentation is a parse error in YAML; here it simply ends the block and is left
 *         where it is (this reader has no error channel, and `parseFrontmatter`'s catch would make
 *         a throw indistinguishable from "no frontmatter").
 *
 * Known deviation, documented rather than fixed here (it predates this change and applies to the
 * writer's own `|` output too): a spec YAML reader applies *clip* chomping to a scalar with no
 * chomping indicator and therefore returns exactly one more trailing line break than this reader
 * does — measured identically on `yaml@2.9.0` and `js-yaml@4.3.2` across every non-strip case in
 * `probes/probe-vs-reference.mjs` (t_6fc254cd workspace). This reader returns the block's lines
 * verbatim, which is what makes `parse(serialise(fm))` exact for the writer's shape; the `-` forms
 * are exact against a spec reader.
 */
function readBlockScalar(
  lines: string[],
  start: number,
  introduceIndent: number,
  style: { folded: boolean; chomp: '' | '-' | '+'; indent: number },
): { text: string; next: number } {
  // The shallowest column that still belongs to the block: the declared one when the header carries
  // an indentation indicator, otherwise anything deeper than the introducing line.
  const minIndent = style.indent > 0 ? introduceIndent + style.indent : introduceIndent + 1;
  const collected: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      collected.push('');
      i++;
      continue;
    }
    if (leadingSpaces(line) < minIndent) break;
    collected.push(line);
    i++;
  }
  const indents = collected.filter(line => line.trim() !== '').map(line => leadingSpaces(line));
  const strip = style.indent > 0
    ? minIndent
    : indents.length > 0 ? indents.reduce((min, n) => Math.min(min, n)) : 0;
  const content = collected.map(line => (line.trim() === '' ? '' : line.slice(strip)));

  if (style.chomp === '-') {
    while (content.length > 0 && content[content.length - 1] === '') content.pop();
  }
  const text = style.folded ? foldLines(content) : content.join('\n');
  return { text, next: i };
}

/**
 * Fold a `>` block's content lines: adjacent plain lines join with a space, a run of blank lines
 * becomes a paragraph break of the same length, and a more-indented line (after the block's common
 * indentation is stripped, a line that still starts with a space) keeps its own line breaks — YAML's
 * "more indented lines are not folded" rule. Trailing blank lines of the block are kept as line
 * breaks unless the marker's chomping already removed them.
 */
function foldLines(content: string[]): string {
  const parts: string[] = [];
  let breaks = 0;
  let emitted = false;
  let previousMoreIndented = false;
  for (const line of content) {
    if (line.trim() === '') { breaks++; continue; }
    const moreIndented = line.startsWith(' ');
    if (!emitted) {
      parts.push(line);
      emitted = true;
    } else if (breaks > 0) {
      parts.push('\n'.repeat(breaks) + line);
    } else if (moreIndented || previousMoreIndented) {
      parts.push('\n' + line);
    } else {
      parts.push(' ' + line);
    }
    previousMoreIndented = moreIndented;
    breaks = 0;
  }
  if (emitted && breaks > 0) parts.push('\n'.repeat(breaks));
  return parts.join('');
}

/** Whether the next non-blank line is indented deeper than the key that precedes it. */
function hasDeeperNonBlankLine(lines: string[], from: number, keyIndent: number): boolean {
  for (let j = from; j < lines.length; j++) {
    const line = lines[j]!;
    if (line.trim() === '') continue;
    return leadingSpaces(line) > keyIndent;
  }
  return false;
}

const BLOCK_ITEM = /^(\s*)-(\s*)(.*)$/;

/** The number of leading whitespace characters on a line. */
function leadingSpaces(line: string): number {
  return line.length - line.replace(/^\s*/, '').length;
}

/** Whether a block item's content opens a mapping (`key: value`) rather than a plain scalar. */
function isMappingItem(content: string): boolean {
  // A quoted scalar is one scalar however many colons it contains: `- "a: b"` is the string
  // `a: b` (the parent fix of t_4d84ff6b read it as `{'"a': 'b"'}`, as the reviewer measured).
  if (isQuotedScalar(content)) return false;
  // `- http://example.com` is a scalar, not `{ http: '//example.com' }`: the colon has to be
  // followed by whitespace (or end the line) to separate a key from its value.
  return /^[^\s:][^:]*:(\s|$)/.test(content);
}

/** Whether the whole content is one quoted scalar (`"…"` or `'…'` with the matching close at the end). */
function isQuotedScalar(content: string): boolean {
  const quote = content[0];
  return (quote === '"' || quote === "'")
    && content.length >= 2
    && content[content.length - 1] === quote;
}

/**
 * Read a block-style array of `-`-prefixed lines starting at `start`.
 *
 * An item whose content opens a mapping (`- key: value`) decodes into an OBJECT together with its
 * continuation lines — every line indented deeper than the item's dash. This is the `notices`
 * shape (spec §9 / `page-frontmatter.schema.json`): a user-authored page carries an array of
 * `{type, message, claim_id?, tombstone_id?, posted_at?}` objects, and before this the array
 * branch read every dash line as a *string*, so `parse(serialise(fm))` returned
 * `notices: ["type: staleness"]` and pushed the remaining item keys out as stray top-level
 * frontmatter keys (which then fail the contract's `additionalProperties: false`) — t_4d84ff6b.
 *
 * Both the standard shape this serialiser now emits and the mis-indented shape the pre-fix
 * serialiser wrote decode to the same object, so a page written by the broken writer is recovered
 * on read instead of silently degraded. A plain item (`- alpha`) stays a string, a quoted scalar
 * item (`- "a: b"`) stays the one string it is, and a block-scalar item (`- |`, `- |-`, `- >` +
 * deeper lines) is the multi-line string it introduces (t_cf744a8e, t_6fc254cd).
 *
 * Still unread, and left where it is rather than silently swallowed: a nested sequence item
 * (`- - a`), a construct no page field admits. Measured on this reader — recorded here so the next
 * reader does not have to rediscover it — `sources:\n  - - a\n    - b` parses as
 * `{'sources': ['- a', 'b']}`: the item's own content becomes a string and the deeper dash line a
 * sibling item. The page contract types `sources` items as strings, so the outcome is two legal
 * strings holding the wrong values, and no in-tree writer emits one
 * (`probes/probe-unread-constructs.mjs` in the t_6fc254cd workspace carries the case).
 */
function parseBlockArray(lines: string[], start: number): { items: unknown[]; next: number } {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const match = BLOCK_ITEM.exec(lines[i]!);
    if (!match) break;
    const dashIndent = match[1]!.length;
    const content = match[3]!.trim();
    i++;

    const style = blockStyle(content);
    if (style) {
      // A block scalar as the item's own value (`- |`, `- |-`, `- >`): the block-array form of a
      // multi-line string. Before t_cf744a8e the marker was kept as the value and the content
      // dropped; before t_6fc254cd the chomping/folded markers read the same way.
      const { text, next } = readBlockScalar(lines, i, dashIndent, style);
      items.push(text);
      i = next;
      continue;
    }

    if (!isMappingItem(content)) {
      // A plain item is a string, as before.
      items.push(unquote(content));
      continue;
    }

    // `parseYAML` is mostly indentation-agnostic (one `key: value` per line), but the block-scalar
    // branch and the bare-key branch need the item's *content column*, which is where standard
    // block YAML puts it: the dash plus one space (`  - key: value`, keys of the same item aligned
    // under the first one at column dashIndent + 2). The dash line's content is trimmed, so it is
    // re-indented to that column; the continuation lines keep the indent they were written with.
    const itemIndent = dashIndent + 2;
    const block = [' '.repeat(itemIndent) + content];
    while (i < lines.length && leadingSpaces(lines[i]!) > dashIndent) {
      block.push(lines[i]!);
      i++;
    }
    items.push(parseYAML(block.join('\n')));
  }
  return { items, next: i };
}
