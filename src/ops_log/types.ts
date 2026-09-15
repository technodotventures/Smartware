// Operations log canonical surface types.
//
// One entry per JSONL line. Validates against schemas v0.4.2's
// operation-log-entry.schema.json. See docs/atomicity.md for the role of
// this surface in cross-artifact commit semantics.

export type OpType =
  | 'observe'
  | 'recall'
  | 'reflect.explicit'
  | 'reflect.auto'
  | 'reflect.profile'
  | 'revise.claim'
  | 'endorse'
  | 'revive'
  | 'forget'
  | 'forget.scope'
  | 'hold.release'
  | 'retention.expire'
  | 'consolidate'
  | 'session.start'
  | 'session.end'
  | 'watch.subscribe'
  | 'watch.event'
  | 'access.allow'
  | 'access.deny'
  | 'guardian'
  | 'dream.verify'
  | 'dream.extract_relations'
  | 'dream.detect_conflicts'
  | 'dream.recompile_pages'
  | 'dream.check_capacity'
  | 'dream.find_orphans';

/** One canonical entry in `pod_data/operations/YYYY-MM-DD.jsonl`. */
export interface OpLogEntry {
  /** ULID-shaped, `^op_[0-9A-HJKMNP-TV-Z]{26}$` */
  operation_id: string;
  /** Registered ActorId per agent registry */
  actor_id: string;
  /** ISO 8601 — equals the operation's commit_ts; equals version_at of any L1 produced */
  timestamp: string;
  op: OpType;
  /** Operation-specific structured details. No PII; use IDs not content. */
  details?: Record<string, unknown>;
}

/** Pattern check for OperationId — matches common.schema.json. */
export const OPERATION_ID_PATTERN = /^op_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidOperationId(value: string): boolean {
  return OPERATION_ID_PATTERN.test(value);
}
