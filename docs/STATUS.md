<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Regenerate: npm run status   (node scripts/substrate-status.mjs)
     Staleness:  npm run status:check (fails when this file is stale — run in a
     working checkout that has git refs; it is not a CI job for that reason)
     Derived from: git, package.json, docs/spec, docs/protocol, docs/adr,
     docs/journal, docs/substrate.json and (where reachable) the kanban board. -->

# STATUS — current operational state

> This is a *projection*, not a source of truth. Every line is regenerated from
> canonical state; if it disagrees with a canonical source, this file is wrong.
> A fresh agent should be able to read this file alone and know where the project is.

**Branch:** `wip/tech-head/retention-sweep-audit` · **Trunk:** `main` (trunk has moves this tree does not — run `git log main..HEAD` / `git log HEAD..main`)
**Version:** 0.7.0 · **Spec:** smartware-spec-v1.6.16.md · **Protocol:** smartware-protocol-v0.5.0.md · **Schemas:** v0.4.2, v0.5.0

## Declared (human-owned; the only non-derived block)

- **Mission:** One memory for every app and agent: an open, user-owned memory protocol with provenance, bitemporal truth, policy-first retrieval, and deterministic fallback. Reference implementation in TypeScript, local-first, SQLite + JSONL + compiled Markdown.
- **Phase:** 0.7.0 release cut on release/coffee-v050-surface (PR #3, open, pending human merge). Retention + consolidation landed via #4, closing the ADR-0001 / ADR-0002 archive loop. feature/retention-expiry carries 6 further commits (owner sign-off freezing Tier-1 invariants, HQ competitive corpus entry) awaiting their own PR.
- **Owner:** Stevie G (Techno Ventures)
- **Next action (declared):** Merge PR #3 (0.7.0 cut) to main, then land the project-substrate change (#6). Then open a PR for the 6 outstanding commits on feature/retention-expiry.
- Declared: 2026-09-11 · source: `docs/substrate.json`

## Latest material change

- **Journal:** [`2026-09-14-t_ec159c21.md`](journal/2026-09-14-t_ec159c21.md) — P0 fix: deterministic corroboration proof in Coffee-shaped pilot (2026-09-14)
- **Journal entries:** 36 · tasks completed on board `smartware`: 65
- Commit-level history is deliberately NOT duplicated here — see `git log`. This projection tracks operational state, not the commit stream.

## In flight

| Branch | Ahead | Last commit | Subject |
|---|---|---|---|
| `wip/neo/host-lane-identity` | 59 | 2026-09-15 | docs: state the ADR-0012 delta — verified baseline, remaining limits, journal entry |
| `wip/smarty/canonical-schema-boundary` | 59 | 2026-09-15 | docs: state the ADR-0012 delta — verified baseline, remaining limits, journal entry |
| `wip/smarty/l1-forgotten-supersedes` | 59 | 2026-09-15 | docs: regenerate STATUS projection (kanban t_3ba3ee39; board counters moved while closing) |
| `fix/status-projection-adr-bullet` | 58 | 2026-09-15 | fix(status): the ADR reader accepts the template's `- **Status:**` bullet |
| `wip/tech-head/claim-record-semantic` | 57 | 2026-09-15 | docs: regenerate STATUS projection (board event counter moved while closing t_229601e4) |
| `wip/smarty/retention-payload-identity` | 56 | 2026-09-15 | fix(protocol): the retention sweep matches the OperationId payload, not just the id |
| `wt/t_f2b584dc` | 56 | 2026-09-15 | docs(adr-0012): tighten the context paragraph (scope spelling, amended-binding pointer) |
| `wip/smarty/retention-op-id` | 55 | 2026-09-15 | fix(protocol): the retention sweep mints a contract-valid OperationId |
| `wip/neo/optype-derivation-guard` | 54 | 2026-09-15 | ops-log: guard the OpType derivation against silent widening (t_9f0f314c, F-1 of t_2b8776f7) |
| `wip/smarty/l1-legacy-op-id` | 54 | 2026-09-15 | fix(layer1): the L1 record writer stamps a Crockford-valid legacy OperationId |
| `wt/t_9740ae98` | 54 | 2026-09-15 | docs: regenerate STATUS projection (board counters and branch tips moved while this lane ran; no content lines differ) |
| `wip/neo/ops-enum-symmetry` | 53 | 2026-09-15 | docs: state delta for t_0e3989eb (gate evidence, conformance counts, STATUS projection) |
| `wip/neo/tombstone-backfill-writer` | 53 | 2026-09-15 | docs: regenerate STATUS projection (board counters moved while closing t_9e124fe6) |
| `wt/t_ba868906` | 52 | 2026-09-15 | docs: record the exact status:check outcome (board-counter drift) for the adapter cut |
| `wip/neo/legal-hold-findings` | 51 | 2026-09-15 | docs: state delta for t_7a64ded2 (gate evidence, conformance counts, STATUS projection) |
| `wip/smarty/tombstone-snapshot-envelope` | 51 | 2026-09-15 | fix(schemas): tombstone snapshot block enumerates the claim record envelope |
| `wip/neo/repick-survivor` | 50 | 2026-09-15 | docs: regenerate STATUS (board counters; drift is projection-only) |
| `wip/neo/storage-fencing` | 50 | 2026-09-15 | docs: regenerate STATUS projection (board counters moved while closing t_695656d8) |
| `wip/neo/legal-hold-marker` | 49 | 2026-09-15 | docs: state delta for t_463c1ff9 (legal-hold marker) + journal/STATUS projections |
| `wip/neo/f1b-demoted-fingerprint` | 48 | 2026-09-15 | fix: a fingerprint hit on a demoted duplicate routes corroboration to the fact's survivor (ADR-0005 F1b) |
| `falsifier/t_e8bd6747` | 47 | 2026-09-15 | test-tree: compose F1 + F2 onto one tree for the ADR-0005 steady-state falsifier |
| `wt/t_c5c999ba` | 47 | 2026-09-14 | docs: decide legal hold — v1 composition stands, marker not built (ADR-0008) |
| `feat/deepseek-provider` | 46 | 2026-09-15 | feat(extraction): add deepseek provider (OpenAI-compatible, api.deepseek.com) |
| `wip/neo/fencing-token` | 46 | 2026-09-15 | docs: fencing evidence — before/after gauntlet pair, measured cost, guard-list fix |
| `wip/smarty/demotion-handbuilt-records` | 46 | 2026-09-14 | docs: regenerate STATUS (board counters after the t_742e31f9 evidence comment) |
| `wt/t_65569b9e` | 46 | 2026-09-15 | health: host-facing health/metrics contract, lane-explicit counts, Coffee-trial SLOs (ADR-0008) |
| `wt/t_ad51d0e2` | 46 | 2026-09-14 | docs: regenerate STATUS projection (lifecycle composition lane) |
| `wip/neo/f1-reflect-auto-identity` | 44 | 2026-09-15 | docs(journal): record the pilot cross-check and gate evidence for t_2996a3ab |
| `wip/neo/p0-sources-ingestion` | 44 | 2026-09-14 | docs: regenerate journal + STATUS projections after the resilience gauntlet |
| `wip/neo/demotion-durability` | 43 | 2026-09-14 | docs(journal): state delta for t_01ef0ede (demotion durability) + STATUS regen |
| `docs/protocol-identity-adr` | 41 | 2026-09-15 | docs: accept ADR-0005 — protocol claim identity decided; F1 released, F2 fixed on branches |
| `fix/duplicate-claim-recipe` | 39 | 2026-09-14 | docs: state the measured numbers, not the remembered ones |
| `wip/neo/p0-contradiction-temporal` | 38 | 2026-09-14 | contradiction: deterministic admission, contested recall, bi-temporal closure (P0-2/P0-4) |
| `docs/saas-retention-ops-entry` | 37 | 2026-09-15 | docs: the retention sweep's ops entry is caller-supplied only (measured) |
| `wip/neo/p0-isolation-conformance` | 37 | 2026-09-14 | isolation: actor-bound raw window + activity lanes, explicit denials (P0-5/P0-7) |
| `feat/corroboration-reachable` | 33 | 2026-09-12 | feat: make corroboration reachable, and demonstrate it in the reference example |
| `fix/concurrent-schema-migration` | 32 | 2026-09-11 | fix: make column migrations idempotent when two processes open one brain |
| `fix/public-surface-and-docs` | 31 | 2026-09-11 | fix: make the public surface sufficient for host-side claim persistence |
| `docs/node-requirement` | 29 | 2026-09-11 | docs: correct the Node requirement in the integration guide (>=20 -> >=22) |
| `ci/tag-publish` | 25 | 2026-09-11 | ci: publish on version tags, with provenance and the gate in front of it |
| `docs/v070-handoff-accuracy` | 25 | 2026-09-11 | docs: point the SaaS integration guide at the release that carries the surface |
| `docs/project-substrate` | 15 | 2026-09-11 | docs: regenerate STATUS projection after the release-line rebase |
| `feature/retention-expiry` | 14 | 2026-09-11 | adr: owner sign-off — freeze Tier-1 invariants (retention + consolidation) |
| `release/coffee-v050-surface` | 8 | 2026-09-10 | release: 0.7.0 — v0.5.0 protocol surface cut on the upstream Node 22/24 gate |
| `agent/hermes-onboarding` | 3 | 2026-08-25 | [verified] docs: name complete retrieval CI gate |

Unmerged work — read the branch before assuming this tree is current.

## Queued / next up

- `t_46c4acce` [todo] GATE prepare: Smartware Coffee trial release candidate and Roham handoff (created 2026-09-13, assignee neo)
- `t_f2b584dc` [ready] DECIDE: FORGET.SCOPE revokes whole grant rows — multi-client staff lose their other clients (Coffee gate finding, ADR-0011) (created 2026-09-15, assignee tech-head)
- `t_864a5900` [todo] IMPL (ADR-0012): one grant row per (actor, client) + degraded-precheck union — close the FORGET.SCOPE multi-client access-loss finding (created 2026-09-15, assignee neo)
- `t_ef77c695` [todo] L1 replay: a `wrong`/`extraction_error` correction writes `state: 'active'`, so the retraction never reaches the canonical JSONL (measured, carded out of t_3ba3ee39) (created 2026-09-15, assignee tech-head)
- `t_0b079fbf` [todo] L1 replay mints `claim_<lowercase hex>` / `tomb_<lowercase hex>`, which the published ClaimId/TombstoneId patterns reject (measured, carded out of t_3ba3ee39) (created 2026-09-15, assignee tech-head)
- `t_8098b097` [todo] L1 writer: `insertClaim` drops a caller-supplied `superseded_by` on the forgotten path (measured, carded out of t_3ba3ee39) (created 2026-09-15, assignee tech-head)
- `t_102f3dfa` [todo] REVIEW (independent): ADR-0012 — is option (a) the right call, and is the §10b amendment + re-grant requirement correctly recorded? (created 2026-09-15, assignee smarty-pants)

## Blockers and stale work

- `t_66f1dd7d` GATE review: independent Coffee company-brain release verdict
- `t_dc609143` VERIFY (independent): retention sweep OperationId writer — branch wip/smarty/retention-op-id @ 37c914c (base 0a68482)

## Decisions

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](adr/0001-retention-expiry-archival.md) | ADR-0001 — Retention, Expiry & Archival | Approved (owner sign-off 2026-09-10 — Tier-1 invariants §2.2 frozen; `staleness` block deprecated §2.4) — **Tier-1 invariant 5 and the §2.3 / §2.5 / §4-AC3 description of the `retention.expire` entry are superseded by [ADR-0012](0012-retention-sweep-commit-identity.md) (Proposed, 2026-09-15: the sweep always commits under an OperationId); the other four Tier-1 invariants stand unchanged.** | 2026-09-10 |
| [0002](adr/0002-consolidation.md) | ADR-0002 — Consolidation of claim clusters | Approved (owner sign-off 2026-09-10 — Tier-1 invariant §2.2 frozen) | 2026-09-10 |
| [0004](adr/0004-contradiction-and-bi-temporal-lifecycle.md) | ADR-0004 — Contradiction and bi-temporal lifecycle | (no status line) |  |
| [0005](adr/0005-sources-ingestion-and-federation.md) | ADR-0005 — Sources, connector ingestion and federated reads | (no status line) |  |
| [0006](adr/0006-export-restore-return-path.md) | ADR-0006 — An export must have a return path: RESTORE.SCOPE | (no status line) |  |
| [0007](adr/0007-fencing-token-at-the-mutation-boundary.md) | ADR-0007 — A fencing token validated at the brain mutation boundary | (no status line) |  |
| [0012](adr/0012-retention-sweep-commit-identity.md) | ADR-0012 — The retention sweep always commits under an OperationId | (no status line) |  |

**Pending decision:** 0001 (ADR-0001 — Retention, Expiry & Archival)

## Verification state

- **Acceptance criteria + exact commands:** [`VERIFY.md`](../VERIFY.md) — the definition of done for this repo.
- **CI gate:** `.github/workflows/ci.yml` (Node 22 + 24 matrix; `npm ci`, prod-vulnerability rejection, build, tests).
- **Adjacent status projections:** [`conformance-status.md`](conformance-status.md) · [`dream-status.md`](dream-status.md) · [`security-audit.md`](security-audit.md)
- **Last recorded gate evidence:** see the newest journal entry (each entry carries the commands run and their output).

## Health

- ✅ declared block fresh (4d old)
- ✅ kanban board readable (82 tasks, 3369 events)
- ⚠️ 29 completed task(s) have no journal entry — run: npm run journal:sync
- ⚠️ 2 blocked task(s)

## Canonical index

| Question | Source |
|---|---|
| What is this project for? | [`README.md`](../README.md) |
| What must the code do (normative)? | [`docs/spec/smartware-spec-v1.6.16.md`](spec/smartware-spec-v1.6.16.md) |
| What is the wire contract? | [`docs/protocol/smartware-protocol-v0.5.0.md`](protocol/smartware-protocol-v0.5.0.md) |
| Why is it built this way? | [`docs/adr/`](adr/) |
| What work happened? | [`docs/journal/`](journal/) |
| How do I know a change is acceptable? | [`VERIFY.md`](../VERIFY.md) |
| What is queued or blocked? | kanban board `smartware` (operational record, outside this repo) |
| How do I operate in this repo? | [`AGENTS.md`](../AGENTS.md) |

_Projection generated by `scripts/substrate-status.mjs` from the canonical sources listed under "Canonical index"._
