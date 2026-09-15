# ADR-0011 — Coffee company-brain acceptance gate: the packaged artifact, a six-business fixture, and the surface it forced

- **Date:** 2026-09-15
- **Status:** Accepted (implemented; evidence in the `coffee-gate` run attached to card `t_9740ae98`)
- **Deciders:** Neo (Head of Technology) — card `t_9740ae98` (GATE run: realistic
  Coffee company-brain acceptance and soak)
- **Builds on:** ADR-0010 (Coffee reference adapter), ADR-0006 (export/restore
  return path), ADR-0007 (fence at the mutation boundary), ADR-0008 (host-facing
  health + Coffee-trial SLOs), ADR-0001 (retention expiry)

## Context

ADR-0010 shipped the Coffee adapter with a 53-check deterministic smoke: two
businesses, two replicas, one lease dance. That proves the contract's mechanics,
not the release question — *can Coffee run this as a company brain across shared
workspaces, staff and agents?* A company brain is consumed under load, across
businesses with colliding client names, by many actors with different grants,
through lifecycle events (offboarding, erasure, retention, restore) and through
failures (replica loss, restarts, hostile input).

The card is explicit: run the full accepted contract against the **packaged
artifact** and the reference adapter, not source internals; six businesses with
overlapping client names, multiple staff and agents, shared and private sources,
duplicate/paraphrased facts, contradictions, corrections, offboarding, erasure,
retention expiry, export/restore, replica failover and degraded reads; include
unauthorized fuzzing and restart during load; report exact gate count, failures,
p50/p95, resource growth, claim/evidence counts and all leakage checks. A partial
pass is a failed release gate.

## Decision

**1. The gate is a fixture plus a runner, and both live in this repository.**
`scripts/coffee-company-brain-fixture.mjs` is the acceptance fixture (79 checks,
one `PASS`/`FAIL` line each). `scripts/coffee-company-brain-gate.mjs` packs the
build (`npm pack`), installs the tarball into a scratch app (`npm install`), copies
the adapter and the fixture next to that install, and runs the fixture so every
import resolves through the installed package's own `exports` map. `npm run
verify:coffee-gate` is the entry point; the run writes `results.json`,
`summary.json`, `README.md` and the raw log into an evidence directory.

**2. The fixture models replicas as adapter instances over injected ports.** One
in-memory arbiter and app store are shared by six businesses × two replicas (as
one Redis would be); the clock is injectable so lease drills are deterministic;
every element carries a per-business marker, and every check that reads a response
scans it for foreign markers. Latency is measured in-process: the numbers state
what they cover (no Redis, no network).

**3. The smoke stays the unit proof; the fixture is the acceptance surface.**
Where they overlap the fixture re-derives the behaviour at product scale; the
smoke keeps the two-business determinism that runs in seconds.

**4. The fixture forced a surface extension.** Three operations the accepted
contract requires had no adapter path: the retention sweep (ADR-0001), the
restore return path (ADR-0006 §8), and a warranted correction (spec verb
CORRECT/REVISE — the only path that settles a disagreement by explicit action
rather than recency). The adapter now exposes them as lease-routed
pass-throughs — `expireRetention`, `restoreScope`, `correctClaim` — and
`coffeeTenantConfig` can grant the `forget` capability, which the template
previously never issued. A granted-but-unreachable capability is a contract
hole; the fixture closes it.

**5. Two defects were found by the gate and fixed in the same serialized lane.**
  - **FORGET.SCOPE desynchronised the raw-observation projection.** The audit
    marker is an accepted Layer-0 observation in the pod scope; a rebuilt index
    indexes every accepted observation, but the live commit did not index the
    marker. Consequence, measured: `health.drift.in_sync` turned `false` and the
    Coffee-trial SLO reported `breach` after **every** offboarding/erasure until
    the next restart — a company brain that says "your erasure went through"
    while its own health surface reports a drifted projection. Fixed in
    `forget_scope.ts` (index the marker with its effective status, so live ==
    rebuilt); regression test `S7` in `test/observability/health-contract.test.ts`
    (red first: `expected 1, received 0`, green after).
  - **The adapter accepted `client:<id>#0`.** `scopeForClient` rejects
    incarnation 0 as non-reusable, but the explicit-scope pattern accepted it, so
    a caller could write a scope the provisioning surface can never mint. Fixed
    by tightening `SCOPE_PATTERN` to `#[1-9]\d*`; the fuzz phase now proves the
    refusal.

**6. Measured consequences that are contract-conformant are recorded as
findings, not silently blessed or failed.** The gate emits a `findings` array
(grant-row revocation affects a staff member's other clients; the raw L0 evidence
JSONL keeps erased plaintext until the deferred L0 erasure path, spec §16; a
correction does not clear the counterpart's `contested` marking; an authenticated
caller failing brain authorization leaves a counted app-side divergence; the
deliberately provoked stale writer pushes delta-labs' stale_writer_refusals
objective to `breach`). Each is a reviewer decision with a measured number
attached, and the report labels it as such.

## Consequences

- **Release evidence is now reproducible**: one command, one evidence directory,
  artifact sha256 pinned, checks enumerated. The verdict is a gate count, not a
  summary: **79/79 checks pass** against `smartware-0.7.0.tgz` (sha256 in the
  run's `summary.json`) on this machine.
- **Restart-under-load is modelled in-process** (replica stop → standby takeover
  → rejoining standby; plus a process-death window between the two stores and its
  replay). The primitive was proved cross-process with real Redis and SIGKILL in
  the resilience gauntlet (`t_00a9df88`); an adapter-level cross-process drill
  over real Redis remains NOT YET PROVEN and is carried as such in the run notes.
- **The gate does not replace the conformance suite**: it is additive, runs in
  ~1 minute on the packaged artifact, and touches no normative text except this
  ADR and the adapter contract doc it extends.
- **Not proven after this cut** (also stated in the run notes): Coffee staging or
  production traffic; cross-process adapter drill over real Redis; L0 raw-content
  erasure (spec §16); storage-level fencing for a pause inside one mutation
  (ADR-0007's residual); reconciliation automation from the app store.
