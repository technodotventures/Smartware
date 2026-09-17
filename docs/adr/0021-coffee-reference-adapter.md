# ADR-0021 — Coffee reference adapter: public-surface ports, settle-before-write, and a deterministic local proof

- **Date:** 2026-09-15
- **Status:** Accepted (implemented and evidence-backed in this change; the
  contract is the review surface, Coffee staging remains the integration gate)
- **Deciders:** Neo (Head of Technology) — card `t_ba868906` (P1 build: Coffee
  reference adapter for workspaces, staff and agents)
- **Builds on:** ADR-0006 (export/restore return path), ADR-0007 (fence at the
  mutation boundary), ADR-0008 (host-facing health), the resilience gauntlet
  (`t_00a9df88`) and its host-side patterns (saas-integration.md §1h)

## Context

Coffee needs to consume Smartware as a company brain for shared workspaces,
human staff and agents. The substrate is proved at the conformance level (Coffee
tenant shape, grants, scopes, export/forget, fleet behaviour), but a host cannot
integrate a substrate — it integrates a *contract*: which calls, in which order,
with which failure and retry semantics, under which ownership rules, with which
credentials.

The pilot (`brain-pilot`) proved the hard parts end to end — lease arbitration,
the pre-mutation guard, fencing, drift-on-divergence, degraded reads — but it is
a throwaway app with a Redis client baked in, its own HTTP surface, and imports
that predate `exports` enforcement. It is evidence, not a drop-in.

Coffee staging is unavailable, so the integration cannot be proved there in this
cut. The deliverable must therefore be executable **locally and deterministically**
by the Coffee engineer, against the published package surface, with no Redis and
no model key.

## Decision

**1. Ship the adapter as a public-surface example in this repository, not as a
second package.** It lives in `examples/coffee-adapter/` and imports only
`smartware`, `smartware/layer1`, `smartware/layer1/*`, `smartware/layer3`,
`smartware/render`. The package's `exports` map then *enforces* the consumer
contract: a deep `dist/...` import becomes a load-time failure rather than a
review comment. A separate npm package would version-lock an integration that
must be adapted to the host's own ports and schema.

**2. The host's infrastructure enters through two ports, not a driver.** The
adapter carries no Redis dependency: `ports.appStore` (authoritative app store)
and `ports.arbiter` (lease + monotonic epoch) are injected. The contract for the
arbiter's renewal is **compare-and-extend**, and the reason is measured: the
smoke reproduces the dual-owner hazard of existence-only renewal (`SET .. XX`)
and shows the contract refusing it. If the adapter shipped a Redis client, the
host could adopt a renewal that looks harmless and corrupts ownership.

**3. Ownership is settled before either store is touched, and the fence is the
second line.** Every write (a) refuses outright on a standby, (b) renews the
lease with a compare-and-extend before the first write, and (c) submits to the
brain's monotonic epoch, which refuses a *stalled* writer before any canonical
artifact. The division is deliberate: the guard covers the request boundary, the
fence covers the gap between the guard and the mutation — the residual window
ADR-0007 exists to close.

**4. The app store is authoritative; the brain is additive; divergence is
counted, not hidden.** Writes land in the app store first, then the brain
(`observe`, then the host's claims through the public admission seam). A brain
refusal after the app write is reported with `partial_write: true` and a
per-scope drift counter. No cross-store transaction is pretended.

**5. The substrate is the authority for grants on the brain path.** The adapter
validates actor *shape* (fail closed) but does not re-derive authorization when
the brain is reachable: the substrate's codes (`insufficient_permission`,
`actor_unregistered`, `owner_required`, …) surface verbatim, and a denial is
never answered from the fallback. On the degraded path — where no brain exists
to enforce anything — a config-derived precheck fails closed and every response
says so. Re-implementing policy on the hot path would create a second, weaker
authority.

**6. `operation_id` is the retry key and the honesty boundary.** With it, both
halves of a write are idempotent (the app store dedupes by operation id; the
brain replays or completes the same observation), so refusals that wrote no
canonical artifact are safe to retry — including a fenced refusal, which is
completed by re-issuing against the new holder. Without it, retries duplicate
app records; the contract says so instead of implying safety.

**7. Identity comes from the provisioning surface, never the mount path.** Lease
keys, app-store keys and drift keys derive from `workspace_id` + `instance_id` in
the brain's own `config.json`, so replicas that mount the same volume
differently still contend for one lease, and two businesses never share a key
even when both have a client named `acme`.

**8. The acceptance artifact for this cut is a deterministic local proof.**
`npm run verify:coffee-adapter` runs the real adapter against in-memory ports on
a built package: no Redis, no network, no model credential, no wall-clock
dependence (`hooks.afterGuard` is the documented seam that models the stall the
guard cannot cover). It is the executable form of the contract document, and its
output is the evidence recorded in the journal.

**9. No model credential enters the memory layer.** Extraction stays in Coffee's
pipeline; the adapter persists the claims the host already extracted, and the
tenant template ships `llm.provider: 'none'`.

## Consequences

- A Coffee engineer can run the contract locally and see every refusal and
  degraded answer before touching staging; the smoke's check list is the
  integration checklist.
- The adapter adds no dependency and no package to Coffee's build. Its imports
  break loudly if the public surface moves.
- The drift counter is a *detector*, not a reconciliation system: it counts
  divergences this process observed. Reconciling from the app store remains the
  host's job, and the contract says so.
- Denials on the write path can leave an app-side record (the app store is
  written first). That is the accepted cost of app-store authority; the response
  carries `partial_write`/`drift_total` so the host can route or reconcile.
- The adapter is a reference: Coffee may fork it, but the contract document and
  the smoke are the things to keep in sync — a fork that changes semantics
  without changing the check list is drifting silently.
- **Not proven here:** Coffee staging traffic, real-Redis behaviour under
  replicas (the pilot measured the Redis-shaped paths; the smoke measures the
  contract), and the storage-level residual inside a mutation (ADR-0007).

## Alternatives considered

- **A Redis-dependent adapter (ship the driver).** Rejected: it would couple the
  memory layer to Coffee's client shape, make the deterministic local proof
  impossible without a Redis dependency, and let a host adopt a renewal semantic
  the adapter silently depends on. The ports make the requirement explicit and
  testable.
- **Publish `@techno/coffee-adapter` as a package.** Rejected for this cut: a
  package would pin an integration that is by nature host-shaped (auth, schema,
  ports), and would add a second release surface before a single host has
  integrated it.
- **Precheck grants on the write path too (refuse before the app write).**
  Rejected: it re-implements substrate policy in the host's process, where it
  can silently diverge from the brain's rules (expiry, patterns, sessions). The
  adapter instead returns the substrate's own refusal code; the cost — a
  possible app-side record for an unauthorized write — is explicit, counted, and
  the caller's contract violation to fix.
- **Brain-first writes (observe, then the app store).** Rejected: the brain
  would remember messages the product never accepted — memory that cannot be
  shown, against app-store authority.
- **Automatic reconciliation worker in the adapter.** Deferred: it would need
  host policy (what to replay, what to discard, when). The counter and the
  receipt-shaped response give the host what it needs to build that policy
  deliberately.
- **Prove it through the MCP surface instead of in-process.** Rejected for this
  cut: Coffee's backend is in-process and already owns identity and scheduling;
  MCP would add a transport hop with no new capability, and the ports would be
  the same.
