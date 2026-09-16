# Smartware Schemas v0.5.0

These Draft 2020-12 JSON Schemas are the normative beta schema set paired with
Smartware Protocol v0.5.0 and Spec v1.6.16 (base five-verb surface) plus the
mem0-substrate Coffee tenant binding (spec §10–§10b: clients-as-scopes,
FORGET.SCOPE, non-reusable `client:<id>#n` markers).

Each schema has a versioned `$id`. Only this set may be used to claim v0.5.0
schema conformance. **The v0.5.0 contract and v0.5.0 schema set ship together**:
if they disagree, conformance is blocked until corrected. The v0.4.2 set is
retained under `schemas/v0.4.2` and remains valid for five-verb conformance
claims (see the protocol contract's change history — a migration note, not a
break).

## What `claim.schema.json` describes

`claim.schema.json` describes the **L1 claim version record** — one line on the
canonical L1 JSONL surface (spec §5 "L1 — Claim Store", §6 "The Claim Model"),
which is the record the reference implementation appends. Its required set is the
spec §6 required set; beyond it the schema enumerates the record-envelope fields
the implementation carries: the forget-specific fields, the demotion/release
warrants, and the optional extraction materialization block (`semantic`).

The block is optional (records written before v0.6 omit it), carries no
independent epistemic authority — `confidence` / `epistemic_tag` remain the
canonical values (spec §6 → *Implementation note*) — and is not a wire field: no
protocol request or response carries it, and nothing in it is required. It is
enumerated so that a record the implementation writes is accepted by the contract
it publishes; the alternative (declaring the L1 line a deliberately unvalidated
superset of the spec §6 version) was rejected. The decision, its consequences and
the measured divergences it does **not** cover: [ADR-0011](../../docs/adr/0011-claim-record-materialization-block.md).

## Scope vocabulary (closed at v0.5.0; host-registered lanes are not `Scope` values)

`common.schema.json` `$defs/Scope` enumerates the **protocol's** lane vocabulary:
`self`, `workspace`, `project:<slug>`, `agent:<slug>`, `client:<id>`,
`client:<id>#n`. It admits no host-lane form.

A host may register further lane ids in its own scope registry
(`SmartwareCore.ensureScopes`), and the reference implementation's pod-profile
helper does exactly that with `pod/<pod>/<lane>` ids. Those are
**host-registered lanes**: legitimate registry ids and live product scope ids,
but not v0.5.0 `Scope` values. A canonical record whose `scope` is a
host-registered lane is outside this vocabulary, and therefore outside the
v0.5.0 schema-conformance claim — the contract's conformance boundary requires
schema validity on every canonical write. A host that needs v0.5.0
schema-conformant records writes protocol-native lanes. The decision (and the
recommendation to define a host-lane form in a later protocol revision) is
[ADR-0015](../../docs/adr/0015-host-registered-lanes-and-the-substrate-actor-id.md);
`test/schemas-v0.5.0.test.ts` pins the closed vocabulary and
`test/layer1/pod-profile-conformance.test.ts` pins what the writers emit.

Changes vs v0.4.2 (schema-surface only):

- `common.schema.json` `$defs/Scope` widened to admit `client:<id>` and
  non-reusable `client:<id>#n` markers (n ≥ 1, no leading-zero markers, no
  grant wildcards). The old pattern is unchanged in v0.4.2.
- `operation-log-entry.schema.json` `op` enum gains `forget.scope`.
- NEW `forget-scope-request.schema.json` — the FORGET.SCOPE wire request:
  scope, reason (`erasure | offboarding`), operation_id, owner actor; optional
  owner-approved non-PII `owner_pointer` valid for offboarding only.

`integrity-manifest-entry.schema.json` describes an optional post-beta surface.
Its presence does not make the integrity manifest a beta requirement.

## Which schema covers which surface

Four surfaces are easy to confuse. An integrator validating Smartware records should
use the schema named here and no other (ADR-0013, kanban `t_0920aa1d`; the L1 row was
added on kanban `t_11fed5bb`):

| surface | what it is | what validates it |
|---|---|---|
| `<data_dir>/claims/<yyyy-mm>.jsonl` (one line per claim version) | **the L1 claim version record** — the canonical claim store as the writer appends it. `EXPORT.SCOPE` ships these lines **verbatim**, filtered to the exported scope, as `claims.jsonl`: the package copy is the same artifact, not a projection of it | `claim.schema.json` — see *What `claim.schema.json` describes* above. **No separate record schema and no extra manifest field**: unlike the L0 line, this record *is* the artifact `claim.schema.json` names, and the set a package's manifest declares holds that file |
| `observation.schema.json` | **the observation object on the wire** — the OBSERVE payload (`content`, `source` identifier string, `scope`, `metadata{timestamp, actor, informed_by, tags}`, `idempotency_key`) plus the server-stamped `observation_id`, `operation_id`, `actor_id` | itself |
| `<data_dir>/evidence/<date>.jsonl` (one line per observation) | **the L0 record** — the append-only storage envelope. It carries the wire payload's information under different names (`id`, `source.app`, `source.observed_at`, `source.actor`) **plus** canonical state the wire object has no place for: `status`, `visibility`, `version`, `policy`, `provenance`, and the `integrity{hash, writer_id, sequence, previous_hash}` tamper-evidence chain | **no schema in this set** — see the gap below |
| `page-frontmatter.schema.json` | **L2 page frontmatter** (spec §9) for `wiki/<category>/<slug>.md` | itself |

A package's `claims.jsonl` therefore needs no schema name beyond the `schemas` set version in its
manifest — that set holds `claim.schema.json` itself (v0.5.1, if the L0 record schema is present, is
documented as this set plus one additive file). The claim record's boundary is pinned by
`test/layer1/l1-claim-record-portability-boundary.test.ts` and decided in ADR-0013 → *Delta
(2026-09-16) — the L1 claims record*.

**Known gaps, disclosed rather than silently relaxed** (both carded with measured
evidence; the measurement is `test/layer0/l0-record-wire-boundary.test.ts` and the
rationale is ADR-0013):

1. **The L0 record shape is unpublished in v0.5.0.** Applying `observation.schema.json`
   to an evidence line yields errors by construction (4 `required`, 9
   `additionalProperties`, `/source:type`). This includes the copies in
   `EXPORT.SCOPE` packages (`observations.jsonl`, `evidence.jsonl`) — a package whose
   `manifest.json` declares `"schemas": "v0.5.0"` while shipping a record shape no
   v0.5.0 schema describes. A record schema is required for that manifest claim to be
   honest; until it exists, treat the exported record shape as defined by the
   implementation, not by this set.
2. **The reference implementation's compiled page frontmatter does not yet validate
   against `page-frontmatter.schema.json`.** The compiler emits the L2 page with a
   legacy internal envelope and a different vocabulary (`category` plural,
   `confidence` numeric, `epistemic` for `epistemic_tag`, observation ids under
   `sources`); the schema's field set is the normative one, and spec §9 prints the same field set
   (`tags`, `aliases` and `notices` optional). The writer fix is carded. `page-frontmatter.schema.json`
   is the contract
   for that artifact — do not read the implementation's current output as an
   alternative contract.

`tombstone-frontmatter.schema.json` covers `wiki/tombstones/*.md` and
`profile-frontmatter.schema.json` covers `wiki/profiles/*.md`; the page schema's
`category` enum deliberately excludes `tombstone` and `profile` for that reason.
Spec §9 prints the **wider union** in its single "Page frontmatter" block —
`category: concept | entity | decision | synthesis | profile | tombstone` — so an
integrator following that block literally routes `profile` and `tombstone` pages to
`profile-frontmatter.schema.json` / `tombstone-frontmatter.schema.json`, not to
`page-frontmatter.schema.json`, which rejects those two values with `/category:enum`.

Canonical relation schemas intentionally reject `origin: model` and
`origin: reviewed`: model output is a derived candidate, and delegated reviewed
admission is post-beta. In beta, epistemic edges are user-admitted; autonomous
canonical writes are limited to deterministically verified `references`. These
invariants are unchanged in v0.5.0.

The repository schema test compiles every file with AJV 2020 and exercises
positive and negative fixtures for claim protection, relation admission,
REVISE, context bundles, the widened Scope pattern, FORGET.SCOPE requests, and
the claim record's extraction materialization block (optional, closed, and
required-field-complete when present).

## Delivery-planning profile

The implementation exports optional Layer 4 helpers for conservative retrieval
admission and lane-aware token packing. They are wire-neutral and do not add
properties to these frozen v0.5.0 schemas. Consumer adapters may expose the
decision and packing telemetry in their own versioned response envelope.

Terminal `reflect.auto` observation receipts fit the existing open `details`
object in `operation-log-entry.schema.json`; their exact content-free shape and
outcomes are specified in the protocol document.
