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

**Branch:** `falsifier/t_e8bd6747` · **Trunk:** `main` (trunk has moves this tree does not — run `git log main..HEAD` / `git log HEAD..main`)
**Version:** 0.7.0 · **Spec:** smartware-spec-v1.6.16.md · **Protocol:** smartware-protocol-v0.5.0.md · **Schemas:** v0.4.2, v0.5.0

## Declared (human-owned; the only non-derived block)

- **Mission:** One memory for every app and agent: an open, user-owned memory protocol with provenance, bitemporal truth, policy-first retrieval, and deterministic fallback. Reference implementation in TypeScript, local-first, SQLite + JSONL + compiled Markdown.
- **Phase:** 0.7.0 release cut on release/coffee-v050-surface (PR #3, open, pending human merge). Retention + consolidation landed via #4, closing the ADR-0001 / ADR-0002 archive loop. feature/retention-expiry carries 6 further commits (owner sign-off freezing Tier-1 invariants, HQ competitive corpus entry) awaiting their own PR.
- **Owner:** Stevie G (Techno Ventures)
- **Next action (declared):** Merge PR #3 (0.7.0 cut) to main, then land the project-substrate change (#6). Then open a PR for the 6 outstanding commits on feature/retention-expiry.
- Declared: 2026-09-11 · source: `docs/substrate.json`

## Latest material change

- **Journal:** [`2026-09-15-t_2996a3ab.md`](journal/2026-09-15-t_2996a3ab.md) — F1 implemented: reflect.auto consults fact identity before creating (the both-surfaces duplicate is gone) (2026-09-15)
- **Journal entries:** 36 · tasks completed on board `smartware`: 44
- Commit-level history is deliberately NOT duplicated here — see `git log`. This projection tracks operational state, not the commit stream.

## In flight

| Branch | Ahead | Last commit | Subject |
|---|---|---|---|
| `wip/neo/tombstone-backfill-writer` | 53 | 2026-09-15 | docs: regenerate STATUS projection (board counters moved while closing t_9e124fe6) |
| `wip/smarty/tombstone-snapshot-envelope` | 51 | 2026-09-15 | fix(schemas): tombstone snapshot block enumerates the claim record envelope |
| `wip/neo/repick-survivor` | 50 | 2026-09-15 | docs: regenerate STATUS (board counters; drift is projection-only) |
| `wip/neo/legal-hold-marker` | 47 | 2026-09-14 | docs: decide legal hold — v1 composition stands, marker not built (ADR-0008) |
| `wt/t_c5c999ba` | 47 | 2026-09-14 | docs: decide legal hold — v1 composition stands, marker not built (ADR-0008) |
| `feat/deepseek-provider` | 46 | 2026-09-15 | feat(extraction): add deepseek provider (OpenAI-compatible, api.deepseek.com) |
| `wip/smarty/demotion-handbuilt-records` | 46 | 2026-09-14 | docs: regenerate STATUS (board counters after the t_742e31f9 evidence comment) |
| `wt/t_ad51d0e2` | 46 | 2026-09-14 | docs: regenerate STATUS projection (lifecycle composition lane) |
| `wip/neo/p0-sources-ingestion` | 45 | 2026-09-14 | fence: monotonic epoch validated at the brain mutation boundary (ADR-0007) |
| `wt/t_65569b9e` | 45 | 2026-09-14 | fence: monotonic epoch validated at the brain mutation boundary (ADR-0007) |
| `wip/neo/f1-reflect-auto-identity` | 44 | 2026-09-15 | docs(journal): record the pilot cross-check and gate evidence for t_2996a3ab |
| `wip/neo/demotion-durability` | 43 | 2026-09-14 | docs(journal): state delta for t_01ef0ede (demotion durability) + STATUS regen |
| `docs/protocol-identity-adr` | 41 | 2026-09-15 | docs: accept ADR-0005 — protocol claim identity decided; F1 released, F2 fixed on branches |
| `fix/duplicate-claim-recipe` | 39 | 2026-09-14 | docs: state the measured numbers, not the remembered ones |
| `wip/neo/p0-contradiction-temporal` | 38 | 2026-09-14 | contradiction: deterministic admission, contested recall, bi-temporal closure (P0-2/P0-4) |
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

- `t_ba868906` [todo] P1 build: Coffee reference adapter for workspaces, staff and agents (created 2026-09-13, assignee neo)
- `t_9740ae98` [todo] GATE run: realistic Coffee company-brain acceptance and soak (created 2026-09-13, assignee neo)
- `t_66f1dd7d` [todo] GATE review: independent Coffee company-brain release verdict (created 2026-09-13, assignee smarty-pants)
- `t_46c4acce` [todo] GATE prepare: Smartware Coffee trial release candidate and Roham handoff (created 2026-09-13, assignee neo)

## Blockers and stale work

- No blocked tasks on the board.

## Decisions

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](adr/0001-retention-expiry-archival.md) | ADR-0001 — Retention, Expiry & Archival | Approved (owner sign-off 2026-09-10 — Tier-1 invariants §2.2 frozen; `staleness` block deprecated §2.4) | 2026-09-10 |
| [0002](adr/0002-consolidation.md) | ADR-0002 — Consolidation of claim clusters | Approved (owner sign-off 2026-09-10 — Tier-1 invariant §2.2 frozen) | 2026-09-10 |
| [0003](adr/0003-claim-fact-identity.md) | ADR-0003 — Fact identity on the claim write path: the library resolves the fact, not the key | (no status line) |  |
| [0005](adr/0005-protocol-claim-identity.md) | ADR-0005 — Claim identity vs. creation idempotency: one fact-identity predicate, one operation key | Accepted (2026-09-15) — decided by the Head of Technology (`@neo`) under founder delegation on kanban `t_15bb0cd0` ("decide this yourself, record in an ADR, implement if it needs code — no owner gate; the ADR/PR is the review surface"). **Amended 2026-09-15: F1 implemented** (kanban `t_2996a3ab`) — see *Amendment (2026-09-15)* at the end; the decision text below is unchanged except the D7 status line. It supersedes the *Known divergence* section of [ADR-0003](0003-claim-fact-identity.md); ADR-0003's Decision and its frozen write-path contract stand unchanged. | 2026-09-14 |

## Verification state

- **Acceptance criteria + exact commands:** [`VERIFY.md`](../VERIFY.md) — the definition of done for this repo.
- **CI gate:** `.github/workflows/ci.yml` (Node 22 + 24 matrix; `npm ci`, prod-vulnerability rejection, build, tests).
- **Adjacent status projections:** [`conformance-status.md`](conformance-status.md) · [`dream-status.md`](dream-status.md) · [`security-audit.md`](security-audit.md)
- **Last recorded gate evidence:** see the newest journal entry (each entry carries the commands run and their output).

## Health

- ✅ declared block fresh (4d old)
- ✅ kanban board readable (53 tasks, 2057 events)
- ⚠️ 8 completed task(s) have no journal entry — run: npm run journal:sync

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
