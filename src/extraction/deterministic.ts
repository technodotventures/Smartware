// Extraction — Deterministic extraction: structured patterns from text
//
// These extractions are high-confidence because they use unambiguous patterns.
// The goal is to catch everything that doesn't need LLM interpretation:
// decisions, statuses, relationships, tools, people, deadlines, URLs, etc.

import type { PreExtractedClaim } from '../layer0/types.js';

const COMPILER_VERSION = '0.6.1';

// ── Regex patterns ──────────────────────────────────────────────────────────

// Dates and times
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;
const DATETIME_RE = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)\b/g;

// URLs
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;

// Version numbers — exclude money values (preceded by $) and bare decimals under 1.0
const VERSION_RE = /(?<!\$)\bv?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\b/g;

// Deadline keywords
const DEADLINE_PATTERNS = [
  /deadline[:\s]+(\d{4}-\d{2}-\d{2})/gi,
  /due[:\s]+(\d{4}-\d{2}-\d{2})/gi,
  /by[:\s]+(\d{4}-\d{2}-\d{2})/gi,
];

// Status patterns — "X is deployed", "Status: active", "X — rejected"
// The subject captures are length-bounded ({0,60}) to prevent catastrophic
// backtracking (ReDoS) on long prose that never reaches a status keyword.
const STATUS_PATTERNS = [
  /\b(\w[\w\s.]{0,60}?)\s+(?:is|are|was)\s+(active|inactive|deployed|rejected|approved|pending|completed|deprecated|in[_\s-]?progress|planned|cancelled|viable|paused)\b/gi,
  /\bstatus[:\s]+(\w[\w\s.]{0,60}?)\s*[:\s]\s*(active|inactive|deployed|rejected|approved|pending|completed|deprecated|in[_\s-]?progress|planned|cancelled|viable|paused)\b/gi,
  /\b([\w][\w\s.]{1,40}?)\s+(?:—|–)\s*(rejected|approved|deployed|deprecated|viable|planned|chosen|selected)\b/gi,
];

// Decision patterns — "decided to X", "direction: X", "choosing X over Y"
// Require alphanumeric content (reject arrow-heavy fragments like "→ Action → Outcome")
const DECISION_PATTERNS = [
  /\b(?:decided|decision|chose|choosing|direction)[:\s]+([A-Za-z][\w\s,;:'"-]{8,120}?)(?:\.|$)/gim,
  /\b(?:build|use|adopt|implement|ship)\s+(?:a\s+)?([A-Za-z][\w\s,;:'"-]{3,80}?)(?:\s+(?:from scratch|cleanly|instead|over|for))/gi,
];

// Belongs-to / part-of patterns — "X for Y", "X is part of Y"
const BELONGS_TO_PATTERNS = [
  /\b([\w][\w\s.]{2,30}?)\s+(?:for|of)\s+([\w][\w\s.]{2,30}?)(?:\s*[:.—]|\s+(?:is|has|uses|with)|\s*$)/gim,
];

// Money/pricing patterns
const MONEY_PATTERNS = [
  /\$(\d+(?:,\d{3})*(?:\.\d{2})?[KMBT]?)\b/gi,
  /(\d+(?:\.\d+)?)\s*%\s*(management fee|performance fee|hurdle|carry|fee)/gi,
];

// Tool/service evaluations — "X (MIT, ...)", "X for Y"
// Must start with uppercase letter to avoid matching random words from hyphenated compounds
const TOOL_EVAL_RE = /\b([A-Z][\w.]*)\s*\(([^)]{5,80})\)/g;

// Entity name patterns — capitalized multi-word names, likely proper nouns
const PROPER_NOUN_RE = /\b([A-Z][\w]*(?:\s+[A-Z][\w]*)+)\b/g;

// Percentage/number patterns
const PERCENTAGE_RE = /(\d+(?:\.\d+)?)\s*%/g;

export interface RelationProposal {
  kind: 'references';
  source_content: string;
  target_content: string;
  rule_id: string;
  observation_ids: string[];
  origin: 'deterministic';
}

export interface DeterministicResult {
  claims: PreExtractedClaim[];
  entities: Array<{ name: string; type: string }>;
  relation_proposals: RelationProposal[];
}

/**
 * Extract structured claims deterministically from text content.
 */
export function extractDeterministic(
  content: string,
  scope: string,
  subjectName: string,
  validityFrom: string,
): DeterministicResult {
  // Cap scanned content length: extraction targets short observations, and this
  // bounds worst-case regex work regardless of the length-bounded patterns.
  if (content.length > 100_000) content = content.slice(0, 100_000);
  const claims: PreExtractedClaim[] = [];
  const entities: Array<{ name: string; type: string }> = [];
  const seen = new Set<string>(); // dedup key: predicate|objectValue

  function addClaim(claim: PreExtractedClaim): void {
    const val = typeof claim.object.value === 'string' ? claim.object.value : JSON.stringify(claim.object.value);
    const key = `${claim.subject_name}|${claim.predicate}|${val}`;
    if (seen.has(key)) return;

    // For text claims with same subject+predicate, skip if value is a substring of an existing claim
    if (typeof claim.object.value === 'string') {
      for (const existing of claims) {
        if (existing.subject_name === claim.subject_name &&
            existing.predicate === claim.predicate &&
            typeof existing.object.value === 'string') {
          if ((existing.object.value as string).includes(claim.object.value) ||
              claim.object.value.includes(existing.object.value as string)) {
            return; // skip substring duplicate
          }
        }
      }
    }

    seen.add(key);
    claims.push(claim);
  }

  const base = {
    scope,
    validity: { from: validityFrom, to: null },
    t_valid_from: { value: validityFrom, state: 'inferred' as const, basis: 'source_observed_at' },
    t_valid_to: { value: null, state: 'null' as const },
    sensitive: false,
    extraction: {
      method: 'deterministic' as const,
      model: null,
      compiler_version: COMPILER_VERSION,
      prompt_hash: null,
    },
  };

  // ── Deadlines ─────────────────────────────────────────────────────────
  for (const pattern of DEADLINE_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      addClaim({
        ...base,
        subject_name: subjectName,
        predicate: 'deadline_is',
        object: { type: 'date', value: match[1]! },
        epistemic: 'observed',
        confidence: 0.95,
      });
    }
  }

  // ── URLs ──────────────────────────────────────────────────────────────
  const urls = [...content.matchAll(URL_RE)];
  for (const url of urls.slice(0, 5)) {
    addClaim({
      ...base,
      subject_name: subjectName,
      predicate: 'related_to',
      object: { type: 'text', value: url[0] },
      epistemic: 'observed',
      confidence: 0.9,
    });
  }

  // ── Version numbers ───────────────────────────────────────────────────
  for (const ver of [...content.matchAll(VERSION_RE)].slice(0, 3)) {
    const v = ver[1]!;
    // Skip bare decimals that look like money/percentages (e.g. 0.04, 0.07)
    if (/^0\.\d+$/.test(v) && !v.includes('.0.')) continue;
    // Skip if the match is immediately preceded by $ (lookbehind may not catch all cases)
    const idx = ver.index ?? 0;
    if (idx > 0 && content[idx - 1] === '$') continue;

    addClaim({
      ...base,
      subject_name: subjectName,
      predicate: 'version_is',
      object: { type: 'text', value: v },
      epistemic: 'observed',
      confidence: 0.9,
    });
  }

  // ── Status patterns ───────────────────────────────────────────────────
  for (const pattern of STATUS_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const subject = cleanSubjectName(match[1]!);
      const status = match[2]!.toLowerCase().replace(/[\s-]+/g, '_');
      if (subject.length < 2 || subject.length > 50) continue;
      if (isStopWord(subject)) continue;

      const entityType = inferEntityType(subject, content);
      addClaim({
        ...base,
        subject_name: subject,
        subject_type: entityType,
        predicate: 'status_is',
        object: { type: 'enum', value: status },
        epistemic: 'observed',
        confidence: 0.85,
      });

      entities.push({ name: subject, type: entityType });
    }
  }

  // ── Decision patterns ─────────────────────────────────────────────────
  for (const pattern of DECISION_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const decision = match[1]!.trim();
      if (decision.length < 8 || decision.length > 150) continue;

      addClaim({
        ...base,
        subject_name: subjectName,
        predicate: 'decided_on',
        object: { type: 'text', value: decision },
        epistemic: 'asserted',
        confidence: 0.85,
      });
    }
  }

  // ── Tool/service evaluations with parenthetical details ───────────────
  for (const match of content.matchAll(TOOL_EVAL_RE)) {
    const toolName = match[1]!.trim();
    const details = match[2]!.trim();
    if (toolName.length < 2 || toolName.length > 30) continue;
    if (isStopWord(toolName)) continue;
    // Skip version-like parens e.g. "v2 (beta)"
    if (/^\d/.test(toolName)) continue;

    addClaim({
      ...base,
      subject_name: toolName,
      subject_type: 'tool',
      predicate: 'description_is',
      object: { type: 'text', value: details },
      epistemic: 'observed',
      confidence: 0.8,
    });

    entities.push({ name: toolName, type: 'tool' });
  }

  // ── Money/pricing ─────────────────────────────────────────────────────
  for (const match of content.matchAll(MONEY_PATTERNS[0]!)) {
    addClaim({
      ...base,
      subject_name: subjectName,
      predicate: 'value_is',
      object: { type: 'text', value: `$${match[1]}` },
      epistemic: 'observed',
      confidence: 0.9,
    });
  }
  for (const match of content.matchAll(MONEY_PATTERNS[1]!)) {
    addClaim({
      ...base,
      subject_name: subjectName,
      predicate: 'value_is',
      object: { type: 'text', value: `${match[1]}% ${match[2]}` },
      epistemic: 'observed',
      confidence: 0.9,
    });
  }

  const relation_proposals: RelationProposal[] = [];
  for (const url of urls.slice(0, 5)) {
    relation_proposals.push({
      kind: 'references',
      source_content: subjectName,
      target_content: url[0],
      rule_id: 'url_mention',
      observation_ids: [],
      origin: 'deterministic',
    });
  }

  return { claims, entities, relation_proposals };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function cleanSubjectName(raw: string): string {
  return raw.trim()
    .replace(/^(the|a|an|this|that|its)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set([
  'it', 'this', 'that', 'the', 'a', 'an', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'shall', 'should', 'may', 'might', 'can', 'could',
  'not', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where',
  'which', 'who', 'whom', 'what', 'how', 'all', 'each', 'every',
  'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'use', 'set', 'model', 'prior', 'working', 'phase',
  'join', 'send', 'get', 'put', 'post', 'run', 'start', 'stop', 'end',
  'open', 'close', 'read', 'write', 'check', 'test', 'add', 'remove',
]);

function isStopWord(name: string): boolean {
  return STOP_WORDS.has(name.toLowerCase());
}

function inferEntityType(name: string, context: string): string {
  const lower = name.toLowerCase();
  // Check context clues
  if (/\b(?:fund|capital|AUM|fee|investor)\b/i.test(context) && context.includes(name)) return 'organisation';
  if (/\b(?:person|founder|CEO|CTO|advisor)\b/i.test(context) && context.includes(name)) return 'person';
  if (/\.(?:ai|io|com|dev|app|finance|capital)\b/.test(lower)) return 'tool';
  if (/\b(?:api|sdk|framework|library|runtime|server|client|registry)\b/i.test(lower)) return 'tool';
  if (/\b(?:decision|direction|strategy|approach)\b/i.test(lower)) return 'decision';
  if (/\b(?:pricing|fee|cost|budget)\b/i.test(lower)) return 'concept';
  return 'concept';
}

/**
 * Detect dates in text for use in validity ranges.
 */
export function extractDates(text: string): string[] {
  const dates: string[] = [];
  const dtMatches = [...text.matchAll(DATETIME_RE)];
  for (const m of dtMatches) dates.push(m[1]!);
  const dateMatches = [...text.matchAll(DATE_RE)];
  for (const m of dateMatches) {
    if (!dates.some(d => d.startsWith(m[1]!))) dates.push(m[1]!);
  }
  return [...new Set(dates)];
}
