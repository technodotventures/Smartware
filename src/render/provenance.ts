// Reference provenance-rendering contract — spec §10c.
//
// Executable form of the Coffee provenance-rendering wording table
// (docs/competitive/mem0-substrate-spec-draft.md §10c). Coffee MUST render
// exactly the strings this module produces (template substitution only:
// resolved display names + dates). This module is the conformance anchor so
// wording cannot drift from the contract.
//
// Contract rules encoded here:
//   - Attribution is STAFF-FACING ONLY. `surface: 'client'` renders no
//     provenance chrome except an opt-in "from your messages" citation for
//     client-owned content (never staff/agent identity, never corrections,
//     never confidence/epistemic labels).
//   - Default-on predicate (staff): unverified/FAILED freshness, stale,
//     contested, low confidence, consequential claim types/tags, or a
//     recently-changed / recently-corrected fact. Everything else renders
//     under the "why this answer?" toggle only.
//   - FAILED wording is used whenever the compile job failed, even though the
//     RECALL hit label is `unverified` (spec §11.2: failures keep raw
//     searchable with `unverified`; the failing-vs-pending distinction lives
//     in compile state, which Coffee must pass as `compileState`).

export type FreshnessState = 'unverified' | 'extracted' | 'failed';
export type CompileState = 'pending' | 'failed' | 'resolved';
export type EpistemicTag = 'fact' | 'inference' | 'opinion' | 'stale' | 'contested';
export type ConfidenceBucket = 'high' | 'medium' | 'low';
export type ClaimType =
  | 'decision'
  | 'constraint'
  | 'correction'
  | 'lesson'
  | 'preference'
  | 'hypothesis'
  | 'checkpoint'
  | 'handoff'
  | 'finding';
export type Surface = 'staff' | 'client';
export type ActorKind = 'person' | 'agent' | 'system' | 'unknown';

export interface ProvenanceInput {
  /** Recipient surface. 'client' suppresses everything except client-owned citations. */
  surface: Surface;
  /** Literal freshness label from the RECALL/compile payload (spec §10a). */
  freshness: FreshnessState;
  /** Compile-job state. 'failed' forces FAILED wording even when freshness is 'unverified'. */
  compileState?: CompileState;
  /** Observation actor: person (staff/owner/display name), agent, system, or unknown. */
  actorKind: ActorKind;
  /** Resolved display name (first name for persons, e.g. "Maya"; "Coffee AI" for the agent). Never a raw actor id. */
  actorDisplay?: string;
  /** Observation source timestamp (ISO string or Date). */
  sourceDate?: Date | string;
  /** Display name of the actor who issued the effective correcting revision. */
  correctedBy?: string;
  /** Timestamp of the correcting revision (corrects/supersedes edge). */
  correctedAt?: Date | string;
  /** Effective-current claim version_at — drives the "recently-changed" defaulting. */
  versionAt?: Date | string;
  claimType: ClaimType;
  epistemicTag: EpistemicTag;
  confidence: ConfidenceBucket;
  /** Claim tags (lower-kebab). A tag in consequentialTags forces default-on. */
  tags?: string[];
  /** True when the source is the client's own content (client-facing citation only). */
  clientOwned?: boolean;
}

export interface ProvenanceOptions {
  /** "Recently changed" window for version_at (days). Default 14 (presentation cap, §10c.6); may lower, never raise. */
  recentDays?: number;
  /** Window during which a correction is always visible (days). Default 30. */
  correctionVisibleDays?: number;
  /** Extra tags that mark a claim as consequential. */
  consequentialTags?: ReadonlySet<string>;
}

export const DEFAULT_OPTIONS: Required<ProvenanceOptions> = {
  // §10c.6 binds the presentation recency window to ≤14d (may be lowered by
  // Coffee, never raised — the why-panel still shows the full lineage).
  recentDays: 14,
  correctionVisibleDays: 30,
  consequentialTags: new Set([
    'price', 'quote', 'appointment', 'booking', 'contact', 'address',
    'payment', 'dispute', 'deadline', 'commitment',
  ]),
};

/** Claim types that commit the business — default-on even when stable (spec §10c). */
export const CONSEQUENTIAL_CLAIM_TYPES: ReadonlySet<ClaimType> = new Set([
  'decision', 'constraint', 'handoff', 'correction',
]);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Deterministic UTC "Mon D" date (e.g. "May 12"). Invalid input yields "". */
export function formatMonthDay(value?: Date | string): string {
  if (value === undefined) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

function parsed(value?: Date | string): Date | null {
  if (value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Default-on predicate (staff surface). True => attribution renders without
 * the "why this answer?" toggle. Client surface always returns false.
 */
export function showAttributionByDefault(
  input: ProvenanceInput,
  options: ProvenanceOptions = {},
  now: Date = new Date(),
): boolean {
  if (input.surface === 'client') return false;

  // Unverified or failed facts are never silent-skipped (state-based freshness, §10a).
  if (input.freshness !== 'extracted') return true;
  if (input.compileState === 'failed') return true;

  if (input.epistemicTag === 'stale' || input.epistemicTag === 'contested') return true;
  if (input.confidence === 'low') return true;
  if (CONSEQUENTIAL_CLAIM_TYPES.has(input.claimType)) return true;

  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (input.tags?.some((t) => opts.consequentialTags.has(t))) return true;

  const version = parsed(input.versionAt);
  if (version && daysBetween(version, now) <= opts.recentDays && daysBetween(version, now) >= 0) {
    return true;
  }
  const corrected = parsed(input.correctedAt);
  if (
    corrected &&
    daysBetween(corrected, now) <= opts.correctionVisibleDays &&
    daysBetween(corrected, now) >= 0
  ) {
    return true;
  }
  return false;
}

function displayName(input: ProvenanceInput): string {
  if (input.actorDisplay) return input.actorDisplay;
  if (input.actorKind === 'agent') return 'Coffee AI';
  if (input.actorKind === 'system') return 'Coffee';
  return 'the record';
}

function correctionClause(input: ProvenanceInput): string {
  const date = formatMonthDay(input.correctedAt);
  if (input.correctedBy) return `; corrected by ${input.correctedBy}${date ? ` ${date}` : ''}`;
  if (date) return `; corrected ${date}`;
  return '';
}

/**
 * Attribution line (staff badge/annotation). Returns null when nothing may
 * render (client surface, non-client-owned content).
 */
export function attributionLine(input: ProvenanceInput): string | null {
  if (input.surface === 'client') {
    // Client-facing: only the client's own words may be cited. Never staff identity.
    if (!input.clientOwned) return null;
    const date = formatMonthDay(input.sourceDate);
    return date ? `From your messages, ${date}` : 'From your messages';
  }

  const name = displayName(input);
  const date = formatMonthDay(input.sourceDate);
  const base = `${name}${date ? `, ${date}` : ''}`;
  const corr = correctionClause(input);

  if (input.freshness === 'extracted' && input.compileState !== 'failed') {
    if (input.epistemicTag === 'inference' && input.actorKind === 'agent') {
      return `Inferred by Coffee, ${date}${corr}`;
    }
    let suffix = '';
    if (input.epistemicTag === 'inference' && input.actorKind === 'person') suffix = ' — inference';
    if (input.epistemicTag === 'opinion') suffix = ' — preference';
    return `From ${base}${suffix}${corr}`;
  }

  // unverified, or failed compile: honest non-verified framing.
  const failed = input.freshness === 'failed' || input.compileState === 'failed';
  return `From ${base}${failed ? ' — not verified' : ''}${corr}`;
}

/** Badge label (staff surface only). Null = no badge. */
export function badge(input: ProvenanceInput): string | null {
  if (input.surface === 'client') return null;
  if (input.freshness === 'failed' || input.compileState === 'failed') return 'Not verified';
  if (input.freshness === 'unverified') return 'New';
  // extracted
  if (input.epistemicTag === 'contested') return 'Conflict';
  if (input.epistemicTag === 'stale') return 'May be stale';
  if (input.confidence === 'low') return 'Unconfirmed';
  return null;
}

/**
 * "Why this answer?" panel lead sentence (staff surface only; client gets null).
 * Canonical flagship: "Learned from Maya, May 12; corrected by owner May 13."
 */
export function whySentence(input: ProvenanceInput): string | null {
  if (input.surface === 'client') return null;
  const name = displayName(input);
  const date = formatMonthDay(input.sourceDate);

  if (input.freshness === 'failed' || input.compileState === 'failed') {
    return `Coffee couldn't verify this automatically; shown as received from ${name}${date ? ` on ${date}` : ''}. Review before relying.`;
  }
  if (input.freshness === 'unverified') {
    return `Learned from ${name}, ${date}; still being filed — may change.`;
  }

  const corrInline = input.correctedBy
    ? formatMonthDay(input.correctedAt)
      ? `; corrected by ${input.correctedBy} ${formatMonthDay(input.correctedAt)}`
      : `; corrected by ${input.correctedBy}`
    : formatMonthDay(input.correctedAt)
      ? `; corrected ${formatMonthDay(input.correctedAt)}`
      : '';

  let lead: string;
  if (input.epistemicTag === 'inference' && input.actorKind === 'agent') {
    lead = `Coffee inferred this on ${date}; it wasn't stated directly.`;
  } else if (input.epistemicTag === 'inference') {
    lead = `Learned from ${name}, ${date} — an inference, not stated directly.`;
  } else if (input.epistemicTag === 'opinion' && input.actorKind === 'agent') {
    lead = `Coffee noted this as a preference on ${date}; not a fact.`;
  } else if (input.epistemicTag === 'opinion') {
    lead = `Learned from ${name}, ${date} — recorded as a preference, not a fact.`;
  } else if (input.actorKind === 'agent') {
    lead = `Coffee learned this on ${date}${corrInline}.`;
  } else {
    // Canonical flagship: "Learned from Maya, May 12; corrected by owner May 13."
    lead = `Learned from ${name}, ${date}${corrInline}.`;
  }

  const asOf = formatMonthDay(input.versionAt) || date;
  let extra = '';
  if (input.epistemicTag === 'stale') extra = ` Not updated since ${asOf}.`;
  if (input.epistemicTag === 'contested') extra = ' Sources disagree about this.';
  if (input.confidence === 'low') extra += ' Low confidence.';

  return `${lead}${extra}`.trimEnd();
}
