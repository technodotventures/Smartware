# Smartware Schemas v0.5.1

This set is **the v0.5.0 set plus one additive schema**: `observation-record.schema.json`, the
published contract for the **L0 evidence record** — the append-only line in
`<data_dir>/evidence/<date>.jsonl` (spec §5 "L0 — Observation Log"), which is also the bytes
`EXPORT.SCOPE` ships in `observations.jsonl` / `evidence.jsonl`.

## What "v0.5.1" means (and what it does not)

- **No v0.5.0 schema byte moves.** `schemas/v0.5.0/` is untouched, byte for byte
  (`SHA256SUMS` unchanged); v0.5.0 conformance claims are unaffected.
- **This is a schema-set revision, not a protocol revision.** The protocol contract remains
  v0.5.0 and there is no v0.5.1 contract document. What the number names is the set: v0.5.0's
  file list *plus* the record schema.
- **It is an overlay, not a second copy.** This directory holds one schema; every shared
  definition stays where it is. `observation-record.schema.json` `$ref`s
  `../v0.5.0/common.schema.json` (`Scope`, `ActorId`, `ObservationId`, `OperationId`,
  `Iso8601`), so validating a record requires **both** sets registered. A validator that loads
  only this directory will fail to resolve those `$ref`s — that is the point: the shared
  vocabulary is not restated, so it cannot drift.

## Which schema covers which surface

| surface | what it is | what validates it |
|---|---|---|
| `observation.schema.json` (v0.5.0) | **the observation object on the wire** — the OBSERVE payload (`content`, `source` identifier string, `scope`, `metadata{timestamp, actor, informed_by, tags}`, `idempotency_key`) plus the server-stamped `observation_id`, `operation_id`, `actor_id` | itself |
| `observation-record.schema.json` (**this set**) | **the L0 record** — the append-only storage envelope in `<data_dir>/evidence/<date>.jsonl`, and the identical bytes in an `EXPORT.SCOPE` package's `observations.jsonl` / `evidence.jsonl`: nested provenance `source`, `content{format, body}`, `status`, `visibility`, `version`, `policy`, `provenance`, and the `integrity{hash, writer_id, sequence, previous_hash}` tamper-evidence chain | itself |

The record is **not** the wire object: it carries the same information under different names and adds
canonical state the closed wire schema has no place for. `observation.schema.json` rejects it by
construction (4 `required`, 9 `additionalProperties`, `/source:type` — measured, and pinned by
`test/layer0/l0-record-wire-boundary.test.ts`). Reshaping the writer to fit the wire schema was
rejected: it would delete the integrity chain and the canonical state. The reasoning, the rejected
options and the migration story are [ADR-0013](../../docs/adr/0013-which-schema-covers-the-l0-record-and-the-l2-page-frontmatter.md)
→ *Delta (2026-09-16): D1 carried out*.

## The record contract, precisely

Closed (`additionalProperties: false`) at the top level and in every nested object except
`content.body` (app-owned payload). Required: `id`, `version`, `type`, `status`, `source`, `scope`,
`visibility`, `content`, `provenance`, `policy`, `integrity` — the field set the reference writer
always appends.

- `id` — `obs_<sha256 of the canonical observation payload>` (shared `ObservationId`).
- `version` — the substrate version that wrote the record (`0.7.0`, …). Historical records keep the
  version that wrote them; the schema pins the string's shape, not the current release.
- `operation_id` / `actor_id` — **optional** commit identity, present exactly when the write carried
  an `OperationId`.
- `status` — `accepted | quarantined` as written. Effective status (`tombstoned`, `redacted`,
  `rejected`, `erased`) is derived from later mutation records and is never stored on this line.
- `source` — `{app, app_version, source_id, actor{type,id,display_name}, captured_at, observed_at}`.
- `content` — `{format, body}`; `format` is the writer's declared input contract
  (`text/markdown | text/plain | application/json`).
- `provenance` — `{parent_ids, supersedes, context}` plus optional `informed_by`.
- `idempotency` — `null`, or the `{actor_id, key, payload_hash}` the write consumed. **Optional**:
  the consent-change and quarantine-review writers do not emit the key at all, while OBSERVE and the
  mutation writers emit it (as `null` when unused).
- `policy` — `{retention, retention_duration, sensitive, pii_detected}`.
- `integrity` — `{hash, writer_id, sequence, previous_hash}`; `hash` covers the record **including**
  `previous_hash`, `sequence` and `writer_id`, so re-pointing a link past a deleted record breaks the
  chain.
- `claims` — the deprecated pre-v1.6.16 pre-extracted block. OBSERVE writes L0 only and rejects a
  non-empty value, so the key is accepted **only empty**; a record carrying claim entries is a
  pre-v1.6.16 artifact and is outside this set.

## Boundaries this schema does not widen

- **`scope` is the shared `common.schema.json#/$defs/Scope`.** A record written in a lane the
  vocabulary does not admit — a host-registered lane such as `pod/<pod>/<lane>`
  ([ADR-0015](../../docs/adr/0015-host-registered-lanes-and-the-substrate-actor-id.md)) — is outside
  this set's conformance claim. The record schema does not silently admit it; the vocabulary is closed
  and a widening is a protocol revision, not a schema edit. (The reference implementation's
  consent-change writers hardcoded the literal `personal` here until kanban `t_e6fce49a`: GRANT,
  REVOKE and the two `?? 'personal'` fallbacks now write the protocol-native `self`. Records already on
  disk keep the spelling they were written with — L0 is append-only — so a pre-fix `personal` record is
  a pre-fix artifact and still outside this set. The remaining `personal` literals outside the writers
  were decided on kanban `t_574be8cd`: `layer1/confidence.ts`'s half-life table is keyed on this
  vocabulary, the session summariser default names `self`, and the OBSERVE tool-description example
  reads `self, project:foo, client:acme#1`.)
- **Legacy value shapes are not admitted by pattern tricks.** `id`, `actor_id`, `operation_id` and
  the integrity hash reuse the published `$defs`, so a record either matches the published identifier
  forms or is out of the set.

## Validating a record (AJV 2020)

```js
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
// Load BOTH sets — the record schema $refs the v0.5.0 common definitions.
for (const set of ['v0.5.0', 'v0.5.1']) {
  for (const file of readdirSync(`schemas/${set}`).filter(f => f.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(readFileSync(`schemas/${set}/${file}`, 'utf8')));
  }
}
const validate = ajv.getSchema('https://smartware.dev/schemas/v0.5.1/observation-record.schema.json');
```

## Migration

- **Existing data dirs: nothing to migrate.** The schema describes the records already on disk; the
  writer is unchanged, so already-written protocol-native-lane records validate as-is. Records written
  before this set existed are not rewritten (L0 is append-only).
- **Existing export packages: nothing to rewrite.** A package is an immutable artifact — an
  `operation_id` retry returns the same package, manifest included — so a package produced before
  this change keeps its historical `"schemas": "v0.5.0"` label. Its `observations.jsonl` /
  `evidence.jsonl` bytes are the same record shape this set covers: validate them with
  `observation-record.schema.json` regardless of the label. Re-exporting under a **new**
  `operation_id` produces a package whose manifest names the v0.5.1 set and the record schema.
- **Export manifest.** `manifest.json` now carries `"schemas": "v0.5.1"` and an explicit
  `"record_schema"` `$id` (`EXPORT_SCHEMA_VERSION` / `EXPORT_RECORD_SCHEMA` in
  `src/protocol/export_scope.ts`), so a consumer no longer has to infer which schema covers the
  package's record bytes.
