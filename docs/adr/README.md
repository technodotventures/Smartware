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

- **Date:** YYYY-MM-DD
- **Status:** Proposed | Accepted | Superseded by NNNN | Rejected
- **Deciders:** <who>
- **Supersedes:** <NNNN or —>

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
