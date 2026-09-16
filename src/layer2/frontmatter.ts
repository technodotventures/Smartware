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
        for (const item of val) {
          const itemLines = toYAML(item as Record<string, unknown>, indent + 4).split('\n').filter(Boolean);
          lines.push(`${pad}  - ${itemLines[0]}`);
          for (const l of itemLines.slice(1)) lines.push(`  ${l}`);
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
        // Array
        const arr: unknown[] = [];
        i++;
        while (i < lines.length && lines[i]!.match(/^\s*-/)) {
          const item = lines[i]!.replace(/^\s*-\s*/, '').trim();
          arr.push(unquote(item));
          i++;
        }
        result[key] = arr;
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
