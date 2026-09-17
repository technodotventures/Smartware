// Layer 2 — Compiled wiki types

import type { ConfidenceBucket, ClaimStatus, EpistemicLabel, EpistemicTag } from '../layer1/types.js';

export interface ExportRule {
  to_scope: string;
  predicates: string[];
}

/** Canonical wiki subdirectories (spec v1.5.4.2 page-category routing). */
export type PageCategoryDir =
  | 'concepts'
  | 'entities'
  | 'decisions'
  | 'synthesis'
  | 'tombstones'
  | 'profiles';

/** Spec §9 page categories. Singular in frontmatter, plural in the directory name. */
export type PageCategory =
  | 'concept'
  | 'entity'
  | 'decision'
  | 'synthesis'
  | 'profile'
  | 'tombstone';

/** Spec §9 category vocabulary the page frontmatter admits (profile/tombstone have their own schemas). */
export const PAGE_FRONTMATTER_CATEGORIES: readonly PageCategory[] = [
  'concept',
  'entity',
  'decision',
  'synthesis',
] as const;

/** Spec v0.1.2 page-frontmatter notice slot. Agents post here on user pages. */
export interface PageNotice {
  type: 'retracted_reference' | 'contradiction' | 'staleness' | 'guardian_alert';
  message: string;
  claim_id?: string;
  tombstone_id?: string;
  posted_at?: string;
}

/**
 * The **published** L2 page frontmatter — spec §9's "Page frontmatter" field set, which is
 * `schemas/v0.5.0/page-frontmatter.schema.json` verbatim. This interface is a *contract*: it
 * carries page vocabulary only, and every field here has a counterpart in the schema. The
 * compiler's own bookkeeping lives in `PageEnvelope`, rendered into the page's cached region
 * (see `src/layer2/envelope.ts`) — it is not part of this structure (ADR-0013 → D2).
 */
export type Frontmatter = {
  title: string;
  page_id: string;
  category: PageCategory;
  author: 'agent' | 'user';
  /** ClaimIds the page cites (locked at endorsement on user-authored pages). */
  sources: string[];
  /** ClaimIds an agent added as corroboration after endorsement. */
  supporting_claims: string[];
  /** Page creation date, `YYYY-MM-DD`. */
  created: string;
  /** Last-update date, `YYYY-MM-DD`. */
  updated: string;
  scope: string;
  confidence: ConfidenceBucket;
  epistemic_tag: EpistemicTag;
  summary: string;
  /** Lowercase-hyphenated tags. */
  tags?: string[];
  /** Aliases (alternate page names). */
  aliases?: string[];
  /** Notice slot for agent annotations on user-authored pages. */
  notices?: PageNotice[];
};

/**
 * The compile/endorsement envelope — implementation mechanics, **not** protocol vocabulary
 * (ADR-0013 → D2). It is rendered into the page's Evidence Timeline region, a derived cached
 * render that §9 already makes agent-managed and rebuildable, so nothing authoritative depends
 * on it: entity and sensitivity are derived from L0/L1, and the timeline may be deleted at
 * no cost to canonical state.
 */
export type PageEnvelope = {
  /** When this cached render was produced. */
  compiled_at: string;
  compiled_by: string;
  entity_id: string;
  /** Entity canonical name (the page's subject). */
  entity: string;
  /** Entity type in the substrate's own vocabulary. */
  type: string;
  /** Compiled projection of L1 sensitivity; read gating derives the authoritative value from L1. */
  sensitive: boolean;
  /** Observation ids this page is grounded in (the pre-fix `sources` field). */
  source_observation_ids: string[];
  model?: string;
  supersedes: string[];
  /** Entity ids of related pages. */
  related: string[];
  /** Durable endorsement metadata for operation recovery (written by ENDORSE). */
  endorsement_operation_id?: string;
  endorsed_by?: string;
  endorsed_at?: string;
};

/**
 * A page as it exists on disk. `frontmatter` is typed loosely on purpose: pages written before
 * ADR-0013 → D2 landed carry the legacy envelope fields inline, and the reader has to accept
 * both shapes (see `readPageFile` in `./envelope.js`).
 */
export interface PageFile {
  frontmatter: Record<string, unknown>;
  /** Envelope from the cached region — or reconstructed from a legacy page's frontmatter. */
  envelope: PageEnvelope | null;
  body: string;
  /** True when the frontmatter still carries pre-fix fields (needs rewriting on next write). */
  legacy: boolean;
}

export interface CompiledPage {
  path: string;
  frontmatter: Frontmatter;
  envelope: PageEnvelope;
  oneliner: string;
  paragraph: string;
  fullPage: string;
  raw: string;              // full file content (frontmatter + body)
}

export interface CompilationAudit {
  entity_id: string;
  entity_name: string;
  claims_used: number;
  claims_contested: number;
  observations_used: number;
  compiled_at: string;
  model: string | null;
  path: string;
}

export interface EntityMerge {
  from_name: string;
  to_name: string;
  to_entity_id: string;
  jaro_winkler_score: number;
  resolution: 'auto' | 'borderline_accepted' | 'borderline_rejected' | 'exact';
}

export interface CompileTelemetry {
  observations_processed: number;
  claims_extracted_per_observation: Record<string, number>;
  observations_with_zero_claims: string[];
  entity_merges: EntityMerge[];
  entities_created_new: string[];
  layer3_indexed_count: number;
  duration_ms: number;
  timed_out: boolean;
  stage_durations_ms: Record<string, number>;
  llm_extraction_attempted: number;
  llm_extraction_failed: number;
  llm_extraction_skipped_sensitive: number;
  llm_synthesis_attempted: number;
  llm_synthesis_failed: number;
  llm_synthesis_skipped_sensitive: number;
  /**
   * State-based freshness payload contract (spec §10a): literal
   * unverified / EXTRACTED / FAILED counts over the raw-observation window
   * so clients assert compile state instead of inferring it from search.
   */
  freshness?: FreshnessCounts;
  /**
   * §11.2b re-scope marker: true when the handler ran with L2 wiki
   * synthesis deferred (params.defer_synthesis) — claim production, L1/L3
   * sync and freshness completed; pages_compiled is 0 and the wiki stage
   * runs separately (compile queue worker).
   */
  synthesis_deferred?: boolean;
}

/** State-based freshness counts over the raw-observation FTS window. */
export interface FreshnessCounts {
  unverified: number;
  extracted: number;
  failed: number;
}

/** Re-exported so layer-2 callers do not reach into layer 1 for the projection inputs. */
export type { ClaimStatus, EpistemicLabel };
