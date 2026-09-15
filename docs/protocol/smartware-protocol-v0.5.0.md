# Smartware Protocol Contract

**v0.5.0 · Normative beta contract derived from Smartware Spec v1.6.16 and the
mem0-substrate Coffee tenant binding (spec §10–§10b, both closed 2026-08-29)**

This contract defines the callable Smartware surface and wire-level invariants.
The specification defines the architecture and epistemic model; the JSON Schema
set under `schemas/v0.5.0` defines canonical data and normative payload shapes.
If these artifacts disagree, the conflict blocks conformance until corrected.

**The v0.5.0 contract and the v0.5.0 schema set ship together.** A server may
claim v0.5.0 conformance only if the contract and the schema set it publishes
are both v0.5.0. The v0.4.2 artifacts are retained and remain valid for
five-verb conformance claims — see [Change history](#change-history-v042--v050).

## Normative baseline

This document defines the complete v0.5.0 beta wire contract for Specification
v1.6.16 (base five-verb surface, unchanged since v0.4.2) plus the Coffee tenant
binding: clients-as-scopes and FORGET.SCOPE (spec §10), the v0.5.0 index and
freshness cut (§10a), and the tenant config shape (§10b). The versioned schemas
under `schemas/v0.5.0` are normative.

The v0.5.0 conformance surface is: **the five core memory verbs (OBSERVE,
RECALL, REFLECT, REVISE, FORGET) plus FORGET.SCOPE.**

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

Scopes (v0.5.0 addition):

```text
Scope = self | workspace | project:<slug> | agent:<slug>
      | client:<id> | client:<id>#n          (n >= 1; markers are non-reusable)
```

`client:<id>` is the tenant-boundary scope of the Coffee frame (spec §10). Scope
ids are versioned, non-reusable markers: onboarding mints `client:<id>#1`; a
returned client after erasure/offboarding mints `#2` (or higher). `#1` is
permanently retired on `reason=erasure` and its scope entry removed. A
re-opened scope never inherits tombstoned history — except an explicit,
owner-approved non-PII pointer on offboarding (see FORGET.SCOPE). Grant
wildcards (`*`, `client/*`, `client:acme#*`) are configuration patterns and are
never scope identifiers.

Claim `state` is exactly `active | forgotten`. Supersession is not a state. An
active claim may be excluded from ordinary current truth by an admitted,
non-invalidated `supersedes` or `corrects` relation from a live source claim.

## Universal conventions

### Authorization

Every operation resolves an ActorId and applies grant middleware before reading
or writing protected data. Owner-only operations and explicit sensitive-data
opt-ins remain owner-only even when an actor otherwise holds broad scope access.
**FORGET.SCOPE is owner-only** (spec §10b.2): erasure/offboarding is an owner
decision and is never a staff capability.

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
- FORGET.SCOPE follows the same rules with a marker-last ordering: the L0 audit
  marker is written after every physical mutation, and a crash before the
  marker leaves the operation pending (the retry re-runs it idempotently).

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

Common codes include `invalid_payload`, `invalid_parameter`, `invalid_scope`,
`not_found`, `forbidden`, `conflict`, `user_required`, `claim_forgotten`,
`effective_current_cycle`, `relation_not_found`, `cascade_required_ack`, and
`preview_expired`. Implementations may add narrower codes but must not turn a
defined denial or conflict into success. FORGET.SCOPE rejects pod-internal
scopes, invalid reasons, erasure-with-pointer, and malformed OperationIds with
`invalid_parameter`.

## Core memory verbs

The five verbs below are **unchanged from v0.4.2**; the entire v0.4.2 semantic
and wire surface for them is preserved byte-for-byte. This is the
backward-compatibility guarantee of the v0.5.0 migration (see Change history).

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
- `scope` now admits `client:<id>` / `client:<id>#n` — observation of client
  business context is bound to the client boundary scope.

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
- v0.5.0 freshness contract (§10a): raw observations in the state-based window
  are searchable and carry a literal freshness label (`unverified`) until their
  compile job resolves (`EXTRACTED` → claim ranks above, observation retained as
  evidence; `FAILED` → observation stays searchable forever with `unverified`).
  Freshness is STATE-based, never time-based.
- An erased scope returns zero results in every lane (vector, BM25, graph),
  including after a wipe-and-rebuild from the canonical log — a stale derived
  entry is a conformance failure (rebuild-equivalence, §10a).

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
  repick_survivor: <boolean>          # v0.5.0: user-only re-pick of the surviving duplicate
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

#### Re-picking the survivor (`repick_survivor`, v0.5.0)

The one user act that releases a mechanical demotion (ADR-0003 → *Releasing a
demotion*). `target` must be a demoted duplicate — its latest version carries
`superseded_by`; otherwise the operation is rejected with `not_demoted` and
nothing is written. `repick_survivor` is the operation's only action in v0.5.0:
combining it with any other action is rejected (`invalid_parameter`, and the
schema enforces the same).

One atomic commit appends two version records under one OperationId:

- the **release** — the target's new active version with `superseded_by` /
  `superseded_at` cleared, `epistemic_owner: user`, and the audit-only
  `reinstated_by: 'user'`; and
- the **demotion** — a new version of the fact's current active copy (or copies)
  with `superseded_by: <released claim>`, `superseded_at` and the warrant
  `superseded_by_origin: 'user'`. Mechanical demotions leave that warrant absent.

The demotion uses the mechanical channel (`status: superseded`), deliberately
not an admitted `supersedes` edge: it is not subject to `effective_current_cycle`
and `invalidate_relations` neither touches nor undoes it. Exactly one copy of the
fact stays recall-eligible; the next §1e write touching the fact finds only the
released claim. If the survivor is already forgotten, the release happens alone
(rescue mode; `demoted: []`).

The result reports `demoted: [claim_<ulid>, ...]` (empty in rescue mode) and — the
target being released — carries no `superseded_by`. Replay and crash recovery
follow §5: the intent names both artifacts, and recovery commits only a complete,
exact set (a partial set fails closed to manual review).

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

## FORGET.SCOPE (v0.5.0 — scope erasure and offboarding)

The normative request is `forget-scope-request.schema.json`.

```yaml
forget.scope:
  scope: client:<id> | client:<id>#n
  reason: erasure | offboarding
  operation_id: op_<ulid>
  actor_id: user:<slug>       # owner only; never a staff capability
  owner_pointer: <string>     # optional; offboarding ONLY
```

FORGET.SCOPE is a substrate-required operation for the Coffee tenant model
(spec §10): one audited operation for a client that left, disputed, or
requested erasure. It sits beside lifecycle operations (session, grant, …) but
unlike them it IS part of the v0.5.0 conformance surface — its semantics change
conformance (atomicity, same-commit grant revocation, reason-aware behavior,
lane-exhaustive purge), so it is not an extension slot.

Semantics:

- **Owner-only.** `requireOwner` runs before any mutation. Staff grants never
  carry scope erasure/offboarding; staff-initiated five-verb FORGET within a
  cluster is allowed only where the business configures it, and it never
  escalates to scope erasure.
- **Client scopes only.** `self` / `workspace` are pod-internal and rejected
  with `invalid_parameter` — erasing the pod's own scope would destroy the audit
  surface (the marker lives in `self`).
- **One ops-log entry** of op `forget.scope` carrying the exact pre-mutation
  counts: `claims_retracted`, `observations_retracted`, plus `grants_revoked`,
  `scope_entry_removed`, `derived_summaries_flagged`,
  `vector_entries_removed`, and the audit marker identifiers
  (`audit_observation_id`, `observation_hash`, `payload_hash`). Counts are
  latest-state based: a claim whose latest version is `forgotten` is already
  retracted and not retracted again.
- **Same-commit grant revocation.** Grants referencing the scope are revoked
  (`status: 'revoked'`) and config is saved before the ops-log entry is
  appended — one commit as far as clients and auditors observe.
- **`reason` determines behavior:**
  - `erasure` (legal/PII) — physical content purge: Layer1 rows and L1 JSONL
    records purged, claim / entity-page / observation FTS rows removed,
    vector/embedding records removed, derived L2 summaries removed (flagged for
    re-derivation), compile-queue scope jobs and fingerprint-index rows
    dropped; the config scope entry is REMOVED and the marker is permanently
    retired; observations get a terminal `erased` effective status via the
    scope-level marker so zero results hold in EVERY lane (vector, BM25, graph)
    and against a rebuilt index.
  - `offboarding` — tombstone + grant revoke, auditably REVIVE-able: active
    claims receive `state: forgotten` versions (complete snapshots, reversible
    via REVIVE), observations are scope-level tombstoned (terminal), grants are
    revoked but re-activatable, and the scope entry REMAINS so a `client:<id>#2`
    can be minted later. The owner-approved non-PII `owner_pointer` may carry
    into `#2` — an audited choice, never silent resurrection.
- **Idempotency and crash recovery.** Same `operation_id` + identical payload
  returns the recorded prior result (verified against the durable audit
  marker); a different payload returns `conflict`. The durable intent (WAL) is
  written before any mutation; the L0 audit marker is written LAST. A crash
  before the marker leaves the operation pending — recovery or the retry
  re-runs the idempotent purge; a crash after the marker finalizes from the
  recorded counts. `requiresManualReview` is never silently bypassed.
- **Non-reusable markers.** The scope id spelling is the erasure boundary: a
  re-opened `client:<id>#2` inherits none of `#1`'s content by construction
  (grant matching is exact-id only — no wildcard spans versions).
- **Audit marker scope.** The L0 marker observation (`type: erasure`) is written
  into the POD scope (`self`), never inside the erased scope, and is content-free
  except for identifiers, counts, reason, and the optional pointer.

Result (all lanes done, audit and counts committed):

```yaml
result:
  scope: client:<id>#n
  reason: erasure | offboarding
  claims_retracted: <int>
  observations_retracted: <int>
  grants_revoked: [grant_<ulid>, ...]
  scope_entry_removed: <boolean>
  derived_summaries_flagged: <int>
  vector_entries_removed: <int>
  audit_observation_id: obs_<hash>
  status: forgotten
```

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
as Coffee Pod. The v0.5.0 `context-request` and `context-bundle` schemas remain
frozen: adapters may expose admission controls and packing telemetry in their
own versioned envelope, but must not claim those fields are part of the v0.5.0
wire schema.

Lifecycle/operational operations are `session`, `status`, and
`quarantine_review`. Access operations are owner-managed `grant` and `revoke`,
with middleware enforcement on every operation. They are not extra memory
verbs. FORGET.SCOPE is a conformance surface for v0.5.0 but is not a new
memory verb: it applies the five-verb FORGET semantics at the scope boundary,
with reason-aware behavior.

## WATCH transport binding

WATCH is not a core operation or canonical log. Its envelope is
`watch-event.schema.json`; `event_id` provides at-least-once delivery dedup.
Subscribers receive only events authorized by their grants, with identifiers
rather than restricted content.

Beta emits events for `observe`, `reflect`, `revise`, and `forget`. Grant,
revoke, session, quarantine-review, and forget.scope events are post-beta.
Reconnect replay is best-effort; the canonical operations log remains the audit
record.

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
  confidence/tag elevation, or page notice;
- **FORGET.SCOPE (v0.5.0):** `erasure` yields zero RECALL results in every lane
  (vector, BM25, graph) AND against a wipe-and-rebuilt index; exact
  `claims_retracted` / `observations_retracted` counts in the single ops-log
  entry; same-commit grant revocation; `offboarding` is REVIVE-able with grants
  re-activatable; owner-only enforcement; pod-internal scope rejection;
  idempotent retry and crash recovery (marker-last ordering,
  `requiresManualReview` escalation); non-reusable `client:<id>#n` markers.
- **Scope schema (v0.5.0):** `client:<id>` / `client:<id>#n` accepted in every
  schema that references `Scope` (`observation`, `claim`, `recall-request`,
  `context-request`, `context-bundle`, `page-frontmatter`,
  `tombstone-frontmatter`, `watch-event`, `agent-registry-entry`);
  grant-wildcard spellings rejected as no scope is ever `client:*`.

The exhaustive invariant list remains Spec v1.6.16 §17.

## Versioning

- Specification: v1.6.16 (base five-verb surface)
- Substrate spec: v0.7 normative (Coffee tenant binding §10–§10b; FORGET.SCOPE
  normative source)
- Protocol: v0.5.0 — v0.4.2 artifacts remain reference-valid for five-verb
  conformance claims
- Schemas: v0.5.0 (directory version; each `$id` is versioned) — the v0.4.2 set
  remains frozen for five-verb claims
- TypeScript package: independent implementation version

An implementation version does not imply protocol conformance. A consumer
vendor snapshot records both its upstream implementation commit and the
protocol/spec versions it has actually passed.

## Change history: v0.4.2 → v0.5.0

**2026-08-29 — v0.4.2 → v0.5.0: FORGET.SCOPE joins the conformance surface
(migration note; NOT a break)**

- **What changed.** The conformance surface grew from the five core memory verbs
  (OBSERVE, RECALL, REFLECT, REVISE, FORGET) to **five verbs + FORGET.SCOPE**.
  FORGET.SCOPE adds a reason-aware scope-boundary erasure/offboarding operation
  for the Coffee tenant model (spec §10). Contained schema-surface changes:
  `Scope` widened to admit `client:<id>` / `client:<id>#n`; ops-log `op` enum
  gains `forget.scope`; new `forget-scope-request.schema.json`.
- **What does NOT change.** Every v0.4.2 semantic and wire invariant of the five
  verbs is preserved byte-for-byte. No existing verb, payload, result, error
  code, or conformance requirement was modified, removed, or renamed.
- **v0.4.x servers:** fully backward-compatible on the five verbs (they remain
  reference-conformant for five-verb claims — keep using the v0.4.2 contract
  and schema set for such claims); **non-conformant on scope-erasure** — they
  have no FORGET.SCOPE, so they cannot meet its atomicity, same-commit grant
  revocation, exact-count audit, or lane-exhaustive purge requirements.
- **This is a migration note, not a break.** Existing five-verb client code runs
  unchanged against a v0.5.0 server. The deliberate anti-pattern we are NOT
  following is mem0's v2→v3 churn: a protocol revision that broke consumers and
  quarantined existing deployments with no migration path. Here each revision
  supersets the previous wire surface; nothing is withdrawn.
- **What implementers must do:**
  1. To target v0.5.0 conformance, ship the v0.5.0 contract AND the v0.5.0 schema
     set together — a mismatch blocks conformance.
  2. Five-verb-only implementations may keep claiming v0.4.2 conformance with
     the retained v0.4.2 artifacts and add FORGET.SCOPE when tenant scope
     boundaries are in scope for them.
  3. v0.4.2 clients must not submit `client:<id>` / `client:<id>#n` scopes to a
     v0.4.2 server (its schema rejects them by design).
