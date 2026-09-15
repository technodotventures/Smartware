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

Verified 2026-09-15 on Node v26.5.1 for the creation-side identity change (F1 of
[ADR-0005](adr/0005-protocol-claim-identity.md): `reflect.auto` consults fact
identity before creating), superseding the 2026-09-14 duplicate-claim-identity
baseline (which recorded **493 tests across 69 files**): **497 tests across
70 files**, 31 schema files, and the public-API smoke passing end to end (12/12
PASS lines). The 4-test delta is `test/protocol/reflect-auto-fact-identity.test.ts`
(see below); no other suite changed. The 2026-09-14 retrieval numbers (9/9
retrieval-kernel scenarios, activation contract fails closed) were **not re-run**
for this change — it touches no retrieval surface — and stand as recorded. (CI
re-runs the same gate via `npm ci` from `package-lock.json` on Node 22 and 24,
so the two runtime lines are verified by CI rather than by this local run.)

- The TypeScript package builds cleanly (`tsc`; npm run build, no errors).
- All 16 v0.5.0 schemas compile and match the committed checksum manifest
  (`npm run verify:schemas`: 16 v0.5.0 files OK); the retained v0.4.2 set
  (15 files) still verifies.
- The standalone suite passes **497 tests across 70 files** with no skips.
- The fact-identity suite (`test/layer1/fact-identity.test.ts`, 22 tests) pins the
  claim write-path identity contract documented in the integration guide §1e:
  `ClaimStore.findActiveFactMatches` returns **every** active claim asserting a
  fact (survivor order — lexicographically smallest claim id, i.e. earliest-minted
  ULID first) and `resolveFactMatches` folds duplicates into that survivor by
  unioning the losers' `supporting_evidence`, demoting them (`status:
  'superseded'`, `superseded_by`, timestamped, never deleted), recomputing
  confidence with the library formula, and reporting `ambiguous_matches` /
  `superseded_claims`. Both insertion orders of a duplicate pair yield the same
  survivor; a demoted duplicate is no longer matched. The same 6 fixtures as the
  host-side pilot reference implementation are reproduced 1:1, and the pilot's own
  deterministic suite was re-run unchanged against this change's package (6/6 pass,
  evidence on `t_2996a3ab`), so the pilot cross-check remains valid.
- The same suite pins the **crossing between that write-path identity and the
  structured claim fingerprint** (`computeStructuredClaimFingerprint`,
  `reflect.auto` idempotency, spec §193/§238) in both measured directions: two
  active rows differing only in `claim_type` are one fact to the write path and two
  to the fingerprint, while two rows differing only in text case are the reverse.
  The relationship is decided in [ADR-0005](adr/0005-protocol-claim-identity.md)
  (one fact-identity predicate, `claim_type` excluded; the fingerprint is the
  autonomous-creation key only), with a reversal trigger in
  [ADR-0003](adr/0003-claim-fact-identity.md) → *Known divergence*. Re-closing the
  crossing silently fails the suite (measured: dropping `claim_type` from the
  fingerprint fails 1 test, case-folding a text value in `normaliseValue` fails 3,
  making fact identity depend on `claim_type` fails 1).
- `test/protocol/reflect-auto-fact-identity.test.ts` (4 tests) pins F1 of ADR-0005
  on the in-repo protocol surface: a host-held fact restated by an autonomous
  observation **under another classification** gets corroboration (`derived_from`
  extended, one active claim, recall answers once, receipt records the decision)
  instead of a second claim; a protected (`epistemic_owner: user`) claim is neither
  corroborated nor duplicated; the matching-classification control still converges
  through the fingerprint key; and creation is unchanged when no claim holds the
  fact. RED-first evidence: against pre-fix `src/` the suite reports
  `Tests 2 failed | 2 passed (4)`, after the change `4 passed`.
- `npm run verify:saas` (public-API smoke) exercises the same contract end to end
  against the packaged surface: a store seeded with two active claims for one fact
  answers **2** recall results for that fact and **1** after
  `resolveFactMatches`, with the duplicate superseded, its evidence unioned
  (2→3 refs), survivor confidence formula-consistent, and the two rows for the one
  fact shown to carry two different `canonicalKey`s (the key includes
  `validity_from`, so it is not the fact identity).
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
- Duplicate-claim convergence is **write-triggered**, not automatic: an existing
  store keeps two active claims for one fact until a write touching that fact
  resolves them or the host sweeps the scope (`ClaimStore.findActiveFactMatches`
  + `resolveFactMatches`, integration guide §1e). Identity is
  `(subject, predicate, scope, object value)` — the same fact asserted in two
  different scopes is never merged. The autonomous path **no longer creates** such
  a duplicate for a fact the store already holds (`reflect.auto` consults fact
  identity before creating and attaches corroboration instead — F1 of ADR-0005),
  but it does not retro-repair a store that already holds one.
- **Two keys over the claim table, one fact-identity predicate.** The write-path
  identity above is the fact-identity predicate (`claim_type` excluded); the
  structured claim fingerprint (`claim_type` included, text lowercased) is the
  autonomous-creation key and answers a different question — it must not be read as
  a fact verdict, and the two relations cross in both directions (two active rows
  differing only in `claim_type` are one fact and two fingerprints; two rows
  differing only in text case are the reverse — the second direction is unchanged).
  The relationship is decided in
  [ADR-0005](adr/0005-protocol-claim-identity.md) with measured cases and limits;
  the write-path contract stands in
  [ADR-0003](adr/0003-claim-fact-identity.md). "The library has one notion of a
  fact" remains false and must stay unwritten.
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
safety, a single fact-identity rule across its write and compile paths, or full
Specification v1.6.16 conformance.
