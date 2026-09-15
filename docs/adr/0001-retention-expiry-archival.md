# ADR-0001 — Retention, Expiry & Archival

**Status:** Approved (owner sign-off 2026-09-10 — Tier-1 invariants §2.2 frozen; `staleness` block deprecated §2.4) — **Tier-1 invariant 5 and the §2.3 / §2.5 / §4-AC3 description of the `retention.expire` entry are superseded by [ADR-0013](0013-retention-sweep-commit-identity.md) (Proposed, 2026-09-15: the sweep always commits under an OperationId); the other four Tier-1 invariants stand unchanged.**
**Author:** @smarty-pants
**Date:** 2026-09-10
**Supersedes:** none
**Touches:** `src/layer0/types.ts` (enforcement, no schema change), `src/config.ts` (additive `retention` block), `src/protocol/observe.ts` (populate `retention_duration`), new `src/protocol/expire.ts` sweep, conformance tests.

---

## 1. Context

Smartware's raw evidence log (Layer 0) is append-only by design: observations are
tombstoned, not deleted, so the source of every derived claim remains auditable.
FORGET.SCOPE erasure physically purges Layer-1 claims and every derived lane, but
retains the original L0 evidence bytes on disk with effective status `erased`.
The net effect, absent any lifecycle policy, is **unbounded L0 growth** — the
"archive bloat" half of the earlier analysis.

Two adjacent axes are frequently conflated and must not be:

- **Freshness / staleness** — *"is this fact still current?"* A correctness
  concern. Smartware's design is already **state-based, never time-based**
  (spec §9.1: `unverified` / `EXTRACTED` / `FAILED`; superseded claims never
  satisfy recall). This ADR does **not** resurrect time-based freshness.
- **Retention / expiry** — *"how long does this data physically live?"* A
  lifecycle + legal concern. This is the missing piece.

**Verified current state (2026-09-10):**

- `RetentionPolicy = 'forever' | 'duration' | 'until_revoked'` is declared
  (`src/layer0/types.ts:28`), as is
  `Observation.policy = { retention, retention_duration, sensitive, pii_detected }`
  (`src/layer0/types.ts:109-114`).
- OBSERVE accepts `retention` (default `'forever'`) but hardcodes
  `retention_duration: null` — the `duration` and `until_revoked` policies are
  **unreachable** (`src/protocol/observe.ts:282-284`).
- `config.staleness = { default_half_life_days, scope_overrides, stale_threshold }`
  is declared (`src/config.ts:47-51`) but **inert**: `half_life`/`stale_threshold`
  are read only by `manifest.ts` for display, and `scope_overrides` is read
  nowhere. No half-life decay or staleness computation exists in the runtime.
- No expiry scheduler, archive path, GC, or retention enforcement exists.

## 2. Decision

### 2.1 Retention is a lifecycle axis, not a freshness axis

Retention/expiry governs **data lifecycle** (archive → tombstone → purge). It is
independent of staleness/freshness, which remains state-based. A fact can be
*stale* (superseded) yet *retained* (legal hold), or *current* yet *expired* by
policy (client offboarded). The two never share a mechanism.

### 2.2 Tiers — "set the knobs, never the guarantees"

**Tier 1 — Protocol invariants (fixed, not settable):**
1. Expiry is **archival/tombstone by default** — reversible and receipt-bearing.
2. Physical purge is a **separate, owner-gated** operation requiring a reason
   and writing an audit marker. Purge is never the default of expiry.
3. Expiry/purge **never fires under a legal hold or open dispute** — it defers
   to the FORGET.SCOPE hold lane (offboarding + export snapshot).
4. The L0 evidence of an expired (not purged) record is retained until an
   explicit purge; derived ≠ authoritative regardless of lifecycle state.
5. Every expiry/purge writes exactly one ops entry with exact counts and an
   audit marker — "silent deletion" is impossible by construction.

**Tier 2 — Owner/tenant policy parameters (settings, typed + bounded):**
- Retention policy and duration per scope, with a safe default of `forever`
  (opt-in to time-bound retention, never opt-out of the guarantee).
- Per-scope overrides (mirrors the existing `staleness.scope_overrides` shape).
- Which scopes are `sensitive` / `pii_detected` (already declared).

**Tier 3 — Integrator operational knobs (dev/deployer settings):**
- Sweep cadence, archive backend, GC batch size. Host-owned.

### 2.3 No new protocol verb or schema change (v0.5.0 → v0.6.0)

Retention is implemented as a **host-triggered lifecycle sweep** over the
already-declared retention fields — the same pattern as `drainCompileQueue`.
Expiry maps onto the **existing** replay-based effective-status mechanism
(`tombstoned`), with the ops entry carrying `reason: 'retention_expiry'` to
distinguish it from correction-driven forgetting. No new `EffectiveStatus`, no
new verb, no schema field is added: the v0.5.0 observation model already
declares everything this feature uses.

A dedicated `EXPIRE`/`RETENTION.SWEEP` protocol verb is **deferred** to a future
protocol version if and when multi-implementation conformance of the sweep
semantics is required — not before.

### 2.4 Config: additive `retention` block; deprecate inert `staleness`

```ts
// config.ts (additive; existing keys untouched)
retention: {
  default: { policy: 'forever' | 'duration' | 'until_revoked'; duration_days: number | null };
  scope_overrides: Record<string, { policy: RetentionPolicy; duration_days: number | null }>;
  expire_action: 'tombstone' | 'archive';   // 'tombstone' is the only v0.6.0 value; 'archive' reserved
}
```

- `staleness.default_half_life_days` / `stale_threshold` are **deprecated**
  (kept read-compatible for config round-trips, documented as legacy/unenforced;
  they never drove behavior). `staleness.scope_overrides` is superseded by
  `retention.scope_overrides`.
- OBSERVE gains a `retention_duration` parameter; when absent, it is derived
  from `retention.scope_overrides` → `retention.default`; when absent everywhere,
  `retention: 'forever'`, `retention_duration: null` (today's behavior).

### 2.5 Enforcement model

- **Sweep (`expire`, host-triggered):** for each observation whose resolved
  `retention_duration` has elapsed, mark it `tombstoned` via the replay path,
  purge its derived lanes (claim rows, FTS, vectors, pages) exactly as the
  existing tombstone/erasure paths do, and write one ops entry
  `{ op: 'retention.expire', reason, counts }`. Idempotent per `operation_id`.
- **Purge (`purge`, owner-gated):** physical reclaim is **scope-level erasure** via
  the already-shipped FORGET.SCOPE `erasure` (purges L1 claims + every derived
  lane, marks L0 `erased`, writes the deletion certificate). Record-level
  byte-purge of individual L0 evidence records is **deferred**: the append-only
  hash chain (each record's `previous_hash`) makes in-place byte removal unsafe
  by construction. The sweep already makes expired records non-retrievable; the
  scope-erasure path reclaims storage. A `purge` convenience surface is
  therefore unnecessary — `forgetScope({ reason: 'erasure' })` IS the purge.
- **Archive (reserved, not v0.6.0):** move L0 evidence to cold storage, retain a
  tombstone pointer. Deferred; `expire_action` locked to `'tombstone'` for now.
- Scheduler is **host-owned** (Coffee runs it, like `drainCompileQueue`); the
  substrate exposes only the idempotent, receipt-backed primitive.

## 3. Composition with erasure / legal hold / DSR (binding)

| Event | Retention/expiry behavior |
|---|---|
| Legal hold / open dispute | Sweep **skips** the held scope; data retained under FORGET.SCOPE offboarding semantics |
| Client erasure (DSR) | FORGET.SCOPE `erasure` (terminal) supersedes retention; no snapshot retained |
| Client offboarding | FORGET.SCOPE `offboarding` (tombstone + revoke, reversible); retention sweep treats tombstoned records as already-expired |
| Expiry while current | Tombstone + receipt; correctable/recoverable until purge |

## 4. Acceptance criteria (conformance)

1. OBSERVE with `retention_duration` → field populated (no longer forced null).
2. Per-scope override resolves before default; absent everywhere → `forever`.
3. `expire` sweep tombstones elapsed records, excludes them from recall/context,
   purges derived lanes, writes one ops entry with exact counts; idempotent.
4. Rebuild-equivalence holds after expiry (wipe + rebuild excludes expired).
5. `forgetScope({ reason: 'erasure' })` (owner-only, already shipped) is the
   physical purge + deletion certificate; refused for non-owner, refused under
   hold. No separate record-level purge surface in v0.6.0.
6. Hold scope is skipped by the sweep; erasure still overrides retention.
7. `staleness` config remains round-trippable (backward compatible).

## 5. Migration / rollback

- Config is additive; old configs load unchanged (retention defaults to
  `forever` = today's behavior — zero behavior change for existing tenants).
- `retention_duration` is a new-write population; existing observations are
  `forever` unless the sweep is explicitly configured. No data migration.
- Rollback = stop the sweep + remove the `retention` block; semantics revert to
  append-only `forever`. Fully reversible.

## 6. Approval required

Tier-1 invariants (5 items in §2.2) are protocol-level commitments. This ADR
requests owner sign-off on those invariants and on deprecating the inert
`staleness` block. Everything else (config shape, sweep, tests) is
implementation and proceeds on a feature branch pending that sign-off.
