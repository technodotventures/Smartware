# ADR-0002 — Consolidation of claim clusters

**Status:** Approved (owner sign-off 2026-09-10 — Tier-1 invariant §2.2 frozen)
**Author:** @smarty-pants
**Date:** 2026-09-10
**Supersedes:** none
**Touches:** `src/protocol/consolidate.ts` (new), `src/ops_log/types.ts` (op type), `src/core.ts` + `src/mcp.ts` (surface).

---

## 1. Context

Supersession already keeps the recall surface current: only the latest active
version of a claim satisfies recall, and superseded versions are excluded. What
it does **not** do is collapse *distinct but related* claims — the same fact
restated across meetings, a decision plus its restatements, a preference
repeated over months — into one reviewed "current understanding." As a company
brain compounds, the active claim set accumulates near-duplicates that must be
navigated, not just superseeded one-at-a-time.

Consolidation is the **working-set compaction** operation: it merges a cluster
of claims into one reviewed summary claim while keeping the full evidence and
correction trail intact.

## 2. Decision

### 2.1 Operation — `CONSOLIDATE`

`consolidate({ actor, claim_ids[], summary, subject_name, predicate, scope, reason, operation_id? })`

1. **New identity.** The consolidated claim is a **new `claim_id`**, not a
   version of any input. It is the current understanding.
2. **Evidence is preserved, never summarized away.** The new claim's
   `derived_from` is the union of every input claim's `derived_from` **plus the
   input `claim_id`s themselves**, so the full lineage (summary → prior claims →
   source observations) is walkable.
3. **Inputs are tombstoned, not deleted.** Each input claim gets a forgotten
   version (supersedes its latest active), so they leave recall but remain in
   history — correctable and auditable.
4. **Reviewed, never autonomous.** The `summary` is human/LLM-authored and
   human-reviewed; consolidation is an explicit adjudication, not an automatic
   rewrite (mirrors the "reviewed correction" principle). Actor must be a user.

### 2.2 Binding invariant

> Consolidation preserves the correction path and provenance. The consolidated
> claim's `derived_from` MUST be a superset of the inputs' evidence lineage, and
> inputs MUST be tombstoned (never physically deleted). A consolidation that
> drops an evidence pointer is a correctness bug, not a valid compaction.

### 2.3 Non-goals

- No autonomous consolidation (no `reflect.auto`-style silent merge).
- No physical JSONL compaction of the input versions (append-only, same
  constraint as ADR-0001's purge).
- No cross-scope consolidation — all inputs must share the consolidated scope.

## 3. Acceptance criteria (conformance)

1. `consolidate` over 2+ active claims → one new active consolidated claim;
   recall returns the consolidated claim and **not** the inputs.
2. Consolidated `derived_from` ⊇ union of inputs' `derived_from` ∪ input ids.
3. Inputs are `forgotten` (history retains them); rebuild-equivalence holds.
4. Non-user actor is refused; cross-scope inputs are refused.
5. Idempotent per `operation_id` (retry returns the same consolidated claim id).

## 4. Approval required

The Tier-1 invariant in §2.2 is a protocol-level commitment. Everything else is
implementation on the existing claim-version machinery.
