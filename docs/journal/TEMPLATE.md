---
task: <kanban-task-id or "none">
board: <board slug or "none">
status: done
completed: YYYY-MM-DDTHH:MM:SSZ
created: YYYY-MM-DDTHH:MM:SSZ
assignee: "<agent or human>"
artifacts: []
---

# <one-line title: what changed>

## Intent

The bounded objective, stated so a fresh agent understands why this happened.
Include what was explicitly **out of scope**.

## What was done

The change itself, with file/commit pointers. Not a restatement of the code —
the shape of it and the non-obvious parts.

## Evidence

Commands actually run in this session and their real output:

```
Gate:   <command>            → <result>
Run:    <date>, <machine>, <runtime version>, <n>
Notes:  <what the numbers mean; what did NOT pass; what remains unproven>
```

If a gate was not run, say so. An unstated unrun gate is how a project
accumulates fiction.

## Resulting state

What is now true that was not true before. If this changes anything
`docs/STATUS.md` derives from, run `npm run status` in the same session.

## Unresolved

- open questions, newly discovered constraints, known-broken paths
- approaches that failed and should not be retried as-is
- the next bounded action, if it is known
