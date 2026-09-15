# ADR-0007 — A fencing token validated at the brain mutation boundary

- **Date:** 2026-09-14
- **Status:** Proposed (implemented and evidence-backed in this change; operator sign-off pending)
- **Deciders:** Neo (Head of Technology) — closing the residual single-writer window the
  resilience gauntlet (kanban `t_00a9df88`) stated as an honest limit
- **Supersedes:** —

## Context

A brain is **single-writer**, but a SaaS runs replicas, so ownership is arbitrated outside the
brain: the pilot uses a Redis lease with a compare-and-extend renewal, and every brain mutation
is preceded by a host-side guard that re-verifies ownership immediately before the call
(measured: guard catches a lost lease in 9 ms; handoff stops the old owner in 163 ms —
gauntlet `postfix2`, `/opt/data/workspaces/brain-pilot-evidence/gauntlet-postfix2-20260914T165142Z/`).

That still leaves a **window between "guard passed" and "write committed"**. The lease says who
*should* own the brain; it cannot stop a process that owns a stale handle from committing, and a
stall of ≥ TTL between the guard and the commit hands the brain to a new owner while the old
process is still holding a write. Two processes then write beside each other — the exact
split-brain the lease exists to prevent. The gauntlet README and
`docs/integration/saas-integration.md` §1h recorded this as a **residual limit**: "closing it
needs a fencing token validated at the brain's commit boundary — not implemented".

A lease alone cannot close this by construction: the lease holder's belief is in its own memory,
and the arbiter is outside the resource. What a resource *can* do is refuse a write that
presents an **epoch older than the last epoch it has seen**. That is a fencing token
(Kleppmann), and for file-backed stores it is implementable with the serialisation the brain
already has: SQLite (`smartware.db` is shared by every process that opens the brain, and SQLite
serialises writers across processes).

Constraints that shaped the design:

1. **Additive on the unreleased 0.7.0 line.** Existing hosts open brains and write without any
   ownership story; they must not break.
2. **The arbiter stays outside the brain.** The token is issued by the host's lock service
   (Redis `INCR` in the pilot), monotonic per acquisition; the brain only *enforces* monotonicity.
   A brain-issued token cannot order two processes that both opened it — the exact failure.
3. **Refusal must be precise and priced.** Code-carrying `ProtocolError`, before any canonical
   artifact (evidence JSONL, claim version, ops entry) is written, auditable afterwards.
4. **The guard must be cheap on the known-good path.** The pilot's write p50 is 13.1 ms; the
   fresh-token path may not measurably regress (re-verified by a same-session alternated A/B —
   see Evidence).

## Decision

**`SmartwareCore` gains an optional fencing guard: a writer presents a monotonic epoch token;
the brain persists the highest epoch it has seen and refuses, with a code-carrying
`ProtocolError` before any artifact is written, any mutation carrying an older epoch.**

Specifics:

- **Surface (embedded-core seam, session-scoped — not per-call).** The token belongs to an
  ownership term, not to an individual call, so it is attached to the core writer session:
  - `SmartwareCore.open({ dataDir, ownerId, fencingToken?: number })` — optional; when present the
    session is fenced and the token is **claimed at open** (fail-fast: a stale owner cannot open
    a claim on a newer epoch).
  - `core.claimFence(token)` — register a new epoch mid-session (takeover without reopen);
    refuses `fencing_token_stale` when the token is below the persisted high-water mark.
  - `core.fencingState()` — `{ enabled, token, high_water, refusals, last_refusal }`, the
    auditable surface.
- **Persisted state**: one row in `smartware.db` (`writer_fence`: `high_water`, refusal counter,
  last refusal op/token/high-water/timestamp). Claim and guard decisions are single SQLite
  statements (claim runs in an IMMEDIATE transaction), so they serialise with every other process
  that has the brain open.
- **Guard placement**: the first step of every canonical mutation on the core
  (`observe`, `ingest`, `compile`, `drainCompileQueue`, `correct`, `revise`, `forget`,
  `forgetScope`, `restoreScope`, `expireRetention`, `consolidate`, `revive`, `endorse`,
  `quarantineReview`, `grant`, `revoke`, `dream`, `registerSource`, `ensureScopes`,
  `createPodProfile`, `ensureTrustedClientGrant`). Session bookkeeping, derived-index writes
  (e.g. freshness labels, semantic sync) and reads are not canonical mutations and are not
  gated.
- **Fail-closed once fenced; unchanged until then.** A brain that has never seen a claim
  (`high_water = 0`) behaves exactly as before. After the first claim, any writer without a
  token is refused `fencing_token_missing` (fail-closed on the unknown epoch); a writer with an
  older token is refused `fencing_token_stale`. Both refusals are counted in `fencingState()`,
  and the thrown error carries `details: { op, token, high_water }`.
- **What is now closed**: any mutation whose boundary check executes after a higher claim has
  committed is refused with **zero canonical artifacts written** — including a mutation resumed
  from a stall between the host's ownership guard and the brain call, at any stall length.
- **What is not** (see Consequences): a pause *inside* one mutation, after its boundary check and
  before its last artifact write, can still leave partial artifacts; the ops entry (the durable
  commit signal) is still written last, so recovery treats the set fail-closed. Storage-level
  fencing — stamping the epoch into intents/artifacts and validating it in recovery — is the
  follow-on if a host needs that case closed too.

## Consequences

- A host that adopts fencing has a brain-enforced invariant: after epoch `n` is claimed, no
  mutation presenting epoch `< n` can be committed — regardless of what the old process believes
  or how long it was stalled. The host must issue tokens from the same arbiter as the lease
  (pilot: `INCR brainfence:<identity>` on each ownership acquisition) and must not reuse tokens
  across ownership terms.
- Refusals are **operationally visible**: HTTP hosts can route on the code (the pilot returns
  `503 { retryable: true, code: fencing_token_stale }` and records the divergence), and the
  brain's `fencingState()` records count + last refusal. A refusal is not a crash and needs no
  manual repair.
- Enabling fencing on an existing deployment is a **one-way door in practice**: once claimed,
  tokenless writers are refused. A host that stops sending tokens must resume with a token
  `>= high_water`, or restore the pre-fencing backup. (Failure is loud and code-carrying, not
  silent corruption — the accepted trade.)
- **Kill switch:** none by design. Disabling fencing after adoption re-opens the split-brain
  window silently, so the supported "rollback" is restoring the pre-fencing backup (same as
  ADR-0006's upgrade rule). Reversal trigger: a host that needs tokenless writes after adoption
  and can state why fail-closed is unacceptable.
- The guard reads (usually) a single row; steady-state cost is one indexed SELECT per mutation,
  and a write only when a token *advances* the high-water mark (once per ownership term on the
  happy path). Measured on the pilot path (same-session alternated A/B, 5 pairs × 40 writes per
  arm, fenced `c65b302` vs unfenced `9cbe1fb`): p50 median 15.96 ms vs 15.62 ms (+0.34 ms,
  inside run-to-run spread), p95 noise-dominated — not a measurable regression.
- **Not closed / not proven**: (1) an in-process pause between the boundary check and the last
  artifact write can still land orphaned artifacts (never a committed ops entry) — recovery
  reports them for manual review; (2) fencing validates writers, not readers — a stale process
  can still read; (3) token issuance quality is the host's responsibility — a lock service that
  re-issues a token breaks the guarantee without breaking the API; (4) the pilot's arbiter is
  single-node Redis, not a partition-tolerant consensus store.

## Evidence (this change)

- **TDD**: `test/fence/fencing-token.test.ts` (6 tests) fails 6/6 on the parent commit
  `8d24717` and passes 6/6 on the implemented tree — red/green runs recorded under
  `/opt/data/workspaces/brain-pilot-evidence/fencing-tdd-20260915T083124Z/` (test-file sha256
  identical in both runs).
- **Before/after drill** (`lease-loss-steal` phase A, deterministic post-guard stall + SIGSTOP
  across a lease handoff): unfenced `9cbe1fb` — the stalled write **commits** on resume (the
  residual window, demonstrated); fenced `c65b302` — the same write is refused before any
  artifact with `fencing_token_stale`. Runs:
  `/opt/data/workspaces/brain-pilot-evidence/gauntlet-fencing-before-20260915T083255Z/` and
  `/opt/data/workspaces/brain-pilot-evidence/gauntlet-fencing-after-20260915T083414Z/`.
- **Latency A/B**: `/opt/data/workspaces/brain-pilot-evidence/latency-ab-20260915T083526Z/`.
- **Full-suite regression** on the fenced build (all 19 gauntlet drills, incl. this one):
  `/opt/data/workspaces/brain-pilot-evidence/gauntlet-fencing-20260914T182639Z/`.
- **Repo gate** on the committed tree: `tsc` clean · 526/526 vitest across 73 files ·
  `verify:schemas` 31 OK · `verify:saas` pass · `status:check` current (recorded with kanban
  `t_9ee8bd54`; the repo journal entry is projected from the board by the substrate sync).

## Alternatives considered

1. **Per-mutation token parameter (`observe({ ..., fencing_token })`).** Rejected: changes every
   public parameter type, forces hosts to thread a value that is constant for an ownership term,
   and makes it easy to forget on one call — a silent hole in a whole-brain invariant. The
   session-scoped token makes "am I fenced?" a property of the writer, not of each call.
2. **Brain-issued tokens (the brain hands out epochs itself).** Rejected: the brain cannot order
   two processes that both opened it — whichever opens second would receive the higher epoch and
   the first would be fenced by opening order, not ownership order. The arbiter must be the
   component that already arbitrates ownership.
3. **Advisory fencing (log stale writes, allow them).** Rejected: it does not close the window it
   exists to close, and it teaches operators that split-brain writes are normal. The fail-closed
   default is the point.
4. **Fail-open when fenced-but-tokenless.** Rejected: a host that forgot its token after adoption
   would silently run unprotected. Fail-closed makes the mistake loud; the recovery (present a
   current token) is trivial.
5. **Storage-level fencing now (epoch stamped on intents/artifacts/ops entries, validated by
   recovery).** Deferred, not rejected: it closes the in-mutation window but touches every
   canonical writer and the recovery dispositions table (`docs/atomicity.md`) — a larger,
   separate change. This ADR's boundary check is the smallest complete slice that closes the
   window the gauntlet measured; storage-level fencing is the follow-on trigger when a host
   needs orphan-free pauses inside a mutation.
6. **Rely on the lease TTL alone (do nothing).** Rejected: the gauntlet documented the residual
   window with a measured handoff drill; leaving it undocumented-as-closed would overstate the
   product's single-writer claim.
