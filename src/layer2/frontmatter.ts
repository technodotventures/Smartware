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
// form the reader would silently flatten or drop (t_cf744a8e). Refinements from t_5768425d:
// a string the reader would coerce to another type (`"123"`, `"true"`, `"null"`, the `0x10`/`1e3`/
// `Infinity` spellings) is written quoted so it reads back as the string it was, and the guard
// reaches every value position — a mapping nested at any depth, a mixed scalar/object array —
// rather than only one level into a notice item. t_0e19036e closes the array positions: a
// non-string scalar or an array as an array element and an empty object item are refused (the
// t_cf744a8e nested-sequence carve-out is superseded on the write side — it was the same
// uncarriable class), and a multi-line string as an array element is supported by emitting the
// block form (`- |`) the reader already decodes — for an element whose minimum indentation over
// its non-blank lines is 0 (some line's content starts at column 0). An all-indented element is a
// disclosed, pinned remaining loss, not a refusal: the writer's fixed 4-space prefix and the
// reader's minimum-indent strip take the element's own indentation with them (`' a\n b'` reads
// back `'a\nb'`), silently (independent VERIFY t_6012c8ca Finding 1).

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
 * a mixed scalar/object array, a non-string scalar or an array as an array element, an empty
 * object item (t_cf744a8e, t_5768425d, t_0e19036e) — instead of writing YAML that flattens,
 * drops or retypes it on the next read. A multi-line string inside a string array is carried in
 * the block form, not refused, when some line's content starts at column 0; an all-indented
 * element is written the same way but reads back de-indented (the reader's minimum-indent strip —
 * a disclosed remaining loss, not an over-refusal; see the module header).
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
 * (measured on t_cf744a8e; the deeper positions on t_5768425d). The walk refuses it and names the
 * offending field path; `assertArrayCarriable` below adds the array-only shapes — a non-string
 * element, an array element, an empty object item (t_0e19036e).
 */
function assertPageVocabulary(frontmatter: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(frontmatter)) {
    if (isObjectValue(value)) rejectNestedObject(key);
    if (Array.isArray(value)) assertArrayCarriable(value, key);
  }
}

/**
 * Walk one array the writer is about to emit. `toYAML` has two carriable array forms and picks
 * between them by item kind: an all-string array — inline `[a, b]`, or the block form (`- a`,
 * `- |` + lines) when an element contains a newline — and an all-object array, written as block
 * items (`- key: value`). Two rules keep the forms honest, both refusing a value rather than
 * emitting bytes the reader cannot bring back (t_5768425d, t_0e19036e):
 *
 * - A **mixed** array (some object items, some not) is refused: the writer would write the
 *   non-object items through `String(item)` (`[a, [object Object]]`, or `0: a` lines
 *   object-first), and nothing reads back.
 * - An array with no object items can carry **strings only**: the inline form writes every
 *   element as a string and the reader reads every element back as one, so a number, boolean or
 *   null element silently changes type (`[1, 2]` → `["1","2"]`, `[null]` → `["null"]`), and a
 *   null *first* element additionally sent the pre-fix writer down the block branch into a raw
 *   `Object.entries(null)` TypeError with no field name (t_5708fed6, `X.number_array` /
 *   `X.null_first_item_array`). An **array** element is never carriable at all (`String([])` →
 *   `''`; `Object.entries` → `0: …` lines) — including the pure nested sequence, whose
 *   t_cf744a8e "written, still garbled, documented" carve-out this supersedes: it is the same
 *   uncarriable class the mixed-array rule refuses, and the honest failure is a loud refusal, not
 *   silent flattening (t_5768425d's C2 reasoning; `[["x"]]` inside a notice item is
 *   contract-legal — notices items carry no `additionalProperties: false` — which is exactly why
 *   the write boundary, not the contract, has to catch it).
 *
 * Each object item's properties are value positions in their own right: a mapping there is the
 * flattening case above (`notices[0].links[0].meta`), an array there recurses — arrays of objects
 * inside a notice item round-trip (t_5768425d, probe rows C2ctl1–C2ctl2) — and an object item
 * with no properties is refused too, because a block item is written from its `key: value` lines
 * and an empty item reads back as an empty string.
 */
function assertArrayCarriable(items: unknown[], path: string): void {
  if (items.length === 0) return;
  const objectItems = items.filter(isObjectValue);
  if (objectItems.length === items.length) {
    items.forEach((item, index) => {
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length === 0) rejectEmptyItem(`${path}[${index}]`);
      for (const [itemKey, itemValue] of entries) {
        const propertyPath = `${path}[${index}].${itemKey}`;
        if (isObjectValue(itemValue)) rejectNestedObject(propertyPath);
        if (Array.isArray(itemValue)) assertArrayCarriable(itemValue, propertyPath);
      }
    });
    return;
  }
  if (objectItems.length > 0) rejectMixedArray(path);
  items.forEach((item, index) => {
    if (Array.isArray(item)) rejectNestedArrayItem(`${path}[${index}]`);
    if (typeof item !== 'string') rejectArrayItem(`${path}[${index}]`, item);
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
    `serialiseFrontmatter: page field "${field}" mixes object and non-object items in one array, which `
    + `the page YAML vocabulary cannot carry (write a string array or an array of objects, not both); `
    + `split the value or extend the page contract (schemas/v0.5.0/page-frontmatter.schema.json) first`,
  );
}

/** A non-string scalar as an array element: the inline form would read it back as a string. */
function rejectArrayItem(field: string, value: unknown): never {
  const kind = value === null ? 'null'
    : typeof value === 'number' ? 'a number'
      : typeof value === 'boolean' ? 'a boolean'
        : typeof value === 'undefined' ? 'undefined'
          : `a ${typeof value}`;
  throw new Error(
    `serialiseFrontmatter: page field "${field}" holds ${kind}, which the page YAML vocabulary `
    + `cannot carry as an array item (an array is written as a string array; the reader reads every `
    + `inline element back as the string it is); write the element as a string or extend the page `
    + `contract (schemas/v0.5.0/page-frontmatter.schema.json) first`,
  );
}

/** An array as an array element (a nested sequence): `String`/`Object.entries` it, never read back. */
function rejectNestedArrayItem(field: string): never {
  throw new Error(
    `serialiseFrontmatter: page field "${field}" holds an array item (a nested sequence), which `
    + `the page YAML vocabulary cannot carry (an array is a string array or an array of objects — `
    + `an element is never itself an array); flatten the value or extend the page contract `
    + `(schemas/v0.5.0/page-frontmatter.schema.json) first`,
  );
}

/** An object item with no properties: the block form writes a bare dash, read back as `''`. */
function rejectEmptyItem(field: string): never {
  throw new Error(
    `serialiseFrontmatter: page field "${field}" is an object item with no properties, which the `
    + `page YAML vocabulary cannot carry (a block item is written from its key: value lines, so an `
    + `empty item reads back as an empty string); drop the item or extend the page contract `
    + `(schemas/v0.5.0/page-frontmatter.schema.json) first`,
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
        // this file's own parser (t_4d84ff6b). The guard has already refused every item that is
        // not an object, so the cast is sound.
        for (const item of val) {
          const itemLines = toYAML(item as Record<string, unknown>, indent + 4).split('\n').filter(Boolean);
          const [first = '', ...rest] = itemLines;
          lines.push(`${pad}  - ${first.slice(indent + 4)}`);
          for (const l of rest) lines.push(l);
        }
      } else if ((val as string[]).some(item => item.includes('\n'))) {
        // A string array with a multi-line element: the inline form cannot carry a newline — the
        // quoted element would span lines and the whole array would read back as one string
        // (measured on t_0e19036e, probe S2.aliases_elem rows). Write the block form instead:
        // `- item` lines, and `- |` plus the indented content for each multi-line element. The
        // reader already decodes both (t_cf744a8e's block-scalar item branch); this is also the
        // form the writer uses for a multi-line mapping value. The guard has already refused
        // every non-string element, so the cast is sound. Reading is exact when some line's
        // content starts at column 0; an all-indented element loses its own minimum indent to the
        // reader's minimum-indent strip (`' a\n b'` reads back `'a\nb'`) — disclosed and pinned,
        // not refused (t_6012c8ca Finding 1).
        lines.push(`${pad}${key}:`);
        for (const item of val as string[]) {
          if (!item.includes('\n')) {
            lines.push(`${pad}  - ${yamlString(item)}`);
            continue;
          }
          lines.push(`${pad}  - |`);
          for (const contentLine of item.split('\n')) lines.push(`${pad}    ${contentLine}`);
        }
      } else {
        // All-string and single-line: the inline form (the guard has already refused every
        // non-string element, so `yamlString` sees strings only).
        lines.push(`${pad}${key}: [${(val as string[]).map(v => yamlString(v)).join(', ')}]`);
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
