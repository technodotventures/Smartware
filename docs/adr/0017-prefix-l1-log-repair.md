# ADR 0017 — A canonical claim log written before ADR-0016 is repaired by an offline, L0-derived, append-only pass (an out-of-band migration, not a protocol verb)

**Status:** Proposed (drafted on card `t_a54a4606`; the owner's ruling is the binding act — this document changes no code and no schema)
**Date:** 2026-09-17
**Deciders:** @tech-head (measurement `t_e833be91`, decision draft), the operator (owner gate)
**Supersedes:** —

> Written in the bare `**Status:**` line-start form on purpose: on this tree `scripts/substrate-status.mjs:53-59` reads
> only `^\*\*Status:\*\*`, so the `docs/adr/README.md` template's bulleted `- **Status:**` projects as `(no status line)` and
> a Proposed decision vanishes from `docs/STATUS.md`'s pending-decision line. `fix/status-projection-adr-bullet` closes the
> reader gap; once it lands, either form reads.
>
> **Number:** `0017`, the lowest free above `0016` in the registry snapshot carried by
> `docs/adr-numbering-registry` (PR #20 — unmerged on this base, so this tree has no registry table to add a row to).
> Verified 2026-09-17: no branch ref and no open pull request carries a `0017-*` ADR. The registry row lands with
> PR #20's table, or in this file's commit on whichever base carries it first.

## Context

ADR-0016 changed what a canonical L1 record *means*: `insertClaim` derives the record's `state` from
`claim.status` (`statusToState`, `src/layer1/types.ts:126`) instead of honouring a caller-supplied, stale `state`
carried out of the store by `rowToClaim`. The correction path (`replay.ts` → `handleCorrection`) mutates `status` on a
claim it read back and re-inserts it, so **every correction a pre-fix build performed wrote an `active` version in place
of the retraction**. ADR-0016 recorded the consequence and explicitly left it open:

> *"Existing corrupted pods repair on their next write, not retroactively … No repair pass over existing pods is part of
> this change."* — ADR-0016, *Consequences*

Kanban `t_e833be91` (verdict **REPRODUCES**, independently reviewed and APPROVED on `t_e833be91` by a different profile)
measured what "on their next write" does not cover, at pre-fix `e937fab73d863d38d790eca6a001201a403854d9` vs fixed
`1e3772b77f492de00a0cdae192bd60840358265b`. All engine facts below are measured there and cited by path; the code facts
are re-read by this card on `fix/b1-correction-durability` @ `ab9cf2b` (which differs from `1e3772b` only in
`docs/journal/2026-09-16-t_8ddfa350.md`, so the measurements stand for the tip).

1. **The resurrection is durable, not transient.** A brain whose canonical log was written by the pre-fix build, opened
   by the fixed build in a fresh process with no later write, serves **two rows** — the corrected `2026-12-15` *and* the
   retired `2026-11-02`, both `active` — and the retracted claim's **latest canonical version still says
   `state: active`** (`attachments/t_e833be91/out/B2-postfix-open-only.json`, `S0-rawlines.txt`). The read is
   read-only on L1 (identical `claims/*.jsonl` sha256 before/after).
2. **The only in-brain disagreement cue is destroyed by the first open.** The correcting process leaves the row
   `status: retracted` / `state: active`; the next fresh open — pre-fix *or* fixed build — re-derives the row from the
   canonical line and writes `status: active` (`out/A-db.json`, `out/B-db.json`, `out/C-db.json`). A repair keyed on the
   row therefore works only on the exact directory as the correcting process left it, and only before anything opens it.
   **The derivation must come from L0.**
3. **It is sticky.** A later write of a different fact changes nothing; the same text is L0-deduplicated (no claim
   write); the same fact with new text **corroborates the resurrected claim** and appends more `active` versions of the
   retired value; a post-fix `compile` appends nothing (the replay watermark `last_replayed_sequence = 2` already covers
   the correction observation) (`out/S3-*`, `S4-*`, `S5-*`, `WM-prefix-brain.json`, `WM-l2-compiled.json`).
4. **The defect travels.** `EXPORT.SCOPE` ships every version and `RESTORE.SCOPE` re-derives from them, so the restored
   brain serves the retired value too (`out/R1b-repair-dry.json`, `R2b-repair-applied.json`).
5. **The derived L2 surface carries it.** `compile` over the unrepaired brain writes `wiki/concepts/acme.md` holding the
   retired value four times; repairing the claim log alone does **not** touch the page — only a recompile cleared it (0
   occurrences) and wrote `wiki/tombstones/<claim>.md` (`out/L2c-recompile.txt`).
6. **The acceptance gate cannot see this class.** Checks 3j–3n write the brain with the build under test and then
   restart it — a same-build round trip. The gate is **85/85 at `1e3772b`** while a pre-fix brain still replays the
   retired value (`out/gate-1e3772b/`).

Code facts this card re-read (not measured behaviour), which fix the decision's boundaries:

- **Which L0 events retire a claim.** `handleCorrection` (`src/layer1/replay.ts:246`) branches on four reasons.
  `wrong` and `extraction_error` set `status: 'retracted'` — the only two that project to `state: 'forgotten'`.
  `changed` and `duplicate` set `status: 'superseded'`, which `statusToState` maps to **`active` by construction**: that
  is the separately-carded *superseded* class (B2/B3, `t_5ef44cc1` / `t_864a5900`), not this one. The correction
  observation itself carries `source.actor` and `source.captured_at`, and its body carries
  `target_claim_id` / `reason` / `changed_claim` / `change_time` (`src/protocol/_correct_legacy.ts:90-126`; the same
  shape pre- and post-fix — `e937fab..1e3772b` touches only `src/core.ts` and `src/layer1/store.ts`).
- **CORRECT writes no ops entry.** `OpType` (`src/ops_log/types.ts`) has no `correct`; measured, the brain has no
  `operations/` directory at all and the exported package's `counts.operations` is 0. ADR-0001's "every mutating op
  writes exactly one ops entry" is therefore **already false for CORRECT** — this ADR does not restate it as an
  invariant, and the repair does not inherit an audit trail it can key on.
- **REVIVE requires the latest record to be `forgotten`.** `src/protocol/forget.ts:541-557` throws
  `ProtocolError('not_forgotten')` otherwise, then appends an `ActiveClaimVersion` stamped `revived_via`.
  Read from code, not measured: on a defective brain the sanctioned re-admission verb is *unreachable* for the very
  claim that needs it.
- **A file-level pass bypasses the fence.** Measured on a brain whose high-water is ahead of the caller:
  `ProtocolError: fencing_token_missing … high-water epoch 2`, recorded in the brain's `writer_fence` table
  (`refusals: 2`, `last_refusal_op: compile`) (`out/FENCE2-no-token.log`, `FENCE2-watermark.json`).
- **Latest-version resolution is the only reader contract.** `ClaimStore.setDataDir` (`src/layer1/store.ts:211-218`)
  takes `max(version)` per `claim_id` across `claims/*.jsonl` and re-derives the row from it; `claimVersionVals`
  derives `status` from the record's `state`. Export and restore read the same chain.

**Exposure today is zero.** The Coffee trial build starts from a fresh brain and the Coffee RC (`wt/t_9740ae98`) was
never handed over, so no brain in the field carries this defect. The window that closes it is *the first post-fix write
on a brain written by a pre-fix build* — and that window recurs for every future change of this shape.

## Decision

**A brain whose canonical L1 log was written by a pre-fix (pre-ADR-0016) build is repaired by an offline,
L0-derived, append-only pass that appends exactly one `state: 'forgotten'` version per affected claim; the pass ships as
an out-of-band migration tool with its own audit artifact — not as a protocol verb, not as a new `OpType`, and with no
spec, protocol or schema revision.**

The pass is a repository script (`scripts/repair-canonical-claim-log.mjs`; `scripts/` is outside `package.json`'s
`files`, so it is not a distributed surface) driven by the operator against a stopped pod. It changes no engine code.

### 1. The derivation rule (what the pass acts on)

Never the claim row's `status` (Context 2). The work list is derived from L0 evidence plus the canonical log, both of
which the pass reads and neither of which the first open modifies:

1. Read every record under `<brain>/evidence/*.jsonl`. Keep the `type: 'correction'` observations whose
   `content.body.reason` is **`wrong`** or **`extraction_error`** and whose `content.body.target_claim_id` is present.
   `changed` / `duplicate` are excluded by rule — they express a supersession, and the superseded class is
   `t_5ef44cc1` / `t_864a5900`'s to close (this is where the `t_e833be91` probe's own selector was looser than this
   rule: it matched any observation carrying a `target_claim_id`).
2. For each target claim, compare against the canonical log: candidates are the claims whose **latest** record
   (max `version` across `claims/*.jsonl`) has `state: 'active'`.
3. Skip a candidate whose latest record carries **`revived_via`** — an explicit re-admission after the retirement
   (`src/protocol/forget.ts:592`) is a decision that outranks the retirement.
4. **Apply one appended version per candidate.** A later non-retirement correction on the same claim does not make the
   retired value current again, so it does not remove the candidate; the plan prints the claim's whole correction history
   so the operator sees that shape before applying.

The rule is **idempotent by effect and crash-safe by construction**: a repaired claim's latest record is `forgotten`, so
it is not a candidate on the next run (`out/R5a-repair-run1.json` → `R5b-repair-run2.json`: `plan: []`, four lines after
two runs), and a run interrupted part-way leaves the untouched claims still candidates. It is also
**open-invariant**: the pass reads L0 and the canonical chain, never the derived row, so it can be planned at any time —
before or after the first post-fix open.

### 2. The record the pass appends

The shape is the fixed writer's own forgotten record (`src/layer1/store.ts:541`), with everything copied from the line
being superseded so the pass invents no values:

| field | source |
|---|---|
| `claim_id`, `claim_type`, `claim_role`, `author`, `epistemic_owner`, `fingerprint`, `confidence`, `epistemic_tag`, `scope`, `derived_from`, `relations`, `created_at`, `version_at`, `operation_id`, `actor_id`, `tags` | copied verbatim from the latest (superseded) record |
| `version` | `superseded.version + 1` |
| `state` | `'forgotten'` |
| `supersedes` | the superseded version number — required by the shipped schema for any `version >= 2` and for every forgotten record |
| `tombstone_id` | `tomb_${claim_id.slice(6)}` (the writer's rule) |
| `forgotten_at` | the retiring L0 observation's `source.captured_at` — the instant the engine recorded the retirement, which is also what the pre-fix writer stamped into the row's `t_invalidated` |
| `forgotten_by` | the retiring L0 observation's `source.actor.id` — the actor who decided the retirement; if that record carries no actor, the candidate is **skipped and reported**, never guessed |
| — | `content` and `semantic` are dropped (the forgotten branch has no content) |

Deliberate divergences from the current writer, both flagged because a reader may compare the two shapes: the writer
carries `forgotten_at = versionAt` (`store.ts:541`, effectively the inherited ingestion stamp) and, on this base, emits
**no** `supersedes` at all — the repaired record dates the tombstone truthfully and satisfies the field the writer
leaves out (ADR-0014's writer rule is `t_3ba3ee39`'s lane to land).

**`operation_id` is inherited, never minted.** A migration is not a protocol operation, so it must not stamp an `op_`
identity that no operation produced; inheriting keeps the record's provenance identical to the line it continues. On
this generation that propagates the pre-existing `op_LEGACY00000000000000000000` marker (`t_85817375`) — measured below
as **exactly one** residual schema error, and zero once the lines being superseded carry real operation ids (post-B2).

### 3. The audit question: migration artifact, not `OpType`

**No new `OpType`, no protocol/spec revision.** A published verb is a permanent client-facing surface (grants, an MCP
tool, fence participation, a protocol version bump) minted for a transitional condition that exists only for brains
written between two builds. It would also run through `insertClaim`, i.e. with *less* control over the exact record than
the pass has — and on this base the writer does not emit `supersedes`, so a verb-shaped repair would produce a record
the shipped schema rejects.

The pass writes its own audit artifact instead:

- `<brain>/migrations/<YYYY-MM-DDTHHMMSSZ>-<tool-revision>/report.json` (+ a human-readable `report.md`) — written on
  every run, dry run included, so the *absence* of a repair is as recorded as its application.
- Contents: the tool revision and build digests, the brain path, the L0 retirement observations used as the work list,
  the plan (per claim: id, scope, latest version/state, the correction history, the action), the applied appends
  (version, `supersedes`, `tombstone_id`), the `sha256` of every `claims/*.jsonl` file touched before and after, and
  **the scopes that now need a recompile** (§4). Ids, counts and hashes only — no claim values, no PII.
- The artifact is not a packaged surface: `EXPORT.SCOPE` ships `claims/`, `observations/`, `entities/` and
  `operations/`, so a repaired brain's package is unchanged by it (measured, the package count that moves is
  `counts.claims`, 4 → 5 after a repair: `out/R2b-export-rawlines.txt`).
- **Honest statement of what the ops log gets: nothing.** The pass writes no operations entry, and it must not be
  described as doing so. CORRECT writes no entry either (§Context), so a repaired brain's `operations/` stays empty for
  this class — the audit trail is the migration artifact, and calling it anything else is how a project accumulates
  fiction. Closing the CORRECT-side gap is its own decision on the writer, not a side effect of this repair.

### 4. L2 staleness: the repair is paired with a recompile, not declared complete

The repair moves L1 only. A compiled page that captured the retired value keeps it until that scope is recompiled
(measured: 4 occurrences after the repair, 0 after a recompile, plus a tombstone page). The pass therefore **reports the
affected scopes in its artifact** and the procedure requires a recompile of each — a normal `compile` against the
repaired brain, after the repair and before the pod is declared whole. Where an operator chooses to defer it, the
deferral is recorded in the artifact rather than left as an unstated gap. `wiki/tombstones/<claim>.md` carrying the
retired value is expected for a tombstone and is not a defect.

### 5. The offline rule

The pass writes `claims/*.jsonl` directly and therefore does not participate in the writer fence (measured refusal,
`fencing_token_missing`, high-water 2). It is therefore **run with no live writer**: the pod is stopped, or the pass is
not run. The tool refuses to be pointed at a brain it cannot prove is quiescent and requires the operator to state that
the pod is stopped; it takes no brain-level lock and offers no live-writer mode. Driving the same work "through a verb
under the fence" is explicitly *not* this decision (§Alternatives, E).

### 6. The trigger, and the standing rule

- **Repair before the first post-fix write on any brain written by a pre-fix build.** The pass run with `--dry-run`
  (default) *is* the affectedness check for that brain: `plan: []` means no repair is needed, and the check is
  open-invariant (§1) so it can be run at any point before or after an upgrade.
- **Today:** no repair is needed anywhere — the trial build starts from a fresh brain and the Coffee RC was never handed
  over. The obligation is a gate on the release step that first ships the fixed build to a brain that already exists,
  not a task with work waiting behind it.
- **Standing rule (the same window recurs).** Any future change that alters what a canonical record *means* — rather
  than what new records contain — owes an offline, L0-derived, append-only re-derivation pass with its own audit
  artifact, decided when the change lands. That is the shape this ADR fixes; a later instance supplies a derivation
  rule, not a new mechanism decision.
- **Reversal trigger.** Supersede this ADR if any of the following becomes true: (a) a pod can never be stopped, so the
  work must run under the fence — the condition under which a protocol verb becomes the only viable shape; (b) CORRECT
  gains an ops entry (or the protocol gains a first-class repair receipt), which would give the work an audit surface to
  key on; (c) `superseded` gains a canonical state, which would remove the reason to exclude `changed`/`duplicate` by
  rule.

### Now permitted / now forbidden

- **Permitted:** an operator-run, offline, append-only pass over a quiescent brain, with its own audit artifact, derived
  from L0 correction observations and validated against the shipped `claim.schema.json`; a second run being a no-op.
- **Forbidden:** keying the work on the claim row's `status`; rewriting or deleting a canonical line in place
  (spec §6 / protocol v0.5.0:97 — *"never in-place edits"*), including the mechanically-working state-only flip;
  a blanket `layer1_state.last_replayed_sequence` rewind as a repair; minting an `operation_id` for the appended line;
  running the pass against a brain with a live writer; and describing the operations log as recording the repair.

## Consequences

- A repaired brain serves exactly one row for the corrected fact (`out/R2b-repair-applied.json`: one row, the corrected
  `2026-12-15`), the repair survives `EXPORT.SCOPE → RESTORE.SCOPE` (restored brain: one row, canonical
  `v1 active / v2 active / v3 forgotten / corrected v1 active`), and REVIVE becomes reachable again for the claim
  (its latest record is now `forgotten`, the guard REVIVE requires).
- **The broken line stays.** Append-only means the log holds a `v2 active` and a `v3 forgotten` for the same id; every
  latest-version reader (`setDataDir`, `readLatestVersion`, export, restore) is correct, and a reader that takes a
  version's `state` at face value still sees the stale line. That is the price of not destroying the evidence of what
  the pre-fix writer emitted — and it is why the repair is a re-derivation rather than a rewrite.
- The repair adds a version per affected claim, so package/manifest claim counts grow (4 → 5 in the measured brain);
  `counts.observations` / `counts.entities` are untouched (no new evidence is fabricated).
- The appended record validates against the shipped schema with exactly one residual error — the inherited
  `op_LEGACY…` operation id (measured, §Evidence) — and with zero on a brain whose superseded line carries a real id.
  The repair neither creates nor closes that class.
- Recompiling affected scopes costs a compile run per scope and rewrites pages; the retired value leaves the L2 surface
  only then.
- The pass is not a guardian of future classes: it closes the *retraction* class only, and the classes it deliberately
  does not touch are listed below.

## Alternatives considered

1. **B — rewrite the claim's latest line in place.** Measured to work mechanically in both variants: the minimal flip
   heals recall (`out/R3-repair-flip.json`) but the record fails the schema on four required properties
   (`tombstone_id`, `forgotten_at`, `forgotten_by`, `supersedes`); the writer-shaped flip validates
   (`out/R4-repair-flip-clean.json`). Rejected on protocol grounds and on evidence grounds: it violates spec §6 /
   protocol v0.5.0:97 "never in-place edits", destroys what the pre-fix writer actually emitted, and invalidates every
   package or tombstone derived from that line.
2. **C — rewind `layer1_state.last_replayed_sequence` and let the fixed writer re-derive from L0.** Measured to work —
   the writer itself appends `v3 forgotten` attributed to the correcting actor and recall drops to one row
   (`out/WMb-rewind-compile.txt`, `WMc-rewind-open-only.json`) — but it is **not exactly-once**: the same replay also
   appended a duplicate version of the corrected claim, and on a brain whose L0 carries `claim_extracted` observations
   it would re-materialise claims through `deterministicClaimId` (`src/layer1/replay.ts:26`, carded `t_0b079fbf`). On
   this base the writer also emits no `supersedes` for `version >= 2`, so the re-derived record is schema-invalid too.
   Rejected as a general repair; a per-claim rewind would be a derivation rule with a worse failure mode
   (re-running the whole write path) than appending one record.
3. **D — a policy gate instead of a repair** ("a brain written by a build older than the state-derivation fix takes no
   post-fix write until it is rebuilt from L0 or repaired"). Kept as the *operational* fallback for a brain that cannot
   be quiesced (rebuild from L0), and rejected as the answer: it does not cover a pod that is live when the fix lands,
   it leaves the operator to detect the condition by memory, and it carries the residual as prose — which is the failure
   mode this card exists to end.
4. **E — a protocol verb / a new `OpType` (`repair.canonical`).** Rejected: a permanent client-facing surface (grants,
   MCP tool, fence, version bump) for a transitional condition; it would run through the writer, which on this base
   produces a record the shipped schema rejects and which offers less control over the appended shape; it would paper
   over the CORRECT-side audit gap instead of fixing it; and `OpType` is policed by the enum-symmetry guard
   (`wip/neo/optype-derivation-guard`, PR #18) precisely so that new op vocabulary is a deliberate act. Its one genuine
   advantage — the ability to run *while the pod is live*, under the fence — is preserved as a reversal trigger (§6).

## Explicitly not decided here

- The **superseded** class (`changed` / `duplicate` → `status: 'superseded'` → `state: 'active'` by construction):
  `t_5ef44cc1` / `t_864a5900`. The pass excludes those reasons by rule and must not be widened to cover them silently.
- `op_LEGACY…` operation ids (`t_85817375`), replay-minted `claim_<lowercase hex>` ids (`t_0b079fbf`), the demotion
  pointer on hand-built records (`t_8098b097`), and the L2 frontmatter serialiser's shape limits (`t_cf744a8e`).
- The duplicate *corrected* claim that the operator remedy (re-issuing CORRECT on the fixed build) leaves behind
  (measured, `out/S6c-postfix-recorrect.json`): that is the fact-identity dedup path (§1e `resolveFactMatches`), not
  this repair.
- Whether CORRECT *should* write an ops entry (the pre-existing audit gap this ADR refuses to restate as an invariant).
- **Implementation.** No code, schema or protocol byte changes on this card; the pass is specified here and implemented
  only after the owner's ruling.

## Evidence

Parent measurement (every number above, with the probe scripts verbatim):
`/opt/data/kanban/boards/smartware/attachments/t_e833be91/MEASURE-t_e833be91.md`, `out/` (probe reports),
`probe/` (scripts), reviewed and APPROVED by a different profile on the same card.

Re-derived by this card (attachments on `t_a54a4606`), at `fix/b1-correction-durability` @ `ab9cf2b`, Node v26.5.1:

```
adr0017-record-shape.mjs -> evidence/adr0017-record-shape.json   (schemas registered: 16)
  rule selected the retired claim: true
  ADR-0017 record        errors (1): /operation_id must match pattern "^op_[0-9A-HJKMNP-TV-Z]{26}$"
  same record, real op id errors (0): []
  fixed writer's OWN forgotten record on this base errors (5):
      "/ must have required property 'supersedes'" + "/ must match \"then\" schema"   (state=forgotten branch)
      "/ must have required property 'supersedes'" + "/ must match \"then\" schema"   (version>=2 branch)
      "/operation_id must match pattern ..."
    i.e. three distinct causes; Ajv reports five entries because the missing `supersedes`
    is reported once per if/then branch.
```

Not run here, and not claimed: no build (`npm run build`) and no test suite — this card changes no code; the defect
itself was not re-measured (the parent's measurement was independently reviewed and approved, and this card owns the
decision, not the measurement); the coffee gate was not re-run; the repair tool does not exist yet, so its record shape
is validated as a constructed record against the shipped schema rather than by being written by a tool.
