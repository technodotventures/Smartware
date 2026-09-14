# ADR-0005 — Claim identity vs. creation idempotency: one fact-identity predicate, one operation key

**Date:** 2026-09-14
**Status:** Proposed — **owner sign-off required** (this is protocol identity semantics; it touches how every surface must read the `claims` table). It supersedes the *Known divergence* section of [ADR-0003](0003-claim-fact-identity.md); ADR-0003's Decision and its frozen write-path contract stand unchanged.
**Deciders:** @tech-head (recommendation + evidence; kanban `t_15bb0cd0`) · @smarty-pants (author of the ADR-0003 *Known divergence* section this ADR supersedes) · **operator sign-off pending**
**Supersedes:** ADR-0003 *Known divergence* section only.

## Context

Two rules read the same `claims` rows and answer "are these two rows one fact?" differently:

- **Rule A — fact identity (ADR-0003, new; host write path).** `(subject_id, predicate, scope, normaliseValue(object), validity.to === null)`; survivor = lexicographically smallest claim id. Shipped as `ClaimStore.findActiveFactMatches` + `resolveFactMatches`.
- **Rule B — structured claim fingerprint (pre-existing; normative).** `computeStructuredClaimFingerprint(subject_name, predicate, object, scope, claim_type)` (`src/layer1/fingerprint.ts:20`): sha256 over `lowercase(stableJson({subjectName,predicate,object}))` + `scope` + `claim_type`, 16 hex chars. Consumed by `reflect.auto` creation idempotency (`src/protocol/reflect.ts:351` → `FingerprintIndex.activeByFingerprint`, `src/compile_queue/fingerprint.ts:139`, with the `findSemanticMatch` scan fallback at `src/protocol/reflect.ts:894`); stamped on every insert when the store has a `dataDir` (`src/layer1/store.ts:488`). Normative basis: spec v1.6.16 §193/§238, protocol v0.5.0:201 — *"the autonomous-creation idempotency key"*.

ADR-0003 recorded that they disagree and deferred the disposition here. This ADR is that disposition. It is written against measurements taken on the parent branch `fix/duplicate-claim-recipe` (commit `93a7cfd`, local, unmerged), using the **public package surface** (`SmartwareCore`, `smartware/layer1`), in `t_15bb0cd0`'s evidence set.

### What was measured for this ADR (all VERIFIED, artifacts cited below)

| # | case | Rule B (fingerprint) | Rule A (`findActiveFactMatches`) |
|---|---|---|---|
| 1 | same assertion, `claim_type` `'preference'` vs `'finding'` | fingerprints **differ** (`fp_66ef30ca17b3e6d7` vs `fp_1784904eec21a8eb`) → the compile path sees **two** claims | returns **2** → the write path merges them |
| 2 | same assertion, text `'Quarterly'` vs `'quarterly'` | fingerprints **equal** → the compile path sees **one** claim | returns **1** for a `'quarterly'` query → the write path sees **two facts** |
| 3 | **end-to-end, one store, both surfaces.** Host structured insert (`claim_type` unset → store default `'finding'`, `src/layer1/store.ts:400`); `OBSERVE` + `REFLECT` over the same assertion (`reflect.ts` default `'hypothesis'`, `src/protocol/reflect.ts:349`) | two distinct stamped fingerprints (`fp_cdb17540…` vs `fp_9cfa41b7…`) | `findActiveFactMatches` → **2** |
| 4 | case 3, on the real recall surface | — | `memory.recall` → **2 claims for one fact**; after `resolveFactMatches` → **1** |
| 5 | case 3, **control**: identical shape but `claim_type` matches (`'hypothesis'`) | fingerprint **equal** → `claims_created: 0`, corroboration attached | one claim, no duplicate — the classification is the discriminating variable |
| 6 | case 3, **recurrence**: after the sweep, one more autonomous restatement | `claims_created: 0` again, **but** the demoted row returns to the recall-eligible set → `recall` → **2** | — |

Cases 1–2 reproduce the round-1 reviewer probe byte-for-byte. Cases 3–6 are new here and close the gap the card labelled *NOT YET PROVEN* (parity had been fixture-level): the both-surfaces collision is now measured end-to-end, from the public surface, in one store.

Case 6 is not a fingerprint-identity fact; it is a **demotion-durability defect** found while measuring the interop consequence, and it is filed separately (finding F2 below). It is recorded here because it bounds what this ADR may claim about convergence.

## Decision

**The protocol has exactly one fact-identity predicate — Rule A — and `claim_type` is not part of it. Rule B is an autonomous-creation idempotency key: it answers "has this exact creation already happened?", never "is this one fact?". The two relations are formally incomparable (they cross in both directions), so no surface may substitute one for the other.**

**D1 — Fact identity is Rule A, and it is the only rule that decides sameness of a fact.** Any component asking "are these two stored rows one fact?" (write path, sweep, repair, duplicate reporting that claims a fact-level verdict, a host's dedupe policy) uses Rule A. `claim_type` is **not** part of it: classification is claim metadata (spec §6: "categorisation is not a truth judgment"), so a re-classification is not a new fact.

**D2 — Rule B stays what the spec already calls it: the autonomous-creation idempotency key.** Its two "extra" members are correct *for that job*, and must not be removed:

- `claim_type` is in it because a creation request that changes the classification must mint a distinct claim rather than silently attach to a differently-classified one;
- lowercasing the whole structured assertion is in it because extraction case-noise must not mint twins.

Removing either would make `reflect.auto` over-merge creations, which is a different defect from the one measured here.

Protocol v0.5.0:201 puts the same rule in operative terms: autonomous reflection may *"deduplicate claims by stable fingerprint while extending provenance only on an unprotected claim"*. That sentence is about reflection's **own creations** — the operation-key role above — plus the protection boundary. It is **not** a rule for deciding whether two stored rows are one fact, and reading it that way is exactly what D3 forbids.

**D3 — Rule B must never be used to conclude anything about facts.** Forbidden: deciding "this fact is already represented" by fingerprint; deduping recall output by fingerprint; inferring "different facts" from fingerprint inequality; using fingerprint equality as a fact-identity verdict. Fingerprint **equality** may be used as one input to a *data-quality review* ("identical normalized claims"), never as a verdict — and fingerprint **inequality** carries no information about facts at all.

**D4 — Named consumer, so this is not re-discovered as news.** `dream` already uses Rule B over active versions to surface `duplicate_active_claims` for review (`src/dream/phases.ts:336-347`). That is permitted under D3 (a review candidate, not a merge, and not a verdict), but the two rules' duplicate *reports* disagree in both directions exactly as the table shows — a host consuming both receives contradictory quality signals. Documentation of either surface must say which question it answers.

**D5 — A host that runs both surfaces must not assume either rule implies the other.** Concretely: run §1e identity on every write touching a fact (that is the only convergence point), and treat "resolved" as provisional until F2 is fixed.

**D6 — Documentation must not claim the library has a single notion of fact identity.** ADR-0003 already complies; this ADR is the single normative statement of the relationship, and any future text that asserts coherence between the two rules is wrong until a superseding ADR says otherwise.

**D7 — Two follow-ups are recorded and deliberately NOT decided here** (both need their own sign-off; cards created from `t_15bb0cd0`):

- **F1 — make the autonomous path consult fact identity before creating.** `reflect.auto` currently asks only Rule B. If it also asked Rule A ("does an active claim already assert this fact?"), the collision in case 3 disappears *by construction* — case 5 shows the mechanism already works when the classification matches. Two variants are open (attach corroboration only; or attach + record the classification as a proposed candidate rather than a new claim), and the choice binds spec §238 wording, so it is its own decision.
- **F2 — demotion is projection-only (defect).** `resolveFactMatches` writes `status: 'superseded'` + `superseded_by` into the SQLite row; the canonical L1 version record carries **no** `status` and **no** `superseded_by` field, and `statusToState('superseded')` is `'active'` (`src/layer1/types.ts:126`). Measured: the compile path's row sync re-materialises the row from the canonical record and the demoted duplicate returns to the recall-eligible set (case 6); a canonical replay into a fresh projection loses the demotion entirely (both rows `active`, `superseded_by: null`); the string `superseded` appears nowhere in the L1 JSONL. Spec §6 says supersession is expressed by the `supersedes` relation / version-chain field, not by `state` — so the canonical substrate has a place to record it.

## Consequences

- **One answer exists for the decision question**, and it is checkable: fact identity is Rule A; `claim_type` is not in it; Rule B is an operation key. Option (a) and option (c) of `t_15bb0cd0` are rejected on measured grounds (see *Alternatives*), so nobody reopens them without new evidence.
- **The divergence is declared, not closed.** A both-surfaces host can still hold two active claims for one fact after an autonomous restatement of a host-held fact with a different classification (case 3). The cost is bounded but real: recall answers twice until a §1e write or sweep touches that fact, and (F2) resolution is not durable.
- **The claim "the library has one notion of a fact" remains false and must stay unwritten.** The compensating claim is stronger and testable: *one identity predicate, one creation key, crossing relations, and the crossing is measured in both directions.*
- **ADR-0003's convergence sentence is scoped by this ADR**: the sweep converges the recall-eligible set at the moment it runs; it does not prevent the next autonomous restatement (case 6), because that restatement consults Rule B only.
- **Docs obligation:** the integration guide's §1e already scopes the rule to the host write path. Guide §10 and the conformance notes must not be read as a guarantee about the autonomous path; if any text implies that, it is a bug under D6.
- **What becomes harder:** a host can no longer use one key for both jobs; a future "just use the fingerprint everywhere" simplification is now explicitly rejected. That is the price of an honest answer.

### Falsification test (what would supersede this ADR)

Two claims carry this disposition, and each has a cheap falsifier:

1. **"The write path is a sufficient convergence point."** Test: a **steady-state both-surfaces run** — the host follows §1e on every write touching the fact, with one autonomous restatement per round, over N ≈ 10 rounds — must show `recall` answering **once** for the fact in every round, with no rebuild and with the autonomous path still running. It does **not** pass today, and the failing step names its own cause: case 6 flips the demoted row back, which is F2 (durability), not the identity split. Once F2 — and, for the creation side, F1 — land, this run must be green. If it is still not, the premise is false and this ADR must be superseded, not patched.
2. **"Rule B carries no fact-level information."** Test: a deployment in which a fact merged by Rule A is acted on as two claims by a Rule-B consumer, or the reverse, and produces a wrong answer. Case 2's direction (`'Quarterly'` vs `'quarterly'`: fingerprint-equal, Rule-A-distinct) is the one to watch — it is the direction where a Rule-B consumer treats two facts as one. Any such incident supersedes this ADR.

## Alternatives considered

1. **(a) Add `claim_type` to fact identity — rejected on measurement.** It would make the write path treat a re-classification as a different fact, so `findActiveFactMatches` would stop returning the autonomous duplicate (case 3) and the only mechanism that converges it (§1e) would be disabled: the pair of active claims for one fact becomes permanent, and recall answers twice forever. It also changes a frozen, host-visible contract and would require re-deriving the pilot cross-check (its `buildClaim` leaves `claim_type` unset, measured in `brain-pilot/claims.mjs:20-23`). It fixes nothing that is broken and breaks the thing that works.
2. **(c) Unify on the structured fingerprint — rejected.** Rule B lowercases the whole assertion, so the write path would merge facts it is required to keep apart (case 2: `'Quarterly'` vs `'quarterly'` are two facts to Rule A and one claim to Rule B); it would still split one fact across classifications (case 1); and it would change `reflect.auto` behaviour as well. Both surfaces change, both directions get worse.
3. **(b) as ADR-0003 wrote it — "keep them scoped, document the divergence" — accepted in substance and strengthened here.** The scope statement was right; what was missing was the *relationship* (crossing, not overlapping), the *named consumers*, and the two follow-ups. Without them "unreconciled" invites a future reader to assume the divergence is harmless. Rejected only in its weak form.
4. **Pacify Rule B: drop `claim_type` from the fingerprint so the two rules agree on case 3.** Rejected: that is the same defect as (a) seen from the other side — it removes `reflect.auto`'s ability to record a re-classification as a distinct creation, and it does not touch case 2, so the relations would still cross.
5. **Make Rule A the creation key now (F1 immediately, inside this change).** Rejected as scope: it changes `reflect.auto` and the normative sentence in spec §238, needs its own sign-off, and this card is explicitly an owner-decision brief with no code change in scope. Recorded as F1 with the mechanism already demonstrated (case 5).
6. **Silence.** Rejected: a silent divergence between two documented identity rules over one table is the failure mode, not the inconvenience.

## Evidence

- Probe (reviewer's, re-run by this card): `review-fingerprint-identity-probe.mjs` → cases 1–2, output byte-identical to the round-1 record.
- End-to-end harness (this card): `step2-both-surfaces-experiment.mjs` → cases 3–6 + control, `evidence/22-bothsurfaces-experiment.txt`.
- Mechanism harness (this card): `step3-demotion-durability.mjs` → F2, `evidence/23-demotion-durability.txt`.
- Run against: `dist/` built from branch `fix/duplicate-claim-recipe` @ `93a7cfd` = parent of this ADR's branch. Node v26.5.1, 2026-09-14.
- All three are harnesses outside the repository (they import the built `dist/`), archived with kanban task `t_15bb0cd0`; none of them is a repository test. **Consequence for this ADR:** cases 3–6 are *measured evidence*, not regression pins — pinning them (a repository test asserting the interop consequence) belongs to F1/F2, which is where the behaviour would change.
