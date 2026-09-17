# ADR 0018 — A matched `operation_id` returns the recorded result: REFLECT replay writes nothing

**Status:** Proposed (drafted and implemented on card `t_efa8d5a8`; the operator's ruling is the binding act — this changes the observable result of a published protocol verb)
**Date:** 2026-09-17
**Deciders:** @tech-head (measurement + decision), the operator (owner gate on the merge)
**Supersedes:** —

> Written in the bare `**Status:**` line-start form on purpose: on this tree `scripts/substrate-status.mjs` reads only
> `^\*\*Status:\*\*`, so the `docs/adr/README.md` template's bulleted `- **Status:**` projects as `(no status line)` and a
> Proposed decision disappears from `docs/STATUS.md`'s pending-decision line (`fix/status-projection-adr-bullet` closes
> that reader gap; once it lands, either form reads).
>
> **Number:** `0018`, the lowest free above `0017`. The registry snapshot lives on `docs/adr-numbering-registry`
> (PR #20, unmerged on this base, so this tree carries no table to add a row to); `0017` is claimed by
> `t_a54a4606` (PR #30). Verified 2026-09-17: no branch ref and no open pull request carries an `0018-*` ADR.

## Context

Protocol v0.5.0, *Idempotency and commit identity*, already states the contract: **"Same OperationId plus
identical canonical payload returns the prior result."** Every other mutating verb implements it that way —
`observe` resolves the recorded result and returns before its write path, `forget` / `forget.scope` / `endorse` /
the retention sweep compare the recorded `payload_hash` before returning, and the connector ingest's own
conformance row reads *"replaying a committed `operation_id` returns the recorded receipt and writes nothing"*.

REFLECT did not. `src/protocol/reflect.ts` matched the recorded `reflect.explicit` entry by `operation_id`,
refused a different `op` / `actor_id` / `payload_hash`, and then **fell through into the whole compile** — it
re-ran claim production, L2 page synthesis, L3 indexing and `reflect.auto` receipts, suppressed only the second
`reflect.explicit` entry, and returned the entry's recorded `claims_created` next to a freshly measured
`pages_compiled`. Measured on this lane (`attachments/t_efa8d5a8/replay-ab.log`, pair A — a brain written by a
build of `658c3cb`, its id replayed by a build of the fix's base `48cdc0b`; the copies are byte-identical,
`diff -r` clean):

```
result:   claims_created 0 (RECORDED)   pages_compiled 4 (FRESH)   layer3_indexed_count 4
          freshness {unverified:0, extracted:4, failed:0}   audit 4 entries
wrote:    claims +4   pages +5 (page bytes differ)   ops_lines +8   reflect.auto receipts +8
entry:    {scope:'personal', claims_created:0, pages_compiled:0}   (unchanged — the only record)
```

One result object described two different runs; a retry wrote claim versions, pages, L3 rows and receipts the
caller did not ask for; and the numbers a caller can act on contradicted what the call had just written. The
same-revision case is worse than it looks: on a brain whose observations are all already processed, re-running
the compile happens to produce the same *counts* (pair B: recorded 4/4, fresh 4/4) while still rewriting every
page's bytes (`page_digest dcbc302a… → 3a3aa2f8…`) — the defect was invisible in the numbers that were being
looked at.

## Decision

**A matched `operation_id` is a pure no-op: REFLECT returns the recorded result of the operation that committed,
and performs no writes at all.**

Specifically:

- The matched `reflect.explicit` entry **is** the prior result. It is appended only after the compile returns,
  so its counts belong to the run that committed and nothing else. On a match the handler returns there:
  no claim production, no L2 synthesis, no L3 sync, no `freshness` read, no `reflect.auto` receipt, no second
  entry, no byte on any canonical surface.
- **Both** counts come from the entry — `claims_created` *and* `pages_compiled`. The result is
  self-consistent: it is one run, neither a mixture nor a repair.
- The result says what it is. `telemetry.replayed: true`; every telemetry count is 0 because this call measured
  nothing; `freshness` is **omitted** rather than filled with a live reading (a current-state read inside a
  recorded result is the defect class this ADR rules out); `audit: []` and no `git_sha`, because neither is in
  the entry — the durable audit trail of the operation is the operations-log entry itself.
  `synthesis_deferred: true` is carried over when the recorded run deferred L2 synthesis, because that is what
  its prior result carried.
- **Fail-closed, not silent:** an entry carrying no numeric `claims_created` / `pages_compiled` is refused with
  `ProtocolError('conflict', "operation_id '<id>' has no replayable REFLECT result")` — never reported as a 0/0
  run. No build in this tree writes such an entry (measured: the writer has emitted both counts since the
  initial commit `d8a2126`), so this is a guard, not a live path. It follows OBSERVE's precedent exactly.
- **What the operations log records does not change.** The entry that committed the operation is its record and
  is written once, on the compile path, after the compile returns — the two writers and their `details` shape are
  untouched. A replay appends nothing. `details.scope` and `payload_hash` inputs are unchanged by this ADR.
- **The gates still run first.** Actor/scope authorization and the payload conflict check precede the replay
  return, so a replay is not a way around a grant and a different payload on the same id is still `conflict` (one
  of the two pins that pass on both arms of the A/B).

### Why this is the reading, not a new contract

The published contract already says "returns the prior result"; the implementation was the only thing that
disagreed. Choosing the other arm — re-run and report fresh counts — would leave the entry recording the first
run's counts forever, so the log and the returned result would describe different runs *permanently*, and the
same idempotency key would return different answers as the brain changed. The decision also matches what the
caller is doing: an `operation_id` is a retry handle, and a retry that commits work it did not ask for is not a
retry.

## Consequences

**1. Pre-existing ids from a pre-fix brain (the case the operator is weighing on `t_27c73d58`).** Exact
statement: *a pre-existing `operation_id` from a pre-fix brain replays to its recorded result and writes
nothing — it is replay-safe, and it does not repair the brain.* Concretely, the measured upgrade case replays to
`claims_created: 0, pages_compiled: 0` (its recorded result) with the brain untouched; the observations the
pre-fix run left unprocessed stay unprocessed. **Fresh behaviour needs a fresh `operation_id`.** Paired with the
unscoped-REFLECT decision (`t_27c73d58`) this is coherent: that lane's journal already states the replay contract
hoped for here, and `payload_hash` is byte-identical pre/post fix for the same params, so an old id keeps
replaying rather than colliding. This ADR is what makes that sentence true — it was not true at `48cdc0b`.

**2. Durability coexists — the two mechanisms key on different identities.** The durable compile queue's crash
recovery is keyed on the queue row's `observation_id` (`running` → `pending` on the next open, then re-processed)
and is made idempotent by the fingerprint index plus the per-observation `reflect.auto` receipts; the worker
never replays a `reflect.explicit` id (it calls `produceObservationClaims`, not the handler). REFLECT's own crash
story is the ordering above: the entry is written **after** the compile returns, so an interrupted run has no
entry to match and its retry compiles legitimately — its already-processed observations are skipped by their own
receipts. There is therefore no case where the no-op replay suppresses required work: it fires only when the
operation committed, which is exactly when there is nothing left to do at that granularity. A host that wants a
re-derivation asks for one (a fresh id, or `drainCompileQueue`), not for a retry.

**3. The deferred L2 stage becomes an explicit, separate operation.** Measured (pair C): with `defer_synthesis`
absent, a same-id call used to complete the L2 stage silently (fresh `pages_compiled`, page bytes rewritten,
mixed result); it is now a replay — `pages_compiled: 0`, `synthesis_deferred: true`, nothing written — and the
completion runs under its own `operation_id` (measured on the same brain: `pages_compiled: 4`, pages on disk).
`defer_synthesis` is deliberately not part of the `payload_hash` (settled inputs, not reopened here), so the two
calls are the same operation as far as idempotency is concerned: a stage with its own effects gets its own id.
This is the one host-visible behaviour change, and it is the reason for the owner gate.

**4. Cost.** A replay can no longer be used as a cheap "recompile this id". That was never a documented
capability, and it was the mechanism by which a retry could silently extend provenance and re-index.

**Reversal trigger.** If a host genuinely needs "same id, re-derive", add an explicit verb or flag (or drive the
compile queue) rather than restoring the fall-through. Re-opening this decision means superseding this ADR, not
widening it.

## Alternatives considered

1. **Re-run the compile and report fresh counts everywhere** (drop the recorded fallbacks). Lost: it contradicts
   the published contract, the entry would keep recording the first run's counts while the result reported the
   latest one, and the same id would answer differently as the brain changed — idempotency in name only.
2. **Keep the fall-through, fix only the mixture** (report the recorded counts for both fields). Lost: the writes
   remain, so a retry still appends receipts, pages and L3 rows; the entry's own counts become a fiction about
   the brain's state and the second run is unreported.
3. **Return the recorded result but keep the writes** (no-op *report*, retained effects). Lost: silent writes
   behind an idempotent-looking result — the same defect, hidden one layer deeper.
4. **Refuse a replay outright with `conflict`.** Lost: contradicts the contract, breaks the ordinary
   retry-after-timeout case (the caller then has to discover that its work landed), and pushes per-host dedup into
   every integrator. It also contradicts how the four other mutating verbs behave.
