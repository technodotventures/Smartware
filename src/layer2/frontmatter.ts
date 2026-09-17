// Layer 2 — YAML frontmatter read/write/validate
//
// The parser is deliberately untyped: a page on disk may still carry the pre-ADR-0013 → D2
// envelope inline, and the reader has to accept both shapes. Use `readPageFile`
// (`src/layer2/envelope.ts`) for the shape-aware entry point.

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
 */
export function serialiseFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${toYAML(frontmatter)}---\n${body}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
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
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === '' || rest === '|') {
      // Could be array or nested object — peek ahead
      if (i + 1 < lines.length && lines[i + 1]!.match(/^\s*-/)) {
        const { items, next } = parseBlockArray(lines, i + 1);
        result[key] = items;
        i = next;
        continue;
      }
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      // Inline array
      const inner = rest.slice(1, -1).trim();
      if (inner === '') {
        result[key] = [];
      } else {
        result[key] = inner.split(',').map(s => unquote(s.trim()));
      }
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

const BLOCK_ITEM = /^(\s*)-(\s*)(.*)$/;

/** The number of leading whitespace characters on a line. */
function leadingSpaces(line: string): number {
  return line.length - line.replace(/^\s*/, '').length;
}

/** Whether a block item's content opens a mapping (`key: value`) rather than a plain scalar. */
function isMappingItem(content: string): boolean {
  // `- http://example.com` is a scalar, not `{ http: '//example.com' }`: the colon has to be
  // followed by whitespace (or end the line) to separate a key from its value.
  return /^[^\s:][^:]*:(\s|$)/.test(content);
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
 * on read instead of silently degraded. A plain item (`- alpha`) stays a string.
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

    if (!isMappingItem(content)) {
      // A plain item is a string, as before. A construct this minimal parser has never read (a
      // block scalar, a nested sequence) is left where it is rather than silently swallowed.
      items.push(unquote(content));
      continue;
    }

    // `parseYAML` is indentation-agnostic (one `key: value` per line), so the item's whole block
    // can be handed to it: the dash line's content first, then the continuation lines.
    const block = [content];
    while (i < lines.length && leadingSpaces(lines[i]!) > dashIndent) {
      block.push(lines[i]!);
      i++;
    }
    items.push(parseYAML(block.join('\n')));
  }
  return { items, next: i };
}
