# ADR 0014 — The L1 record writer names the version it replaces; the forgotten branch stops requiring it

- **Date:** 2026-09-15
- **Status:** Proposed
- **Deciders:** @smarty-pants (measurement + draft), operator (merge gate — a published schema moves)
- **Supersedes:** —
- **Numbering:** 0014 — drafted as `0012` branch-locally; refiled before merge under the board
  arbitration `t_201cdca8` (`0012` is the grant-granularity decision, `wt/t_f2b584dc`). Every lane
  reference moved in the same commit; ADRs are never renumbered once merged.

## Context

`schemas/v0.5.0/claim.schema.json` is the contract for one canonical L1 line (ADR-0011: it describes the
record the reference implementation appends, not an abstract §6 object). Two rules in it touch
`supersedes`:

- the `supersedes` property description says **"Required for version > 1"**, and the third `allOf`
  branch enforces exactly that (`if version >= 2 then required supersedes`); and
- the *forgotten* branch (`if state == 'forgotten'`) required `supersedes` unconditionally, alongside
  the forget-specific fields.

Measured on card t_3ba3ee39 (Node v26.5.1, `wip/smarty/l1-forgotten-supersedes` off
`wip/tech-head/claim-record-semantic` @ 981e5a7; the probe and its raw output are attached to that card
as `probe/t_3ba3ee39.probe.test.ts`, `probe/pre-change.out` and `probe/post-change.out`),
`ClaimStore.insertClaim` — the only in-tree writer of the canonical surface that does not hand-build its
record — appended records that fail the contract in three shapes:

| shape the writer can append | pre-change verdict | cause |
|---|---|---|
| v1 active | valid | — (control) |
| v2 active (`insertClaim` again on a claim that already has a line — what a second `replayAll` pass does) | **invalid** `:required supersedes` | writer dropped the field it had just computed |
| v2 active demoted (`status: 'superseded'`) | **invalid** `:required supersedes` | same |
| v1 forgotten (a claim *born* forgotten: legacy/migration rows, `tombstone-backfill.ts`, the pinned shape in `test/layer1/legacy-operation-id.test.ts`) | **invalid** `:required supersedes` | the schema required a prior version that does not exist |
| v2 forgotten (`store.updateClaimStatus(id, 'retracted')` — the path `replay.ts`'s `handleRetraction` drives) | **invalid**, twice — both branches fire | writer, and the branch requirement is redundant there |

Two facts decide which side is wrong for each half.

1. **The number is known and the field is not optional for version > 1.** `insertClaim` derives
   `version` from `nextVersionFor(claim.id)` = `latest.version + 1`, so `version - 1` *is* the prior
   version. Every other writer of the canonical surface already sets it (`FORGET`, retention,
   consolidation, `FORGET.SCOPE` and `REVISE` hand-build `supersedes: latest.version`; `reflect.auto`
   from `existingByFp.version`), and the schema's own property description states the rule. Measured
   control: the record `handleForget` appends validates whole.
2. **A version-1 forgotten record has nothing to name.** A claim can be born forgotten: pre-A3 rows are
   `status: 'retracted'` with no canonical line of their own, and the legacy/migration shape is what the
   pinned test drives and what `tombstone-backfill.ts` (the only in-tree writer of
   `wiki/tombstones/*.md`) exists to convert. `supersedes: 0` — the only value `version - 1` can produce
   there — violates the property's `minimum: 1`, so the writer has **no valid value to write** on that
   path. Requiring it made that record unrepresentable, and LC-04 recovery of it unvalidatable: the
   backfilled tombstone's snapshot is a synthesised *active* v1, and reconstructing the lost line from
   it (snapshot + `tombstone_id`/`forgotten_at`/`forgotten_by`, per the tombstone schema's own
   description) yields a v1 forgotten record — measured `valid=false` pre-change, `valid=true`
   post-change.

Nothing reads the version-chain `supersedes`: the field appears in `src/` only as writers and type
declarations (`ClaimVersionRecord.supersedes?: number` — optional in the type). It is audit metadata
for lineage, not a lifecycle input, so relaxing the branch cannot change retrieval, recall or replay
behaviour.

## Decision

**The writer sets `supersedes: version - 1` on every version > 1 it appends, and the schema's forgotten
branch stops requiring the field — the version rule keeps it required, in every state.**

- `src/layer1/store.ts` (`insertClaim`): `...(version > 1 ? { supersedes: version - 1 } : {})` in the
  record envelope, so it applies to active *and* forgotten versions.
- `schemas/v0.5.0/claim.schema.json`: the forgotten branch's `required` is now
  `[tombstone_id, forgotten_at, forgotten_by]`. `supersedes` stays an enumerated property, stays
  optional-when-present on v1, and stays **required** for every version > 1 through the third branch,
  which was already there and is untouched. The property description and the root description now say
  this in one place.
- The born-forgotten shape stays a **single** line. Writing a synthetic active v1 first (so the
  forgotten version is always ≥ 2) was rejected: it would put assertion content on the canonical
  surface for a claim that never had an active version, and it changes what the tombstone backfill
  reads. Pinned by a test that asserts the shape writes one line.
- `SHA256SUMS` regenerated (`claim.schema.json` `44e16a38…` → `fa3cbec2…`); fixtures in
  `test/schemas-v0.5.0.test.ts` and writer-level tests in
  `test/layer1/claim-record-conformance.test.ts`.

## Consequences

- **Closed.** The record `insertClaim` appends validates whole, in every state it can write (v1/v2
  active, v2 demoted, v1/v2 forgotten), and the probe's complete error list is empty for all of them.
  The same change closes three shapes the card did not name (v2 active and v2 demoted were failing
  identically — the card only measured the forgotten half).
- **LC-04 stays honest.** Reconstructing a lost forgotten line from a backfilled tombstone now validates
  under both readings (same-version snapshot copy; version+1 with `supersedes = snapshot.version`).
- **Public contract moves.** This is a published-schema change: `SHA256SUMS`, the schema README, the
  fixture suite and this ADR move together, and the merge needs the operator's approval — same gate
  ADR-0011 carries. Existing conformant records are unaffected (the change only removes a requirement).
- **Reversal trigger.** Supersede this ADR if the canonical surface is ever defined to *never* contain a
  claim whose only version is forgotten (i.e. a legacy row must be written as an active line first, and
  the migration re-shaped) — then the forgotten branch's requirement becomes correct and the writer
  gains the synthetic-active-line rule.

## Alternatives considered

1. **Writer-only (card option 1, literally): set `supersedes: version - 1` everywhere.** Rejected: for a
   born-forgotten record it produces `supersedes: 0`, which the published `minimum: 1` rejects — measured
   in the probe. It fixes the v≥2 shapes and cannot fix the v1 shape.
2. **Schema-only: relax the forgotten branch and leave the writer alone.** Rejected: every version ≥ 2
   record `insertClaim` appends still fails the untouched version branch — measured. Neither side alone
   closes the class.
3. **Write a synthetic active v1 line before a born-forgotten line.** Rejected above (invents history,
   resurrects content onto L1, changes the backfill's input).
4. **Declare the L1 line an implementation-private superset of the schema and stop validating it.**
   Rejected in ADR-0011 and again here: it makes the disagreement permanent, and five of the six writers
   already satisfy the contract — the outlier is a bug, not a licence.

## Explicitly not decided here (measured, carded)

1. **`replay.ts`'s correction path writes the wrong `state`.** `reason: 'wrong'` / `'extraction_error'`
   set `original.status = 'retracted'` on a claim read back with `store.getClaim(...)`, but
   `insertClaim` resolves `state` as `claim.state ?? statusToState(claim.status)` and `getClaim` returns
   the row's `state` (`'active'`) — so the appended line is `state: 'active'`: the retraction never
   reaches the canonical surface, and recovery that rebuilds from the JSONL re-materialises a claim the
   user retracted as wrong. Measured in `probe/post-change.out` (`replay-correction`), carded as
   **`t_ef77c695`**. It is a durability/correction-propagation defect, not a conformance one, and the
   precedence rule (`state` vs `status`) needs its own decision.
2. **`replay.ts` mints ids its own published patterns reject.** `deterministicClaimId` produces
   `claim_<lowercase sha256 hex>` against `^claim_[0-9A-HJKMNP-TV-Z]{26}$`, and `insertClaim`'s
   forgotten path derives `tomb_<same lowercase hex>` against `^tomb_[0-9A-HJKMNP-TV-Z]{26}$` — every
   replayed line carries both errors. Same class as `t_9a700aed` (pod-profile scopes/actors), carded as
   **`t_0b079fbf`**. Renumbering ids is a data-addressing change, not a schema fix.
3. **`insertClaim` drops a caller-supplied demotion pointer on the forgotten path**
   (`claim.status === 'superseded'` gates the carry, so a caller passing `status: 'retracted'` +
   `superseded_by` loses the pointer on the record while `tombstone-backfill.ts` keeps it in the
   snapshot) — measured `carries_superseded_by=false` in `probe/post-change.out`, carded as
   **`t_8098b097`**. No recall effect (`state: 'forgotten'` is excluded); audit-metadata loss on the
   canonical line.
4. **`schemas/v0.4.2/claim.schema.json` carries the same forgotten branch.** Not touched: v0.4.2 is a
   frozen published set for five-verb conformance claims, and the record writer emits the v0.5.0
   envelope. A record written by this library is not expected to validate against the v0.4.2 set
   (ADR-0011 → the record is the v0.5.0 contract).
