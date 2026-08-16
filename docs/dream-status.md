# Smartware Dream Status

**Status:** Manual operator inspection; safe beta subset

## Current behavior

`SmartwareCore.dream` runs the six default phases once for one scope: Verify,
Extract Relations, Detect Conflicts, Recompile Pages, Check Capacity, and Find
Orphans. Hosts may expose this owner-authorized primitive through their own
transport.

There is no background scheduler. Each phase records one canonical
operations-log outcome, while the detailed run manifest is an atomic,
discardable report under `derived/dream`. Apart from exact operation recovery,
Dream does not write canonical L0 observations, L1 claim versions, or L2 pages.

The phase output is conservative:

- relation candidates are derived and content-hashed, not admitted as
  canonical edges;
- suppressed, redacted, rejected, quarantined, or effectively tombstoned
  observations are excluded from relation extraction;
- duplicate active fingerprints are reported as data-quality duplicates, not
  asserted as contradictions;
- bounded near-duplicate clusters and same-subject/predicate alternative-value
  groups are emitted as review candidates only; no claim is merged, suppressed,
  or marked contested;
- recent checkpoint claims produce a bounded orientation-card source manifest;
  the manifest contains claim identifiers rather than generated assertions;
- page recompilation is skipped unless an explicit operator callback is
  supplied; and
- no phase changes confidence, epistemic tags, retention, or canonical memory.

## Recovery boundary

Verify and Find Orphans consume the same fail-closed startup scanner used by
the embedded core. For intent-backed OBSERVE, REVISE, FORGET, REVIVE, ENDORSE,
and automatic REFLECT claim writes, it may append a missing operations-log
entry only when the complete expected artifact set is exact and hash-valid.
Intent-only or exact partial client operations remain pending; unmaterialized
internal `reflect.auto` intents are safely aborted for recomputation.

Mismatched or unexpected artifacts remain in `requiresManualReview`. Legacy
artifacts without a correlatable operation identity cannot be repaired.
Automatic quarantine is not implemented, so ambiguous append-only artifacts
are never moved or rewritten.

Dream is therefore an owner-triggered inspection and deterministic recovery
surface, not autonomous memory consolidation. Scheduling is a host concern,
and canonical repair remains out of scope for beta.
