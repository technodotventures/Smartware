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
// form the reader would silently flatten or drop (t_cf744a8e). Two refinements from t_5768425d:
// a string the reader would coerce to another type (`"123"`, `"true"`, `"null"`, the `0x10`/`1e3`/
// `Infinity` spellings) is written quoted so it reads back as the string it was, and the guard
// reaches every value position — a mapping nested at any depth, a mixed scalar/object array —
// rather than only one level into a notice item.

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
 * Refuses (throws on) a value the minimal reader cannot carry — a mapping at any value position,
 * at any depth, and a mixed scalar/object array (t_cf744a8e, t_5768425d) — instead of writing
 * YAML that flattens or drops it on the next read.
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
 * an object at a *property position* comes back flattened into the nearest enclosing mapping with
 * its own key lost — `{meta: {a: b}}` inside a notice item reads as `{meta: …, a: b}`, at the top
 * level `a` leaks out as a stray page key, and inside a nested array both levels of keys are
 * pulled up (`notices[0].links[0].meta` loses `meta`). The value is lost, not merely re-shaped
 * (measured on t_cf744a8e; the deeper positions on t_5768425d). The walk below reaches every
 * value position: refuse the write and name the offending field path.
 */
function assertPageVocabulary(frontmatter: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(frontmatter)) {
    if (isObjectValue(value)) rejectNestedObject(key);
    if (Array.isArray(value)) assertArrayCarriable(value, key);
  }
}

/**
 * Walk one array the writer is about to emit. `toYAML` picks the array's form from its FIRST item
 * (`typeof items[0] === 'object'` → block items, else an inline `[a, b]` of `String(item)`
 * elements), so only a homogeneous array is carriable: all scalars inline, or all objects as
 * block items. A mixed array is written through `String(item)` — `[a, {b: c}]` becomes
 * `[a, [object Object]]`, `[{b: c}, a]` becomes `0: a` lines — and never reads back; it is
 * refused. Each object item's properties are then value positions in their own right: a mapping
 * there is the flattening case above (`notices[0].links[0].meta`), and an array there recurses —
 * arrays of objects inside a notice item round-trip (t_5768425d, probe rows C2ctl1–C2ctl2).
 *
 * Left as-is, deliberately: an array of *arrays* (a nested sequence) is the out-of-vocabulary
 * shape documented by t_cf744a8e — no page field admits one, it is still written through the
 * block branch as `0: …` lines and still reads back garbled (`[["x", "y"]]` →
 * `[{0: "x", 1: "y"}]`, measured as t_5768425d probe row C2g); it is not refused, keeping the
 * pre-existing behaviour for that shape.
 */
function assertArrayCarriable(items: unknown[], path: string): void {
  const objectItems = items.filter(isObjectValue);
  if (objectItems.length === 0) return;
  if (objectItems.length !== items.length) rejectMixedArray(path);
  items.forEach((item, index) => {
    for (const [itemKey, itemValue] of Object.entries(item as Record<string, unknown>)) {
      if (isObjectValue(itemValue)) rejectNestedObject(`${path}[${index}].${itemKey}`);
      if (Array.isArray(itemValue)) assertArrayCarriable(itemValue, `${path}[${index}].${itemKey}`);
    }
  });
}

function rejectNestedObject(field: string): never {
  throw new Error(
    `serialiseFrontmatter: page field "${field}" holds a nested object, which the page YAML `
    + `vocabulary cannot carry (strings, string arrays, and notice objects of scalar values only); `
    + `flatten the value or extend the page contract (schemas/v0.5.0/page-frontmatter.schema.json) first`,
  );
}

function rejectMixedArray(field: string): never {
  throw new Error(
    `serialiseFrontmatter: page field "${field}" mixes scalar and object items in one array, which `
    + `the page YAML vocabulary cannot carry (write a string array or an array of objects, not both); `
    + `split the value or extend the page contract (schemas/v0.5.0/page-frontmatter.schema.json) first`,
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
  // A string the reader's coercion would turn into another type is quoted too: written bare,
  // `summary: "123"` read back as the number 123 and the page failed its own contract after a
  // write it made itself (`/summary:type`; t_5768425d). `isCoercedScalar` is the reader's own
  // predicate, so the two halves cannot drift.
  if (isCoercedScalar(s) || /[:\[\]{},&*#?|<>=!%@`'\"]/.test(s) || s.includes('\n') || s.startsWith(' ') || s.endsWith(' ')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * The scalar spellings `readBareScalar` reads as a non-string value: `true`/`false`/`null`, or
 * anything `Number` accepts (`123`, `1.50`, `0x10`, `1e3`, `Infinity`, `007`, `.5`, `5.`, …).
 * Shared by the reader (which coerces them) and the writer (which quotes them, so a string that
 * only looks like one of them reads back as the string it was) — one predicate, no drift
 * (t_5768425d).
 */
function isCoercedScalar(raw: string): boolean {
  return raw === 'true' || raw === 'false' || raw === 'null'
    || (raw !== '' && !isNaN(Number(raw)));
}

/** Read one scalar with the type the coercion above implies. */
function readBareScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (isCoercedScalar(raw)) return Number(raw);
  return unquote(raw);
}

/** Minimal YAML parser — handles our specific frontmatter schema */
function parseYAML(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === '|') {
      // Literal block scalar — how `toYAML` writes any string containing a newline (`key: |`, the
      // content indented under the key). Before t_cf744a8e this branch only looked for an array
      // item next and then dropped the key, so a multi-line `summary` (or a notice's `message`)
      // vanished from the parse.
      const { text, next } = readBlockScalar(lines, i + 1, leadingSpaces(line));
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
    } else {
      result[key] = readBareScalar(rest);
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
 * Read a literal block scalar introduced on the line before `start` (`key: |` or `- |`): the run
 * of lines indented deeper than the introducing line, blank lines in between kept, and the block's
 * common indentation stripped. This is the reader half of `toYAML`'s multi-line-string shape
 * (t_cf744a8e). Only `|` is understood — the serialiser never writes `|-`, `|+` or `>`.
 */
function readBlockScalar(
  lines: string[],
  start: number,
  introduceIndent: number,
): { text: string; next: number } {
  const collected: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      collected.push('');
      i++;
      continue;
    }
    if (leadingSpaces(line) <= introduceIndent) break;
    collected.push(line);
    i++;
  }
  const indents = collected.filter(line => line.trim() !== '').map(line => leadingSpaces(line));
  const strip = indents.length > 0 ? indents.reduce((min, n) => Math.min(min, n)) : 0;
  const text = collected.map(line => (line.trim() === '' ? '' : line.slice(strip))).join('\n');
  return { text, next: i };
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
 * item (`- "a: b"`) stays the one string it is, and a block-scalar item (`- |` + deeper lines) is
 * the multi-line string it introduces (t_cf744a8e). A nested sequence — a construct no page field
 * admits — is still left where it is rather than silently swallowed.
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

    if (content === '|') {
      // A block scalar as the item's own value: the block-array form of a multi-line string.
      const { text, next } = readBlockScalar(lines, i, dashIndent);
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
