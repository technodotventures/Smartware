# ADR-0004 — Contradiction and bi-temporal lifecycle

- **Date:** 2026-09-14
- **Status:** Proposed (implemented and evidence-backed in this change; operator sign-off pending)
- **Deciders:** Neo (Head of Technology) — implementing the frozen Coffee parity contract, principle 8 ("no autonomous truth-arbitration")
- **Supersedes:** —

## Context

The Coffee company-brain contract freezes the temporal model as *bi-temporal
claims (event-valid × system-recorded); supersede/contested; current recall
excludes non-current state, history only on request*, and forbids autonomous
LLM truth-arbitration. Two write paths exist and must not drift:

- **route (a):** Smartware's extraction replay materialises claims from
  `claim_extracted` events;
- **route (b):** the host owns extraction and persists structured claims
  (`ClaimStore` + `smartware/layer1/corroboration`). This is the Coffee shape.

Three gaps were reproduced before this decision:

1. **Contested claims vanished from recall.** Marking a pair contested set
   `status: contested`; `syncSearchFromClaims` then re-derived the claim index
   from `getActiveClaims()`, which excludes contested. A disagreement answered
   with silence — indistinguishable from "no memory" (contract gate P0-2).
2. **Supersession recorded only half of bi-temporal time.** The older claim was
   stamped `superseded` and `t_invalidated` (system time) but its event-valid
   window (`t_valid_to`) stayed open, so event-valid as-of reads could not tell
   when the fact stopped being true (gate P0-4).
3. **Valid-time as-of could not see superseded history**, and the host path had
   no admission policy at all: a contradicting fact persisted through
   `ClaimStore.insertClaim` became a second *active* claim, so both "current"
   facts satisfied recall.

What cannot be decided autonomously is which of two conflicting reports is
true. Deciding it by recency ("last writer wins") would silently bury a
disagreement; deciding it by an LLM is forbidden. The policy below chooses
explicitly, using only claim metadata.

## Decision

**Conflicts are resolved only by an explicit deterministic policy over claim
metadata; a genuine disagreement is retained, marked contested, and surfaced —
never silently resolved.**

Specifically, for a claim N with `(subject, predicate, scope, validity_from)`:

1. **Identity is the canonical key.** Same key + same normalised value →
   *corroboration*: fold N's evidence into the existing claim, recompute
   confidence, never mint a twin.
2. **Same key + different value → contested.** Insert N, mark every live claim
   (active/stale/contested) sharing the key as `contested`, link them pairwise
   in `contested_by`. Nothing is superseded, no confidence ordering promotes a
   winner, and contested claims **remain recallable** — RECALL returns them
   with `status: contested` and `epistemic_tag: contested` so the host can
   render the conflict; `readConflicts` remains the dedicated lane.
3. **Later event-valid start, same subject/predicate/scope, active target →
   *supersession*.** The later window replaces the earlier claim under the
   policy "a later event-valid start closes the earlier window": the old claim
   gets `status: superseded`, `t_valid_to` = the replacement's `t_valid_from`
   (**event-valid closure**), `t_invalidated` = the replacement's `t_ingested`
   (**system-recorded time**). Contested and stale claims are not supersession
   targets — recency must never resolve a disagreement or promote decaying
   evidence.
4. **Superseded/stale facts never satisfy current recall.** They are excluded
   by default and reachable only through explicit history reads
   (`include_superseded`, `include_stale`) or temporal reconstruction.
5. **Histories reconstruct along both axes.** Valid-time as-of/range reads
   include claims that were true in the window *even if later superseded*
   (forgotten/retracted material stays excluded — it was never true).
   Transaction-time as-of reads reconstruct what the brain had recorded,
   superseded and forgotten included.
6. **One policy, both write paths.** `admitClaim(claim, store)` in
   `src/layer1/conflicts.ts` is the single implementation; replay calls it and
   hosts import it as `smartware/layer1/conflicts`. It returns the outcome
   (`inserted` / `corroborated` / `contested` / `superseded`) so the caller
   surfaces what happened instead of inferring it.
7. **Resolution is warranted, not automatic.** Retiring one side of a contest
   requires the existing user-only REVISE path (admitting a `supersedes` /
   `corrects` edge, `origin: user`), which the effective-current rule then
   honours.

## Consequences

- A disagreement is now visible product behaviour: two recall results, both
  flagged, plus a conflict lane. Hosts (Coffee) must render `contested` rather
  than treating recall as a single truth.
- Recall result objects gained `epistemic_tag`, `superseded_by`,
  `contested_by` (additive; no protocol/schema change, no frozen wire break).
- `validity.to` is now meaningful for superseded claims — existing consumers
  that assumed open superseded windows must read the field. Superseded claims
  keep their bytes and their evidence; nothing is deleted.
- The supersession policy is event-time ordered, not arrival-time ordered: a
  backdated conflicting claim does not displace a later-starting active claim
  (it becomes a separate assertion), and a later-window claim cannot resolve an
  existing contest. Volume of contested pairs depends on hosts keying the same
  fact to the same `validity_from` — the identity rule already frozen in the
  contract (rule 6).
- **Reversal trigger:** if pilots show contested pairs dominated by hosts
  stamping per-write timestamps (identity drift), revisit whether "same open
  window with different values" should contest regardless of start — an
  identity-model change, and therefore a superseding ADR.

## Alternatives considered

- **Last-writer-wins on any conflicting write** (the implicit prior behaviour
  for ordered windows): silent arbitration by recency; rejected — it hides
  disagreements and contradicts the contract's no-autonomous-arbitration rule.
- **LLM contradiction adjudication** (Graphiti-style): forbidden by contract.
- **Hide contested claims from recall** (status quo defect): rejected — a
  disagreement must be visible, never a silent empty answer (gate P0-2).
- **Keep the per-write-path conflict logic duplicated** between replay and
  hosts: rejected — two policies drift; the P0-9 corroboration twin incident
  was exactly that failure mode.
