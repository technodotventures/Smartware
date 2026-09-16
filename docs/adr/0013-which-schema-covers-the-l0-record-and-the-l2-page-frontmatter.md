# ADR 0013 — `observation.schema.json` covers the wire observation, not the L0 record; the compiled L2 page frontmatter must conform to `page-frontmatter.schema.json`

**Status:** Proposed — the two fixes this record decides are owner-gated (one publishes a record surface, the other changes an L2 artifact a core verb reads). The boundary statement in `schemas/v0.5.0/README.md` and the boundary-pinning tests shipped with this ADR move **no** published schema byte.
**Date:** 2026-09-15
**Deciders:** @smarty-pants (measurement and decision prepared on kanban `t_0920aa1d`); owner sign-off is the gate for the carded fixes.
**Supersedes:** —
**Numbering note:** `0008`–`0012` are held by other in-flight branches and two of them are double-allocated; `0013` is the next free number.

## Context

Kanban `t_9a700aed` measured the pod-profile scope/ActorId divergence and, in the same probe, validated the
rest of that flow's canonical artifacts against the published v0.5.0 schema set. Two of them failed:

1. the **L0 evidence line** (`<dataDir>/evidence/<date>.jsonl`) against `observation.schema.json`;
2. the **compiled wiki page frontmatter** (`wiki/<category>/<slug>.md`) against
   `page-frontmatter.schema.json`.

Both failed on the **protocol-native control flow too** (`scope: self|workspace`), so neither is the
host-lane divergence ADR-0012 settled, and neither is fixed by it. The card asked the question this
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
