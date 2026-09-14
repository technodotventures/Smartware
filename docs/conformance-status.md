# Implementation conformance

**Target:** Specification v1.6.16 (five-verb surface), Protocol v0.5.0,
Schemas v0.5.0. The v0.5.0 conformance surface is **the five core memory verbs
(OBSERVE, RECALL, REFLECT, REVISE, FORGET) plus FORGET.SCOPE.**

Smartware is beta software. The repository provides executable evidence for
the implementation boundaries below; it does not claim exhaustive
Specification v1.6.16 conformance.

## Protocol v0.5.0 migration note (NOT a break)

- v0.4.x servers are backward-compatible on the five verbs: every v0.4.2
  semantic and wire invariant of those verbs is preserved unchanged in v0.5.0.
  Existing five-verb client code runs unchanged against a v0.5.0 server.
- v0.4.x servers are **non-conformant on scope-erasure**: they have no
  FORGET.SCOPE and cannot meet its atomicity, same-commit grant revocation,
  exact-count audit, or lane-exhaustive purge requirements.
- The v0.4.2 contract and schema set are retained and remain valid for
  five-verb conformance claims. This is a migration note, deliberately **not**
  a break — the anti-pattern avoided is mem0's v2→v3 churn, where a protocol
  revision broke consumers with no migration path.
- The v0.5.0 contract and the v0.5.0 schema set ship together; a mismatch
  between them blocks conformance until corrected. See the
  [v0.5.0 contract change history](protocol/smartware-protocol-v0.5.0.md).

## Release identity

- The package version is **0.7.0**; `package.json` and `src/version.ts` are kept
  in sync and are the single source of truth for the version string.
- 0.7.0 carries the v0.5.0 protocol surface. The earlier published `0.6.3` on
  the npm registry **predates that surface** and does not contain
  `schemas/v0.5.0`; integrators following the v0.5.0 documentation must not
  pin `0.6.3`.

## Verified baseline

Verified 2026-09-10 for the 0.7.0 release cut on Node v26.5.1 (CI re-runs the
same gate via `npm ci` from `package-lock.json` on Node 22 and 24, so the two
runtime lines are verified by CI rather than by this local run), superseding
the 2026-09-07 baseline: the counts below are unchanged — **446 tests across
64 files**, 31 schema files, 9/9 retrieval-kernel scenarios, and the activation
contract still fails closed. Re-measured 2026-09-14 after the isolation suite
landed: **482 tests across 69 files**, build clean (`tsc`), same schema and
kernel results.

- The TypeScript package builds cleanly (`tsc`; npm run build, no errors).
- All 16 v0.5.0 schemas compile and match the committed checksum manifest
  (`npm run verify:schemas`: 16 v0.5.0 files OK); the retained v0.4.2 set
  (15 files) still verifies.
- The standalone suite passes **446 tests across 64 files** with no skips.
- The G3 provenance-rendering contract suite (`test/render/provenance-rendering.test.ts`,
  33 tests) asserts the spec §10d wording table verbatim — flagship
  "Learned from Maya, May 12; corrected by owner May 13.", badge set
  (New / Not verified / May be stale / Conflict / Unconfirmed), the
  default-on predicate truth table (unverified/FAILED freshness, failed
  compile state, stale/contested/low-confidence, consequential
  types/tags, 14d recency + 30d correction windows, custom-window
  honoring), the client-facing denial matrix (only client-owned
  "From your messages" citation; no staff identity, badges, or
  why-panel), and UTC date determinism — via the reference renderer
  `src/render/provenance.ts` (importable as `smartware/render`).
- The G2 v0.5.0 conformance suite (`test/conformance/v050-rebuild-forget-provenance.test.ts`,
  14 tests) asserts, against wipe-clean REBUILT indexes: (a) byte-level
  rebuild-equivalence — canonical JSONL (evidence/claims/operations) is
  bit-identical after wipe-and-rebuild and every canonical line round-trips
  its own bytes; (b) FORGET.SCOPE `erasure` yields zero results in every lane
  (claim FTS, page FTS, raw-observation window, recall, vector store, graph)
  and stale-FTS "ghost" rows are eliminated by regeneration, not merely
  hidden; (c) erasure vs offboarding semantics — exact pre-mutation counts,
  one ops entry, same-commit grant revocation, non-reusable `client:<id>#n`
  markers; (d) provenance integrity — every recall hit resolves its source
  observation + ops entry, superseded claims never satisfy recall/get, and
  multi-version history is order-correct, including on rebuilt state.
- The Coffee company-brain e2e suite (`test/conformance/coffee-company-brain.test.ts`,
  3 tests) proves the multi-actor product flow on the real core (spec §10b/§10c/§25):
  one business = one tenant; owner admin; clients as scopes under `workspace`
  with `visibility_default: 'scope'`; staff granted per exact client cluster;
  a staff member builds a client's company brain and the owner recalls it scoped
  to that client with no cross-client leakage; EXACT grant clusters (Gigi → Acme,
  never Bcau/Gate/`*`; owner bypasses grants); and EXPORT.SCOPE is exactly one
  client — `scope_exclusive: true`, zero cross-client ids in the package, per-client
  packages distinct, and idempotent by `operation_id`.
- The isolation suite (`test/conformance/p0_isolation_conformance.test.ts`,
  11 tests, added 2026-09-14) closes P0-5/P0-7: six businesses with IDENTICAL
  client scope ids in one process, every read lane (recall, hybrid recall,
  context, raw-observation window, activity feed, read/browse, conflicts,
  knowledge graph, semantic documents) driven per actor (owner, human staff,
  agent, revoked staff, unregistered stranger); a fuzz over
  **1,350 (actor × scope × lane) combinations** — 972 denials, 378 allowed,
  **zero cross-tenant or cross-scope results**; federated multi-scope reads
  deny rather than partially answering an unauthorized scope; denied writes
  leave no observation, claim, or index row behind. Every denial is an explicit
  `ProtocolError` (`actor_unregistered` for an identity with no grant row,
  `insufficient_permission` for a known actor outside its scope) — a lane never
  answers an unauthorized actor with an empty result.
- Tests exercise OBSERVE, RECALL, REFLECT, REVISE, FORGET, REVIVE, ENDORSE,
  FORGET.SCOPE (erasure and offboarding lanes, owner-only enforcement,
  same-commit grant revocation, exact retraction counts, idempotent retry,
  crash recovery), access control, sessions, context delivery, retrieval
  eligibility, reflection receipts, recovery behavior, and the v0.5.0 schema
  surface (widened Scope pattern, `forget.scope` ops entries,
  forget-scope-request payloads).
- The packed package exposes the embedded `SmartwareCore`, the side-effect-free
  MCP adapter (including `smartware_forget_scope` and `smartware_export_scope`),
  the CLI, and both frozen
  schema sets (v0.5.0 current; v0.4.2 retained).
- The stdio MCP transport is exercised end to end.
- The nine-scenario retrieval-kernel contract passes with zero forbidden hits.
- The activation contract fails closed on public development evidence, as
  required.
- `npm audit --omit=dev` reports zero production dependency vulnerabilities.
  This required a lock refresh in the 0.7.0 cut: the pre-0.7.0 lock still
  resolved `fast-uri@3.1.5`, `hono@4.13.0`, and `qs@6.15.3`, each covered by
  published advisories (1 high, 2 moderate). The fix moved exactly those three
  transitive packages to `3.1.7`, `4.13.7`, and `6.16.0` within their parents'
  existing semver ranges — no direct dependency, protocol, or source change.

Host products must separately test their adapters, transports, persistence,
and user-facing authorization against the exact Smartware version they ship.

## Crash-recovery boundary

Operation-ID-backed OBSERVE, REVISE, FORGET, REVIVE, ENDORSE, automatic
REFLECT, and FORGET.SCOPE claim writes persist a content-free expected-artifact
intent before canonical mutation.

Startup recovery:

- commits only a complete, exact, hash-valid artifact set;
- leaves exact partial client operations resumable;
- safely discards an unmaterialized internal `reflect.auto` intent so
  deterministic reflection can retry;
- removes stale intents after finding their exact commit;
- leaves every mismatch untouched in `requiresManualReview`;
- finalizes a FORGET.SCOPE only when its L0 audit marker exists — the marker is
  written LAST, after every physical mutation and the config save, so a crash
  before it leaves the operation pending (the retry re-runs the idempotent
  purge) and a crash after it proves the purge already happened.

The exact ordering and recovery state table are documented in
[atomicity.md](atomicity.md).

## Remaining limits

- Legacy direct calls without an operation ID are outside the recovery
  guarantee.
- Automatic quarantine is not implemented; ambiguous append-only artifacts
  remain available for manual review.
- The suite does not prove concurrent multi-writer serialization or universal
  sudden-power-loss durability.
- REFLECT page output and search databases are rerunnable projections rather
  than one transaction spanning the entire compilation run.
- FORGET.SCOPE `erasure` is unrecoverable by design (physical purge); the
  owner-approved non-PII pointer path exists only for `offboarding`.
- Passing schemas and behavioral invariants is not an exhaustive
  requirement-by-requirement proof of Specification v1.6.16.

## Consumer-visible change — isolation enforcement (2026-09-14, unreleased)

The embedded read lanes are now actor-bound end to end; a host that currently
reaches them without an identity must pass one. **No protocol or schema surface
changed** (the five verbs, RECALL family and FORGET.SCOPE are untouched); this
is the embedded `SmartwareCore` seam.

| surface | before | now |
|---|---|---|
| `core.searchObservations(query, scope, opts?)` | no actor, no grant check — anyone holding the core could read any scope's raw evidence | `core.searchObservations({ actor, query, scope, ... })`; requires a `read` grant on the scope, sensitive content requires owner + opt-in |
| `core.listActivity(opts?)` | no actor, no grant check; `includeSensitive` widened any caller's view | `core.listActivity({ actor, ... })`; per-scope grants (scope-less calls return only readable scopes); `includeSensitive` requires the owner |
| `core.recall(...)` / `core.context(...)` on an ungranted scope | empty result set (indistinguishable from "no memory") | `ProtocolError` — `insufficient_permission` / `actor_unregistered` |
| any `requireGrant` denial | always `insufficient_permission` | `actor_unregistered` when the actor has no grant row at all; `insufficient_permission` when the Pod knows the actor (including revoked/expired grants) |

Hosts must supply the same actor identity they already use for `observe`/`read`,
and should surface the denial code to the user rather than treating it as "no
data". Coffee/Pod adapters calling `listActivity` need the actor threaded
through their activity routes.

## Accurate release claim

The tested beta boundary is:

> Idempotent, crash-consistent local mutation commits that recover after one
> process terminates and the operation is retried, plus reason-aware scope
> erasure/offboarding with lane-exhaustive purge, same-commit grant
> revocation, and exact-count audit on the scope boundary.

Smartware must not be described as providing general ACID filesystem
transactions, automatic repair of ambiguous memory, concurrent multi-writer
safety, or full Specification v1.6.16 conformance.
