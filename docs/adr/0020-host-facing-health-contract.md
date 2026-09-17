# ADR-0020 — A host-facing health contract with a three-state SLO verdict

- **Date:** 2026-09-15
- **Status:** Accepted (implemented and evidence-backed in this change; the SLO
  thresholds are trial policy and are expected to move with trial data)
- **Deciders:** Neo (Head of Technology) — card `t_65569b9e` (P1-3), from the
  company-brain plan's requirement that a Coffee trial be *operable*
- **Supersedes:** — (corrects the `STATUS.layer3.indexed` field, which was
  misleading rather than formally decided anywhere)

## Context

A company brain in a trial has two audiences for operational truth: the host
operator ("is the brain healthy, is it keeping up, is it safe to sleep?") and
the studio ("did the trial actually meet its numbers?"). Before this change the
only machine-readable surface was `STATUS`: six numbers, owner-only, with one of
them — `layer3.indexed` — counting the entity/topic FTS lane while its name read
as "everything is indexed". Everything else a host needs (lease state, queue
age, ingestion lag, denials, retention receipts, storage, backup freshness,
latency, recovery) lived in logs, in the ledger's own API, or nowhere.

Three constraints shaped the design:

1. **The host owns the lease, the backup policy and the SLO.** The brain must
   not invent an arbiter, must not create backups, and must not pretend a
   threshold it cannot measure is met. Ownership is external (ADR-0007): the
   brain validates epochs, it does not own the TTL.
2. **A health surface is a privacy surface.** It is the one thing a host renders
   on a dashboard and pastes into incident threads. It must be impossible for
   tenant content to travel in it, and that must hold by construction rather
   than by remembering to redact.
3. **Unmeasured is a first-class state.** A fresh trial has no latency history,
   no backup, maybe no synced source. Reporting `ok` for an unmeasured objective
   is the same class of lie as calling a system production-ready because it
   booted.

## Decision

**1. `HEALTH` is a first-class protocol surface** (`SmartwareCore.health`,
MCP `smartware_health`, types in `src/protocol/health.ts`), separate from
`STATUS` and separate in audience: `STATUS` is a compact owner summary;
`HEALTH` is the full contract — ownership/lease, brain-open state, compile
queue depth/age/failures, ingestion cursor lag, lane-explicit counts, drift
records, denied-access counts, retention/forget receipts, storage size, backup
freshness, recall/write latency histograms, recovery events and the SLO verdict.

**2. Authority is scope-based and fails closed.** The owner sees the whole
brain; a registered actor with `read` on at least one scope sees the
scope-scoped rows for exactly those scopes; a registered actor with no `read`
anywhere is `insufficient_permission`; an unregistered actor is
`actor_unregistered`. Cross-scope totals and every brain-wide operational block
are owner-only, because they are other clients' metadata.

**3. Content cannot travel: the report is counts, states, ids and time.** There
is no field a tenant body, claim value or display name could occupy. The
guarantee is asserted on the serialized report in tests.

**4. Measurements are lane-explicit and definition-carrying.** Each count names
its population rule (docs/integration/observability.md §2.4), and the
misleading single `indexed` number is replaced by `entity_index_rows`,
`claim_index_rows`, `observation_index_rows` and `observations_by_freshness` in
both `STATUS` and `HEALTH`.

**5. Latency is reported as histograms with upper-bound quantiles.** Averages
hide the tail that fails a trial; bucket resolution is stated rather than
implied. Samples are buffered in-process and flushed (buffer full / report /
close) so measurement never turns a read into an fsync storm, and the loss
window is bounded and documented.

**6. SLOs are a three-state verdict over the same report.** `pass` / `breach` /
`unknown`, with the policy table exported in code (`COFFEE_TRIAL_SLO`) and
mirrored in the doc; overall status is `breach` > `unknown` > `ok`. Unmeasured
objectives can never yield `ok`.

**7. The metrics store is operational state, not canonical memory.** It lives in
`<dataDir>/indices/metrics.db`, is deletable, and a report after deletion states
zeroes by absence rather than fabricating a pass.

## Consequences

- `STATUS`'s shape changed (`layer3.indexed` → four named lanes). It is a
  generated projection; `docs/STATUS.md` is regenerated. Any host reading
  `layer3.indexed` must switch to a named lane — the field is gone rather than
  deprecated, because leaving it would keep the misleading name alive.
- A host can now alert on `slo.status`, on any `drift` record, and on
  `ownership.role === 'observer'` for a process that believes it is the writer.
- `drift` is a detector over two projections, not a proof of consistency for
  every index. Extending the surface list is additive and expected.
- `stale_writer_refusals` will move during an ownership takeover; the objective
  is documented as "expected only during a takeover" so an operator does not
  chase it as a bug.
- The thresholds are trial policy, not a public guarantee, and are explicitly
  excluded from the released protocol surface.
- Cost is documented per block (§4 of the doc): lane counts are cheap enough to
  poll; `storage` and `receipts` are O(files) / O(ops bytes) and should be
  polled on a slower cadence.

## Alternatives considered

- **Extend `STATUS` instead of adding `HEALTH`.** Rejected: `STATUS` is a
  compact owner summary whose consumers (CLI, docs) do not want an O(walk)
  report, and conflating the two surfaces would force every cheap read to carry
  the expensive blocks.
- **Emit Prometheus/OpenTelemetry metrics.** Rejected for this cut: the host is
  Coffee's own process, not a metrics stack, and a protocol surface keeps the
  contract testable end-to-end (including authority) with no new dependency.
  The histogram bucket shape is deliberately compatible with a later exporter.
- **Brain-owned lease with TTL inside the brain.** Rejected (ADR-0007): a
  resource cannot arbitrate its own ownership across processes; it can only
  refuse epochs older than the last it has seen. The report therefore states
  `ttl_owner: 'host'` rather than inventing a TTL.
- **Report drift as a boolean only.** Rejected: a bare `false` is not
  actionable. Records carry `expected`, `observed`, `delta` and the rule.
- **Two-state SLOs (pass/fail) with defaults.** Rejected: it converts "not
  measured" into "fine", which is the failure mode this ADR exists to prevent.
