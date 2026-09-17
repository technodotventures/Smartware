// Layer 2 — the page envelope, and the compatibility reader for pages already on disk.
//
// ADR-0013 → D2: the published L2 page frontmatter is spec §9's field set (==
// `schemas/v0.5.0/page-frontmatter.schema.json`). The compiler's own bookkeeping — entity
// identity, compile provenance, the observation groundtruth, endorsement-recovery metadata —
// is implementation mechanics, not protocol vocabulary, and it is **not** enumerated into the
// frozen contract. It is rendered into the page's Evidence Timeline region instead, which §9
// already makes a derived, agent-managed, rebuildable cached render ("deleting it loses
// nothing") carrying exactly `compiled_at` and source observation ids.
//
// This module owns: rendering/parsing that block, and reading a page in *either* shape so a
// tree that already has pages on disk keeps working before its next compile (the L2 surface is
// git-versioned and pages can be user-authored).

import type { ConfidenceBucket, EpistemicTag } from '../layer1/types.js';
import { confidenceToBucket, epistemicToTag } from '../layer1/types.js';
import { parseFrontmatter } from './frontmatter.js';
import { toPageCategory } from './paths.js';
import type { Frontmatter, PageEnvelope, PageFile, PageNotice } from './types.js';

/** Marker of the derived cached-envelope block. Never authored, never authoritative. */
export const ENVELOPE_OPEN = '<!-- smartware-envelope';
export const ENVELOPE_CLOSE = '-->';

/** The visible §9 "cached view" line, rendered together with the envelope so the two cannot drift. */
const CACHED_VIEW_LINE = /^<!-- cached view — compiled_at: .* -->$/;

/** `YYYY-MM-DD` — the schema's `format: date`. */
export function isoDate(value: string | undefined | null): string {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Keys that only exist on the pre-fix (legacy) frontmatter shape. */
const LEGACY_FRONTMATTER_KEYS = [
  'entity_id',
  'entity',
  'type',
  'sensitive',
  'claim_ids',
  'sources_claim_ids',
  'compiled_at',
  'compiled_by',
  'epistemic',
  'supersedes',
  'related',
  'endorsement_operation_id',
  'endorsed_by',
  'endorsed_at',
] as const;

/** Does this frontmatter still carry the pre-fix envelope inline? */
export function isLegacyFrontmatter(fm: Record<string, unknown>): boolean {
  return LEGACY_FRONTMATTER_KEYS.some(key => key in fm);
}

/**
 * Render the envelope block (plus §9's visible "cached view" line) for the Evidence Timeline
 * region. Both lines are generated here so the visible timestamp and the machine copy cannot
 * drift.
 */
export function renderEnvelopeBlock(envelope: PageEnvelope): string {
  const lines = [
    `<!-- cached view — compiled_at: ${envelope.compiled_at} -->`,
    ENVELOPE_OPEN,
    JSON.stringify(envelope, null, 2),
    ENVELOPE_CLOSE,
  ];
  return lines.join('\n');
}

function coerceEnvelope(raw: Record<string, unknown>): PageEnvelope | null {
  if (typeof raw['entity_id'] !== 'string') return null;
  const envelope: PageEnvelope = {
    compiled_at: str(raw['compiled_at']) ?? '',
    compiled_by: str(raw['compiled_by']) ?? '',
    entity_id: raw['entity_id'],
    entity: str(raw['entity']) ?? '',
    type: str(raw['type']) ?? '',
    sensitive: raw['sensitive'] === true,
    source_observation_ids: strArray(raw['source_observation_ids']),
    supersedes: strArray(raw['supersedes']),
    related: strArray(raw['related']),
  };
  const model = str(raw['model']);
  if (model) envelope.model = model;
  const operationId = str(raw['endorsement_operation_id']);
  if (operationId) envelope.endorsement_operation_id = operationId;
  const endorsedBy = str(raw['endorsed_by']);
  if (endorsedBy) envelope.endorsed_by = endorsedBy;
  const endorsedAt = str(raw['endorsed_at']);
  if (endorsedAt) envelope.endorsed_at = endorsedAt;
  return envelope;
}

/** Parse the envelope out of a page's raw text (frontmatter or body), if present. */
export function parseEnvelope(raw: string): PageEnvelope | null {
  const start = raw.indexOf(ENVELOPE_OPEN);
  if (start === -1) return null;
  const rest = raw.slice(start + ENVELOPE_OPEN.length);
  const end = rest.indexOf(ENVELOPE_CLOSE);
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(rest.slice(0, end).trim()) as Record<string, unknown>;
    return coerceEnvelope(parsed);
  } catch {
    return null;
  }
}

/**
 * Remove the derived cached region's envelope unit — the envelope block and, when present, the
 * visible "cached view" line rendered with it — from page text (it is metadata, not content).
 * A legacy page's bare "cached view" line is left alone: it is not ours to rewrite without a
 * compile.
 */
export function stripEnvelopeBlock(text: string): string {
  const start = text.indexOf(ENVELOPE_OPEN);
  if (start === -1) return text;
  const end = text.indexOf(ENVELOPE_CLOSE, start);
  if (end === -1) return text;
  let from = text.lastIndexOf('\n', start);
  from = from === -1 ? start : from;
  const lineBeforeStart = text.lastIndexOf('\n', from - 1);
  const lineBefore = text.slice(lineBeforeStart + 1, from);
  if (CACHED_VIEW_LINE.test(lineBefore.trim())) from = lineBeforeStart + 1;
  const lineEnd = text.indexOf('\n', end + ENVELOPE_CLOSE.length);
  return text.slice(0, from) + (lineEnd === -1 ? '' : text.slice(lineEnd + 1));
}

/**
 * Replace (or insert) the envelope unit inside the page's Evidence Timeline region, leaving the
 * rest of the derived render — the per-claim timeline entries, and the Current Understanding
 * prose above it — untouched.
 */
export function writeEnvelopeIntoBody(body: string, envelope: PageEnvelope): string {
  const block = renderEnvelopeBlock(envelope);
  const withoutEnvelope = stripEnvelopeBlock(body);
  const marker = '## Evidence Timeline';
  const idx = withoutEnvelope.indexOf(marker);
  if (idx === -1) {
    return `${withoutEnvelope.replace(/\s+$/, '')}\n\n${marker}\n\n${block}\n`;
  }
  const headingEnd = withoutEnvelope.indexOf('\n', idx + marker.length);
  if (headingEnd === -1) return `${withoutEnvelope.replace(/\s+$/, '')}\n\n${block}\n`;
  const rest = withoutEnvelope.slice(headingEnd + 1).replace(/^\n+/, '');
  return `${withoutEnvelope.slice(0, headingEnd)}\n\n${block}\n\n${rest}`;
}

/**
 * Reconstruct an envelope from a legacy page's inline frontmatter (pre-ADR-0013 → D2 shape).
 * Returns null when the frontmatter carries no entity identity at all.
 */
export function legacyEnvelopeFromFrontmatter(fm: Record<string, unknown>): PageEnvelope | null {
  if (typeof fm['entity_id'] !== 'string') return null;
  return coerceEnvelope({
    compiled_at: fm['compiled_at'],
    compiled_by: fm['compiled_by'],
    entity_id: fm['entity_id'],
    entity: fm['entity'],
    type: fm['type'],
    sensitive: fm['sensitive'],
    // Legacy `sources` held ObservationIds; the claim list was `sources_claim_ids`/`claim_ids`.
    source_observation_ids: fm['sources'],
    model: fm['model'],
    supersedes: fm['supersedes'],
    related: fm['related'],
    endorsement_operation_id: fm['endorsement_operation_id'],
    endorsed_by: fm['endorsed_by'],
    endorsed_at: fm['endorsed_at'],
  });
}

/** Read a page in either shape: `{ frontmatter, envelope, body, legacy }`. */
export function readPageFile(raw: string): PageFile | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  const frontmatter = parsed.frontmatter as unknown as Record<string, unknown>;
  const legacy = isLegacyFrontmatter(frontmatter);
  const envelope = parseEnvelope(raw)
    ?? (legacy ? legacyEnvelopeFromFrontmatter(frontmatter) : null);
  return { frontmatter, envelope, body: parsed.body, legacy };
}

/** The ClaimIds a page cites — the published `sources`, or the pre-fix names on a legacy page. */
export function pageCitedClaimIds(page: PageFile): string[] {
  const fm = page.frontmatter;
  if (!page.legacy) return [...new Set(strArray(fm['sources']))];
  const explicit = strArray(fm['sources_claim_ids']);
  if (explicit.length > 0) return [...new Set(explicit)];
  const claimIds = strArray(fm['claim_ids']);
  if (claimIds.length > 0) return [...new Set(claimIds)];
  // Last resort on a legacy page whose only list is the observation list.
  return [...new Set(strArray(fm['sources']).filter(id => id.startsWith('claim_')))];
}

/** A page's creation date: the published field, else a legacy `compiled_at`, else `fallbackIso`. */
export function pageCreatedDate(fm: Record<string, unknown>, fallbackIso: string): string {
  const created = str(fm['created']);
  if (created) return isoDate(created);
  const compiledAt = str(fm['compiled_at']);
  if (compiledAt) return isoDate(compiledAt);
  return isoDate(fallbackIso);
}

/** A page's confidence bucket: the published field, else the legacy numeric derivation. */
export function pageConfidenceBucket(fm: Record<string, unknown>): ConfidenceBucket {
  const value = fm['confidence'];
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  if (typeof value === 'number') return confidenceToBucket(value);
  return 'low';
}

/** A page's epistemic tag: the published field, else derived from the legacy `epistemic` label. */
export function pageEpistemicTag(fm: Record<string, unknown>): EpistemicTag {
  const value = fm['epistemic_tag'];
  if (value === 'fact' || value === 'inference' || value === 'opinion' || value === 'stale' || value === 'contested') {
    return value;
  }
  const legacy = fm['epistemic'];
  if (typeof legacy === 'string') {
    return epistemicToTag(legacy as Parameters<typeof epistemicToTag>[0], 'active');
  }
  return 'inference';
}

/** Representative numeric confidence for a bucket — the projection-side inverse of the writer's map. */
export function bucketToConfidence(bucket: ConfidenceBucket): number {
  if (bucket === 'high') return 0.8;
  if (bucket === 'medium') return 0.5;
  return 0.2;
}

export interface EndorsementStamp {
  pageId: string;
  actorId: string;
  operationId: string;
  commitTs: string;
}

/**
 * The published frontmatter of an endorsed page: the page's own contract fields, with `author`,
 * `updated` and the cited `sources` set by the cascade (§9 — `sources` is locked at endorsement).
 * Pre-fix inline fields are *normalised* onto the published vocabulary rather than copied, so
 * endorsing a legacy page upgrades it instead of re-introducing the rejected shape.
 */
export function endorsedPageFrontmatter(
  page: PageFile,
  citedClaimIds: string[],
  stamp: EndorsementStamp,
): Frontmatter {
  const fm = page.frontmatter;
  const title = str(fm['title']) ?? page.envelope?.entity ?? '';
  const scope = str(fm['scope']) ?? '';
  const summary = str(fm['summary']) ?? '';
  const pageId = str(fm['page_id']) ?? stamp.pageId;
  return {
    title,
    page_id: pageId,
    category: toPageCategory(fm['category']) ?? 'concept',
    author: 'user',
    sources: citedClaimIds,
    supporting_claims: strArray(fm['supporting_claims']),
    created: pageCreatedDate(fm, stamp.commitTs),
    updated: isoDate(stamp.commitTs),
    scope,
    confidence: pageConfidenceBucket(fm),
    epistemic_tag: pageEpistemicTag(fm),
    summary,
    tags: strArray(fm['tags']),
    aliases: strArray(fm['aliases']),
    notices: (Array.isArray(fm['notices']) ? fm['notices'] : []) as PageNotice[],
  };
}

/**
 * The envelope of an endorsed page: the page's existing envelope plus the durable endorsement
 * metadata `runRecovery` needs (the ENDORSE intent's recovery path finds the page by its
 * operation id). Kept out of the frontmatter for the same reason as the compile envelope —
 * it is implementation mechanics, not page vocabulary.
 */
export function endorsedEnvelope(page: PageFile, stamp: EndorsementStamp): PageEnvelope {
  const base: PageEnvelope = page.envelope ?? {
    compiled_at: '',
    compiled_by: '',
    entity_id: '',
    entity: str(page.frontmatter['title']) ?? '',
    type: '',
    sensitive: false,
    source_observation_ids: [],
    supersedes: [],
    related: [],
  };
  return {
    ...base,
    endorsement_operation_id: stamp.operationId,
    endorsed_by: stamp.actorId,
    endorsed_at: stamp.commitTs,
  };
}
