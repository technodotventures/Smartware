# ADR 0008 — Legal hold is composition, not a substrate marker

**Date:** 2026-09-14
**Status:** Accepted
**Deciders:** @tech-head (card t_c5c999ba, on the lifecycle-composition lane t_ad51d0e2)
**Supersedes:** —
**Interprets:** ADR-0001 §2.2(3) and §4 AC5–AC6 (wording reconciliation, §4 below); spec §10c.3 / §10c.7 (closes open decision 4 of §10c.7)
**Owner-facing:** this ADR changes no protocol surface and no acceptance criterion. It answers the §10c.7 open question "v1 composition or explicit legal-hold marker?" with **composition**, and it names the trigger that would requeue the marker to the owner (§3). Building the marker still needs owner sign-off; nothing here spends it.

---

## Context

ADR-0001 (owner-signed, Tier-1 invariants frozen) commits the substrate to: *"Expiry/purge never fires under a legal hold or open dispute — it defers to the FORGET.SCOPE hold lane (offboarding + export snapshot)"* (§2.2 (3)), with acceptance criteria 5–6 written as the shorthand *"erasure … refused under hold"* and *"hold scope is skipped by the sweep"* (§4). §10c.3 binds the product rule (a dispute never triggers erasure; erasure runs after the owner attests the hold released; the attestation is recorded — implemented t_ad51d0e2 as `details.attestation`), and §10c.7 defers the **explicit legal-hold marker** to G4 with "v1 = composition (offboarding + export + attestation)".

No substrate hold state exists: no config surface, no scope state, no sweep skip, no erasure refusal. The open question this ADR closes is whether to build one.

**Measured before deciding** (`test/conformance/r_legal_hold_composition.test.ts`, live core, `client:acme#1` with a 1-day retention override and an elapsed observation — i.e. the case the C8 scenario could not exercise, because its evidence was `forever`-policy and therefore never time-bound):

1. The hold lane (offboarding) tombstones every observation in the scope in the same act that opens the hold. A sweep over the held scope expires **nothing** (0), writes **no bytes** — the "skip" is by construction: the sweep only targets `accepted` observations, and a held scope has none.
2. Evidence observed **after** the hold lane executes is *not* skipped: an elapsed sweep tombstones it (1). Tombstone-only, though — L0 bytes are retained (the tombstone is appended, nothing removed), the record stays in the canonical log, and a post-sweep F1 export of the held scope still carries **every** observation row (`deletion_certificate: null`).
3. Erasure **with no attestation**, on a scope that took the hold lane, **succeeds** (terminal, scope entry removed) and records `attestation: null` in the ops entry. The substrate does not refuse.

So: the destructive operation is already receipt-gated, and every other lifecycle path is non-destructive; what is *not* true is the literal AC shorthand — the substrate neither refuses nor has a flag to check.

## Decision

**Legal hold stays v1 composition — hold lane (offboarding: silence + revoke) + the F1 snapshot as the defense record + an owner attestation recorded immutably on erasure. The substrate gains no hold marker, no hold verbs, and no hold config until a trigger in §3 fires.**

- **The refusal lives where the dispute lives.** A hold is a legal fact the *product* knows (the owner saw a dispute). The substrate cannot verify it; a marker would only record an intent the integrator must honor anyway, while adding a second source of truth for "is this scope held" that can drift from Coffee's.
- **The enforceable seam is the receipt, not a state check.** Every FORGET.SCOPE ops entry carries `attestation` — the hold-release statement, or an explicit `null` when none was given — plus `export_id` for the snapshot link. An audit can therefore always tell whether the owner claimed the hold had released, from the canonical record, without trusting any flag. "Never silent" is the guarantee, and it is testable (§4, R3).
- **Non-destruction is structural.** The only destructive lane is `reason: 'erasure'`, and it is owner-gated (`requireOwner`), attestation/export-receipted, and terminal by design. Expiry and offboarding are tombstone-only: bytes retained, history portable, marker intact, exportable at any time. A hold cannot be defeated by forgetting to set a flag.
- **The skip is realized by the hold lane itself**, in the same act, not by a check the sweep performs: offboarding tombstones the scope's observations, and the sweep targets only `accepted` records (finding 1). Residual: post-hold writes (§4 AC6).
- **Reversal trigger — revisit (owner sign-off) if any of these fires:** (a) a real dispute/hold occurs before the client-scope flows are generally available — decide the surface from real requirements instead of guessing it; (b) a second consumer (regulator, enterprise contract) needs a substrate-verifiable refusal or a hold-in-place obligation the substrate must *prove*; (c) an audit or incident shows an erasure ran with a hold open — a Tier-1 breach, so the fix would be marker + refusal; (d) a tenant must prove hold state existed at a past instant (the attestation proves the owner's act, not the world).

## Consequences

- **Coffee (integrator) owns the gate.** The dispute flow must: run F1 first (snapshot), offboard with an `owner_pointer`, offer erasure only behind the attestation, and render a held scope from the snapshot — a held scope is **lane-silent by design** (`offboarding` tombstones its claims/observations; REVIVE restores canonical state but recall stays evidence-suppressed), so recall is not the retrieval path for defense evidence.
- **Retention keeps minimizing while never destroying.** Post-hold evidence with elapsed retention is tombstoned (minimization) and remains preserved and portable (no loss). Both halves are asserted in R2.
- **Cost avoided:** unverifiable hold state; gating a statutory DSR erasure behind a flag someone can forget to clear; a new protocol/config surface, state machine, migration and owner sign-off cycle for a guarantee the composition already provides in substance.
- **What this forecloses (honestly):** the substrate will not, on its own, refuse an erasure or skip a sweep for a scope the product considers held. If a tenant's legal posture requires that *proof*, this ADR is the thing to supersede — the trigger list is the doorway.
- No code, protocol, config or schema change. The decision is pinned by tests, not prose (R1–R3).

## Wording reconciliation (ADR-0001 §4; §2.2 unchanged)

AC5 and AC6 were written before the composition model existed and read as substrate state checks. As built and as now decided:

| Clause | What the substrate does | Residual (stated, not hidden) |
|---|---|---|
| §2.2 (3) "defers to the FORGET.SCOPE hold lane (offboarding + export snapshot)" | Implemented literally: a dispute path never reaches the sweep or the erasure lane; it offboards + snapshots. | none — this sentence is the invariant.
| AC5 "erasure … refused under hold" | `requireOwner` refuses every non-owner; the hold-release *flow* refuses until the owner attests; the substrate records the attestation — or its absence, as an explicit `null` — in the one ops entry, with `export_id`. | The substrate itself does not refuse on hold state (finding 3). The refusal is the flow's, the record is the substrate's. |
| AC6 "hold scope is skipped by the sweep" | Held scope ⇒ offboarded ⇒ no `accepted` observations ⇒ nothing for the sweep to fire on (finding 1). | Evidence written into the scope *after* the hold is not skipped and an elapsed sweep tombstones it — non-destructively (finding 2). |

§2.2 and the AC text are **not edited** (ADR rule 2: amending is not editing). This table is the interpretation ADR-0001 §4 now points at.

## Alternatives considered

1. **Build the explicit marker now** (`config.holds` + audited `hold.open` / `hold.release`, erasure refusal, sweep skip) — the option §10c.7 slotted to G4. *Lost:* it invents state the substrate cannot verify, and buys a refusal only for callers that would honor it anyway, since the owner gate already stands between staff and the lane. Cost is a new config surface, verbs, state machine, migration and an owner sign-off cycle; the new failure mode is a stale hold flag blocking a statutory DSR erasure. Not rejected forever — trigger-gated (§3), and the surface sketch above is what a G4 card should start from.
2. **Derive the refusal from the log** (an erasure of a scope whose latest `forget.scope` marker is `offboarding` and not yet erased must carry an attestation; absent ⇒ refuse). No new state — the substrate already records the hold lane. *Lost:* it converts a *recording* seam into a *gate* on an operation with statutory clocks, unilaterally and without owner sign-off; it makes a call that succeeds in v0.5.0/v0.6.0 fail (a breaking change for existing tenants); it forces an attestation on non-dispute erasure-after-churn; and it fixes only half the AC (no sweep skip). Recorded here so G4 starts from it if a trigger fires.
3. **Do nothing — leave the AC wording unreconciled** (status quo before this card). *Lost:* an owner-signed Tier-1 document would keep asserting a guarantee the substrate does not provide, and every future audit of the hold lane would have to rediscover which half is real. That is the failure this ADR exists to prevent.
