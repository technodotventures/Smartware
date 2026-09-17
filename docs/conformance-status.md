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
kernel results. Re-measured again 2026-09-14 after the contradiction/temporal
lifecycle suite landed: **488 tests across 70 files**, build clean (`tsc`),
same schema and kernel results. Re-measured a third time 2026-09-14 after the
sources/ingestion/federated-read suite landed: **515 tests across 71 files**,
build clean (`tsc`), same schema and kernel results. Re-measured a fourth time
2026-09-14 after the export-restore return path landed (ADR-0006):
**520 tests across 72 files**, build clean (`tsc`), same schema and kernel
results. Re-measured a fifth time 2026-09-14 after the lifecycle-composition
suite landed (`test/conformance/q_lifecycle_composition.test.ts`, t_ad51d0e2):
**529 tests across 73 files**, build clean (`tsc`), 31 schema files verified,
`verify:saas` pass — same kernel and conformance results. Re-measured a sixth
time 2026-09-14 after the legal-hold composition suite landed and the hold
decision was recorded (`test/conformance/r_legal_hold_composition.test.ts`,
t_c5c999ba → ADR-0008): **532 tests across 74 files**, build clean (`tsc`),
31 schema files verified, `verify:saas` pass — same kernel and conformance
results. Re-measured a seventh time 2026-09-15 after the explicit legal-hold
marker landed (ADR-0009, card t_463c1ff9; the legal-hold suite rewritten to
R1–R4 and the ops-log schema op enum extended with `hold.release`):
**534 tests across 74 files**, build clean (`tsc`), 31 schema files verified,
`verify:saas` pass — same kernel and conformance results. Re-measured an eighth
time 2026-09-15 after the legal-hold verification findings were fixed (card
t_7a64ded2: release requires `operation_id`, a release replay converges the
released *duty*, `saveConfig` writes atomically with fsync, and the v0.5.0
ops-log enum completed with `consolidate` / `reflect.explicit` /
`retention.expire`): **541 tests across 75 files**, build clean (`tsc`), 31
schema files verified, `verify:saas` pass — same kernel and conformance results.
Re-measured a ninth time 2026-09-15 after the writer-surface pin landed (card
t_0e3989eb: `OpType` derives from an exported `OP_TYPES` runtime list, the four
dead members `recall` / `watch.subscribe` / `watch.event` / `guardian` removed,
and `test/schemas-v0.5.0.test.ts` now asserts every writer op validates against
the published `op` enum): **542 tests across 75 files**, build clean (`tsc`), 31
schema files verified, `verify:saas` pass — same kernel and conformance results.

- The TypeScript package builds cleanly (`tsc`; npm run build, no errors).
- All 16 v0.5.0 schemas compile and match the committed checksum manifest
  (`npm run verify:schemas`: 16 v0.5.0 files OK); the retained v0.4.2 set
  (15 files) still verifies.
- The standalone suite passes **542 tests across 75 files** with no skips
  (446/64 at the 2026-09-10 cut).
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
- The legal-hold marker suite
  (`test/conformance/r_legal_hold_composition.test.ts`, 7 tests, rewritten
  2026-09-15, t_463c1ff9 → [ADR-0009](adr/0009-explicit-legal-hold-marker.md),
  R5–R7 added by the verification follow-up t_7a64ded2;
  supersedes the ADR-0008 composition pins, whose R2/R3 were the assertions the
  marker had to change) is the executable half of the marker decision: with an
  **elapsed time-bound** observation in a scope that took the hold lane, (R1)
  the hold lane opens the hold in the same commit (`config.holds`, ops receipt
  `hold_opened: true`) and the sweep **skips** the held scope explicitly —
  nothing expires, no bytes are written, post-hold evidence stays `accepted`,
  and the skip is receipted (`details.skipped: 'legal_hold'`, and that receipt
  validates against the published v0.5.0 ops-log schema); (R2) erasure on
  the held scope is **refused** (`legal_hold_open`, no mutation, the
  `operation_id` is not consumed) and release is the audited owner act —
  receipt + config + one `hold.release` ops entry (naming the duty it lifted,
  `hold_operation_id`), idempotent per `operation_id`, `conflict` on a
  different payload, `no_open_hold` when nothing is open, owner-only; (R3)
  release lifts the gate (the sweep resumes; erasure runs with its
  attestation/export receipts; the release record survives the scope; a
  terminal erasure still replays by `operation_id`); (R4) backward
  compatibility and payload identity — a never-held scope erases as before,
  fresh configs carry no hold state, and the v0.5.0 payload-hash formula is
  unchanged (replaying a committed hold lane does not re-open a released hold);
  (R5) a release replay **converges** a lost config write (the ops entry is
  canonical — a same-key retry re-publishes the recorded release rather than
  answering "released" while the scope still reads OPEN); (R6) release
  **requires** `operation_id` — a keyless or malformed key is refused
  `invalid_parameter` before any mutation, so no unaudited release path exists;
  (R7) convergence is **duty-scoped** — a stale replay of an old release never
  lifts a hold opened afterwards (a new duty per §2).
  (C8 of the lifecycle-composition suite now runs the same dispute flow:
  offboarding + snapshot → refused erasure → `hold.release` → erasure.)
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
- The contradiction/temporal lifecycle suite
  (`test/conformance/p0_contradiction_temporal.test.ts`, 6 tests, added
  2026-09-14) closes P0-2/P0-4 against the embedded `SmartwareCore` seam:
  two actors' conflicting facts for the same canonical key are both retained
  (claims, evidence lists, raw L0 episodes) and both marked contested, and
  RECALL returns both with `status: contested` / `epistemic_tag: contested`
  instead of a silent empty result (the pre-fix defect); a third voice joins
  the same contest rather than becoming a lone active claim; supersession
  closes the older claim's event-valid window at the replacement's start
  (`t_valid_to`) while recording system time (`t_invalidated`); current recall
  and the working index exclude superseded and stale facts
  (`include_superseded` / `include_stale` history reaches them); as-of reads
  reconstruct along **both** axes (event-valid March → the superseded fact;
  system-recorded March → what the brain then knew); a warranted user REVISE
  (`origin: user` supersedes edge) is the only path that retires one side of a
  contest — no LLM adjudication anywhere (fixture configures
  `llm.provider: 'none'`).
- The sources/ingestion/federated-read suite
  (`test/conformance/p0_sources_ingestion.test.ts`, 24 tests, added
  2026-09-14) closes the shared-workspace contract (P1-2 shape): a source
  registry inside one business brain (owner-only upsert; per-brain scope; a
  second business never sees another's sources); fail-closed source context on
  the write path (unknown → `source_unregistered`, paused → `source_inactive`,
  actor outside the allow-list → `insufficient_permission`, and nothing
  written); scope-aware item dedup (the same source item in two scopes is two
  observations — a client's evidence is never shadowed by another's); ingest
  receipts with per-item outcomes (a `secret_detected` item is rejected with
  its code while the batch still commits); `operation_id` replay returning the
  recorded receipt with zero new writes; crash-mid-batch convergence on retry
  (fault-injected after the second item: written prefix dedups, the remainder
  completes once); per-`(source, scope)` cursors; sync status counts and
  cursors per source/scope, owner-only, with "connected, never synced" and an
  explicit `source_unregistered` denial for a named unknown source; federated
  reads across scopes — owner answers across named scopes with scope-tagged
  results, a staff actor naming an unauthorized scope is denied as a whole
  (never partially answered), omitted scopes federate over exactly the actor's
  readable set, and no result carries another business's facts; and attribution
  through every lane for a human and an agent writing one workspace (actor,
  actor type and source preserved; quarantined ingestions counted and hidden
  from the raw window; dedup never rewrites the original writer). The MCP
  transport suite (`test/conformance/mcp_smoke.test.ts`) drives the same
  contract over the real stdio server: the five new tools are registered with
  their required inputs, and a register → ingest → sync-status → federated-read
  round trip plus a fail-closed ingest denial run over the wire.
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

## Consumer-visible change — contradiction and temporal semantics (2026-09-14, unreleased)

Conflicting facts now have defined, deterministic semantics on both write paths,
and a disagreement is visible instead of silent. **No protocol or schema
surface changed** (the five verbs and their schemas are untouched); this is the
embedded `SmartwareCore` seam plus one new public subpath. Decision record:
[ADR-0004](adr/0004-contradiction-and-bi-temporal-lifecycle.md).

| surface | before | now |
|---|---|---|
| conflicting writes | second claim became a parallel `active` claim — two "current" truths for one fact | one deterministic policy: same canonical key + different value → every side `contested` (retained, linked via `contested_by`); later event-valid start → older claim `superseded` |
| contested claims in RECALL | dropped from the claim index → **empty result** for a disagreement | recallable, returned with `status: contested` and `epistemic_tag: contested`; `readConflicts` unchanged |
| superseded claims | `t_invalidated` (system time) recorded, event-valid window (`t_valid_to`) left open | window closed at the replacement's `t_valid_from` (event-valid time); `validity.to` is now meaningful |
| valid-time as-of / range reads | superseded claims excluded, so a past window could read empty | include claims that were true in the window (superseded history reconstructs); transaction-time reads unchanged |
| recall result `claim` object | `id`, `predicate`, `object`, `epistemic`, `confidence`, `status`, `observation_ids`, `valid_at`, `invalid_at`, `recorded_at`, `invalidated_at` | **additive**: `epistemic_tag`, `superseded_by`, `contested_by` |
| host write path | hosts hand-rolled corroboration and had no contradiction handling at all | `admitClaim(claim, store)` from the new public `smartware/layer1/conflicts` returns `inserted / corroborated / contested / superseded` |

Hosts that render recall results should now handle `contested` (surface both
sides with the marker) instead of assuming one current truth, and should prefer
`admitClaim` over a bare `insertClaim` when persisting an extracted fact so the
corroborate/contest/supersede policy is the library's, not a re-implementation.

## Consumer-visible change — sources, ingestion and federated reads (2026-09-14, unreleased)

Connectors now have a registered provenance origin and an idempotent ingestion
contract, and a company brain can read across client scopes in one call. **No
protocol or schema surface changed** (the five verbs, the RECALL family and
FORGET.SCOPE are untouched); this is the embedded `SmartwareCore` seam plus one
new public subpath (`smartware/ingestion`) and five MCP tools. Decision record:
[ADR-0005](adr/0005-sources-ingestion-and-federation.md).

| surface | before | now |
|---|---|---|
| observation source | `observation.source` carried only the free-form `source_id` dedup string — any string, no registered origin | **additive** optional `source_ref` = the registered source id; every lane that returns raw evidence carries it (`searchObservations`, `listActivity`, `readObservationEvidence`) |
| source registry | none | `core.registerSource({ actor, id, kind, display_name, status?, actor_ids?, external_ref? })` (owner-only upsert in `config.json`, `created_at` preserved) and `core.listSources({ actor })`; `kind ∈ connector/meeting/note/agent/manual/system`; `status ∈ active/paused/revoked` |
| writes under a source | a `source_id` string was accepted from anyone | fail-closed before any write: `source_required` (missing), `source_unregistered`, `source_inactive`, `insufficient_permission` (actor outside the entry's allow-list) |
| dedup identity | `(app, source_id)` — **scope-blind**: the same item in a second scope was silently dropped as a duplicate of the first | `(app, source_id, scope)` — one item per scope; the same message that matters to two clients lands in both (index swap is in-place in the derived Layer 0 index) |
| connector ingestion | none — hosts looped `observe` with no cursor, no batch replay, nothing to reconcile after an interrupted sync | `core.ingest({ actor, source_id, scope, cursor, operation_id, items })`: one polled page per batch; opaque cursor + `cursor_before` per `(source, scope)`; replaying a committed `operation_id` returns the recorded receipt and writes nothing; a crash mid-batch converges on retry (written prefix dedups); per-item outcomes with codes (`accepted/duplicate/quarantined/rejected`) and a rejected item never wedges the batch; ≤ 500 items per batch |
| sync status | none | `core.sourceSyncStatus({ actor, source_id? })` (owner-only): per source and scope — cursor, `cursor_before`, `synced_at`, batch and outcome counts; a registered source with no batches reports "connected, never synced"; a named unknown source denies (`source_unregistered`) |
| multi-scope reads | no lane answered across scopes (`recall` is single-scope) | `core.recallFederated({ actor, query, scopes? })`: named scopes must **all** be readable or the whole read denies; omitted scopes federate over exactly the actor's readable set (owner: all); results are scope-tagged, scope-major, ranked within each scope |
| `core.findObservationBySource(app, sourceId)` | two args | now requires the `scope` (identities are scope-aware) |
| MCP tools | — | `smartware_register_source`, `smartware_list_sources`, `smartware_ingest`, `smartware_sync_status`, `smartware_recall_federated`; `smartware_observe` gains optional `source_ref` |

The ingestion receipt/cursor ledger is **operational state**, not canonical
evidence: the evidence JSONL a batch wrote is the record, and losing the ledger
costs a resume hint, not writes (item dedup is content-safe). Hosts keep their
own checkpoint too; a missing cursor means "resume from your side", never "the
brain lost writes".

## Accurate release claim

The tested beta boundary is:

> Idempotent, crash-consistent local mutation commits that recover after one
> process terminates and the operation is retried, plus reason-aware scope
> erasure/offboarding with lane-exhaustive purge, same-commit grant
> revocation, and exact-count audit on the scope boundary.

Smartware must not be described as providing general ACID filesystem
transactions, automatic repair of ambiguous memory, concurrent multi-writer
safety, or full Specification v1.6.16 conformance.
