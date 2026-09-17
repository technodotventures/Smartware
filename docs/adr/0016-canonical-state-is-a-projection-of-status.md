# ADR 0016 — The canonical record's `state` is the writer's projection of `status`, not a caller input

- **Date:** 2026-09-15
- **Status:** Proposed
- **Deciders:** @tech-head (measurement, decision, draft), operator (merge gate — this lane rides ADR-0014's published-contract gate)
- **Supersedes:** —

## Context

A `Claim` carries two lifecycle fields. `status` is the substrate's richer enum
(`active | superseded | contested | retracted | stale`); `state` is the spec-conformant binary
projection of it (`active | forgotten`) defined by `src/layer1/types.ts` → `statusToState`:
`retracted` → `forgotten`, **everything else** → `active`.

`ClaimStore.insertClaim` — the only in-tree writer of the canonical L1 surface that does not
hand-build its record — resolved the line it appends as `claim.state ?? statusToState(claim.status)`.
The explicit `state` won, so `status` was ignored whenever a claim carried one; and `rowToClaim`
**always** returns one (the row's own `state` column, backfilled by `migrateSchema`). Any claim read
out of the store therefore arrives at `insertClaim` carrying a lifecycle value that is stale by
construction, and a caller that changes `status` and re-inserts it writes the *old* lifecycle to both
surfaces at once — the row's `state` column and the canonical line.

Measured on kanban `t_ef77c695` (Node v26.5.1, base `eb83381`; raw output attached to that card as
`red-at-eb83381.log`): `replay.ts` → `handleCorrection` retires a claim for `reason: 'wrong'` /
`'extraction_error'` by
mutating `original.status = 'retracted'` on a claim it read back with `store.getClaim(...)` and
re-inserting it. The claim's chain after `claim_extracted` + `correction {reason: 'wrong'}` is

```
v1 state: active
v2 state: active   supersedes: 1     ← the retraction, written as an active version
```

and the derived row kept `state: 'active'` beside `status: 'retracted'`. Both directions matter:

- **Durability.** `src/layer1/jsonl.ts` states the JSONL **is** the source of truth on disk — it is
  what `syncFromJsonlVersion`, LC-04 catastrophic recovery and export read. A claim the user retracted
  as *wrong* has no retraction on that surface, so recovery re-materialises a claim the user withdrew.
- **Recall, in the run that performed it.** `effective_current.ts` derives the effective-current set
  from `claims.state` (`SELECT id FROM claims WHERE state = 'active'`), so the same stale column kept
  the retracted claim in `getEffectiveCurrentIds` / `isEffectiveCurrent` while it was live.
- **It is the production path.** `handleCorrect` (the REVISE verb) appends exactly these two events and
  dispatches them through the same `handleCorrection`; this is not a replay curiosity.

Three facts decide the direction of the precedence.

1. **`status` is the richer field and the rebuild direction already runs one way.** `claimVersionVals`
   reconstructs `status` from a record's `state` (`active` → `active`/`superseded` via `superseded_by`;
   `forgotten` → `retracted`). A record with `state: 'forgotten'` therefore rebuilds a **retracted**
   row; a pair whose two halves disagree can only describe a row that disagrees with its own canonical
   line — there is no rebuild-equivalent claim for which the explicit `state` contradicts
   `statusToState(status)`. `statusToState` is total and many-to-one, while the rebuild direction
   recovers `status` only with `superseded_by` alongside it — so one direction can be derived from the
   record and the other cannot.
2. **The codebase already wrote the rule one call site early.** `updateClaimStatus` — the ONLY in-tree
   writer that ever set `state` explicitly — does `claim.state = statusToState(status)` immediately
   before `this.insertClaim(claim)`. That is why the tombstone/`FORGET` path (`handleRetraction` →
   `updateClaimStatus`) has always written its forgotten line while the correction path did not.
3. **No caller depends on the contradiction.** Across `src/` and `test/`, every explicit `state` handed
   to `insertClaim` agrees with `statusToState(status)` (`updateClaimStatus`; the legacy
   `status: 'retracted', state: 'forgotten'` fixtures in `legacy-operation-id.test.ts`,
   `claim-record-conformance.test.ts`, `tombstone-backfill.test.ts`); `replay.ts`'s `handleClaimExtracted`
   and every protocol flow pass no `state` at all. The only caller that ever produced the disagreeing
   pair is the defect itself.

## Decision

**`insertClaim` derives `state` from `claim.status` (`statusToState`); a `Claim`'s own `state` is no
longer an input to the writer.** One field carries the caller's intent — the one `statusToState`
projects — and the record and the row are written from that one resolution.

- `src/layer1/store.ts` (`insertClaim`): `const state: ClaimState = statusToState(claim.status);`.
  The resolved value already feeds both surfaces (the `claims.state` column and the active/forgotten
  branch of the appended record); it no longer takes the caller's stale copy.
- **Now permitted:** mutating `status` on a claim read from the store and re-inserting it — the
  correction/tombstone/host-helper shape. It writes the matching row and record.
- **Now forbidden:** writing a forgotten record while leaving `status` something else (and the mirror:
  a caller-supplied `state` no longer overrides, in either direction). A caller that wants a forgotten
  record sets `status: 'retracted'`.
- **Unchanged on purpose:** `claimVersionVals` (the rebuild direction), `schemas/` (no schema, protocol
  or spec text moves — `verify:schemas` reports the same 31 files), `updateClaimStatus`'s now-redundant
  `claim.state = …` line (harmless, and it keeps `claim.state` coherent for in-memory readers), and the
  card's constraint that the retraction is written **once** — pinned by a chain-length assertion, no
  synthetic extra version.

## Consequences

- **A class, not an instance.** Every in-tree caller that flips `status` and re-inserts a `Claim` now
  writes the record that matches: the measured instance (`handleCorrection`, `wrong` /
  `extraction_error`, reached by REVISE), and any future one — a local fix at the one call site would
  have left the trap armed for the next.
- **Both surfaces of both measured directions are closed:** the canonical line is `state: 'forgotten'`
  with `supersedes: version - 1` (ADR-0014's writer rule), the row is `status: 'retracted'`,
  `state: 'forgotten'`, and a rebuild from the JSONL alone keeps the claim out of the recall-eligible
  set. The replacement claim the correction spawned is untouched — still one `active` v1 line and still
  eligible.
- **Existing corrupted pods repair on their next write**, not retroactively: a row holding
  `status: 'retracted'` + `state: 'active'` is written correctly by the next `insertClaim` on it
  (including `updateClaimStatus` and any replay of that claim's events). No repair pass over existing
  pods is part of this change.
- **A contradicting explicit `state` is now ignored rather than written.** That is the only direction
  available without inventing a second source of truth, and the mirror pair is pinned by a test:
  `state: 'forgotten'` + `status: 'active'` writes an **active** record, because a forgotten record
  would rebuild `status: 'retracted'` and the row would stay recall-eligible — the divergence this ADR
  exists to remove, pointed the other way.
- **Reversal trigger.** Supersede this ADR if a claim ever needs a lifecycle in which `state` and
  `status` are genuinely independent — e.g. a forgotten record whose row stays recall-eligible for
  audit, or a third state that `statusToState` cannot express. That is a schema and
  `claimVersionVals` change (the rebuild direction would need a second input), not a precedence tweak.

## Alternatives considered

1. **Local fix in `replay.ts` (the card's option 2): set `original.state = statusToState('retracted')`
   in the two branches, mirroring `updateClaimStatus`.** Measured, not argued — and it retires the
   replacement claim too. `buildCorrectedClaim(original, …)` spreads the claim **after** the mutation
   has set `state`, so the corrected claim inherits `state: 'forgotten'` while its own `status` is
   `'active'`; under the old precedence that writes the *corrected* claim as a forgotten v1 record
   (raw output attached to `t_ef77c695` as the option-2 counter-evidence log). Rescuing the option
   needs a second patch plus an ordering constraint — build the corrected claim before mutating
   `original` — that nothing in the type or the tests enforces, and it still leaves every other
   caller that flips `status` on a `getClaim` result writing the stale lifecycle. Rejected.
2. **Throw (or warn) on a contradiction inside `insertClaim`.** Converts silent loss into a loud
   failure, but `insertClaim` is the replay hot path and the contradiction is exactly what the buggy
   lineage already persisted: a pod that ran the correction path holds `status: 'retracted'` +
   `state: 'active'` rows, so its next write — any `updateClaimStatus`, any replay — would start
   failing, and the failure would be on the recovery path. Rejected.
3. **Make `rowToClaim` project `state` from `status` on read**, so the stale column cannot travel.
   Insufficient: the caller flips `status` *after* the read, so the explicit `state` it carries is
   still stale at `insertClaim` — the precedence is the defect, not the read. It would additionally
   hide the row/record divergence the bug already wrote, instead of repairing it on the next write.
   Rejected.
4. **Keep the precedence and require every mutating caller to set `state` explicitly** (the status quo
   plus documentation). Measured to fail: the caller that matters did not, and the divergence is
   silent in both directions — the row stays recall-eligible and the retraction never reaches the log.
   Rejected.

## Explicitly not decided here

- The two published-pattern residuals on a replayed line (`/claim_id`, `/tombstone_id` — carded
  `t_0b079fbf`) and the demotion-pointer drop on the forgotten path (`t_8098b097`) are untouched;
  they are ADR-0014 → *Explicitly not decided here* items, and the tests assert them as the exact
  known error list so this change cannot quietly absorb them.
- **Observation, no action:** a `duplicate` correction supersedes the target without writing a
  suppressor relation, so `isEffectiveCurrent` returns `true` for that superseded claim. Measured while
  writing these tests; **no reachable effect** — every in-tree caller of `isEffectiveCurrent` filters
  on `status` first (`core.ts` → contested; `layer4/authorized-claims.ts` → superseded), and
  `getEffectiveCurrentIds` has no in-tree caller outside tests. Recorded here rather than carded,
  because nothing is broken; revisit if a caller ever consults the effective-current set without a
  status filter.
