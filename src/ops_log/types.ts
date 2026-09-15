// Operations log canonical surface types.
//
// One entry per JSONL line. Validates against schemas v0.5.0's
// operation-log-entry.schema.json. See docs/atomicity.md for the role of
// this surface in cross-artifact commit semantics.
//
// `OP_TYPES` is the writer surface, and test/schemas-v0.5.0.test.ts pins every
// member of it to the published v0.5.0 `op` enum — an op admitted here but
// absent from the enum would emit receipts the published contract rejects
// (latent asymmetry measured by verification t_fa18b2bf F-2, closed by
// t_0e3989eb). The published enum may carry ops no writer emits yet — a
// superset is safe; a superset in *this* direction is not.
//
// `recall`, `watch.subscribe`, `watch.event` and `guardian` were removed from
// this surface by t_0e3989eb: none had a writer site and none is a canonical
// ops-log operation (spec: RECALL is a read and does not emit; WATCH is a
// transport binding, "not a core operation or canonical log"; Verify/Guardian
// is read-only).

/**
 * Every op the reference implementation's writer surface can emit, as a
 * runtime list — the schema-conformance test iterates it. `OpType` is derived
 * from this list, so the type cannot drift from it.
 */
export const OP_TYPES = [
  'observe',
  'reflect.explicit',
  'reflect.auto',
  'reflect.profile',
  'revise.claim',
  'endorse',
  'revive',
  'forget',
  'forget.scope',
  'hold.release',
  'retention.expire',
  'consolidate',
  'session.start',
  'session.end',
  'access.allow',
  'access.deny',
  'dream.verify',
  'dream.extract_relations',
  'dream.detect_conflicts',
  'dream.recompile_pages',
  'dream.check_capacity',
  'dream.find_orphans',
] as const;

export type OpType = (typeof OP_TYPES)[number];

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
