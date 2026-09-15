# ADR 0009 — Explicit legal-hold marker: erasure is refused, the sweep skips, release is audited

**Date:** 2026-09-15
**Status:** Accepted
**Deciders:** Owner (pre-production gate ruling on board card t_c5c999ba → implementation card t_463c1ff9); @tech-head (design + implementation)
**Supersedes:** ADR-0008 — the deferral ("the substrate gains no hold marker … until a trigger in §3 fires") is lifted: the owner has fired the trigger ahead of Coffee production.
**Interprets:** ADR-0001 §2.2(3), §3, §4 AC5–AC6 — now enforced literally by the substrate (refusal + explicit skip), replacing the ADR-0008 composition reading.

**Owner-facing:** the FORGET.SCOPE contract changes: `reason: erasure` is **refused** while a scope has an open legal hold; the retention sweep **skips** held scopes; the hold is **opened by the hold lane itself** (offboarding — the act every dispute/hold trigger already requires) and **released by a new owner-only audited act** (`hold.release`). Callers that never execute the hold lane see no behavior change.

---

## Context

ADR-0001 (owner-signed, Tier-1) is literal: *"Expiry/purge never fires under a legal hold or open dispute"* (§2.2(3)); §3: *"Legal hold / open dispute → Sweep **skips** the held scope; data retained under FORGET.SCOPE offboarding semantics"*; AC5/AC6: *"erasure … refused under hold"*, *"hold scope is skipped by the sweep"*. ADR-0008 measured that *composition* realized those clauses by construction (offboarding tombstones the scope's observations, so the sweep finds nothing; erasure was recorded, not gated) and deferred the explicit marker pending a trigger. The owner has now fired the trigger: the marker ships as a **pre-production gate** before Coffee launch (card t_463c1ff9), while v1 trial behavior stays composition-shaped.

Two failure modes ADR-0008 named shape the design and must not be re-created:

1. **A marker that can be forgotten at the moment of the dispute** (the product intended a hold but never set one, so erasure stays unrefused) — therefore the hold is *not* a separate act: **the hold lane IS the hold open.** Every dispute/hold trigger already executes offboarding (binding rule §10c.3); offboarding now opens the hold in the same commit.
2. **A stale hold flag silently blocking a statutory DSR erasure** — therefore release is a first-class, one-step, audited owner act, and the refusal is **loud and precise** (`legal_hold_open`), never a silent no-op. The release statement is where the "hold released / no pending dispute / request verified" attestation is canonically recorded.

## Decision

**Legal hold becomes explicit substrate state in `config.holds`, opened by the hold lane (`FORGET.SCOPE offboarding`), consulted by `FORGET.SCOPE erasure` (refused while open) and by the retention sweep (skipped while open), and closed only by an audited owner act (`hold.release`).**

### 1. Surface — `config.holds`

Additive config (absent in pre-marker configs ⇒ no hold state). One entry per scope that has taken the hold lane:

```
holds: {
  "client:acme#1": {
    scope: "client:acme#1",
    opened_at: <ISO 8601>,
    opened_by: <owner actor id>,
    operation_id: <offboarding op id | null>,
    released_at: <ISO 8601 | null>,
    released_by: <owner actor id | null>,
    release_operation_id: <op id | null>,
    release_statement: <string | null>
  }
}
```

`isScopeHeld(config, scope)` ⇔ an entry exists with `released_at == null`. The record is content-free: ids, timestamps and a non-PII statement phrase (same rule as the erasure attestation).

### 2. Open = the hold lane

`FORGET.SCOPE { reason: 'offboarding' }` opens (or refreshes) `holds[scope]` in the **same commit** as its tombstone + grant revocation (same config save). The ops entry carries `hold_opened: true`. Re-executing the lane after a release opens a **new** hold (a new preservation duty). An idempotent replay of a committed offboarding returns the recorded result and does not re-mutate config (`committedResult` path is unchanged). Post-hold writes into a held scope remain possible (owner writes, owner_pointer flow); they are preserved (see §4).

### 3. Erasure is refused while held

`FORGET.SCOPE { reason: 'erasure' }` on a held scope throws `ProtocolError('legal_hold_open', …)` **before any mutation and before the operation_id is consumed** — no ops entry, no intent, retryable after release. A *committed* erasure replayed by `operation_id` still returns its recorded result: idempotency wins over current state. Erasure of a released (or never-held) scope is unchanged, including the existing optional `attestation` and `export_id` fields — payload identity for existing callers is preserved.

### 4. Sweep skip

`expireRetention` on a held scope expires **0** observations, writes **no** evidence bytes, and records the skip in its ops entry (`details.skipped = 'legal_hold'`; result carries `skipped_reason: 'legal_hold'`). Retention expiry does not fire under a hold — this includes evidence written into the scope *after* the hold: it is preserved, not tombstoned. This supersedes ADR-0008 finding 2 (under composition an elapsed sweep tombstoned post-hold writes non-destructively); the literal Tier-1 invariant is now the behavior.

### 5. Release = audited owner act with a receipt

New substrate operation `hold.release` (ops-log op `hold.release`; MCP tool `smartware_hold_release`; core `releaseHold`):

- owner-only (`requireOwner`);
- idempotent per `operation_id` — replay returns the recorded receipt; a different payload ⇒ `conflict`;
- writes `released_at` / `released_by` / `release_operation_id` / `release_statement` into `holds[scope]` and appends **one** ops entry carrying `payload_hash`, `scope`, `released_at`, `statement`;
- refuses a scope with no open hold with `no_open_hold`, except the crash-retry case where the config already records this `operation_id` (the ops entry is finalized);
- **does not revive:** the scope stays offboarded (tombstoned claims, revoked grants, retained bytes) until erasure or a `#N` return;
- the release record **persists after erasure** (content-free audit).

Pinned by `test/conformance/r_legal_hold_composition.test.ts` (R1–R4) and the C8 scenario of `test/conformance/q_lifecycle_composition.test.ts`.

### 6. Composition retained

Offboarding still tombstones + revokes (recall stays silent); export-before-erasure is unchanged; erasure remains the terminal purge with the deletion certificate; the erasure `attestation` field remains valid. The release statement is the canonical home for the hold-release attestation; recording it in both places is allowed — both are receipts.

### 7. Protocol bookkeeping

The FORGET.SCOPE section of `docs/protocol/smartware-protocol-v0.5.0.md` gains the hold gate as a dated (2026-09-15) note; the v0.5.0 ops-log schema op enum gains `hold.release` (additive; `SHA256SUMS` regenerated). No FORGET.SCOPE request/result shape changes; the v0.4.2 schema set is untouched. `hold.release` is a substrate lifecycle operation (like `retention.expire`), not a new conformance verb.

## Consequences

- **AC5/AC6 are enforced literally by the substrate.** ADR-0008's wording reconciliation is retired; ADR-0001's realization note is updated to point here. No AC text or §2.2 text is edited (ADR rule 2).
- **Every dispute-path erasure gains a substrate-recorded release prerequisite.** A flow that offboards then erases without releasing gets a loud `legal_hold_open` refusal; the remedy is one audited owner act. This is the accepted cost of a substrate-verifiable refusal.
- **Minimization defers under a hold by design.** Held scopes keep everything — that *is* the preservation duty; it ends at release.
- **Migration (honest scope).** Holds exist only for hold-lane executions that happen after this change ships: a scope offboarded earlier has no hold entry and erases as before — grandfathered, because no preservation duty was opened through the marker. Config is additive: old configs load unchanged.
- **`config.holds` is provisioning state, not canonical truth.** The canonical record of every open/release is the ops log; a hand-edited config can drift from it. The refusal/skip read config; every act writes a receipt. Tamper-evidence of the marker itself is not claimed.
- **Reversal trigger:** if the release requirement proves operationally unsafe (e.g. a real statutory deadline is missed because a release was not performed in time), revisit the *release act's preconditions* (e.g. allow a time-boxed, owner-notified auto-release) — not the refusal, and not by silent re-composition.

## Alternatives considered

1. **Keep ADR-0008 composition (no marker).** Rejected by owner ruling: the substrate itself cannot refuse or skip, so a tenant/auditor cannot verify hold state from the substrate, and an erasure under a hold depends entirely on flow discipline.
2. **A separate `hold.open` act, or config-provisioned markers.** Rejected: re-creates ADR-0008's failure mode 1 — the hold must be set by the product at dispute time, and a forgotten open leaves erasure unrefused. The hold lane (offboarding) is already mandatory on every dispute/hold trigger (§10c.3), so opening there is free and unforgettable.
3. **Derive the refusal from the log (ADR-0008 alternative 2).** Still cannot skip the sweep (AC6), and converts a recording seam into a gate without state; superseded by the marker.
4. **Skip the sweep only while the scope's records are non-terminal (composition skip).** Rejected: "expiry never fires under a hold" is the owner-signed invariant; a post-hold write with elapsed retention must survive, and only explicit hold state can say so.

## Amendment — 2026-09-15 (card t_7a64ded2; findings from independent verification t_55fdccdd)

Independent adversarial verification of this decision passed the gate and raised three hardening findings. All three are fixed; the decision above is unchanged.

1. **`operation_id` is required on `hold.release`** (refused before any mutation — core `invalid_parameter` for an absent or malformed key; at the MCP boundary an absent field fails the transport's input validation before the handler runs). §5 called the act audited, but the key was optional at the MCP boundary, so a keyless release performed the act with **no** ops entry — an unaudited claim. The receipt is now unconditional, and the house convention matches `smartware_forget_scope`.
2. **Replay converges state.** The §5 receipt replay returned the recorded result without re-publishing it, so a lost config write (the old `saveConfig` was a non-atomic, non-fsync `writeFileSync`) could leave the log saying "released" while the scope still read OPEN — fail-closed, but a same-`operation_id` retry reported success and never lifted the hold. Replay now re-applies the recorded release to `config.holds` when the scope still reads open, and `saveConfig` writes atomically with fsync (temp file → fsync → rename → directory fsync), closing the window that produced the divergence. Convergence is **duty-scoped**: the receipt records the offboarding operation it released (`hold_operation_id`), so a hold opened after the release — a new duty per §2 — is never lifted by a stale replay.
3. **The v0.5.0 ops-log enum now lists every op the substrate writes.** `consolidate`, `reflect.explicit` and `retention.expire` join `hold.release` (additive only; `SHA256SUMS` regenerated). Those receipts previously failed validation against the published set — including this marker's own sweep-skip receipt, whose `op` is `retention.expire`.

Pinned by `test/conformance/r_legal_hold_composition.test.ts` (R1–R7) and `test/schemas-v0.5.0.test.ts`.
