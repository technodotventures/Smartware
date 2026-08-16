// Layer 1 — Claim Store Types

import type { TypedValue } from '../layer0/types.js';

export type EpistemicLabel = 'observed' | 'asserted' | 'inferred' | 'user_confirmed' | 'system_generated';
export type ClaimStatus = 'active' | 'superseded' | 'contested' | 'retracted' | 'stale';
export type ClaimTimeState = 'known' | 'inferred' | 'null';

// ── Spec v1.5.4.2 fields (PR-4 / A3) ─────────────────────────────────────
//
// These are layered onto the existing `status`-keyed schema. The `state`
// enum is the spec-conformant binary state {active, forgotten}. The
// richer `status` enum is preserved for internal use; the wire boundary
// projects `state` from `status` (retracted → forgotten; everything else
// → active).

/** Binary state per Protocol Contract v0.4.1. */
export type ClaimState = 'active' | 'forgotten';

/** What kind of assertion the claim is (Spec v1.5.4.2 §"Three orthogonal metadata dimensions"). */
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

/** How the system uses the claim. */
export type ClaimRole = 'memory' | 'working' | 'summary' | 'checkpoint' | 'audit' | 'retrospective';

/** Authorship — governs mutability per Voice protection. */
export type ClaimAuthor = 'agent' | 'user';

/** Bucketed confidence per Spec v1.5.4.2; numeric scoring is post-beta. */
export type ConfidenceBucket = 'high' | 'medium' | 'low';

/** Spec-conformant epistemic tag (distinct from the substrate's internal EpistemicLabel). */
export type EpistemicTag = 'fact' | 'inference' | 'opinion' | 'stale' | 'contested';

/** Inter-claim relation kinds (Spec §"Typed claim relations"). */
export type RelationKind =
  | 'supports'
  | 'contradicts'
  | 'supersedes'
  | 'corrects'
  | 'invalidates'
  | 'summarizes'
  | 'references';

// ── Relation provenance (spec §6) ─────────────────────────────────────────
// Required on every canonical relation edge. Discriminated by origin to
// enforce the warrant rule at the schema level.

interface ProvenanceBase {
  asserted_in_source_version: number;
  target_claim_version: number;
  observation_ids: string[];
  source_spans?: Array<{ start: number; end: number; text?: string }>;
}

export interface DeterministicProvenance extends ProvenanceBase {
  origin: 'deterministic';
  rule_id: string;
  model_id?: string;
}

export interface ModelProvenance extends ProvenanceBase {
  origin: 'model';
  model_id: string;
}

export interface ReviewedProvenance extends ProvenanceBase {
  origin: 'reviewed';
  reviewed_by: string;
  review_operation_id: string;
}

export interface UserReferenceProvenance {
  origin: 'user';
}

export interface UserEpistemicProvenance extends ProvenanceBase {
  origin: 'user';
}

export type RelationProvenance =
  | DeterministicProvenance
  | ModelProvenance
  | ReviewedProvenance
  | UserReferenceProvenance
  | UserEpistemicProvenance;

export const EPISTEMIC_RELATION_KINDS: ReadonlySet<RelationKind> = new Set([
  'supports', 'contradicts', 'supersedes', 'corrects', 'invalidates', 'summarizes',
]);

export function isCanonicalRelationValid(kind: RelationKind, origin: RelationProvenance['origin']): boolean {
  if (kind === 'references') return origin === 'deterministic' || origin === 'user';
  if (EPISTEMIC_RELATION_KINDS.has(kind)) return origin === 'user';
  return false;
}

/** A single typed temporal claim-to-claim edge (spec §6). */
export interface ClaimRelation {
  /** Stable edge identity. Server-stamped once at admission, immutable on carry-forward. */
  relation_id: string;
  kind: RelationKind;
  /** Target ClaimId. Observation provenance lives in `derived_from`. */
  target: string;
  /** When the relation became true. */
  valid_at: string;
  /** When it stopped being true. null = still valid. */
  invalid_at: string | null;
  /** Required on every canonical relation edge. */
  provenance: RelationProvenance;
}

/**
 * Project the substrate's internal `status` enum onto the spec's binary
 * `state`. `retracted → forgotten`; everything else → active.
 */
export function statusToState(status: ClaimStatus): ClaimState {
  return status === 'retracted' ? 'forgotten' : 'active';
}

/**
 * Map the substrate's `epistemic` label onto a spec-conformant epistemic_tag.
 * The substrate's `system_generated` etc. map to `inference`; `user_confirmed`
 * to `fact`. `stale` is preserved when status indicates staleness.
 */
export function epistemicToTag(epistemic: EpistemicLabel, status: ClaimStatus): EpistemicTag {
  if (status === 'stale') return 'stale';
  if (status === 'contested') return 'contested';
  if (epistemic === 'user_confirmed') return 'fact';
  if (epistemic === 'observed') return 'fact';
  if (epistemic === 'asserted') return 'opinion';
  return 'inference';
}

/** Project numeric confidence (0..1) onto a bucket. */
export function confidenceToBucket(value: number): ConfidenceBucket {
  if (value >= 0.7) return 'high';
  if (value >= 0.4) return 'medium';
  return 'low';
}

export interface ClaimTimeValue {
  value: string | null;
  state: ClaimTimeState;
  basis?: string;
}

export interface Claim {
  id: string;                       // claim_<ulid>
  subject_id: string;               // entity_<ulid>
  subject_name: string;
  predicate: string;
  object: TypedValue;
  scope: string;
  /** Compatibility view retained for existing query/conflict/search code. */
  validity: { from: string; to: string | null };
  t_ingested: ClaimTimeValue;
  t_invalidated: ClaimTimeValue;
  t_valid_from: ClaimTimeValue;
  t_valid_to: ClaimTimeValue;
  source_event_id: string;          // original Layer 0 observation
  extraction_event_id: string;      // the claim_extracted event in Layer 0
  supporting_evidence: string[];    // all Layer 0 obs IDs supporting this claim
  extraction: {
    method: 'deterministic' | 'llm' | 'user_input';
    model: string | null;
    compiler_version: string;
    prompt_hash: string | null;
    extracted_at: string;
  };
  status: ClaimStatus;
  epistemic: EpistemicLabel;
  confidence: number;
  sensitive: boolean;
  superseded_by: string | null;
  contested_by: string[];
  // ── Spec v1.5.4.2 fields (PR-4 / A3) ──────────────────────────────────
  //
  // Optional in TypeScript during migration: insertClaim defaults any
  // missing field to spec-compliant values (state from status, author=agent,
  // claim_type=finding, etc.) and rowToClaim always populates them when
  // reading. Marking them required would force every Claim-constructing
  // call site to be updated in lockstep, which is exactly what PR-5+ does.
  state?: ClaimState;
  author?: ClaimAuthor;
  epistemic_owner?: ClaimAuthor;
  claim_type?: ClaimType;
  claim_role?: ClaimRole;
  version_at?: string;
  created_at?: string;
  operation_id?: string | null;
  actor_id?: string | null;
  relations?: ClaimRelation[];
}

export interface Entity {
  id: string;              // entity_<ulid>
  canonical_name: string;
  aliases: string[];
  type: string;            // from entity types
  scope: string;
  created_at: string;
}

export function knownTime(value: string): ClaimTimeValue {
  return { value, state: 'known' };
}

export function inferredTime(value: string, basis: string): ClaimTimeValue {
  return { value, state: 'inferred', basis };
}

export function nullTime(): ClaimTimeValue {
  return { value: null, state: 'null' };
}

export function compatibilityValidity(
  tValidFrom: ClaimTimeValue,
  tValidTo: ClaimTimeValue,
  tIngested: ClaimTimeValue,
): { from: string; to: string | null } {
  return {
    from: tValidFrom.value ?? tIngested.value ?? '',
    to: tValidTo.value,
  };
}

// Standard predicate vocabulary
export const STANDARD_PREDICATES = new Set([
  'name_is', 'status_is', 'deadline_is', 'belongs_to', 'related_to',
  'created_by', 'decided_on', 'description_is', 'type_is', 'preference_is',
  'located_in', 'version_is', 'value_is', 'completed_at',
]);

// Entity types
export const ENTITY_TYPES = new Set([
  'person', 'agent', 'project', 'concept', 'decision', 'event',
  'tool', 'organisation', 'preference', 'manifest',
]);

/** Canonical claim key used for merge/corroboration checks */
export function canonicalKey(subjectId: string, predicate: string, scope: string, validityFrom: string): string {
  return `${subjectId}|${predicate}|${scope}|${validityFrom}`;
}

/** Normalise a typed value for comparison */
export function normaliseValue(v: TypedValue): string {
  if (v.type === 'text' && typeof v.value === 'string') {
    return v.value.trim().normalize('NFC');
  }
  if (v.type === 'enum' && typeof v.value === 'string') {
    return v.value.toLowerCase().replace(/[\s-]/g, '_');
  }
  return JSON.stringify(v.value);
}
