# ADR-0003 — Fact identity on the claim write path: the library resolves the fact, not the key

- **Date:** 2026-09-14
- **Status:** Accepted — **amended 2026-09-14**: the rule's scope is qualified and the parallel
  fingerprint identity over the same rows is recorded (*Known divergence*). That divergence is
  unreconciled by design; this ADR does not claim the library has one notion of fact identity.
  **Amended again 2026-09-14** (`t_742e31f9`): the demotion's durability is extended to every flow
  that hand-builds a version record — preserved by all of them, reported on `REVISE`
  (*Carry-forward across hand-built version records*).
  **Amended 2026-09-15** (`t_1db21462`, owner directive on the card: "proceed with the
  `repick_survivor` REVISE param recommendation, record in ADR, implement"): the demotion gains its
  release vocabulary — a user-only `REVISE` **re-pick** that releases the duplicate and demotes the
  current active copy, atomically (*Releasing a demotion*).
  **Amended 2026-09-15** (`t_9e124fe6`): which fingerprint form a *backfilled legacy tombstone
  snapshot* carries is recorded under *Known divergence* — the content form, not the structured one.
- **Deciders:** @smarty-pants (protocol stewardship / research). No owner sign-off gate for the
  **additive SDK surface** itself — no protocol invariant, schema, cryptography, or authority-table
  change. The disposition in *Known divergence* (leaving the pre-existing fingerprint rule
  unreconciled) is a deliberate deferral: **reconciling the two rules is protocol identity semantics
  and needs owner sign-off.** No published contract is widened here. The `repick_survivor` surface
  (2026-09-15) is owner-directed protocol surface, specified before it was built and reviewed as a
  PR-style glance rather than a blocking gate.
- **Supersedes:** —

## Context

A host that owns extraction (Coffee's path) decides, on every write, whether an extracted fact
*already is* a claim. The integration guide taught that decision as:

```js
const existing = store.getClaimsBySubject(subjectId, 'active')
  .find(c => c.predicate === predicate && c.scope === scope && …);
```

That recipe is wrong in two ways, both measured — host-side on the Coffee-shaped pilot
(`t_ec159c21`) and now in-repo by `scripts/saas-integration-smoke.mjs`:

1. **`getClaimsBySubject` has no `ORDER BY`.** When the store already holds two active claims for one
   fact — the shape a write path leaves behind when nothing dedupes — `.find()` returns whichever row
   SQLite yields first. The survivor is row-order dependent, the loser keeps its evidence, and
   nothing in the result says a choice was made. Measured: such a brain answers **2 recall results
   for 1 fact**; resolving the duplicate converges it to 1.
2. **`canonicalKey` is not the fact identity.** It keys on `validity_from`, so a host that stamps
   `now()` on every write can never reproduce a key it wrote earlier: `findByCanonicalKey` silently
   never fires and duplicate accumulation returns with the recipe apparently followed.

Past the doc bug there is a design failure: identity — *what counts as the same fact* — is
protocol-level semantics, and leaving it to each host means two hosts disagree about whether two rows
are one fact. That is a portability and interop defect, not a local implementation detail.

**Scope qualification (added in review, 2026-09-14).** Shipping this rule does **not** give the
library a single notion of fact identity. A second identity rule already applies to the same `claims`
rows — the structured claim fingerprint that `reflect.auto` uses for autonomous-creation idempotency
(normative: spec v1.6.16 §193/§238). The two disagree in both directions, measured below. *Known
divergence* is the normative statement of what this ADR does and does not claim; read it before
building on either rule.

## Decision

**Smartware ships the write-path fact-identity rule as public API, and the integration guide
documents that API instead of a hand-rolled `find`:**

**Scope of this decision.** The rule governs the **host write path** — the place a host decides
whether a fact it just extracted restates a claim the store already holds (integration guide §1e). It
is *not* asserted to be the library's universal fact identity: the autonomous-creation path keys on a
different rule over the same rows (*Known divergence*). Unifying the two is an owner decision, not a
change this ADR makes.

- `ClaimStore.findActiveFactMatches(subjectId, { predicate, scope, object })` → **every** active claim
  asserting that fact, in survivor order.
- `resolveFactMatches({ store, matches, observationId?, now? })` → folds them into one survivor and
  **reports what it did** (`ambiguous_matches`, `ambiguity_resolved`, `superseded_claims`,
  `supporting_evidence`, `confidence`).

The contract, frozen (frozen means a change needs a superseding ADR):

1. **Identity is the fact**: same subject, predicate, scope, `normaliseValue(object)`, and
   `validity.to === null`. Not `canonicalKey`.
2. **Survivor is the lexicographically smallest claim id.** Claim ids are ULIDs (time-ordered), so
   that is *earliest minted wins*, independent of store row order. Matches come back in that order,
   so `matches[0]` is the survivor even for a caller that ignores the rest.
3. **Evidence is unioned into the survivor *before* the losers are demoted.** A duplicate is the same
   fact observed again; discarding its observations loses provenance the brain actually has.
4. **Losers are demoted, never deleted**: `status: 'superseded'`, `superseded_by: <survivor>`,
   `t_invalidated` stamped. They stay auditable and leave the recall-eligible set
   (`status === 'active'` filters in layer2/layer3), which is what stops recall answering twice.
5. **Confidence is recomputed** with `computeConfidence` on the survivor after the union.
6. **`observationId` is optional.** A host sweeping a store built before this rule resolves duplicates
   *without* inventing an observation id to stand in for evidence.

Forbidden: `.find()`-style single-row picking as the write-path identity (the guide now shows it as
WRONG); using `canonicalKey` as the fact identity when `validity_from` is not derived from the fact.

### Durability of the demotion (added 2026-09-14 · kanban `t_01ef0ede`)

Item 4's demotion used to be recorded **only in the derived SQLite row**, so a compile-path
`syncFromJsonlVersionsBatch` or a canonical replay restored the duplicate to the recall-eligible set
(measured: `t_15bb0cd0` `evidence/23-demotion-durability.txt` — the L1 JSONL contained no trace of
the demotion at all). The demotion is now recorded in the demoted claim's **canonical version
records** (`superseded_by`, `superseded_at`, carried forward on subsequent versions), and every
materialisation derives `status` / `superseded_by` / `t_invalidated` from the record rather than
from the row it replaces — a replay and the live projection agree on which rows are recall-eligible
by construction. The record field is the substrate's own record of this **mechanical** demotion; it
is deliberately **not** a canonical `supersedes` relation edge, which spec §6 admits only with
`origin ∈ {reviewed, user}` — the dedup carries no user warrant and must not pretend to one. Its
boundaries are recorded in `docs/conformance-status.md` → *Remaining limits*: a pre-fix demotion is
not reconstructible, and flows that hand-build a claim's next version record (user `REVISE`,
endorsement cascade, consolidation) do not yet carry the pointer forward. **That second boundary was
closed in `t_742e31f9` — see *Carry-forward across hand-built version records* below, which decides
the semantics flow by flow.**

### Carry-forward across hand-built version records (added 2026-09-14 · kanban `t_742e31f9`)

The subsection above left a boundary: flows that **hand-build** a claim's next version record (rather
than appending it through `insertClaim`) did not copy `superseded_by`/`superseded_at`, and because
every materialisation derives `status` purely from the record, touching a demoted claim through one of
them silently released the demotion in live **and** replayed state. This subsection decides the
semantics per flow and removes the boundary.

**Decision: every flow preserves the demotion. Nothing in beta releases it implicitly, and no flow
reverses it silently.** A user act that touches a demoted claim is recorded *and reported*, so that
the mirror failure mode — an act that appears to succeed while the claim stays out of recall — is not
silent either. (The one *explicit* release — a user re-pick — was added the next day by
`t_1db21462`; see *Releasing a demotion* below. It is a new act, not a revision of this rule: every
flow below still preserves the demotion whenever it is not that act.)

| Flow | Site | Disposition |
| --- | --- | --- |
| user `REVISE` | `src/protocol/revise.ts` | **Preserve**, and report `superseded_by` on the result |
| `FORGET` tombstone | `src/protocol/forget.ts` (forgotten version) | **Preserve** (§11 carry-forward of non-content metadata) |
| `REVIVE` | `src/protocol/forget.ts` (revived version) | **Preserve** (the snapshot it restores was demoted) |
| endorsement cascade | `src/protocol/endorse.ts` | **Preserve** (already, by spreading the endorsed version — now pinned by test) |
| `CONSOLIDATE` inputs | `src/protocol/consolidate.ts` | **Preserve** on each input's tombstone; the summary is a new claim and inherits none |
| `FORGET.SCOPE` offboarding | `src/protocol/forget_scope.ts` | **Preserve** |
| retention expiry | `src/protocol/retention.ts` | **Preserve** |
| `reflect.auto` fingerprint extension | `src/protocol/reflect.ts` | **Preserve** (already, by spreading the existing version — now pinned by test) |
| `reflect.auto` / `CONSOLIDATE` new claim | version 1 of a fresh claim id | Not applicable: no prior version to carry |

Why preserve is forced rather than merely preferred:

1. **Beta has no verb that changes the fact a claim asserts.** `REVISE`'s payload has no content,
   object, predicate or scope field (`ReviseParams`), `adopt_body` flips authorship only, and spec §6
   is explicit that content "is never rewritten in place". So after every one of these flows the
   claim still asserts the same `(subject, predicate, scope, object)` as the survivor — the exact
   condition the demotion encodes. Releasing it cannot add information; it can only add a second
   recall-eligible copy of one fact.
2. **A release would be unstable.** The next write touching that fact re-runs §1e and demotes the
   same claim again (the survivor is the earliest-minted id, which the release did not change), so
   "release" can only produce an oscillating state that depends on write order — the failure this ADR
   exists to eliminate.
3. **A user `REVISE` is the wrong vocabulary to overrule it.** The demotion carries no user warrant
   (it is substrate bookkeeping), but it is also not an epistemic claim the user is contradicting.
   Beta's sanctioned routes to change current truth — observe → `reflect.auto` → `REVISE` with
   `adopt_body`, or admitting a `corrects`/`supersedes` edge (spec §9) — all produce or protect a
   *different* claim and none of them requires the duplicate to become recall-eligible.

Alternatives considered and rejected:

- **Release on user `REVISE`, reported to the caller.** Rejected: unstable (reason 2), and `REVISE`
  cannot change the fact (reason 1), so it always recreates the duplicate the §1e sweep exists to
  remove.
- **Release only when the revise adjudicates (`adopt_body` / relation admission), preserve otherwise.**
  Rejected: `adopt_body` does not change the body in this implementation, so the split keys semantics
  off a flag that does not affect the fact — a rule with two branches where one behaviour is correct.
- **Refuse `REVISE` on a demoted claim** (`ProtocolError`). Rejected: it would block legitimate
  adjudication of an auditable claim (confidence, epistemic tag, relations, `add_derived_from`,
  protection) and still could not give the user what they asked for, because the survivor *is* the
  claim for that fact. Reporting is the honest version of the same information.
- **Add the un-supersede vocabulary now.** Deferred in this card — new protocol surface, owner
  sign-off required. **Shipped 2026-09-15 as `repick_survivor`**, on owner directive; see *Releasing
  a demotion* below for the shape and why it is a re-pick rather than an un-supersede.

Evidence: `test/layer1/demotion-durability.test.ts` (REVISE, FORGET→REVIVE, ENDORSE, CONSOLIDATE —
each asserting the record, the derived row, the recall-eligible set and a canonical replay),
`test/protocol/forget-scope.test.ts` and `test/protocol/retention-expire.test.ts` for the two sweeps.
The proof of the *old* boundary (a flow that drops the field releases the demotion) is the same tests
run against the pre-change tree.

**Migration note.** The two fields are additive on the record and already existed on demotion
records, so a store written by an older version replays unchanged and no schema or migration is
needed. The one narrow exception is a *pending* operation intent that the old code prepared for a
demoted claim: the intent's `record_hash` was computed without the carried fields, so recovery fails
closed — the operation lands in manual review instead of being applied on a mismatch — and
re-issuing it under a fresh `operation_id` resolves it.

**Remaining limit (recorded, not fixed here).** Two consequences of the decision are worth stating
plainly, because a reader could otherwise assume the substrate can do something it cannot:

- **Releasing a mechanical demotion is now a user-only re-pick (`repick_survivor`).** Shipped
  2026-09-15 (`t_1db21462`, protocol v0.5.0) — see *Releasing a demotion* below. `invalidate_relations`
  still cannot release one (the demotion is deliberately not an edge, so there is no relation to
  withdraw); the re-pick is the vocabulary, and it works in both swap mode (the survivor is active) and
  rescue mode (the survivor is already forgotten — the fact returns from audit-only visibility).
- **`FingerprintIndex.activeByFingerprint` filters on `state`, not on the demotion**, so a demoted
  claim can be the fingerprint holder `reflect.auto` folds a restatement into. Measured
  (`t_01ef0ede` step 2): recall stays at 1 after an autonomous restatement — correct — but the added
  evidence lands on the copy that is out of recall. Reconciling that is the fingerprint/write-path
  identity divergence (*Known divergence*, owner-gated `t_15bb0cd0`), not a carry-forward defect.

### Releasing a demotion — the user re-pick (added 2026-09-15 · kanban `t_1db21462`)

The subsection above left a deliberate gap: every flow preserves a mechanical demotion, and nothing
releases it. The consequence that hurts: a user who believes the *duplicate* is the copy that should
surface has no path, and if the survivor is later forgotten the fact leaves default recall entirely
(the duplicate stays demoted, audit-visible only). This subsection closes the gap — on owner directive
("proceed with the `repick_survivor` REVISE param recommendation, record in ADR, implement") — and
records the shape that ships.

**Decision: a user-only `REVISE` re-pick — `repick_survivor: true` on the claim-admission form —
releases the demoted duplicate and demotes the fact's current active copy, in one atomic commit.**

The act and its semantics (protocol v0.5.0; spec §9):

- **The target is the demoted duplicate.** `REVISE { target: claim_<B>, expected_base_version: <n>,
  repick_survivor: true, reason, operation_id, actor_id: user:<slug> }`. If the target's latest version
  carries no `superseded_by`, there is nothing to re-pick and the call is rejected (`not_demoted`, the
  mirror of `REVIVE`'s `not_forgotten`) — nothing is written.
- **The release.** A new active version of the duplicate with `superseded_by`/`superseded_at` cleared,
  `epistemic_owner: user` (a re-pick is an epistemic adjudication), and the audit-only
  `reinstated_by: 'user'`. The body is not adopted and no confidence/tag value changes.
- **The demotion.** The current active copy (or copies — a store that predates §1e convergence can
  hold more than one) gets a new version with `superseded_by: <released claim>` and the warrant
  `superseded_by_origin: 'user'` (absent on mechanical demotions). Exactly one copy of the fact stays
  recall-eligible.
- **The channel is mechanical, deliberately.** The demotion records `status: superseded`; it does
  **not** admit a `supersedes` edge. No effective-current cycle check, no `invalidate_relations`
  interaction, no second identity rule involved. This is the load-bearing simplification: an admitted
  edge would leave the demoted copy `status: active`, so `findActiveFactMatches` would still return it
  and the next §1e write would re-demote the released claim.
- **Stability is by invariant, not by warrant.** Because the *other* copy is demoted outright, the next
  §1e write finds only the released claim and corroborates it. The `origin: 'user'` warrant is audit,
  not machinery. (The alternative — release the loser and leave both active — was measured unstable in
  `t_30732060`: `[S] → [S,D] → [S] → [S,D] → [S]`.)
- **Rescue mode.** The re-pick is not gated on the survivor being active: if the survivor is already
  forgotten, the release happens alone (`demoted: []`). The active copy is resolved through
  `findActiveFactMatches` on the target's own fact — never from the target's possibly-stale
  `superseded_by` pointer — so a second re-pick over the same fact composes: it targets the copy the
  first one demoted.
- **Atomicity.** One commit, one `operation_id`, two version records appended in one
  `appendClaimVersions` call — release first, so a torn write can only degrade to the pre-op state
  (two active copies, which the next §1e write converges), never to a fact with no recall-eligible
  copy. The durable intent names every artifact; recovery finalises when the set is complete and fails
  closed to manual review when it is not.
- **Beta limits (deliberate).** `repick_survivor` is the operation's *only* action in beta — schema and
  handler both reject combining it with the metadata actions, because a combined commit would mix two
  mutation kinds under one warrant whose interaction is unspecified. And the demotion is still not an
  admitted edge, so `invalidate_relations` neither touches nor undoes it; re-picking back is done by
  re-picking against the copy now demoted.

Rejected alternatives:

- **A sixth verb.** The five-verb surface is frozen; re-picking is a user epistemic adjudication, and
  `REVISE` already is the user-only verb with the version-pinned, crash-safe path.
- **A bare release ("un-supersede the loser").** Unstable — measured, above.
- **A `supersedes` edge from the released claim.** Leaves the demoted copy `status: active`, so the
  next §1e write re-demotes the release, and it entangles the mechanical channel with effective-current
  and acyclicity.
- **An `origin` on `invalidate_relations`.** There is no `relation_id` to withdraw: the mechanical
  demotion is deliberately not an edge.

Evidence: `test/protocol/repick-survivor.test.ts` (swap, stability, rescue, multi-copy demotion, the
two rejections, the two crash legs and the torn-set fail-closed case), the schema fixtures in
`test/schemas-v0.5.0.test.ts`, and the gate recorded on the card (tsc clean · 519/519 vitest / 71 files
· 31 schemas · `SMOKE_OUTCOME=pass`).

**Record envelope (additive).** Two optional fields on the claim version record:
`superseded_by_origin?: 'user'` (the warrant on a demotion) and `reinstated_by?: 'user'` (audit-only
marker on a release). `schemas/v0.5.0/claim.schema.json` now enumerates both, together with the two
pre-existing demotion fields (`superseded_by`/`superseded_at`) it had been missing since they shipped —
additive optional fields only, so no record written before this change stops validating. The tombstone
snapshot block enumerates the same four fields
(`schemas/v0.5.0/tombstone-frontmatter.schema.json` → `snapshot`, kanban `t_2bba749f`, 2026-09-15): its
`additionalProperties: false` block has to cover every field a claim version can carry, or a forgotten
demoted duplicate cannot be reconstructed from the tombstone's own snapshot.

## Consequences

- Hosts that follow the guide no longer reimplement identity **on the write path**, so two hosts
  following §1e cannot disagree about whether two rows are one fact *there*. That is a claim about
  that path, not about the library: a second rule still applies to the same rows (*Known
  divergence*), so "the library has one notion of a fact" is **not** claimed. The host-side pilot's
  reference implementation remains a valid cross-check: its 6 deterministic tests pass **unchanged**
  against the shipped helper (executed 2026-09-14).
- New public names (`findActiveFactMatches`, `resolveFactMatches`, `FactMatchResolution`) — additive,
  so the next release cut is a **MINOR** version bump, not a patch. No schema, protocol, or config
  change; `package.json` `exports` already reach `./layer1` and `./layer1/corroboration`.
- **Not automatic.** An existing store keeps its duplicates until a write touching that fact resolves
  them, or the host sweeps the scope. Recorded as an honest limit in the guide §10 and in
  `docs/conformance-status.md`; the "no automatic repair of ambiguous memory" release claim stays
  true.
- **Scope isolation wins over deduplication.** Identity includes `scope`, so the same fact asserted in
  two scopes is never merged.
- Evidence: `test/layer1/fact-identity.test.ts` (22 tests) and `npm run verify:saas` (2 recall results
  for one fact before resolution, 1 after; duplicate superseded; evidence 2→3; two rows for one fact
  carry two different canonical keys). Mutation check: restoring the silent `.find()` pick in
  `findActiveFactMatches` fails **9 of the 22** tests — `npx vitest run
  test/layer1/fact-identity.test.ts` with the survivor sort replaced by `.slice(0, 1)` reports
  `Tests 9 failed | 13 passed (22)`, the ninth being the `claim_type` divergence test in the section
  below — and also fails the smoke E2E with the symptom itself: "recall returned 2 claims for one
  fact after resolution". Each way the divergence below could be
  silently closed is caught too: dropping `claim_type` from the fingerprint fails 1 test, case-folding
  a text value in `normaliseValue` fails 3, and making fact identity depend on `claim_type` fails 1
  (all three reverted byte-identically, sha256 verified).
- **Reversal trigger:** a host that needs the same fact merged across scopes or subjects is asking for
  *entity resolution* (aliasing), which is a different decision — reopen this ADR rather than widening
  identity here.

## Known divergence: two identity rules over the same `claims` rows (unreconciled)

Found by the round-1 reviewer of `t_29739781` (2026-09-14) and reproduced independently here. Both
rules read the same `claims` table and answer "are these two rows one fact?" differently, in both
directions. **This section is normative about what the *Decision* above does not claim.**

**Rule A — fact identity (this ADR; host write path).**
`(subject_id, predicate, scope, normaliseValue(object), validity.to === null)`. It excludes
`claim_type`, `subject_name` and `validity.from`. Shipped as `findActiveFactMatches` +
`resolveFactMatches`.

**Rule B — structured claim fingerprint (pre-existing; normative; autonomous-creation path).**
`computeStructuredClaimFingerprint(subject_name, predicate, object, scope, claim_type)`
(`src/layer1/fingerprint.ts:20`) = sha256 over `lowercase(stableJson({subjectName,predicate,object}))`
+ `'|'` + `scope` + `'|'` + `claim_type`, truncated to 16 hex characters. Consumers:

- `reflect.auto` idempotency: `src/protocol/reflect.ts:351` → `FingerprintIndex.activeByFingerprint`
  (`src/compile_queue/fingerprint.ts:139`), with the `findSemanticMatch` scan fallback at
  `src/protocol/reflect.ts:894` iterating `store.getActiveClaims()` — the same rows Rule A reads.
- Stamped on every insert when the store was constructed with a `dataDir`: `src/layer1/store.ts:488`.
- Normative basis: spec v1.6.16 §193 and §238 ("`fingerprint` | Stable claim identity over the
  normalized assertion + `scope` + `claim_type`; the autonomous-creation idempotency key"),
  protocol v0.5.0:201.

### Measured disagreements

**VERIFIED** — reproduced 2026-09-14 against the built `dist/` of this branch (probe:
`review-fingerprint-identity-probe.mjs`, re-run output archived with this card's evidence). Seed: two
active claims for one fact, distinct `validity.from`.

| case | Rule B (fingerprint) | Rule A (`findActiveFactMatches`) |
| --- | --- | --- |
| same assertion, `claim_type` `'preference'` vs `'finding'` | **differ** (`fp_66ef30ca17b3e6d7` vs `fp_1784904eec21a8eb`) → the compile path sees **two** claims | returns **2**, and `resolveFactMatches` **demotes** `claim_0002BBBB…` |
| text `'Quarterly'` vs `'quarterly'` | **equal** → the compile path sees **one** claim | returns **1** for the query `'quarterly'` → **two facts** to the write path |

Reachable for Coffee, not exotic: `reflect.ts:351` defaults `claim_type` to `'hypothesis'` while
`ClaimStore` defaults it to `'finding'` (`src/layer1/store.ts:400`), and a host that leaves
`claim_type` unset — as the pilot's `buildClaim` does — produces exactly the first case.

Both cases are pinned as tests in `test/layer1/fact-identity.test.ts` ("fact identity vs. the
structured claim fingerprint"), so a silent change to either rule fails the suite.

### Disposition (decided here): fact identity is scoped to the host write path

**Keep Rule A as the write-path identity, keep Rule B as the autonomous-creation identity, and record
the divergence as known and unreconciled.** A host must not assume the two surfaces agree.

Why not the alternatives *in this ADR*:

- **Widen Rule A to include `claim_type`** (option (a) in the owner card): would change host-visible
  merge behaviour against a frozen contract, change what `resolveFactMatches` demotes, and interact
  with the per-path `claim_type` default split above — the pilot's fixtures leave `claim_type` unset,
  so its 6-test cross-check would have to be re-derived. That is protocol identity semantics:
  **owner sign-off required**, not an SDK-level change.
- **Unify on Rule B** (option (c)): Rule B lowercases text object values, so it would merge facts the
  write path is required to keep apart, and it would change `reflect.auto` behaviour as well. Same
  sign-off gate, larger blast radius.
- **Leave the divergence silent**: rejected outright — a silent divergence between two documented
  identity rules is the failure mode this ADR exists to prevent. Hence this section.

**Owner decision:** `t_15bb0cd0` (assignee `@tech-head`) must produce an amendment to this section or
a superseding ADR, with owner sign-off. This section is the placeholder until then, and it is
deliberately the *only* statement of the relationship between the two rules.

**Reversal trigger (explicit).** Supersede this section when any of the following holds:

1. a host runs both surfaces over one store and observes a fact the write path merged being treated as
   two claims by the compile path, or the reverse;
2. Smartware wants "one claim per fact across classifications" as a stated guarantee;
3. a conformance test is written asserting the two rules agree.

Until then the divergence is a known limit, and documentation must not claim the library has a single
identity rule.

### Interop consequence for a host that runs both surfaces

Coffee plausibly will (see the 2026-09-07 extraction finding: deterministic compile extracts 0 claims
from free-form prose, so the claim-producing path is `reflect.auto` or structured inserts). Such a
host can get:

- a **second active claim** for a fact the write path would have merged — `reflect.auto` did not see
  the existing row as the same claim, so it created one; and
- a row **demoted** by `resolveFactMatches` that `reflect.auto` still treats as a distinct claim.

Both rows stay in the store and recall de-duplicates neither. This is not silent corruption —
`resolveFactMatches` reports what it merged — but do not build policy on the assumption that the two
identity rules agree. The §1e sweep converges duplicates whichever path minted them.

### Which rule a backfilled tombstone snapshot carries (added 2026-09-15 · kanban `t_9e124fe6`)

The tombstone backfill (`src/layer1/tombstone-backfill.ts`) — the only in-tree writer of
`wiki/tombstones/*.md`, which snapshots a legacy `status: retracted` row — **recomputes the content
form** (`computeFingerprint(content, scope, claim_type)`) whenever the materialised row carries no
stored fingerprint. It does not emit the structured claim fingerprint (Rule B) even though
`insertClaim` stamps Rule B on every record it writes, for two reasons: the same legacy rule already
exists for records missing a fingerprint (`src/layer1/migration.ts` → `backfillClaimVersion`, the Q8
read-time backfill), and the snapshot block enumerates neither `subject_name`/`predicate`/`object`
nor `semantic`, so a structured value could not be re-derived from the tombstone alone — in an
artifact whose stated purpose is that a lost L1 version is reconstructible from it (Conformance Test
LC-04; `schemas/v0.5.0/tombstone-frontmatter.schema.json` → `snapshot`). This picks a side for
**legacy backfill snapshots only** and does not reconcile the two rules; no FORGET-path writer emits
`wiki/tombstones/*.md` yet, and when one lands it must carry the claim's **stored** fingerprint
forward, as §11 requires.

## Alternatives considered

1. **Fix only the documentation.** Rejected: every host still reimplements identity, and the docs are
   not executable — the defect reappears as soon as a host writes its own `find`. The repo's own
   convention (the smoke test imports exactly the public paths a guide names) exists to prevent this.
2. **Add `ORDER BY id` to `getClaimsBySubject`.** Rejected: it fixes row order but still returns *one*
   row silently — the duplicate is hidden, its evidence stays unreachable, recall keeps answering
   twice, and a general-purpose query changes behaviour for every existing caller.
3. **Ship the singular `findActiveFactMatch` suggested in the task.** Rejected: the singular name
   encodes the bug. It cannot report ambiguity, and a caller cannot distinguish "one match" from "the
   first of five". Plural matches plus an explicit resolution step makes the ambiguity visible by
   construction.
4. **Use raw value equality (`JSON.stringify(object.value)`), exactly as the pilot does.** Rejected:
   conflict detection already compares objects with `normaliseValue`. Two equality rules in one layer
   would answer "different fact" for identity and "corroboration" for `detectConflict` on the same
   row pair. `normaliseValue` agrees with the pilot on every pilot fixture — its suite passes
   unchanged — so parity holds where it was measured, and the *write path* now has one equality rule.
   It is strictly wider than the pilot's (text trimmed/NFC-normalised, enums case-folded).
   It is **not** the library's only value-equality rule: the structured fingerprint also lowercases
   text, and that difference is one of the measured disagreements in *Known divergence*.
5. **Delete the duplicate rows.** Rejected: destroys provenance and the audit trail; contradicts
   demote-never-delete, which the rest of the claim lifecycle already follows.
6. **Add `claim_type` to fact identity — i.e. unify Rule A with the fingerprint (option (a) in
   `t_15bb0cd0`).** Not rejected on the merits, **deferred to the owner**: it changes a frozen,
   host-visible contract and protocol identity semantics, and it would require re-deriving the pilot
   cross-check (its fixtures leave `claim_type` unset). *Known divergence* records the disposition
   this ADR takes in the meantime.
7. **Do nothing but keep quiet about the divergence.** Rejected: a silent disagreement between two
   documented identity rules over one table is the failure mode, not the inconvenience.
