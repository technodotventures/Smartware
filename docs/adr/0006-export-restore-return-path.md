# ADR-0006 — An export must have a return path: RESTORE.SCOPE

- **Date:** 2026-09-14
- **Status:** Proposed (implemented and evidence-backed in this change; operator sign-off pending)
- **Deciders:** Neo (Head of Technology) — closing the resilience-gauntlet finding that
  `EXPORT.SCOPE` produced a portable package nothing could read back
- **Supersedes:** —

## Context

`EXPORT.SCOPE` (spec §10c.4; `src/protocol/export_scope.ts`) is the substratum of three
customer-facing promises: export before erasure, reversible offboarding, and client
portability. It was implemented and tested as a **producer**: verify the manifest, assert the
one-scope boundary, ship five canonical `.jsonl` files plus `manifest.json`.

The resilience gauntlet (kanban `t_00a9df88`) asked the consumer-side question, and the answer
was: nothing consumes a package. There is no import path in `src/`, no schema for a restore
receipt, and no test that a package written by one brain can be read by another. An export that
cannot be restored is a **dead-end artifact**: the customer's portability and
export-before-erasure guarantees rest on it, and a `sha256`-sealed package nobody can open is
not portability.

Two constraints shaped the design:

1. **The package is canonical-only.** Derived state (SQLite claim store, FTS indexes, ops index,
   compile queue, previews, ingestion ledger) is excluded by construction and regenerable. A
   restore therefore writes canonical records; derived state catches up exactly like a
   wipe-and-rebuild.
2. **One brain is single-writer, one scope is one boundary.** A restore cannot merge into a
   scope that already holds content without inventing conflict semantics nobody has specified,
   and it must not let a package for client A write into client B's memory.

## Decision

**`RESTORE.SCOPE` — restore one `EXPORT.SCOPE` package into a brain whose scope is empty; the
canonical records are written verbatim and the derived state rebuilds from them.**

Specifics:

- **Owner-only**, like EXPORT (`requireOwner`).
- **Integrity before import**: every content file must match its manifest `sha256`, the aggregate
  must match, and the manifest's declared counts must agree with the records actually present.
  Any mismatch is `package_corrupt` and **nothing is written**.
- **Boundary enforced on the way in**: every imported observation and claim version must carry
  the manifest's scope; a package that crosses its boundary is `package_corrupt`, never a
  cross-scope write.
- **Restore, never merge**: the target scope must be empty (`scope_not_empty` otherwise).
  Restoring the *same* package again is idempotent — the receipt under `<data_dir>/imports/`
  returns `already_restored` and writes nothing.
- **Erased packages restore as empty**: a package with a `deletion_certificate` and zero content
  writes nothing (a restore must not resurrect erased data) and records the receipt.
- **Entities are re-resolved**, not imported: the package marks them `non_canonical: true`
  precisely because subject identity belongs to the receiving brain's resolver.
- **Evidence keeps its own date**: imported observations are appended to the day file of their
  `observed_at` (or `captured_at`), not to the day of the restore, so the evidence log stays
  chronological.
- **The receipt is operational state, not canonical evidence** (`<data_dir>/imports/
  <export_id>.json`) — the same honesty rule the ingestion ledger follows. Losing it means a
  retry hits `scope_not_empty`; it can never be a lost write.
- Surfaces: `SmartwareCore.restoreScope()`, MCP tool `smartware_restore_scope`, and the existing
  `/export` companion route on a host HTTP surface. Additive on the unreleased 0.7.0 line; no
  frozen protocol/schema file changes.

## Consequences

- The export path is now **round-trippable and measured**: an exported scope restores into a
  fresh brain with identical claim ids, objects, provenance (`observation_ids`) and recall
  answers, and stays equivalent after the restored brain's derived state is wiped and rebuilt
  (`test/protocol/restore-scope.test.ts`, and the gauntlet's `export-restore` drill).
- Restore is a **write**, so a host must treat it like any other single-writer mutation: it runs
  on the lease holder, behind the same ownership guard as `observe`.
- A restored brain inherits the package's **claim lifecycle state as it was exported**:
  active/contested/superseded versions are canonical records and come back as they were. A
  package exported before an erasure restores pre-erasure content — deliberately, and only into
  a scope-clean brain; that is an owner decision, recorded by the receipt.
- **Open question (not decided here):** restoring into a scope that a *different* export
  previously populated requires an explicit forget/erase step first. Merge semantics for two
  packages of one scope are unspecified; if a real host needs them, that is a new ADR.
- Reversal trigger: a host requirement for merging packages, for scope **renaming** on restore,
  or for cross-brain claim-id remapping would invalidate part of this design.

## Alternatives considered

- **Re-observe the package's content through the normal write path** (new observation ids, claims
  re-extracted): rejected — it discards the identity the export exists to preserve and makes
  "restored equals exported" unverifiable.
- **Import into the derived store only** (skip the canonical JSONL): rejected — that is a
  projection, not a restore; the next wipe-and-rebuild would erase the restored scope.
- **Auto-create the scope in `config.scopes`** when a package names one that the brain does not
  declare: rejected — scope provisioning is a host decision, and silently materialising scopes
  from a file would let a package widen a brain's surface.
- **Merge into an existing scope** with conflicted/duplicate handling: rejected as unspecified
  semantics; the safe default is refusal plus an explicit export/forget step.
