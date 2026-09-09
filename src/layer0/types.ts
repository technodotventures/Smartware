// Layer 0 — Evidence Log Types
// normative definitions

import type { SMARTWARE_VERSION } from '../version.js';

export type ObservationType =
  | 'message' | 'file' | 'meeting' | 'preference' | 'decision'
  | 'tool_output' | 'claim_extracted' | 'correction' | 'tombstone'
  | 'redaction' | 'compaction' | 'feedback' | 'consent_change'
  | 'quarantine_review' | 'system'
  | 'agent_run_started' | 'agent_run_completed'
  | 'agent_action_proposed' | 'agent_action_approved' | 'agent_action_rejected'
  | 'workflow_run_started' | 'workflow_run_completed'
  | 'task_created' | 'task_completed'
  | 'meeting_brief_created' | 'followup_drafted'
  | 'erasure';

export type ObservationStatus = 'accepted' | 'quarantined';

// Effective states are computed by the derived index — NOT stored in JSONL.
// 'erased' is the FORGET.SCOPE{reason:erasure} terminal state (spec §10): it
// excludes an observation from every derived lane on replay, so a REBUILT
// index can never resurface purged content (rebuild-equivalence, §10a).
export type EffectiveStatus = 'accepted' | 'quarantined' | 'tombstoned' | 'redacted' | 'rejected' | 'erased';

export type ActorType = 'person' | 'agent' | 'system';
export type Visibility = 'private' | 'scope' | 'workspace' | 'public';
export type RetentionPolicy = 'forever' | 'duration' | 'until_revoked';

export type ValueType = 'text' | 'date' | 'datetime' | 'number' | 'enum' | 'entity_ref' | 'boolean' | 'any';

export interface TypedValue {
  type: ValueType;
  value: string | number | boolean | object;
}

export interface Actor {
  type: ActorType;
  id: string;
  display_name: string;
}

export type ClaimTimeState = 'known' | 'inferred' | 'null';

export interface ClaimTimeValue {
  value: string | null;
  state: ClaimTimeState;
  basis?: string;
}

export interface PreExtractedClaim {
  subject_id?: string;
  subject_name: string;
  /** Entity type hint (person, tool, organisation, project, decision, concept, etc.) */
  subject_type?: string;
  predicate: string;
  object: TypedValue;
  scope: string;
  /** Legacy compatibility field retained while v1 temporal fields settle. */
  validity?: { from: string; to: string | null };
  t_valid_from?: ClaimTimeValue;
  t_valid_to?: ClaimTimeValue;
  epistemic: string;
  confidence: number;
  sensitive: boolean;
  extraction: {
    method: 'deterministic' | 'llm' | 'user_input';
    model: string | null;
    compiler_version: string;
    prompt_hash: string | null;
  };
}

export interface Observation {
  id: string;             // obs_<sha256(canonical observation payload)>
  version: typeof SMARTWARE_VERSION;
  /** Commit identity for recovery. Optional only for pre-v0.4.2 records. */
  operation_id?: string;
  /** Accountable actor for operation_id. Optional only for legacy records. */
  actor_id?: string;
  type: ObservationType;
  status: ObservationStatus;
  source: {
    app: string;
    app_version: string;
    source_id: string | null;
    actor: Actor;
    captured_at: string;   // ISO 8601
    observed_at: string;   // ISO 8601
  };
  scope: string;
  visibility: Visibility;
  content: {
    format: 'text/markdown' | 'text/plain' | 'application/json';
    body: string | object;
  };
  claims?: PreExtractedClaim[];
  provenance: {
    parent_ids: string[];
    informed_by?: string[];
    supersedes: string[];
    context: string;
  };
  idempotency?: {
    actor_id: string;
    key: string;
    payload_hash: string;
  } | null;
  policy: {
    retention: RetentionPolicy;
    retention_duration: string | null;
    sensitive: boolean;
    pii_detected: boolean;
  };
  integrity: {
    hash: string;
    writer_id: string;
    sequence: number;
    previous_hash: string | null;
  };
}

// State transition matrix
export const TERMINAL_STATES = new Set<EffectiveStatus>(['tombstoned', 'redacted', 'rejected', 'erased']);

export const TRANSITIONS: Record<string, Record<string, EffectiveStatus>> = {
  accepted: {
    tombstone: 'tombstoned',
    redaction: 'redacted',
  },
  quarantined: {
    'quarantine_review:approve': 'accepted',
    'quarantine_review:reject': 'rejected',
    tombstone: 'tombstoned',
  },
};
