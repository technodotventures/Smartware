# ADR-0010 — Storage-level fencing: epoch-stamped mutations and an atomic commit gate

- **Date:** 2026-09-15
- **Status:** Proposed (implemented and evidence-backed in this change; operator sign-off pending)
- **Deciders:** Neo (Head of Technology) — the follow-on ADR-0007 lists as deferred, triggered by
  the in-mutation pause the fencing closure left open
- **Supersedes:** —
- **Extends:** ADR-0007 (a fencing token validated at the brain mutation boundary)

## Context

ADR-0007 validates the writer's ownership epoch at the **mutation boundary**: every canonical
mutation's first step refuses a stale or missing epoch before any artifact is written. That check
runs *before* the mutation; it cannot see a pause that lands *inside* one — GC, a page fault,
SIGSTOP, an IO stall — after the boundary check has already passed.

Measured in this change (gauntlet `storage-fence-in-mutation`, boundary-fenced build): a process
paused mid-mutation across a lease handoff **resumes and writes the commit signal**. The stale
epoch commits. And when the process dies while paused instead of resuming, it leaves an intent
plus partial artifacts that recovery cannot attribute: they land in `orphans` /
`requiresManualReview`, and — worse — an intent whose artifact set happens to be *complete*
is silently **finalized** by the next owner (today's disposition table:
"Intent plus the complete exact, hash-valid set → append the missing operation entry"). That
completes a dead owner's mutation: exactly the split-brain merge the lease exists to prevent.

Why the boundary check cannot be fixed by checking harder, and why the fix must move into
storage: the durable commit signal is an append-only JSONL append (`operations/YYYY-MM-DD.jsonl`)
and cannot be made atomic with anything else. The brain's `smartware.db` (SQLite) *can* — every
process that opens the brain shares it and SQLite serialises writers across processes. So the
commit **decision** can be an atomic check-and-record in SQLite, while the JSONL entry stays the
canonical commit signal (a projection of that decision).

Constraints carried from ADR-0007, unchanged:

1. **Additive on the unreleased 0.7.0 line.** A brain that never adopts fencing stays
   byte-identical; hosts keep working with no change.
2. **The arbiter stays outside the brain.** The brain only *enforces* monotonicity.
3. **Refusals stay precise and priced.** Code-carrying `ProtocolError`, no manual repair for a
   refusal.
4. **The guard stays cheap on the known-good path.**

## Decision

**Every intent-backed mutation carries the ownership epoch that prepared it, and its commit
signal is gated by an atomic check-and-record in the brain's own database; recovery rejects, as a
set, any uncommitted artifacts whose epoch is behind the brain's high-water mark — and never
finalizes them.**

Specifics:

- **Epoch stamps.** A fenced writer stamps `fence: { epoch, writer_id }` into:
  - the operation intent (`operations/intents/<operation_id>.json`) — the write-ahead record that
    already anchors the operation's expected artifact set; and
  - every operations-log entry it writes (inside `details.fence`).
  Artifact records (L0 observations, L1 claim versions, L2 pages) are **not** stamped: their
  versioned schemas are checksum-locked with `additionalProperties: false`, and attribution does
  not need them — the intent is written first and removed last, so every uncommitted artifact
  group resolves through the intent that describes it. A schema-versioned artifact stamp is a
  separate change, not required for the guarantee.
- **Atomic commit gate.** New table `writer_fence_commits` in `smartware.db`
  (`operation_id` PRIMARY KEY, `epoch`, `writer_id`, `authorized_at`). Every commit signal of the
  intent-backed set goes through one IMMEDIATE transaction that (a) refuses a writer whose token
  is missing or behind the persisted high-water mark — the same codes as the boundary guard,
  `fencing_token_missing` / `fencing_token_stale` — and (b) records the authorization for the
  operation. The JSONL entry is appended only after the gate passes. A crash between the gate and
  the append cannot lose the commit: the row is durable proof the commit was authorized, and
  recovery projects the missing entry.
- **Recovery dispositions (fenced brain, intent-backed set):**

  | Persisted state | Disposition |
  |---|---|
  | Operations entry present | Committed (unchanged); remove a stale intent. |
  | No entry, gate row present | Project the commit signal (`recovered: true`) — the commit was authorized before the signal landed. |
  | No entry, no row, stamped epoch ≥ high-water mark | Authorize atomically (**re-checked inside the transaction**) and finalize as today. |
  | No entry, no row, stamped epoch < high-water mark | **Reject as a set**: never finalized, never pending, never merged — reported under `staleEpochRejected` with reason, epoch, high-water mark, and artifact count. |
  | No entry, no row, intent unstamped on a fenced brain | **Reject as a set** (`unstamped_on_fenced_brain`): the epoch is unknown, so fail closed. |
  | Unfenced brain (high-water mark 0) | Legacy dispositions, byte-identical. |

- **Coverage.** The gate and stamps cover the mutation set that carries intents — the
  crash-consistent commit protocol (`observe`, `revise.claim`, `forget`, `forget.scope`, `revive`,
  `endorse`, `reflect.auto`) plus the batch writers that commit through the same contexts
  (`retention.expire`, `consolidate`, `restore.scope`). Session bookkeeping
  (`session.start`/`session.end`) is not a canonical mutation (ADR-0007) and is not gated.
  `commit.ts`'s `runCommit` helper remains unadopted by handlers; it gates when given a fence.
- **Refusal semantics.** A gate refusal is a normal, code-carrying `ProtocolError`; it is
  counted in `fencingState()` like a boundary refusal (same `op`, `token`, `high_water` details).
  A rejection of a stale artifact set is not a refusal of a live writer: it is a recovery
  disposition and appears only in the recovery report.

## Consequences

- A fenced brain has a stronger invariant than ADR-0007 gave it: **no mutation prepared under an
  epoch behind the high-water mark can commit** — not by resuming, not by recovery finalization.
  The remaining artifacts of such a mutation are attributed deterministically and reported, not
  merged; an operator (or the host) sees `staleEpochRejected` instead of an unclassified orphan.
- **Cost on the commit path:** one additional SQLite IMMEDIATE transaction per commit signal
  (the gate; the guard already performs one indexed read per mutation). Measured on the pilot
  path — see Evidence. `writer_fence_commits` grows one row per committed operation; it is
  operational state (like the refusal counter), not canonical memory.
- **Adoption is still a one-way door** (unchanged from ADR-0007). New operational note: drain
  pending operations **before** adopting fencing. An intent prepared without an epoch is, on a
  fenced brain, `unstamped_on_fenced_brain` — rejected as a set, not auto-finalized. That is the
  fail-closed reading of "unknown epoch"; resolve such sets manually before adoption or accept
  that they require review.
- **Append-only reality:** a stale writer's artifacts that landed before the gate are not deleted
  — rejected means *classified and never merged*, not erased. Deleting canonical append-only
  records is not this protocol's business.
- **Known narrow residual (stated, not hidden):** a pause that lands *after* the gate passes but
  *before* the JSONL append is safe (the commit is authorized; recovery projects it), but in one
  interleaving — recovery projects the entry while the paused process later resumes — the
  resumed process can append a **duplicate** projection line for the same operation. Consumers
  key on `operation_id` presence, so the duplicate is inert; it is a log-hygiene artifact, not a
  correctness hole. Closing it would require the append step to be able to observe the
  projection, which the file-based signal cannot do without reintroducing the check-then-write
  window this ADR exists to remove.
- **Reversal trigger:** a host that needs stale artifact sets merged rather than rejected, or a
  cost measurement showing the gate's transaction is material on a hot commit path (then: batch
  the gate across a compile batch is already supported; a per-process write-coalescing design
  would be the next step).

## Alternatives considered

1. **Stamp the artifact records themselves (L0/L1/L2).** Rejected for this change: versioned
   schemas are checksum-locked and `additionalProperties: false`; stamping artifacts is a schema
   version bump. Attribution through the intent (written first, removed last) covers every
   uncommitted group without a schema change. Revisit if artifacts ever need attribution without
   their intent.
2. **Make the JSONL append itself the atomic gate (no SQLite row).** Rejected: a file append
   cannot be transactional with the epoch mark, so a resumed stale writer would still append a
   commit signal — the defect stands.
3. **Refuse to finalize anything once an epoch advanced (no projection).** Rejected: it rejects
   commits that were legitimately authorized before the handoff and can lose a commit whose
   signal never landed. The gate row is exactly what distinguishes "authorized, signal missing"
   from "never authorized".
4. **Fail open for unstamped intents on a fenced brain (finalize as legacy).** Rejected: it
   blesses whatever a pre-adoption writer left behind, including a complete stale set — the merge
   this ADR forbids.
5. **Hash-chain the epoch into artifacts.** Larger change; would alter existing chain semantics
   for derived verification; deferred until a consumer needs artifact-level epoch attribution.
6. **Do nothing (keep the residual documented).** Rejected on the trigger: a host needs
   orphan-free recovery after an in-mutation pause, and the residual is not merely orphaned
   artifacts — a resumed writer commits a stale mutation, which ADR-0007's text did not state
   precisely.

## Evidence (this change)

- **TDD**: `test/fence/storage-fencing.test.ts` (10 tests). RED on the drill-seam commit `5d67409`
  (no storage fence): 9/10 fail — the one pass is the legacy-unfenced compatibility test, which is
  designed to pass on both trees. GREEN on the implemented tree. Test-file sha256 identical in both
  runs (`91de7311b09cb3ddb9abd8a288ee073f3f019d982292075ac1b6d84ab2f5c2ac`). Outputs:
  `/opt/data/workspaces/brain-pilot-evidence/storage-fencing-20260915/red/` and `.../green/`.
- **Before/after drill** (`storage-fence-in-mutation`, gauntlet; pause inside OBSERVE after the L0
  artifact, frozen ~2.2 s across a lease handoff, then resumed):

  - **Before** (`5d67409`, boundary-fenced, storage-blind — probe `storage_fence_supported: false`):
    the resumed write **commits** (`201`) and the new owner's open-time recovery had already
    **finalized** the dead writer's set (`recovered: true`) — two commit signals for one operation.
    Verdict `residual-confirmed`.
    `/opt/data/workspaces/brain-pilot-evidence/storage-fence-before-20260915T1018Z/`
  - **After** (`c852aae`, `storage_fence_supported: true`): refused at the commit gate (`503
    fencing_token_stale`, **zero** commit signals; the partial L0 artifact retained), and the new
    owner's recovery reports `stale_epoch_rejected [{reason: epoch_behind_high_water, epoch: 1,
    high_water: 2, artifacts: 1}]` with zero committed/pending/manual-review. Verdict `pass`.
    `/opt/data/workspaces/brain-pilot-evidence/storage-fence-after-20260915T1020Z/`
  - Index: `/opt/data/workspaces/brain-pilot-evidence/storage-fencing-20260915/README.md`.
- **Full suite** on the committed tree: 536/536 vitest across 74 files (baseline 526 across 73).
- **Full gauntlet regression** on the after build, all 19 entries pass (incl. `lease-loss-steal`):
  `/opt/data/workspaces/brain-pilot-evidence/gauntlet-storage-fence-20260915T1025Z/`.
- **Repo gate** on the committed tree: `tsc` clean · `npm audit --omit=dev` 0 vulnerabilities ·
  `verify:schemas` 31 OK · `verify:saas` pass · `status:check` current.
- **Not proven / not covered:** artifact-level stamps (see Alternatives 1); the duplicate projection
  line in the post-gate interleaving (Consequences); non-intent writers (session bookkeeping,
  `runCommit` without a fence) are not epoch-gated; the arbiter remains single-node Redis in the
  pilot; fencing validates writers, not readers.
