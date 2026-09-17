# Decision records (ADRs)

One file per consequential decision: `NNNN-short-slug.md`, zero-padded, never
renumbered. Use the template below. An ADR is how a decision survives the
conversation it was made in.

## Status values

| Status | Meaning |
|---|---|
| `Proposed` | Written, not yet binding. `docs/STATUS.md` lists these as pending decisions. |
| `Accepted` | Binding. Agents must follow it or write a superseding ADR. |
| `Superseded by NNNN` | No longer binding. The file stays in place — history is not deleted. |
| `Rejected` | Considered and declined. Keep it: it prevents re-litigating. |

## Template

```markdown
# ADR NNNN — <decision in the title>

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Superseded by NNNN | Rejected
**Deciders:** <who>
**Supersedes:** <NNNN or —>

## Context

The forces in play, including the constraints that made the obvious option wrong.

## Decision

**One sentence in bold.** Then the specifics: boundaries, what is now permitted,
what is now forbidden.

## Consequences

What becomes true, what becomes harder, what this forecloses. Include the
reversal trigger: the condition under which this decision should be revisited.

## Alternatives considered

Each with the reason it lost. An ADR with no alternatives was not a decision.
```

## Rules

1. Decisions that change **acceptance criteria, protocol surface, or the authority
   table in `AGENTS.md`** always need an ADR.
2. Amending an ADR is not editing it. Write a new one that supersedes it.
3. `docs/STATUS.md` reads the `**Status:**` line — keep the format exact.
4. No secrets, no customer data. ADRs are committed history.

## Numbering

"Never renumbered" (above) means never **after merge**. Before merge, a number
that collides is refiled in the same commit that moves the file — that is the
one case where the number changes. Numbers are allocated against one registry,
not per branch (three unmerged lanes minted `0012` independently on 2026-09-15;
the arbitration card `t_201cdca8` is recorded below).

1. **Claim from the registry below.** Read it from `main` — your branch's copy
   may be stale:

   ```
   git show origin/main:docs/adr/README.md
   ```

   Take the lowest number that is claimed neither in the registry nor by an open
   pull request (`gh pr list`). Read `main`, not your base: a base branch can be
   refiled beneath you without any git conflict (2026-09-15: `0012` → `0014`
   landed under a fork that had just minted `0014`; the fork rebased and took
   `0016`).
2. **Register in the same commit.** Add your row to the table — keep it sorted
   by number — in the commit that adds `docs/adr/NNNN-slug.md`. A claim that is
   not in the registry is not a claim.
3. **On a collision, the claim that reaches `main` second renumbers** — before
   merge: rename the file, update its `# ADR NNNN` heading and every reference
   in the same commit, and say so in the commit subject. Once a number is on
   `main` it is never renumbered; replace the decision with a superseding ADR
   instead.

`npm run verify:adrs` enforces the mechanical part, on every tree and in CI:
every ADR file has a registry row, no two files share a number, and the table is
sorted.

### Registry

`Where` names one branch carrying the file (not necessarily the minting lane);
claims live on their whole stack. Snapshot: 2026-09-15 ~13:30Z.

| # | Slug | Where | Note |
|---|---|---|---|
| 0001 | retention-expiry-archival | `main` | merged |
| 0002 | consolidation | `main` | merged |
| 0003 | claim-fact-identity | `docs/protocol-identity-adr` (`t_15bb0cd0`) +19 branches | |
| 0004 | contradiction-and-bi-temporal-lifecycle | `feat/deepseek-provider` +15 branches | |
| 0005 | protocol-claim-identity | `docs/protocol-identity-adr` (`t_15bb0cd0`) +3 branches | kept `0005`; `sources-ingestion-and-federation` refiled to `0019` |
| 0006 | export-restore-return-path | `feat/deepseek-provider` +14 branches | |
| 0007 | fencing-token-at-the-mutation-boundary | `feat/deepseek-provider` +7 branches | |
| 0008 | legal-hold-composition | `wip/neo/legal-hold-findings` (`t_7a64ded2`, PR #12) +4 branches | kept `0008`; `host-facing-health-contract` refiled to `0020` |
| 0009 | explicit-legal-hold-marker | `wip/neo/legal-hold-findings` (`t_7a64ded2`, PR #12) +3 branches | |
| 0010 | storage-level-fencing | `wip/neo/storage-fencing` (`t_695656d8`, PR #13) | kept `0010`; `coffee-reference-adapter` refiled to `0021` |
| 0011 | claim-record-materialization-block | `fix/l1-replay-correction-state` (`t_ef77c695`) +6 branches | kept `0011`; `coffee-company-brain-acceptance-gate` refiled to `0022` |
| 0012 | grant-granularity-at-the-forget-scope-boundary | `wt/t_f2b584dc` (`t_f2b584dc`, PR #16) | kept `0012` in the `t_201cdca8` arbitration — see below |
| 0013 | retention-sweep-commit-identity | `wip/tech-head/retention-sweep-audit` (`t_543cb61a`) | kept `0013`; `which-schema-covers-the-l0-record-and-the-l2-page-frontmatter` refiled to `0023` |
| 0014 | forgotten-version-supersedes | `wip/smarty/l1-forgotten-supersedes` (`t_3ba3ee39`) | refiled from `0012` before merge (`t_201cdca8`) |
| 0015 | host-registered-lanes-and-the-substrate-actor-id | `wip/neo/host-lane-identity` (`t_9a700aed`, PR #17) | refiled from `0012` before merge (`t_201cdca8`) |
| 0016 | canonical-state-is-a-projection-of-status | `fix/l1-replay-correction-state` (`t_ef77c695`) | minted after the `0012` arbitration (next free above `0015`) |
| 0017 | prefix-l1-log-repair | `integration/v0.8.0` (card `t_a54a4606`) | |
| 0018 | reflect-replay-returns-the-recorded-result | `integration/v0.8.0` (card `t_efa8d5a8`) | |
| 0019 | sources-ingestion-and-federation | `feat/deepseek-provider` +14 branches | refiled from `0005` before merge |
| 0020 | host-facing-health-contract | `wt/t_65569b9e` (`t_65569b9e`) +3 branches | refiled from `0008` before merge |
| 0021 | coffee-reference-adapter | `wt/t_9740ae98` (PR #14) +2 branches | refiled from `0010` before merge |
| 0022 | coffee-company-brain-acceptance-gate | `wt/t_9740ae98` (PR #14) +1 branch | refiled from `0011` before merge |
| 0023 | which-schema-covers-the-l0-record-and-the-l2-page-frontmatter | `wip/smarty/canonical-schema-boundary` (`t_0920aa1d`) | refiled from `0013` before merge |

> **The `0012` arbitration (`t_201cdca8`).** Three unmerged lanes minted
> `docs/adr/0012-*.md` independently on 2026-09-15 (11:21–11:33Z). Before any of
> them merged, the board card `t_201cdca8` settled it: the grant-granularity
> decision — the only `Accepted` claim and the one already cited outside its own
> lane (`docs/competitive/mem0-substrate-spec-draft.md` §10b, the Coffee adapter
> contract, `VERIFY.md`, the Coffee release handoff) — kept `0012`;
> `forgotten-version-supersedes` refiled to `0014` and
> `host-registered-lanes-and-the-substrate-actor-id` to `0015`, with every
> reference updated on the claiming branches before merge. Stale copies of the
> old `0012-*` files can sit on branches stacked below the refiles until those
> branches rebase — `verify:adrs` fails their merge tree until they do.
