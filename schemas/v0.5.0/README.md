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

Canonical relation schemas intentionally reject `origin: model` and
`origin: reviewed`: model output is a derived candidate, and delegated reviewed
admission is post-beta. In beta, epistemic edges are user-admitted; autonomous
canonical writes are limited to deterministically verified `references`. These
invariants are unchanged in v0.5.0.

The repository schema test compiles every file with AJV 2020 and exercises
positive and negative fixtures for claim protection, relation admission,
REVISE, context bundles, the widened Scope pattern, and FORGET.SCOPE requests.

## Delivery-planning profile

The implementation exports optional Layer 4 helpers for conservative retrieval
admission and lane-aware token packing. They are wire-neutral and do not add
properties to these frozen v0.5.0 schemas. Consumer adapters may expose the
decision and packing telemetry in their own versioned response envelope.

Terminal `reflect.auto` observation receipts fit the existing open `details`
object in `operation-log-entry.schema.json`; their exact content-free shape and
outcomes are specified in the protocol document.
