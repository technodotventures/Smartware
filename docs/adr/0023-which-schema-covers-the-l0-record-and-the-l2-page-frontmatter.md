# ADR 0023 — `observation.schema.json` covers the wire observation, not the L0 record; the compiled L2 page frontmatter must conform to `page-frontmatter.schema.json`

**Status:** Proposed — the two fixes this record decides are owner-gated (one publishes a record surface, the other changes an L2 artifact a core verb reads). The boundary statement in `schemas/v0.5.0/README.md` and the boundary-pinning tests shipped with this ADR move **no** published schema byte.
**Date:** 2026-09-15
**Deciders:** @smarty-pants (measurement and decision prepared on kanban `t_0920aa1d`); owner sign-off is the gate for the carded fixes.
**Supersedes:** —
**Numbering note:** `0008`–`0012` are held by other in-flight branches and several of them are double-allocated. `0013` is free on this base (`wip/neo/host-lane-identity` @ `9fcfff7` holds `0001`, `0002`, `0003`, `0011`, `0015` — this lane's own earlier record was refiled `0012` → `0015` there), but it is **also minted by `wip/tech-head/retention-sweep-audit`** (`0013-retention-sweep-commit-identity.md`, kanban `t_543cb61a`, committed 2026-09-15T12:09Z, unpushed), so `0013` is double-allocated across two unmerged lanes. The contention is carded as `t_73ea9510` and the allocation rule/registry is in flight as PR #20; the number is not changed here. *(Corrected 2026-09-16 during the rebase onto `9fcfff7`, kanban `t_74faf12d`, after an every-ref scan — see `docs/journal/2026-09-16-t_74faf12d.md`; the decision this record carries is untouched.)*

## Context

Kanban `t_9a700aed` measured the pod-profile scope/ActorId divergence and, in the same probe, validated the
rest of that flow's canonical artifacts against the published v0.5.0 schema set. Two of them failed:

1. the **L0 evidence line** (`<dataDir>/evidence/<date>.jsonl`) against `observation.schema.json`;
2. the **compiled wiki page frontmatter** (`wiki/<category>/<slug>.md`) against
   `page-frontmatter.schema.json`.

Both failed on the **protocol-native control flow too** (`scope: self|workspace`), so neither is the
host-lane divergence ADR-0015 settled, and neither is fixed by it. The card asked the question this
record answers: do these schemas describe the artifacts the writers emit (fix the writer, widen the
schema, or disclose — ADR-0011 precedent), or a *different* artifact (write the boundary down and pin it)?

## Measurement

Re-derived independently for this decision on 2026-09-15, Node v26.5.1, branch base `9114fb7`
(`wip/neo/host-lane-identity`), via `core.observe` → `core.reflect` → `core.compile` → `core.exportScope`
over protocol-native lanes, reading the raw bytes off disk and validating with Ajv 2020 (allErrors).
Raw output: `workspaces/t_0920aa1d/probe/shape-before.out`; instrument:
`workspaces/t_0920aa1d/probe/canonical-surface-shape.probe.test.ts`.

| artifact | vs schema | result |
|---|---|---|
| L0 line as written | `observation.schema.json` | **rejected** — 14 errors: `required` ×4 (`observation_id`, `metadata`, `operation_id`, `actor_id`), `additionalProperties` ×9, `/source:type` |
| L0 line, projected to the contract's OBSERVE payload + stamped identity | `observation.schema.json` | **valid**, `errors=[]` |
| compiled page frontmatter as written | `page-frontmatter.schema.json` | **rejected** — 19 errors: `required` ×2 (`created`, `epistemic_tag`), `additionalProperties` ×12, `/category:enum`, `/sources/0:pattern`, `/updated:format`, `/confidence:type`+`/confidence:enum` |
| compiled page frontmatter, projected to the spec §9 field set | `page-frontmatter.schema.json` | **valid**, `errors=[]` |
| `exports/<exp>/observations.jsonl` + `evidence.jsonl` | `observation.schema.json` | **rejected** — byte-identical shape to the L0 line, in a package whose `manifest.json` declares `"protocol": "v0.5.0", "schemas": "v0.5.0"` |

Two of those rows are decisive and were not previously measured:

- **Both artifacts are pure renaming/derivation projections.** No information is added to make either
  projection validate: `id`→`observation_id`, `source.app`→`source`, `source.observed_at`+`source.actor.id`
  →`metadata`; and `category` un-pluralised, `created` derived, `updated` truncated to a date,
  `confidence` bucketed through the library's own `confidenceToBucket`, `epistemic_tag` through
  `epistemicToTag`, `sources`←`sources_claim_ids`. The schemas are therefore not describing an unrelated
  object; they are views of the same information under a different vocabulary.
- **The record shape the schema rejects is a shipped, integrator-facing artifact.** `EXPORT.SCOPE`
  packages carry it in `observations.jsonl` / `evidence.jsonl` and label the package `schemas: v0.5.0`.

Reference graph (whole tree, excluding `schemas/` itself): **no `src/` file references either schema**, and
no normative text assigns either to a surface. The contract prints the OBSERVE payload verbatim in prose
but never names `observation.schema.json`; the only contract mention of `page-frontmatter` is the
Scope-vocabulary list. The one place either filename appears outside `schemas/` is
`test/schemas-v0.5.0.test.ts`, against hand-built fixtures (plus the probe for this decision). Nothing
pinned a schema to a writer, which is how both divergences survived unnoticed.

## Decision

**`observation.schema.json` describes the observation object on the wire and does not describe the L0
evidence record; `page-frontmatter.schema.json` describes the L2 page frontmatter that the compiler
writes, so there the writer is the side that is wrong.**

### D1 — L0: the schema is wire-shaped; the record is a distinct, currently-unpublished surface

`observation.schema.json` required+optional properties are exactly the v0.5.0 contract's OBSERVE
payload (`content`, `source` — a *string*, described as an origin identifier, `scope`,
`metadata{timestamp, actor, informed_by, tags}`, `idempotency_key`, `operation_id`, `actor_id`) plus the
server-stamped `observation_id`. Its `source` is a string and its `content` may be a bare string, which
is not and never was the on-disk record, where `source` is a nested object (`app`, `app_version`,
`source_id`, `source_ref`, `actor{type,id,display_name}`, `captured_at`, `observed_at`) and `content` is
always `{format, body}`. Spec §5's L0 prose describes the same *identity payload* ("`content` plus
`actor_id`, `scope`, `source`, and an optional client `idempotency_key`"), not the record envelope.

The L0 line's extra fields are not decoration: `integrity{hash, writer_id, sequence, previous_hash}` is
the append-only tamper-evidence chain, and `status`, `visibility`, `version`, `policy`, `provenance`
carry real canonical state. The schema is closed, so it cannot hold them.

Therefore:

- `observation.schema.json` is **not** the validator for the L0 record; the boundary is now stated in
  `schemas/v0.5.0/README.md` and pinned by `test/layer0/l0-record-wire-boundary.test.ts`.
- The L0 record — as written on disk **and as shipped in EXPORT.SCOPE packages** — has **no published
  schema**. That is a real gap in the portability story, not a documentation detail, and it is carded
  with this evidence rather than papered over: an integrator cannot currently tell what a valid exported
  observation record is, while the package's own manifest claims `schemas: v0.5.0`.

### D2 — L2 pages: the writer must conform; the compile envelope leaves the frontmatter

`page-frontmatter.schema.json` and spec §9's "Page frontmatter" block are the same field set, and the
compiler writes the very artifact §5/§9 describe — `wiki/concepts|entities|decisions/<slug>.md`, a
`page_<slug>` id, the two-region body, `author`/`sources`/`supporting_claims`/`notices` semantics,
voice protection. This is the tombstone class (`t_9e124fe6`, `wiki/tombstones/*.md`): one in-tree writer,
one published schema for the same artifact, writer emits a rejected shape. The writer is the side that
is wrong, in three separable ways:

1. **Names and types** — `category` plural (`concepts`) where the enum is singular; `updated` a full ISO
   timestamp where the schema is `format: date`; `confidence` a raw number where a bucket is required;
   `epistemic` where the field is `epistemic_tag`; no `created`. The library already owns both mappings
   (`confidenceToBucket`, `epistemicToTag`) and the compiler simply does not use them.
2. **`sources` means two different things.** The schema's `sources` is a list of `ClaimId`s; the compiler's
   `sources` is a list of `ObservationId`s and its claim list is a third name, `sources_claim_ids`. The
   collision has to be resolved by moving the observation list to the spec's own §9 timeline vocabulary
   (`source_observation_ids`, which §9 already defines as cached-view metadata of the Evidence Timeline)
   and giving `sources` its published meaning.
3. **The compile envelope** (`entity_id`, `entity`, `type`, `sensitive`, `claim_ids`, `compiled_at`,
   `compiled_by`, `model`, `supersedes`, `related`) is implementation mechanics. It is **not** to be
   enumerated into the frozen v0.5.0 page contract: `entity_id` and `compiled_by: 'smartware-compiler'`
   are not protocol vocabulary, and the protocol should not absorb one implementation's internals. It
   moves out of the frontmatter (the Evidence Timeline region already carries `compiled_at` and source
   observation ids by §9, and read gating should derive sensitivity from L0/L1, which are authoritative,
   rather than trust a compiled projection).

Because (2) and (3) touch page endorsement — a core verb that reads this frontmatter (`src/protocol/endorse.ts`)
— the writer fix is carded, not landed blind. No published byte moves in this change.

## Consequences

- An integrator now knows which schema to use where: `observation.schema.json` for the wire observation,
  `page-frontmatter.schema.json` for L2 page frontmatter, and **neither** for the L0 record — which is
  the honest statement of the gap rather than a silently relaxed schema.
- The L0 record's shape is pinned by test, so the shape cannot drift in either direction unnoticed, and
  closing the gap forces the docs to move.
- The compiled page frontmatter keeps failing the published schema until the carded writer fix lands.
  The pinning test asserts the exact delta, so the fix cannot land half-done, and the test fails loudly
  when it is fixed (which is the signal to invert it and update the README/ADR).
- Costs: the page fix touches `src/layer2/compiler.ts`, `src/layer2/types.ts`, `src/protocol/endorse.ts`
  and `src/protocol/read.ts`, plus hand-built frontmatter fixtures in three conformance tests
  (`f_l2_voice_protection`, `g_endorsement`, `demotion-durability`). Page-endorsement semantics are
  protocol-visible, so the fix requires the owner gate and a second verifier.
- **Reversal trigger:** if a future set publishes a record schema that covers the L0 envelope (D1) the
  README boundary sentence is replaced by a pointer to that schema; if the owner prefers to publish the
  compile envelope as page contract instead of moving it (D2.3), this record is superseded rather than
  quietly amended.

## Alternatives considered

1. **Rewrite the L0 writer to satisfy `observation.schema.json`.** Rejected: it would delete the
   integrity hash-chain, `policy`, `visibility` and `status` from the canonical record, and renaming `id`
   would break the append-only log, every reader, and already-written history. Conformance must not be
   bought by throwing away the audit surface.
2. **Widen `observation.schema.json` to admit the record.** Rejected: one closed schema would then describe
   two artifacts whose `source` types are incompatible (string identifier vs provenance object), and the
   set already has a wire-payload reading that integrators depend on. The record needs its own schema,
   not a merger.
3. **Widen `page-frontmatter.schema.json` to enumerate the compile envelope.** Rejected as the first move,
   not on effort but on principle: it publishes `entity_id`/`compiled_by` implementation internals into a
   frozen contract, and it still does not fix the `sources` collision — a rename is required either way.
   ADR-0011 widened `claim.schema.json` because that block makes the record re-materializable for other
   implementations; the compile envelope does not.
4. **Declare the compiled page a substrate-internal projection, outside the published page contract.**
   Rejected: it contradicts §5/§9 and the repository's own L2 conformance tests, which treat these pages
   as the L2 surface.
5. **Disclose only (no ADR, no cards).** Rejected: the L0 gap is a portability defect on a shipped
   artifact, and the page gap will keep widening while three code paths and three test fixtures depend on
   the un-published vocabulary.

## Delta (2026-09-16) — D1 carried out: the record schema is published in the v0.5.1 set

*Appended on kanban `t_f1157ed4` (branch `wip/smarty/l0-record-schema`, forked from this lane's
`wip/smarty/canonical-schema-boundary`). Nothing above is edited. This section records the outcome of
the reversal trigger in *Consequences* and which option was chosen. ADR-0013 stays **Proposed** — the
owner gate is now the gate on the new schema file, not on the boundary statement.*

**Chosen: option (a) — a new, additive set.** `schemas/v0.5.1/observation-record.schema.json` (with
its `SHA256SUMS` entry and set README) is the published contract for the L0 record. The set is the
v0.5.0 set plus that one file: **no v0.5.0 byte moves** (`schemas/v0.5.0/SHA256SUMS` sha256
`8d47a427…` unchanged), and the record schema `$ref`s `../v0.5.0/common.schema.json` for `Scope`,
`ActorId`, `ObservationId`, `OperationId` and `Iso8601` — the shared vocabulary (and with it the
ADR-0015 host-lane boundary on `scope`) is reused, not restated.

**Option (b) — add the file to the v0.5.0 directory and bump the set's version of record — was
evaluated and not taken**: it moves the set's file list and checksum manifest, which this card's
constraint forbids without the owner explicitly accepting that move. The schema content is identical
either way; if the owner prefers one 17-file set, supersede this delta and move the file and its
`$id` (no other change).

**The manifest is now honest.** `EXPORT.SCOPE`'s `manifest.json` declares `"schemas": "v0.5.1"` plus
an explicit `"record_schema": "https://smartware.dev/schemas/v0.5.1/observation-record.schema.json"`
(`EXPORT_SCHEMA_VERSION` / `EXPORT_RECORD_SCHEMA`, `src/protocol/export_scope.ts`). The version names
the set that actually covers the package's `observations.jsonl` / `evidence.jsonl` bytes, and the
second field names the file rather than leaving a consumer to infer it.

**Pinned in both directions.** `test/layer0/l0-record-wire-boundary.test.ts` asserts that the record
the reference writer appends validates against the record schema with an **empty error list**; that
the schema stays closed (unknown top-level key, unknown key inside `integrity`, missing `policy`);
that the record schema does **not** accept the wire observation object (12 exact errors), so it
cannot be widened into the wire shape without failing the pin; that `observation.schema.json` still
rejects the record with its exact 14 errors; and that an export package's record lines stay
byte-identical to the canonical line while validating against the schema its manifest names.

**Migration story.** Existing data dirs: nothing to migrate — the writer is unchanged and L0 is
append-only, so protocol-native-lane records already on disk validate as-is. Existing export
packages: nothing to rewrite — a package is immutable (an `operation_id` retry returns the same
manifest), so a package produced before this change keeps its historical `"schemas": "v0.5.0"` label
while its bytes are the shape the record schema covers; re-exporting under a **new** `operation_id`
writes the corrected label. Detail: `schemas/v0.5.1/README.md` → *Migration*.

**Adjacent finding, reported and not fixed here** (measured by sweeping every L0 writer in one brain;
evidence attached to `t_f1157ed4`): the consent-change writers (`src/protocol/grant.ts`,
`src/protocol/revoke.ts`) hardcode `scope: 'personal'` — an id the published `Scope` vocabulary does
not admit, and one that is not in a Core-opened brain's scope registry either (`self` is the spec's
personal lane; `quarantine_review.ts` and `forget.ts` use the same literal as a fallback). Those
records are outside this set's conformance claim for that reason alone — the ADR-0015 boundary, not a
record-schema defect — and the record schema is deliberately **not** widened to admit the literal.
Carded separately as a writer defect.

**Fixed 2026-09-16** (kanban `t_e6fce49a`, `wip/neo/consent-change-scope`, stacked on this lane):
those four writers now stamp the protocol-native `self`, spelled once as `POD_SELF_SCOPE`
(`src/config.ts`, the same value `initialiseDataDir` registers and FORGET.SCOPE's audit marker
resolves to), and `test/protocol/consent-change-lane.test.ts` drives GRANT + REVOKE + the
review/tombstone writers and asserts the appended records' complete Ajv error list against this set's
record schema is empty — the pre-fix revision fails the identical assertion with `['/scope:pattern']`
(A/B pair). No published schema byte, no `SHA256SUMS` line, and no record already on disk changes: L0
keeps the spelling it was written with. The two `?? 'personal'` fallbacks are measured-unreachable
(the effective-status lookup throws `not_found` first and `observations.scope` is NOT NULL), so that
half is a spelling change, not a behaviour change; what the literal *did* decide (raw-window search by
scope, EXPORT.SCOPE's closure, and nothing else) is recorded in the task's journal entry.
