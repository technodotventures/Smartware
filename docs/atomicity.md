# Crash-consistent canonical mutation commits

**Status:** Implemented for the beta mutation set

Smartware cannot use one filesystem or SQLite transaction for L0 evidence,
L1 claims, L2 pages, and the canonical operations log. It instead uses a
content-free operation intent plus an operations-log-entry-last commit
protocol. This provides deterministic recovery after one process terminates;
it is not a claim that every surface changes with instantaneous transactional
visibility.

## Commit protocol

For an operation carrying an `operation_id`:

1. Normalize the request, choose one commit timestamp, and compute the complete
   expected artifact identities and hashes.
2. Persist `operations/intents/<operation_id>.json` with mode `0o600` using a
   synced temporary file and atomic rename. The intent contains identities,
   hashes, counts, and replayable result metadata, never memory content.
3. Append or atomically replace the expected canonical artifacts in the
   operation's fixed order.
4. Append and sync one canonical operations-log entry last.
5. Remove the intent.

The operation ID and prepared timestamp correlate every artifact. The same ID
and payload replays the prior result; the same ID with a different payload
fails with `conflict`.

## Protected operations

| Operation | Expected canonical set |
|---|---|
| OBSERVE | One hash-chain-valid L0 observation |
| REVISE | One exact L1 claim version |
| FORGET | One hash-chain-valid L0 audit observation and, for a claim target, one exact forgotten L1 version |
| REVIVE | One exact active L1 claim version |
| ENDORSE | The complete expected L1 claim-version set and one exact L2 page |
| REFLECT automatic claim write | One exact L1 claim version per generated `reflect.auto` operation |
| REFLECT terminal observation receipt | One content-free operations-log checkpoint; no L0/L1/L2 artifact |

Protocol-facing hosts should require operation IDs on public mutation routes.
Smartware still permits some legacy direct calls without an operation ID;
those calls do not receive this guarantee.

Terminal observation receipts are deliberately separate from claim mutation
commits. They are appended only after an observation reaches
`ignored_context_only`, `ignored_short_content`, `no_claims`, or
`claims_processed`. If a process stops before that receipt, the observation may
be reconsidered; claim fingerprint/provenance idempotency prevents duplication.
Once present, the receipt prevents all later reflection passes from rescanning
the observation.

## Restart disposition

Startup runs recovery before serving requests or opening consumer databases.

| Persisted state | Disposition |
|---|---|
| Intent only | Client mutations remain resumable; an unmaterialized internal `reflect.auto` intent is removed so deterministic reflection can rerun. |
| Intent plus an incomplete but exact artifact subset | Remain pending; same-payload retry writes only missing artifacts. |
| Intent plus the complete exact, hash-valid set | Append the missing operation entry once and remove the intent. |
| Intent plus an exact matching commit | Remove the stale intent without duplicating artifacts or the commit. |
| Mismatched, corrupt, duplicate, or unexpected artifacts | Fail closed in `requiresManualReview`; do not rewrite memory. |
| Artifact with an operation ID but no intent or commit | Report as an orphan requiring manual review. |

L0 recovery also verifies the stored and recomputed hashes and the writer-chain
position. L1 and L2 recovery verifies exact identities, versions, actor,
timestamp, and record or content hashes. The canonical operations entry is
therefore written only when the expected set can be proven.

## Derived projections

Search indices, recall databases, SQLite caches, and compiled views are
rebuildable projections. REFLECT page compilation is rerunnable; each L1 claim
write it creates is protected separately. The manual Dream command consumes
the same recovery report but does not perform speculative repair.

## Limits

- Automatic quarantine is not implemented. Ambiguous append-only artifacts are
  retained for manual review.
- The tested guarantee covers single-process `SIGKILL` and retry recovery. It
  does not establish concurrent multi-writer serialisation.
- File appends and intent files are explicitly synced, but the suite does not
  claim sudden-power-loss guarantees for every filesystem and storage device.
- This implementation evidence does not by itself establish full
  Specification v1.6.16 conformance.

See [conformance-status.md](conformance-status.md) for the verified boundary
and accurate release claim.
