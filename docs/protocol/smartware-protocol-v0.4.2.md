# Smartware Protocol Contract

**v0.4.2 · Normative beta contract derived from Smartware Spec v1.6.16**

This contract defines the callable Smartware surface and wire-level invariants.
The specification defines the architecture and epistemic model; the JSON Schema
set under `schemas/v0.4.2` defines canonical data and normative payload shapes.
If these artifacts disagree, the conflict blocks conformance until corrected.

## Normative baseline

This document defines the complete v0.4.2 beta wire contract for Specification
v1.6.16. The versioned schemas under `schemas/v0.4.2` are normative.

## Identifiers and values

Canonical formats are defined in `common.schema.json`. In prose:

```text
ObservationId      = obs_<content-hash>
ClaimId            = claim_<ulid>
PageId             = page_<slug>
TombstoneId        = tomb_<claim-ulid>
OperationId        = op_<ulid>
CascadePreviewId   = preview_<ulid>
RelationId         = rel_<ulid>
ActorId            = (user|agent|sidecar|substrate):<slug>
```

`substrate:<pod>` is reserved for autonomous Smartware work. Friendly consumer
identities are resolved to canonical ActorIds before authorization or writes.

Claim `state` is exactly `active | forgotten`. Supersession is not a state. An
active claim may be excluded from ordinary current truth by an admitted,
non-invalidated `supersedes` or `corrects` relation from a live source claim.

## Universal conventions

### Authorization

Every operation resolves an ActorId and applies grant middleware before reading
or writing protected data. Owner-only operations and explicit sensitive-data
opt-ins remain owner-only even when an actor otherwise holds broad scope access.

In beta, epistemic admission is user-only. No grant permits an agent to admit
epistemic edges or change user-owned epistemic state.

### Idempotency and commit identity

- Externally requested mutations require a client-supplied `operation_id` and
  `actor_id`.
- `reflect.auto` and dream phases generate their own OperationId and use the
  registered `substrate:<pod>` ActorId.
- Same OperationId plus identical canonical payload returns the prior result.
- Same OperationId plus a different payload returns `conflict`.
- Reads and dry runs do not consume OperationIds.
- One operation computes one `commit_ts`; every L1 `version_at` written by that
  operation and its operations-log timestamp equal that value.
- The operations-log entry is the cross-surface commit signal. Partial work is
  recovered or quarantined, never silently accepted.

### Canonical writes

L0 and L1 are append-only. L2 is a versioned canonical artifact compiled from
L0/L1 and loses any epistemic conflict with them. Every canonical write is
schema-validated. Derived L3/L4 state can be rebuilt.

Claims with `author: user` or `epistemic_owner: user` are fully agent-immutable:
an agent appends no version of them, including a version that only extends
`derived_from`. Corroboration remains derived until incorporated by user
`revise`. A verified `references` edge to a protected claim lives on the
agent-owned source claim.

### Error envelope

```json
{
  "error": {
    "code": "<stable-code>",
    "message": "<human-readable message>",
    "details": {}
  }
}
```

Common codes include `invalid_payload`, `invalid_scope`, `not_found`,
`forbidden`, `conflict`, `user_required`, `claim_forgotten`,
`effective_current_cycle`, `relation_not_found`, `cascade_required_ack`, and
`preview_expired`. Implementations may add narrower codes but must not turn a
defined denial or conflict into success.

## Core memory verbs

### OBSERVE

```yaml
observe:
  content: <string | structured object>
  source: <source identifier>
  scope: <scope>
  metadata:
    timestamp: <iso8601>
    informed_by: [claim_<ulid>, ...]  # optional context-fencing provenance
    tags: [<tag>, ...]                # optional
  idempotency_key: <string>           # optional source-level dedup key
  operation_id: op_<ulid>
  actor_id: <actor>
```

Semantics:

- Writes one immutable L0 observation only; never accepts or creates claims.
- Observation identity hashes the canonical payload, including actor, scope,
  source, content, and optional idempotency key.
- The same source re-ingest under the same idempotency key deduplicates; the same
  text from a different actor, scope, or source is a distinct observation.
- Quarantined observations do not enter reflection until owner review.
- `informed_by` is provenance, not supporting evidence. Reflection must not
  reabsorb a context-derived observation as independent support for those claims.

### RECALL

The normative request is `recall-request.schema.json`.

- Searches canonical content and returns ranked claims or requested renderings.
- Excludes forgotten and superseded claims by default.
- `include_forgotten` and `include_superseded` are explicit audit modes.
- A suppressing edge applies only while the edge and its source claim are live.
- Sensitive content requires explicit owner authorization and opt-in.
- `as_of` is reserved post-beta; beta rejects it with `invalid_payload`.
- Broad multi-scope peek and relation traversal deeper than one hop are
  post-beta.

### REFLECT

```yaml
reflect:
  scope: <scope>
  target: <ClaimId | PageId | null>
  use_model: <boolean>
  operation_id: op_<ulid>  # externally requested only
  actor_id: <actor>         # externally requested only
```

`reflect.auto` instead receives a substrate-generated OperationId and the
registered `substrate:<pod>` identity.

Autonomous reflection may:

- create observation-grounded claims with `author: agent`,
  `epistemic_owner: agent`, `epistemic_tag: inference`, and `confidence: low`;
- deduplicate claims by stable fingerprint while extending provenance only on an
  unprotected claim;
- compile L2 Current Understanding and cached Evidence Timeline regions;
- propose derived relation candidates, notices, and attention signals;
- write a canonical `references` relation only after deterministic verification.

It may not admit an epistemic relation, elevate canonical confidence/tag,
persist a page notice, or append a version of a protected claim. A model-only
relation remains a derived candidate.

Every accepted, in-scope observation that `reflect.auto` considers reaches one
terminal, content-free operations-log receipt. The receipt has:

```yaml
op: reflect.auto
details:
  observation_id: obs_<hash>
  scope: <scope>
  reflection_complete: true
  outcome: ignored_context_only | ignored_short_content | no_claims | claims_processed
  candidates_found: <int>          # when extraction ran
  claim_versions_written: <int>    # when extraction ran
```

This receipt is the replay checkpoint for the observation; claim-version
commits remain separate `reflect.auto` operations with their own crash-safe
intent. A crash before the receipt may safely retry the observation because
claim fingerprints and provenance extension are idempotent. Once the receipt
exists, later passes do not reconsider that observation. The receipt contains
identifiers and counts only, never observation or claim content.

### REVISE

The normative request is `revise-request.schema.json`. It has three disjoint
forms: claim adjudication, page endorsement, and tombstone revival.

#### Claim adjudication

```yaml
revise:
  target: claim_<ulid>
  expected_base_version: <int>
  add_relations:
    - kind: <relation-kind>
      target: claim_<ulid>
      valid_at: <iso8601>
      invalid_at: null
      provenance:
        origin: user
        target_claim_version: <int>
  set_confidence: high | medium | low
  set_epistemic_tag: fact | inference | opinion | stale | contested
  add_derived_from: [obs_<hash>, ...]
  invalidate_relations: [rel_<ulid>, ...]
  adopt_body: <boolean>
  reason: <non-empty string>
  operation_id: op_<ulid>
  actor_id: user:<slug>
```

At least one action is required. `content` is never accepted in beta.

The server appends a new version, stamps its version and new RelationIds, stamps
`asserted_in_source_version`, and keeps the body author unchanged unless
`adopt_body: true`. Any epistemic adjudication sets `epistemic_owner: user`.
Adoption sets both `author` and `epistemic_owner` to `user` without implicitly
changing confidence or epistemic tag.

`add_derived_from` is valid only for an already user-owned claim or when the
same operation adjudicates it. `invalidate_relations` withdraws user-admitted
epistemic edges by stable RelationId. Withdrawing `supersedes` or `corrects`
releases the target back to ordinary current truth. Deterministic-reference
reconciliation is separate and does not use this user action.

Admitting `supersedes` or `corrects` must reject a cycle with
`effective_current_cycle`.

#### Page endorsement

A user revision of a PageId with `author: user` adopts the page's Current
Understanding and every source claim body, setting `author: user` and
`epistemic_owner: user`. It is atomic and does not elevate confidence/tag unless
requested explicitly.

`dry_run: true` consumes no OperationId and returns a CascadePreviewId plus the
cascade. A commit uses a fresh OperationId. Shared claims require the unexpired
preview ID or the operation returns `cascade_required_ack` / `preview_expired`.

#### Tombstone revival

A user revision of a TombstoneId with `revived: true` restores the same ClaimId
from the complete snapshot. It preserves body, author, epistemic owner,
fingerprint, confidence/tag, relations and their pins, source observations,
tags, created time, and endorsement source. Only lifecycle/version fields are
new. Authorization is based on the snapshot. Any reactivated suppressing edge
that would create a cycle is restored invalid and reported. Page links are not
automatically restored.

### FORGET

```yaml
forget:
  target: claim_<ulid>
  reason: <non-empty string>
  operation_id: op_<ulid>
  actor_id: <actor>
```

- Appends a `state: forgotten` L1 version with all non-content metadata carried
  forward and writes a complete L2 tombstone snapshot.
- Never deletes or modifies L0.
- A user-authored or user-epistemic-owned claim is user-only to forget.
- Forgetting a replacement disables suppression from its outgoing
  `supersedes` / `corrects` edges, releasing prior truth if no other live edge
  suppresses it.

## RECALL family and operational surface

`read`, `explain`, and `context` are distinct retrieval operations:

- `read` fetches a compiled page/scope rendering.
- `explain` returns Page → Claim → Observation provenance.
- `context` returns the one-hop graph defined by
  `context-request.schema.json` and `context-bundle.schema.json`.

Context uses the same forgotten/effective-current defaults as RECALL. Relation
endpoints resolve the pinned target/source version. A separate `*_current`
summary may expose a newer version without misrepresenting it as the version the
warrant judged.

### Layer 4 delivery planning profile

The TypeScript package exports wire-neutral Layer 4 helpers for conservative
retrieval admission and lane-aware token packing. `always` preserves legacy
retrieval, `never` is an explicit caller opt-out, and `auto` fails open to
retrieval except for clearly self-contained greetings and arithmetic. Packing
allocates protected relative shares to adapter-defined evidence lanes, then
redistributes unused capacity round-robin while preserving rank prefixes.

These helpers do not change canonical relevance, authorization, provenance, or
epistemic state. They are an implementation profile for protocol adapters such
as Coffee Pod. The v0.4.2 `context-request` and `context-bundle` schemas remain
frozen: adapters may expose admission controls and packing telemetry in their
own versioned envelope, but must not claim those fields are part of the v0.4.2
wire schema.

Lifecycle/operational operations are `session`, `status`, and
`quarantine_review`. Access operations are owner-managed `grant` and `revoke`,
with middleware enforcement on every operation. They are not extra memory
verbs.

## WATCH transport binding

WATCH is not a core operation or canonical log. Its envelope is
`watch-event.schema.json`; `event_id` provides at-least-once delivery dedup.
Subscribers receive only events authorized by their grants, with identifiers
rather than restricted content.

Beta emits events for `observe`, `reflect`, `revise`, and `forget`. Grant,
revoke, session, and quarantine-review events are post-beta. Reconnect replay is
best-effort; the canonical operations log remains the audit record.

## Conformance boundary

Conformance is binary for the behavior under test. A passing type check or a
placeholder assertion is not conformance. At minimum the suite must exercise:

- schema validity on every canonical write;
- OperationId idempotency and one-commit timestamp;
- bounded autonomous claim creation and fingerprint deduplication;
- complete protected-claim immutability;
- user-only admission and suppression withdrawal;
- effective-current filtering, acyclicity, and forgotten-source release;
- complete forget/revival field preservation and inherited authorization;
- page endorsement preview/commit and atomic cascade;
- context fencing and pinned one-hop context bundles;
- exactly-once terminal reflection receipts for claim-producing and no-op
  observation outcomes;
- deterministic Layer 4 admission and lane-budget regression coverage in any
  adapter that enables the delivery-planning profile;
- the central negative invariant: no autonomous canonical epistemic write,
  confidence/tag elevation, or page notice.

The exhaustive invariant list remains Spec v1.6.16 §17.

## Versioning

- Specification: v1.6.16
- Protocol: v0.4.2
- Schemas: v0.4.2 (directory version; each `$id` is versioned)
- TypeScript package: independent implementation version

An implementation version does not imply protocol conformance. A consumer
vendor snapshot records both its upstream implementation commit and the
protocol/spec versions it has actually passed.
