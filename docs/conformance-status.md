# Implementation conformance

**Target:** Specification v1.6.16, Protocol v0.4.2, Schemas v0.4.2

Smartware is beta software. The repository provides executable evidence for
the implementation boundaries below; it does not claim exhaustive
Specification v1.6.16 conformance.

## Verified baseline

- The TypeScript package builds on the supported Node.js versions.
- All 15 v0.4.2 schemas compile and match the committed checksum manifest.
- The standalone suite passes 316 tests across 48 files with no skips.
- Tests exercise OBSERVE, RECALL, REFLECT, REVISE, FORGET, REVIVE, ENDORSE,
  access control, sessions, context delivery, retrieval eligibility,
  reflection receipts, and recovery behavior.
- The packed package exposes the embedded `SmartwareCore`, the side-effect-free
  MCP adapter, the CLI, and the frozen schemas.
- The stdio MCP transport is exercised end to end.
- The nine-scenario retrieval-kernel contract passes with zero forbidden hits.
- The activation contract fails closed on public development evidence, as
  required.
- `npm audit --omit=dev` reports zero production dependency vulnerabilities.

Host products must separately test their adapters, transports, persistence,
and user-facing authorization against the exact Smartware version they ship.

## Crash-recovery boundary

Operation-ID-backed OBSERVE, REVISE, FORGET, REVIVE, ENDORSE, and automatic
REFLECT claim writes persist a content-free expected-artifact intent before
canonical mutation.

Startup recovery:

- commits only a complete, exact, hash-valid artifact set;
- leaves exact partial client operations resumable;
- safely discards an unmaterialized internal `reflect.auto` intent so
  deterministic reflection can retry;
- removes stale intents after finding their exact commit; and
- leaves every mismatch untouched in `requiresManualReview`.

The exact ordering and recovery state table are documented in
[atomicity.md](atomicity.md).

## Remaining limits

- Legacy direct calls without an operation ID are outside the recovery
  guarantee.
- Automatic quarantine is not implemented; ambiguous append-only artifacts
  remain available for manual review.
- The suite does not prove concurrent multi-writer serialization or universal
  sudden-power-loss durability.
- REFLECT page output and search databases are rerunnable projections rather
  than one transaction spanning the entire compilation run.
- Passing schemas and behavioral invariants is not an exhaustive
  requirement-by-requirement proof of Specification v1.6.16.

## Accurate release claim

The tested beta boundary is:

> Idempotent, crash-consistent local mutation commits that recover after one
> process terminates and the operation is retried.

Smartware must not be described as providing general ACID filesystem
transactions, automatic repair of ambiguous memory, concurrent multi-writer
safety, or full Specification v1.6.16 conformance.
