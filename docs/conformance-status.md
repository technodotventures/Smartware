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

## Verified baseline

Verified 2026-08-29 (commit baseline f91a0a8 + uncommitted working tree):

- The TypeScript package builds cleanly (`tsc`; npm run build, no errors).
- All 16 v0.5.0 schemas compile and match the committed checksum manifest
  (`npm run verify:schemas`: 16 v0.5.0 files OK); the retained v0.4.2 set
  (15 files) still verifies.
- The standalone suite passes **431 tests across 62 files** with no skips.
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

## Accurate release claim

The tested beta boundary is:

> Idempotent, crash-consistent local mutation commits that recover after one
> process terminates and the operation is retried, plus reason-aware scope
> erasure/offboarding with lane-exhaustive purge, same-commit grant
> revocation, and exact-count audit on the scope boundary.

Smartware must not be described as providing general ACID filesystem
transactions, automatic repair of ambiguous memory, concurrent multi-writer
safety, or full Specification v1.6.16 conformance.
