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
 * from this list, and the compile-time proof below rejects any union member
 * outside it, so neither the derivation line nor the list can drift silently.
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

/**
 * Compile-time proof that the writer union carries no member outside the list
 * (finding F-1 of t_2b8776f7, closed by t_9f0f314c): widening `OpType` past
 * `(typeof OP_TYPES)[number]` resolves the conditional to `never`, so the
 * initialiser stops compiling. The schema pin cannot see this drift — it
 * iterates the untouched list — and `test/` is outside tsc's include, so the
 * proof has to live here in `src/`.
 */
const _opTypesIsExhaustive: OpType extends (typeof OP_TYPES)[number] ? true : never = true;

/**
 * The proof above is vacuous if either side of its conditional loses its
 * literal type, so the two assertions below guard the guard (findings F-A and
 * F-B of t_037255f6, closed by t_0e732b96).
 *
 * F-A — the list's `as const` is load-bearing: without it, or with the list
 * annotated `readonly string[]`, `(typeof OP_TYPES)[number]` widens to
 * `string` and the conditional becomes `string extends string ? true : never`
 * = `true`. This assertion fails whenever the list's element type admits
 * `string` at all.
 */
type _OpTypesIsLiteral = string extends (typeof OP_TYPES)[number] ? never : true;
const _opTypesIsLiteral: _OpTypesIsLiteral = true;

/**
 * F-B — conditional types over `any` resolve to `true | never` = `true`, so
 * `OpType = (typeof OP_TYPES)[number] | any` (or any other erasure of the
 * derivation to `any`) would satisfy the proof above while admitting every
 * op. This detector fails on that erasure. (`| unknown` and `| string` are
 * already caught by `_opTypesIsExhaustive` directly — measured in
 * t_037255f6.)
 */
type _IsAny<T> = 0 extends 1 & T ? true : false;
type _OpTypeIsNotAny = _IsAny<OpType> extends true ? never : true;
const _opTypeIsNotAny: _OpTypeIsNotAny = true;

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
