# Journal — recorded state transitions

This directory is the repository's **memory of work**. One entry per recorded
state transition: what was attempted, what evidence was produced, what state
resulted, and what remains unresolved.

## What belongs here

A journal entry records a **state delta**, not an activity log:

- intent (the bounded objective)
- evidence (commands run, their real output, artifacts, measurements)
- resulting state (what is now true that was not before)
- unresolved implications, newly discovered constraints, failed approaches

A polished summary that hides the weaker evidence beneath it is worse than no
entry. Record the imperfect result too — a failed approach that is written down
stops the next agent from repeating it.

## What does not belong here

- secrets, credentials, tokens, or customer data
- restatements of code (the code is the code — link it)
- status summaries (those are `docs/STATUS.md`, generated)
- decisions (those are `docs/adr/`; a journal entry *links* to the ADR)

## Entries

- `docs/journal/YYYY-MM-DD-<task-id>.md` — generated from the kanban board by
  `npm run journal:sync` (`scripts/substrate-journal-sync.mjs`). Completed
  tasks land here automatically; you do not hand-write them.
- `docs/journal/YYYY-MM-DD-<slug>.md` — hand-written entry for work that had no
  kanban task (investigation, spike, incident). Use `TEMPLATE.md`.
- [`INDEX.md`](INDEX.md) — generated index. Do not hand-edit.

## Rules

1. **Append-only.** Never edit or delete a past entry. Supersede it: write a new
   entry that says what changed and why, and link back.
2. **Generated entries are projections.** The canonical record is the kanban
   task's `task_events` row. Regenerate, don't patch.
3. **Cite, don't summarize from memory.** Numbers in an entry must come from a
   command that was actually run in that session.
