# AGENTS.md — how to operate in this repository

> **Read this first, then follow the index.** This file is deliberately short: it
> routes you to canonical state instead of copying it. Anything here that
> duplicates another source is a bug — cite the source instead.

## What this repository is

**Smartware** — an open memory protocol (`docs/spec/`, `docs/protocol/`) plus a
local-first TypeScript reference implementation (`src/`). Beta software.

- Package: `smartware` (`package.json`), Node >= 22
- Product context: `docs/competitive/company-brain-plan.md`
- Licence: Apache-2.0 · Owner: Techno Ventures

## Where the truth lives

Read in this order. Do not trust a summary you did not derive from these.

| Question | Canonical source | Notes |
|---|---|---|
| What is the current operational state? | [`docs/STATUS.md`](docs/STATUS.md) | **Generated.** Never hand-edit; regenerate with `npm run status` |
| What must the implementation do? | `docs/spec/smartware-spec-*.md` | Normative |
| What is the wire contract? | `docs/protocol/smartware-protocol-*.md` + `schemas/` | Normative |
| Why is it built this way? | [`docs/adr/`](docs/adr/) | Decision records. Supersede; never delete |
| What work happened, and why? | [`docs/journal/`](docs/journal/) | One entry per recorded state transition |
| What is queued / blocked / in flight? | kanban board `smartware` | Operational record, lives **outside** this repo |
| How do I know a change is acceptable? | [`VERIFY.md`](VERIFY.md) | Acceptance criteria + exact commands |
| What changed recently? | `git log` on the branch, then `docs/journal/` | |
| How do I operate here at all? | this file | |

## Rules of the road

1. **The repository is the record; chat is not.** If a decision exists only in a
   conversation, it does not exist. Write it down in the same session.
2. **Never hand-edit a generated file** — `docs/STATUS.md`, `docs/journal/INDEX.md`.
   Regenerate them. A projection that disagrees with its substrate is wrong.
3. **Every consequential decision gets an ADR** in `docs/adr/`, numbered, with
   `**Date:**` and `**Status:**`. Superseded ADRs stay in place and change status.
4. **A session ends with a state delta, not just a commit.** Intent → evidence →
   resulting state → unresolved. `docs/journal/TEMPLATE.md` has the shape.
5. **Generation and acceptance are separate steps.** Your own report is not
   verification. Run the gate in `VERIFY.md` and cite the actual output.
6. **No secrets in this repository.** Ever. Not in docs, not in fixtures,
   not in examples.
7. **Normative text is not editable as a side effect.** A code change that
   requires a spec or protocol change says so explicitly and updates both.
8. **One writer per working tree.** If another agent is mid-task here, use a
   worktree (`.worktrees/`, gitignored) rather than editing the shared checkout.

## Authority — what you may do without asking

| Role | May read | May modify | Must not |
|---|---|---|---|
| **Builder** | everything | `src/`, `test/`, `scripts/`, `docs/` (except ADR status) | change acceptance criteria or normative spec/protocol text unilaterally |
| **Researcher** | everything | `docs/competitive/`, `docs/journal/` | `src/` |
| **Reviewer** | everything | nothing — comments and findings only | any mutation |
| **Verifier** | everything | nothing | any mutation; its output is *evidence* attached to a transition |
| **Operator (Stevie)** | everything | everything | — |

**Escalate before:** changing a released protocol surface, changing acceptance
criteria, handling keys/secrets, deleting or rewriting history, or making an
ADR's stated consequence untrue.

**Definition of done:** [`VERIFY.md`](VERIFY.md). Not "the work is written".

## Model and interface adapters are thin on purpose

Tool-specific instruction files (`CLAUDE.md`, `.cursor/`, etc.) point here — they
do not restate policy. Canonical rules live in this file, `VERIFY.md`, `docs/adr/`
and the kanban board so that a different model, or a different agent, picks up the
same contract with no briefing.

## Substrate provenance

This contract implements the **project-substrate** pattern (Control Room ADR
0003): canonical state is primary, every view over it is a regenerable
projection, and a fresh agent should be able to enter this repository with
minimal prior context. When this file and a real behaviour disagree, the
behaviour is the bug and this file is wrong — fix whichever is genuinely wrong.
