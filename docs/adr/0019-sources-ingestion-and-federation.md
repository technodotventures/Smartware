# ADR-0019 — Sources, connector ingestion and federated reads

- **Date:** 2026-09-14
- **Status:** Proposed (implemented and evidence-backed in this change; operator sign-off pending)
- **Deciders:** Neo (Head of Technology) — implementing the frozen Coffee parity contract, P1-2
  ("connector ingestion contract — Coffee owns UI/OAuth/creds, Smartware fails closed without
  actor+source") and the shared-workspace half of P0-5/P0-7
- **Supersedes:** —

## Context

The Coffee company-brain contract freezes the definition: **source = provenance origin within a
business (meeting, connector, note)**, and the ownership split: *Coffee owns UI, OAuth login,
scheduled jobs and connector credentials; Smartware accepts authenticated actor/source context
and fails closed when absent.*

Before this decision the substrate had no such object:

- `observation.source.source_id` existed on the wire as a **free-form dedup string** (a message
  id, a screenshot id). Nothing said where evidence came from; a host could pass any string, and
  `source_id` was the only provenance the brain kept — a label, not a registered origin.
- There was **no ingestion contract**. A connector host looped `observe` per item; nothing
  tracked a stream position, nothing could replay a page safely, and an interrupted sync had no
  receipt to reconcile against.
- Dedup identity was `(app, source_id)` — **scope-blind**. Reproduced while building this:
  the same source item ingested into a second client scope was silently dropped as a duplicate
  return of the first scope's observation. One client's evidence shadowed another's, and the
  receipt said `duplicate`, so the loss was invisible.
- RECALL was single-scope. A company brain's characteristic read — "search across my clients" —
  had no lane; the closest existing reads (`readConflicts`, `readKnowledgeGraph`) take scope
  arrays but only to deny multi-scope reads when any scope is unauthorized (P0-5), never to
  answer across scopes.

The product need is the **minimum GBrain-equivalent company operation**: a source registry inside
one business brain, source-scoped provenance, federated reads bounded by actor grants, idempotent
ingestion cursors, replay/dedup, and sync status — without building a second task/wiki system
(Coffee owns the product shell) and without touching the frozen five-verb wire contract.

## Decision

**The brain owns a per-business source registry, one fail-closed ingestion contract over it, and
a grant-bounded federated read. All three are additive embedded-core surfaces; no protocol or
schema file changes.**

1. **Source registry.** `SourceEntry { id, kind, display_name, status, created_at, actor_ids?,
   external_ref? }` lives in `config.json` (the provisioning surface, like `scopes` and
   `grants`), one registry per brain. `kind ∈ {connector, meeting, note, agent, manual, system}`;
   `status ∈ {active, paused, revoked}`. Registration is an **owner-only upsert keyed on id**
   (`created_at` preserved); `paused`/`revoked` refuse new writes while leaving recorded evidence
   untouched. An optional `actor_ids` allow-list stops an actor from claiming provenance it does
   not own (the write-side attribution-forgery hole actor grants cannot close).

2. **Fail-closed source context.** Any write that references a source (`observe` with
   `source_ref`, or `ingest`) denies **before any write**: missing → `source_required`;
   unregistered → `source_unregistered`; not active → `source_inactive`; actor outside the
   allow-list → `insufficient_permission`. Writes without source context keep working exactly as
   before (`source_ref` is absent, not defaulted) — legacy observations stay valid.

3. **Dedup identity is `(app, external_id, scope)`.** The registered source's id is the `app`
   for items it ingests, so re-syncing an item dedups within its scope, and the same item in a
   second scope is a second observation — evidence is never silently shadowed across scopes.
   (Fixes the pre-existing `(app, source_id)` key; the unique index is replaced in place.)

4. **Ingestion contract = one batch per polled page.** `ingest({ actor, source_id, scope,
   cursor, operation_id, items })`:
   - item = one observation, keyed by `(source, external_id, scope)`; replays dedup;
   - `cursor` is an **opaque** stream checkpoint stored verbatim (never parsed), advanced only
     when the batch commits; `cursor_before` is the previous checkpoint for that
     `(source, scope)` stream;
   - `operation_id` (ULID) makes the **batch** idempotent: a committed batch replayed returns its
     recorded receipt (`status: 'replayed'`) and performs no writes;
   - a crash mid-batch converges on retry: written items dedup, the rest complete, the receipt is
     written once;
   - **item-level failures are recorded, never fatal**: a rejected item (e.g. `secret_detected`)
     is reported with its protocol error code and counted, and the batch still commits — a
     poisoned message must not wedge a connector forever;
   - the actor's grants still bound the write: a registered source is not an authorization.

5. **The ledger is operational state, honestly labelled.** Batch receipts and stream cursors live
   in SQLite (`ingestion_batches`). The canonical record is the evidence JSONL the batch wrote;
   losing the ledger loses the resume hint, not writes, because item dedup is content-safe. A
   host treats a missing cursor as "resume from your own checkpoint", never as lost memory.

6. **Sync status is a fold, owner-only.** `sourceSyncStatus()` reports per registered source
   (kind, display name, status) per scope: cursor, `cursor_before`, `synced_at`, batch counts and
   accepted/duplicated/quarantined/rejected totals — plus a source with no batches as
   *connected, never synced*. A named source that is not registered denies
   (`source_unregistered`), never answers empty.

7. **Federated reads are all-or-deny on named scopes.** `recallFederated({ actor, query,
   scopes? })`: named scopes must **all** be readable by the actor, or the whole read denies
   (`insufficient_permission` / `actor_unregistered`) — never a partial answer to a request that
   named an unauthorized scope (the P0-5 isolation contract). With scopes omitted, the read
   federates over exactly the actor's readable scopes (owner: every scope in the brain). Results
   are scope-tagged and ordered scope-major; scores are comparable within a scope, not across
   them. Multi-scope reads answer only what the actor may see.

8. **Sources are provenance labels, not a product surface.** The registry is not a second
   task/wiki system: entries carry no content, no hierarchy, no workflow. Coffee renders labels
   and sync state; the brain keeps the evidence and its origin.

## Consequences

- Hosts that want attributed evidence must register sources first (owner-only), then either
  `observe(..., source_ref)` or `ingest(...)`. Unregistered hosts keep the old path unchanged.
- **Behaviour change:** dedup identity now includes scope. Two scopes can hold the same source
  item; a host that relied on cross-scope shadowing (or on `findObservationBySource` without a
  scope) must pass the scope. This is the bug being fixed, not a regression: the narrower key
  silently lost evidence.
- The batch receipt is the reconciliation surface for connector runs; Coffee stores its own
  checkpoint too, and the two converge by dedup on every retry.
- Admitted rejections are visible (receipt + sync status counts + `code`), so "the sync said ok"
  never means "everything was stored".
- Quarantine still applies through grants (`quarantineForGrants`): an untrusted/paused connector
  produces `quarantined` items the receipt counts and the raw window hides until review.
- New public subpath `smartware/ingestion` (types + helpers) and five new MCP tools
  (`smartware_register_source`, `smartware_list_sources`, `smartware_ingest`,
  `smartware_sync_status`, `smartware_recall_federated`); `smartware_observe` gains optional
  `source_ref`. No protocol version, schema file, or five-verb behaviour changed.
- **Reversal trigger:** if pilots show connector batches routinely exceeding one page, or hosts
  needing per-source scope allow-lists (not just actor allow-lists), revisit — both are additive
  and would not change the fail-closed rule.

## Alternatives considered

- **Receipts in the ops log (`operations/`).** Rejected: the ops-entry schema's `op` enum is a
  frozen protocol surface (`schemas/v0.5.0/operation-log-entry.schema.json`); adding `ingest`
  would revise a released schema for an embedded-core feature. The ledger stays derived/operational
  and the decision is recorded here instead.
- **Sources as L0 observations ("source registered" events).** Rejected: the registry is
  provisioning state, like scopes and grants; logging it as evidence would put configuration into
  the evidence log and make `observe` the only write path for provisioning. It would also engage
  the compile queue on non-evidence rows.
- **Keep `(app, source_id)` dedup and document the cross-scope collision.** Rejected: it silently
  loses one client's evidence and mislabels it `duplicate` — exactly the class of defect the
  isolation work (P0-5) forbids.
- **Partial federated answers (return what the actor can read, deny-or-skip the rest).** Rejected:
  a caller cannot distinguish "empty" from "withheld"; the isolation contract already decided
  denial over partial answers.
- **Per-source scope allow-lists in the registry.** Deferred, not rejected: the actor's grants
  already bound the write scope, and a second ACL multiplies the rules a host must keep coherent.
  `actor_ids` closes the gap grants cannot (provenance forgery), and a scope allow-list can be
  added additively if a real connector needs it.
- **A batch API that wraps creation of claims too (extraction inside the brain).** Rejected for
  the Coffee shape: the host owns extraction (route b); ingestion is evidence-only, and claims
  keep flowing through `admitClaim`. One policy per concern.
