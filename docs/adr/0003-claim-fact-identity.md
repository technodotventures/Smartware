# ADR-0003 — Fact identity on the claim write path: the library resolves the fact, not the key

- **Date:** 2026-09-14
- **Status:** Accepted
- **Deciders:** @smarty-pants (protocol stewardship / research). No owner sign-off gate: this is an
  **additive SDK surface** change — no protocol invariant, schema, identity, cryptography, or
  authority-table change.
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

## Decision

**Smartware ships the fact-identity rule as public API, and the integration guide documents that API
instead of a hand-rolled `find`:**

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

## Consequences

- Hosts no longer reimplement identity, so two hosts cannot disagree about whether two rows are one
  fact. The host-side pilot's reference implementation remains a valid cross-check: its 6
  deterministic tests pass **unchanged** against the shipped helper (executed 2026-09-14).
- New public names (`findActiveFactMatches`, `resolveFactMatches`, `FactMatchResolution`) — additive,
  so the next release cut is a **MINOR** version bump, not a patch. No schema, protocol, or config
  change; `package.json` `exports` already reach `./layer1` and `./layer1/corroboration`.
- **Not automatic.** An existing store keeps its duplicates until a write touching that fact resolves
  them, or the host sweeps the scope. Recorded as an honest limit in the guide §10 and in
  `docs/conformance-status.md`; the "no automatic repair of ambiguous memory" release claim stays
  true.
- **Scope isolation wins over deduplication.** Identity includes `scope`, so the same fact asserted in
  two scopes is never merged.
- Evidence: `test/layer1/fact-identity.test.ts` (19 tests) and `npm run verify:saas` (2 recall results
  for one fact before resolution, 1 after; duplicate superseded; evidence 2→3; two rows for one fact
  carry two different canonical keys). Mutation check: restoring the silent `.find()` pick in
  `findActiveFactMatches` fails **8 of the 19** tests and fails the smoke E2E with the symptom itself
  — "recall returned 2 claims for one fact after resolution".
- **Reversal trigger:** a host that needs the same fact merged across scopes or subjects is asking for
  *entity resolution* (aliasing), which is a different decision — reopen this ADR rather than widening
  identity here.

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
   unchanged — so parity holds where it was measured, and the whole library now shares one rule.
   (The library's rule is strictly wider: text is trimmed/NFC-normalised, enums case-folded.)
5. **Delete the duplicate rows.** Rejected: destroys provenance and the audit trail; contradicts
   demote-never-delete, which the rest of the claim lifecycle already follows.
