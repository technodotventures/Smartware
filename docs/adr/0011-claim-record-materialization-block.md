# ADR-0011 — `claim.schema.json` describes the L1 record, so the extraction materialization block is enumerated in it

**Status:** Proposed — owner approval is the gate before merge (an additive, optional property; the
required set is unchanged; `schemas/v0.5.0` bytes move and `SHA256SUMS` is regenerated)
**Date:** 2026-09-15
**Deciders:** @tech-head (decision prepared and implemented on kanban `t_229601e4`). Owner sign-off is
the merge gate — the repo publishes this schema set to integrators, so the owner decides whether an
implementation-carried block becomes part of the published record surface.
**Supersedes:** none
**Numbering note:** `0004`–`0010` are held by other in-flight branches (contradiction/bi-temporal,
sources, export-restore, fencing, health, legal-hold, adapter, storage-fencing) and two of them are
already double-allocated; `0011` was taken to avoid adding a third collision. Branch:
`wip/tech-head/claim-record-semantic` (forked from `wip/smarty/l1-legacy-op-id` @ `0a68482`).

## Context

`schemas/v0.5.0/claim.schema.json` says of itself *"One L1 claim version."* The reference
implementation appends exactly that — one claim version per line of the canonical L1 JSONL — and since
v0.6 an active version carries a `semantic` materialization block
(`src/layer1/jsonl.ts` → `ClaimSemanticMaterialization`, written by `insertClaim` at
`src/layer1/store.ts:546` and by `reflect.auto` at `src/protocol/reflect.ts:115`). The schema has
`additionalProperties: false` at its root and did not enumerate the block, so **the record the library
writes was rejected by the contract the library publishes**:

```
{ "record_operation_id": "op_000000000000000000000000A3",
  "valid": false,
  "errors": [ { "instancePath": "", "keyword": "additionalProperties",
                "params": { "additionalProperty": "semantic" } } ] }
```

Measured twice: by the previous card's probe (`t_85817375`, which fixed the `operation_id` half of the
same measurement and deliberately did not touch this one) and independently for this decision by
`probe/l1-record-semantic.probe.test.ts`, which reads the raw JSONL line off disk (no library reader in
the path) and validates it with Ajv against the published schema. Raw before/after output:
`probe/pre-change.out` and `probe/post-change.out`, attached to kanban `t_229601e4`.

The question the card asked: does the published schema describe the **L1 record**, or the **spec §6
claim version** (with the L1 line being a documented superset)? Both readings had evidence.

**For the spec-version reading.** Spec v1.6.16 §6 prints the claim version record and its field table
**without** `semantic`, and calls the library's richer representations an implementation note: *"the
library carries richer internal representations — a numeric confidence reduced to a bucket via
`confidenceToBucket`, and a finer epistemic label reduced to the tag via `epistemicToTag` — but the
canonical, spec-level values are the bucketed confidence and the five-value `epistemic_tag`."* Both
scalars named there are fields *inside* the block (`extracted_confidence`, `extracted_epistemic`), so
the spec text can be read as saying the block is an internal representation of values the canonical
record already carries in reduced form.

**For the L1-record reading, and decisively:**

1. §6 opens by defining its subject as the record: *"L1 is a canonical, append-only JSONL store. Each
   line is a claim version."* The schema's field set is that field set plus the record-envelope fields
   the implementation carries — the forget-specific fields (`forgotten_at`, `forgotten_by`) and the
   demotion/release warrants (`superseded_by`, `superseded_at`, `superseded_by_origin`,
   `reinstated_by`), none of which appear in §6's table either. The schema has already been widened
   past the table once, for exactly this reason (`cd7ca98`, REVISE `repick_survivor`).
2. The repository's precedent resolves this class of gap on the **schema** side, keeping
   `additionalProperties: false`: `t_2bba749f` enumerated the claim record envelope in the tombstone
   snapshot block so that a snapshot of a demoted duplicate still validates, and pinned it with a test
   that asserts the two blocks do not drift apart. Nothing in the repo treats an implementation-carried
   field as acceptable schema drift.
3. The contract states the invariant this violates. `schemas/v0.5.0/README.md` and
   `docs/protocol/smartware-protocol-v0.5.0.md`: *"The v0.5.0 contract and the v0.5.0 schema set ship
   together … if they disagree, conformance is blocked until corrected"*, and §17 makes conformance a
   suite *over canonical surfaces* — the L1 line is one. A published contract that rejects the record
   its own reference writer appends is a contract defect, not a record defect.
4. The block is not decoration. It is what makes a record re-materializable: the recall-eligible row
   (`subject_name`, entity type, `predicate`, typed `object`, valid time, sensitivity, extraction
   provenance) is derived from it (`ClaimStore.claimVersionVals`), and the JSONL carries no other
   structured assertion. `test/semantic-materialization.test.ts` proves the consequence end to end: a
   brain closed and re-opened reconstructs *Graphiti API / status_is / enum "deployed" / entity type
   tool* from the log alone. Dropping the block would lose that.

## Decision

**`claim.schema.json` describes the L1 claim version record — one line of the canonical L1 JSONL, as
appended by the reference implementation — so the record envelope is enumerated in it, including the
optional extraction materialization block `semantic`.**

Boundaries, precisely:

- **Optional, never required.** The block is not in the schema's `required` set. Records written before
  v0.6 (and any host writing the spec §6 field set) omit it and remain fully conformant. This is the
  answer to the card's sub-question — *does a public contract want to publish an internal
  materialization block?* It publishes the **shape**, not an obligation: nothing about a v0.5.0
  conformance claim depends on the block, and no conformance test may require it.
- **Closed.** `additionalProperties: false` inside the block and inside its nested `object` /
  `extraction` / valid-time shapes, matching the envelope's style. An unenumerated subfield is
  rejected rather than silently carried.
- **Required-when-present.** Every subfield is required once the block is present — it is one
  materialization, or none.
- **Not a wire field.** No protocol request or response carries it; `field` descriptions say so. The
  block is record-surface, not API-surface.
- **Bound types are the writers' declared input types, not policy.** Two deliberate soft spots, each
  because a tighter bound would re-create the very defect this decision closes, i.e. a published schema
  rejecting a record the writer produced:
  - `extracted_confidence` is `number` with **no** `minimum`/`maximum`. The declared domain is 0..1 and
    the `reflect.auto` path clamps to it, but `insertClaim` copies the caller's number verbatim —
    measured: a caller-supplied `1.5` lands on the record unchanged (`probe/post-change.out`,
    `confidence-1.5`, 0 errors).
  - valid-time `value` accepts a date-time **or** a pass-through string. The deterministic path uses the
    observation's `observed_at` (ISO), while the LLM path copies the model's `validity.from` / `.to`
    (`src/extraction/llm.ts:289`), which can be a date without a time. Not measured (no LLM provider on
    the beta test path); the shape is permissive because the declared type is a plain string.
- **Unchanged:** the required set, every existing property, and every other schema in the set. This is
  a `claim.schema.json` accuracy fix, in the framing `t_2bba749f` used — *schema/contract accuracy, not
  a protocol change*.

**Explicitly not decided here.** The L2 tombstone snapshot block still does **not** enumerate the block,
so a catastrophic reconstruction from a backfilled tombstone still recovers the content form and not
the structured assertion (`t_9e124fe6`, recorded in `docs/conformance-status.md` → *Remaining limits*).
That asymmetry is deliberate and stays: the snapshot's own promise is "every field the claim schema
**requires**", the block is optional, and the writer-side change that would carry it (recomputing a
structured snapshot from a legacy row) is a separate card with its own evidence. If that card lands,
the mirror test gains `semantic` in the same change.

## Consequences

- **The measured divergence is closed.** At this branch's tip the same probe reports `valid=true`,
  `errors=[]` for an active record the writer appends, including the out-of-domain-confidence case;
  the pinned test in `test/layer1/legacy-operation-id.test.ts` now asserts the **whole** error list is
  empty (it previously asserted the single `:additionalProperties` error, so a new divergence could
  have hidden behind the known one).
- **Both writers of the block are guarded.** `test/schemas-v0.5.0.test.ts` gains positive/negative
  fixtures for the block; `test/semantic-materialization.test.ts` validates the records `reflect.auto`
  actually appends. A future change to `ClaimSemanticMaterialization` that stops conforming fails the
  suite instead of shipping.
- **The block's shape is now evidence-grade public surface.** Changing it is a schema change
  (`SHA256SUMS`, fixtures, this ADR), not a TypeScript type edit. That is the intended cost, and the
  reason the owner gates the merge.
- **Known divergences this decision does NOT cover** — both measured during this work, both outside
  this card's scope, both carded rather than silently absorbed. As a result, *"every record the
  reference implementation writes validates against the contract it publishes"* is now true for the
  active-record envelope this card measured, and still **false** for these two:
  1. `ClaimStore.insertClaim` on the forgotten path writes a record with no `supersedes`, which the
     schema's forgotten branch requires — measured `:required: must have required property
     'supersedes'` plus `:if`, on a `insertClaim({ status: 'retracted' })` record. Reachable from
     `src/layer1/replay.ts:305–323` (the legacy observation-replay path, reasons `wrong` /
     `extraction_error`). The real FORGET/retention/consolidation writers build their forgotten record
     by hand with `supersedes: latest.version` and validate. Carded as **`t_3ba3ee39`**
     (@smarty-pants).
  2. `reflect.auto` writes `scope: "pod/<pod>/<lane>"` and `actor_id: "substrate:<ULID>"` (uppercase,
     so the Crockford-style slug fails) — measured `/scope:pattern` and `/actor_id:pattern` on both
     records the probe harvested. The pod-profile scope surface and the v0.5.0 `Scope` pattern do not
     agree. Carded as **`t_9a700aed`** (@neo).
- **Reversal trigger.** Supersede this ADR if a later spec revision declares the L1 line an
  implementation-private superset of the §6 version (the reading this ADR rejected), or if the pod
  profile's scope surface is deliberately moved outside v0.5.0 conformance (divergence 2 above). If a
  runtime range guard ever lands on `insertClaim`'s epistemic inputs, tighten the block's
  `extracted_confidence` to the declared `0..1` domain in the same change.

## Alternatives considered

1. **The schema describes the spec §6 claim version; the L1 line is a documented superset** (card
   option 2). Rejected: it makes the disagreement permanent and normative. The README's own rule —
   *mismatch blocks conformance until corrected* — would then be permanently blocked for every server
   running the reference implementation, and integrators reading "One L1 claim version" would be told
   that the object they see on disk is not the object the schema describes. It also contradicts the two
   precedents (`cd7ca98`, `t_2bba749f`) that closed the same class of gap by enumerating the field.
2. **The writer stops emitting the block where it is re-derivable** (card option 3). Rejected: it is
   not re-derivable. The structured assertion (subject, predicate, typed object, valid time,
   sensitivity, extraction provenance) exists on the record *only* in this block, and every
   materialisation of the derived row reads it; `test/semantic-materialization.test.ts` fails a
   close-and-reopen replay without it. This is not an available option without also abandoning
   structured-claim replay, which no card has asked for.
3. **Move the block to an implementation-private sidecar** the schema does not see. Rejected: it splits
   one logical write across two artifacts (breaking the single-commit-timestamp append discipline the
   protocol relies on for recovery), and LC-04 catastrophic recovery reads the record, not a sidecar.
4. **Add the block to `common.schema.json` `$defs` and `$ref` it.** Deferred, not rejected: the
   tombstone snapshot block, the schema's only sibling of comparable shape, is written inline, and
   adding shared defs would touch a second published file and its checksum for no conformance gain.
   If a third consumer of the shape appears, promote it.
