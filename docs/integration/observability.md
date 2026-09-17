# Host-facing health and metrics contract (P1-3)

> **Audience:** the host (Coffee) operator running a Smartware brain in a trial.
> **Surface:** `SmartwareCore.health(params)` / MCP tool `smartware_health` /
> `HEALTH` in the protocol types.
> **Guarantee:** every value is a number, an id, a timestamp or a state string.
> No observation body, no claim value, no actor display name, no scope content
> ever appears in a report — that property is enforced by the *shape* of the
> report (there is no field a body could travel in), not by redaction at the
> edge. `test/observability/health.test.ts` (case C1) asserts it on the
> serialized JSON.

## 1. Authority

| Caller | Sees |
|---|---|
| Owner | the whole brain: lane counts, queue, ingestion, receipts, storage, backup, drift, denials, latency, recovery, SLO |
| Registered actor with `read` on ≥1 scope | `authority` + `ownership` + `brain` + `drift` + `storage` + `backup` + `counts.by_scope` for **exactly its readable scopes** |
| Registered actor with no `read` anywhere | `insufficient_permission` (fails closed) |
| Unregistered actor | `actor_unregistered` (fails closed) |

Cross-scope totals are other clients' metadata, so a read-granted actor gets
per-scope rows only. Everything that describes the *brain as a whole* (queue,
ingestion, receipts, denials, latency, recovery, SLO) is owner-only.

## 2. Field definitions

Definitions are part of the contract: a count is only reported in a lane whose
population rule is written here. The empty brain is never rendered as a passing
measurement — an absent measurement is `null` (or an absent block), never `0`.

### 2.1 `ownership` — the write lease as the brain knows it

| Field | Definition |
|---|---|
| `arbitration` | Always `external`: the host's arbiter (e.g. a Redis lease) issues ownership epochs; the brain only validates them (ADR-0007). |
| `enforcement` | `fencing` once any epoch has been claimed, else `none`. |
| `role` | This process's role: `writer` (presented an epoch), `observer` (brain is fenced, no epoch presented — every mutation is refused `fencing_token_missing`), `unfenced_writer` (legacy single-writer brain, high-water 0). |
| `presented_token` | The epoch this process presented, or `null`. |
| `epoch_high_water` | The highest epoch this brain has seen — the epoch that currently holds the right to write. |
| `holder.epoch` / `holder.claimed_at` / `holder.age_seconds` | The current write epoch, when it was claimed, and its age at report time. `null` when no epoch has ever been claimed. |
| `holder.identity` | Always `null`: the brain knows the epoch, not who holds it. Identity lives in the host's arbiter. |
| `ttl_seconds` / `ttl_owner` | Always `null` / `host`. The brain enforces ownership by **epoch comparison, not expiry**; the lease TTL is the host arbiter's, and an expired holder is refused as a stale epoch (`fencing_token_stale`), not accepted until a timer fires. |
| `refusals` / `last_refusal` | Canonical mutations refused by the fencing guard, and the newest refusal (`op`, `token`, `high_water`, `at`). |

### 2.2 `compile_queue` — outstanding work (owner only)

`depth = pending + running`. `failed` is terminal and stays raw-searchable
forever, so depth and failures answer different questions.
`oldest_pending_age_seconds` is the stall signal (null when nothing is pending);
`last_completed_at` / `last_failed_at` are the newest completion timestamps among
jobs **currently** in that terminal state — a retried job leaves the failed
population, so `last_failed_at` returns to `null` after a successful retry.
The block is `null` when the derived compile ledger could not be opened — an
honest degraded state, not an empty queue.

### 2.3 `ingestion` — cursor lag (owner only)

Per `(source, scope)` stream: the **newest committed batch's** `cursor`,
`cursor_before`, `synced_at`, and `lag_seconds = now − synced_at`. This measures
*stream staleness* (how long since ingestion last advanced), not the host's
distance from the end of a source's stream — the brain cannot see the source.
`batches` / `accepted` / `duplicated` / `quarantined` / `rejected` are folded
over the stream's batches. A registered source that has never committed a batch
appears in `sources_never_synced` — never as `lag_seconds: 0`.
`max_lag_seconds` is `null` when no stream has ever synced.
The cursor is opaque to the brain (stored verbatim) and is reported owner-only.

### 2.4 `counts` — lane-explicit counts

Owner (`counts.lanes`):

| Lane | Population rule |
|---|---|
| `layer0.total` / `layer0.by_status` | Layer-0 observation rows and their counts per `effective_status` (`accepted`, `quarantined`, `tombstoned`, `erased`, …). |
| `layer0.last_sequence` | Highest canonical evidence sequence, or 0. |
| `layer1.claims` | Effective (current, non-terminal) claims in the claim store. |
| `layer1.entities` | Distinct entities with claims. |
| `layer1.last_replayed_sequence` | The replay watermark: the highest Layer-0 sequence whose claims have been derived. |
| `layer2.pages` | `.md` page files in the wiki tree, excluding the root manifest. |
| `layer3.entity_index_rows` | Rows in the entity/topic FTS lane (`search_index`): one row per entity indexed as a page, plus one row per active claim of an entity with no page. **NOT pages, NOT claims, NOT observations.** |
| `layer3.claim_index_rows` | Rows in the claim-granular FTS lane (`claim_search_index`). |
| `layer3.observation_index_rows` | Rows in the raw-observation FTS lane (`observation_search_index`). |
| `layer3.observations_by_freshness` | State-based freshness labels over the raw-observation lane: `unverified` / `extracted` / `failed`. Literal labels, never derived from timestamps. |

> **Correction recorded here.** `STATUS` used to report a single
> `layer3.indexed` number that counted only the entity/topic lane while reading
> as "everything is indexed". It is gone; `STATUS` and `health` now report the
> four lanes by name, and `docs/STATUS.md` is regenerated from the new shape.

Read-granted actors get `counts.by_scope[]` for their readable scopes:
`observations_recorded` (all effective statuses) and `observations_accepted`.

### 2.5 `drift` — projection vs substrate

One record per check: `surface`, `expected` (what the projection claims),
`observed` (what the substrate holds), `delta = observed − expected`, `state`
(`in_sync` | `drift` | `unknown`), and the `rule` that was evaluated. `in_sync`
is `false` when any record is `drift`; `unknown` means the check could not run
(e.g. no wiki manifest has been written yet) and does not by itself make the
report drift — read `records` for coverage.

| Surface | Rule |
|---|---|
| `wiki_manifest` | Page count stated in `wiki/smartware.md` vs `.md` page files on disk. |
| `observation_fts` | Raw-observation FTS rows vs Layer-0 observations whose `effective_status` is `accepted` (terminal states are excluded from the lane by construction, spec §10a). |

A drift record is actionable, not alarming: rebuild the projection (compile /
`syncObservationsFromEvidence`) or recompile the pages.

### 2.6 `denied` — refused operations (owner only)

Counts refused calls by protocol error code and entry point (`op`), plus the
newest few (`recent`, newest first, capped at 20 rows in the store, 5 reported).
**Codes counted** (`DENIAL_CODES` in `src/observability/instrument.ts`):
authority (`actor_unregistered`, `insufficient_permission`, `owner_required`,
`user_required`, `forbidden`), ownership epoch (`fencing_token_stale`,
`fencing_token_missing`), session policy (`read_disabled`, `write_disabled`),
sensitive-content gates (`sensitive`, `sensitive_opt_in_required`), source
context (`source_required`, `source_unregistered`, `source_inactive`) and
protected voice (`protected_claim`, `protected_revival`).
**Deliberately not counted:** validation and lookup failures
(`invalid_parameter`, `not_found`, `conflict`, …) and operation preconditions —
they are not access decisions. No actor id and no scope are recorded.

### 2.7 `receipts` — retention and forget (owner only)

A fold of the canonical ops log (`retention.expire`, `forget`, `forget.scope`):
`total` per class plus the newest receipt per class. A receipt carries the
`operation_id`, `op`, `at`, and `details_counts` — **only the numeric fields of
the ops entry's details**. Scope ids, actor ids, observation ids and every other
string are dropped, so a receipt says how much was removed, never from whom.

### 2.8 `storage` — bytes on disk (owner only)

`total_bytes`, `files`, and `by_area` — `canonical` (`evidence/`, `claims/`,
`operations/`), `derived` (`indices/`, `wiki/`), `other` (everything else,
including the operational SQLite database and its WAL/SHM sidecars, and
top-level files). The classification is **directory-anchored, not semantical**:
`smartware.db` mixes derived indexes with operational ledgers and is counted
under `other`. Symlinks are not followed. Recomputed per report (O(entries),
not cached), so it cannot go stale.

### 2.9 `backup` — freshness of the host's backup directory

The brain never creates backups and does not know the host's retention policy.
The host passes `backup_dir` (or configures it on the core); the report states
`configured`, `dir`, `artifacts` (direct entries), `newest_at` (newest direct
entry's mtime) and `age_seconds`. Not configured → `null`s, never a fabricated
freshness. A dated directory or a dated file both work as the "artifact".

### 2.10 `latency` — histograms, not averages (owner only)

Sampled for data-plane calls only: `recall`, `observe`, `query`, `context`,
`correct`, `endorse`, `consolidate`. Control calls (`health`, `status`,
`sync_status`) are not sampled. Per operation: `samples`, `buckets`
(`upper_ms`, `count`; `upper_ms: null` is the overflow bucket for samples above
10,000 ms), `p50/p95/p99_ms_upper_bound`, and `max_ms` (the slowest sample — a
measurement, not a bound). Quantiles are **upper bounds at bucket resolution**:
the value is the smallest bucket edge whose cumulative count reaches the
quantile, so the true quantile is ≤ the reported number. A quantile that lands
in overflow is `null`, not silently rounded down. Operations with no samples are
absent from the block.

Samples are buffered per process and flushed to the metrics store when the
buffer fills, when a report is produced, and on close — a SIGKILL loses at most
the buffer, and only *operational* history.

### 2.11 `recovery` — brain-open scans (owner only)

`events` = number of opens that ran recovery; `last` = the newest scan's counts
(`committed_operations`, `orphans`, `pending_operations`, `intent_errors`,
`requires_manual_review`, `completed`, `quarantined`, `aborted`), its `at`, and
the `opened_at` it belongs to. Counts and timestamps only — no locators, no
content.

### 2.12 `slo` — the Coffee-trial objectives (owner only)

See §3. `policy` is the threshold table in force, `objectives` each carry a
three-state verdict, and `status` summarises: `breach` if any objective
breached, else `unknown` if any objective lacks evidence, else `ok`.

### 2.13 The metrics store itself

`<dataDir>/indices/metrics.db` holds denials, latency histograms and recovery
events. It is **operational state, not canonical memory**: it is not
regenerable, and deleting it loses history and nothing else (the brain's memory
is the evidence JSONL). A report after such a wipe says so by absence — zero
latency history, zero denials, zero recovery events — and never renders an
absent measurement as a pass.

## 3. Coffee-trial SLOs

Thresholds live in code (`COFFEE_TRIAL_SLO`, `src/observability/slo.ts`) and in
this table — changing one is a product decision, and both places move together.

| id | Objective | Measure | Threshold | State when unmeasured |
|---|---|---|---|---|
| `recall_p95_ms` | Recall answers inside budget at p95 | `latency.recall.p95_ms_upper_bound` | ≤ 1000 ms | `unknown` below 20 samples |
| `write_p95_ms` | Writes (observe) inside budget at p95 | `latency.observe.p95_ms_upper_bound` | ≤ 500 ms | `unknown` below 20 samples |
| `compile_queue_age_s` | No compile job sits unattended | `compile_queue.oldest_pending_age_seconds` | ≤ 900 s | `unknown` if the ledger did not open |
| `compile_failures` | No terminal failed job | `compile_queue.failed` | = 0 | `unknown` if the ledger did not open |
| `ingestion_lag_s` | Every connected source synced recently | `ingestion.max_lag_seconds` | ≤ 300 s | `unknown` when nothing has ever synced |
| `backup_age_s` | Newest backup artifact is fresh | `backup.age_seconds` | ≤ 86 400 s | `unknown` when no backup dir is configured |
| `drift` | Projections agree with the substrate | `drift.in_sync` | = true | `unknown` when a check cannot run yet |
| `stale_writer_refusals` | No write refused for a stale/missing epoch | `ownership.refusals` | = 0 | `unknown` if ownership was not reported |

Reading the status:

- **`breach`** — a measured objective is outside its threshold. Fix or accept
  it explicitly; do not re-read the report hoping for a different number.
- **`unknown`** — at least one objective has no evidence yet. This is the honest
  state of a fresh trial and the reason `ok` is not granted for free.
- **`ok`** — every objective was measured and passed.

`stale_writer_refusals` is expected to move during an ownership takeover (the
outgoing holder's last write attempt). A nonzero count outside a takeover is a
host-side ownership bug, which is why it is an objective and not a footnote.

## 4. Cost and cadence

| Block | Cost | Notes |
|---|---|---|
| lane counts, queue, ownership | SQLite `COUNT`/`MAX` on indexed tables | cheap, safe to poll every few seconds |
| `drift` | manifest read + wiki tree walk + one FTS count | O(pages) |
| `storage` | recursive `stat` walk of the data dir | O(entries); poll no more than every few minutes on a large brain |
| `receipts` | streaming pass over the ops JSONL | O(ops bytes) |
| `latency` | flush (one small transaction) + indexed reads | flush-bounded |

A host should poll `health` on the SLO cadence it intends to honour (for the
trial: 30–60 s) and alert on `slo.status === 'breach'`, on any `drift` record,
and on `role === 'observer'` for a process that believes it is the writer.

## 5. Not claimed

- Latency numbers are **bucket-resolution upper bounds**, not exact quantiles.
- Ingestion lag is batch staleness, not source-end distance.
- `drift` covers two projections; it is a detector, not a proof of consistency
  for every index in the brain.
- Storage areas are directory-anchored (see §2.8).
- SLO thresholds are trial policy, not a public guarantee; they are not part of
  the released protocol surface.
