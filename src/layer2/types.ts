// Layer 2 — Compiled wiki types

import type { EpistemicLabel } from '../layer1/types.js';

export interface ExportRule {
  to_scope: string;
  predicates: string[];
}

/** Spec v1.5.4.2 page categories (canonical wiki subdirectories). */
export type PageCategory =
  | 'concepts'
  | 'entities'
  | 'decisions'
  | 'synthesis'
  | 'tombstones'
  | 'profiles';

/** Spec v0.1.2 page-frontmatter notice slot. Agents post here on user pages. */
export interface PageNotice {
  type: 'retracted_reference' | 'contradiction' | 'staleness' | 'guardian_alert';
  message: string;
  claim_id?: string;
  tombstone_id?: string;
  posted_at?: string;
}

export interface Frontmatter {
  // ── Substrate-internal fields (legacy + ongoing) ────────────────────────
  entity_id: string;
  entity: string;
  type: string;
  scope: string;
  epistemic: EpistemicLabel;
  sensitive: boolean;
  /** Observation IDs the page is grounded in (substrate-internal). */
  sources: string[];
  /** ClaimIds the page synthesises. The spec calls this `sources`; we keep
   *  `claim_ids` for back-compat and ALSO project to spec `sources_claim_ids`
   *  for the wire-shaped output. */
  claim_ids: string[];
  compiled_at: string;
  compiled_by: string;
  model?: string;
  prompt_hash?: string;
  source_hashes?: string[];
  confidence: number;
  supersedes: string[];
  /** Entity IDs of related pages. */
  related: string[];
  exports?: ExportRule[];

  // ── Spec v1.5.4.2 fields (PR-6 / A5) ────────────────────────────────────
  /** Page category — drives wiki/<category>/ directory. */
  category?: PageCategory;
  /** Authorship: agent (substrate-compiled) or user (endorsed/directly authored). */
  author?: 'agent' | 'user';
  /** ClaimIds the page cites. Endorsement cascade targets these. */
  sources_claim_ids?: string[];
  /** Agent-added corroborating ClaimIds. Spec calls these `supporting_claims`. */
  supporting_claims?: string[];
  /** Notice slot for agent annotations on user-authored pages. */
  notices?: PageNotice[];
  /** PageId — slug-derived. */
  page_id?: string;
  /** Human title; defaults to entity canonical_name. */
  title?: string;
  /** Compact summary; defaults to oneliner. */
  summary?: string;
  /** Lowercase-hyphenated tags. */
  tags?: string[];
  /** Aliases (alternate page names). */
  aliases?: string[];
  /** Last-update timestamp; equals compiled_at on creation. */
  updated?: string;
  /** Durable endorsement metadata for operation recovery. */
  endorsement_operation_id?: string;
  endorsed_by?: string;
  endorsed_at?: string;
}

export interface CompiledPage {
  path: string;
  frontmatter: Frontmatter;
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
  /**
   * Replay marker: true when this call did no work at all because its
   * `operation_id` had already committed, so `claims_created` /
   * `pages_compiled` above are the RECORDED counts of the run that did
   * (protocol v0.5.0, "Idempotency and commit identity"). Every count here
   * is then 0 because this call measured nothing, and `freshness` is
   * omitted rather than filled with a current-state read — mixing a live
   * reading into a recorded result is exactly what this flag exists to rule
   * out. See `docs/adr/0018-reflect-replay-returns-the-recorded-result.md`.
   */
  replayed?: boolean;
}

/** State-based freshness counts over the raw-observation FTS window. */
export interface FreshnessCounts {
  unverified: number;
  extracted: number;
  failed: number;
}
