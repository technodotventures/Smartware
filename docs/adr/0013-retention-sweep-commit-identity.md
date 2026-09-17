# ADR-0013 — The retention sweep always commits under an OperationId

- **Date:** 2026-09-15
- **Status:** Proposed (implemented and evidence-backed in the same change; owner sign-off requested — this restores a Tier-1 invariant of [ADR-0001](0001-retention-expiry-archival.md))
- **Deciders:** @tech-head (measurement + recommendation, kanban `t_543cb61a`, tip `4ff775a`). The decision is the **owner's**: `t_543cb61a` was opened as an owner decision because ADR-0001 cannot be amended in place, and the alternative (make the audit trail unconditional vs. write the gap down) spends a Tier-1 invariant. No owner was reachable in the session that produced this record, so the option implemented here is marked *Proposed* and the sign-off stays open.
- **Supersedes:** ADR-0001 **§2.2 Tier-1 invariant 5** (the audit/ops-entry sentence) and the **§2.3 / §2.5 / §4-AC3** description of the `retention.expire` entry shape. Everything else in ADR-0001 stands unchanged, including its other four Tier-1 invariants, the archival-by-default decision, and the "no new protocol verb" decision of §2.3.
- **Owner-facing:** no schema edit, no new protocol verb, no new protocol version. `operation_id` stays **optional** at the core and MCP surfaces. What changes: a sweep that supplies no id now writes **one** `retention.expire` entry (before: none) and returns the id it committed under. The reversal trigger is in *Consequences* — if the owner prefers the strict reading of protocol v0.5.0:80 ("externally requested mutations require a client-supplied `operation_id`"), the honest form of that is to require the id and let a bare call fail closed, which is a smaller, purely-subtractive change on top of this one.
- **Numbering note:** `0004`–`0012` are held by in-flight branches and several numbers there are already double- or triple-allocated (`0008`, `0010`, `0011`, `0012` — see the note in `wip/neo/host-lane-identity`'s ADR-0012). `0013` was taken to avoid adding another collision; if a different lane lands a `0013-*` first, the merge resolution is to renumber the later one, not to merge two records under one number.

---

## Context

ADR-0001 §2.2 Tier-1 invariant 5 states:

> Every expiry/purge writes exactly one ops entry with exact counts and an audit
> marker — "silent deletion" is impossible by construction.

The integrator-facing sentence in `docs/integration/saas-integration.md` §11 was corrected on kanban `t_b739c9ec` (branch `docs/saas-retention-ops-entry`), but the same unconditional claim also survived in ADR-0001 §2.3/§2.5/§4-AC3 and in the TSDoc that ships as the generated API docs. Re-measured on the current main line `4ff775a` (kanban `t_543cb61a`; probe `test/probe/probe-t543cb61a.test.ts`, raw report `probe-t543cb61a-head.json`, driving the real `SmartwareCore.expireRetention`):

| Leg | `operations/*.jsonl` lines | `retention.expire` entries | L0 tombstones carrying an `operation_id` | L1 forgotten `operation_id` | `runRecovery()` → `requiresManualReview` |
|---|---|---|---|---|---|
| bare sweep, N=3 (no `operation_id`) | 0 (before **and** after) | **0** | 0 of 3 | 67-char sha256 hex, **pattern-invalid** | 4 (3 of them the sweep's L1 records) |
| bare retry | 0 | 0 | 0 | unchanged | — |
| caller-supplied id, N=3 | 1 | **1**, counts 3/3, id verbatim | 3 of 3 | supplied id, pattern-valid | 1 (fixture-only) |

A bare sweep is the natural host-scheduler call: `operation_id` is optional on `ExpireRetentionParams` and on the MCP tool. So invariant 5 does not hold on a reachable path.

Three facts read from source turn this from a wording defect into a structural one:

1. `schemas/v0.5.0/claim.schema.json` **requires** `operation_id` on every claim version (required-array line 23), typed by `common.schema.json#/$defs/OperationId` = `^op_[0-9A-HJKMNP-TV-Z]{26}$`. A forgotten version cannot legally omit it, so the sweep **must** stamp one.
2. `src/ops_log/recovery.ts` classifies every L1 version whose `operation_id` is absent from the operations log as an **orphan** and adds it to `requiresManualReview` — the disposition `docs/atomicity.md` already writes down as *"Artifact with an operation ID but no intent or commit → report as an orphan requiring manual review."* A bare sweep satisfies both halves by construction.
3. On that path the minted id was the payload hash — `op_` + 64 hex chars — which the published pattern rejects (kanban `t_0177d9c3`; fix still unmerged on `wip/smarty/retention-op-id`).

Honest scope of the harm: at startup `runRecovery`'s report is computed but only `pendingOperations` is consumed (`src/core.ts:420-458`, `src/index.ts:121-133`), so `orphans` / `requiresManualReview` are discarded today and no operator alarm fires. The defect is that the substrate's own canonical lifecycle writes land in the class its recovery design defines as anomalous, and that classification is thrown away on every open. There is also no commit signal for a sweep at all — protocol v0.5.0:89 calls the operations-log entry *"the cross-surface commit signal"*, and spec v1.6.16:110 states the universal rule *"Every mutating operation records an entry."*

Consequence for the option space: **"fix the words" alone cannot hold.** Writing the audit gap down would also require a *new* carve-out in the recovery design for "substrate-stamped, never committed" L1 versions, or the substrate keeps classing its own writes as orphans. The real fork is *who* supplies the OperationId.

## Decision

**The retention sweep always commits under an OperationId — the caller's when one is supplied, otherwise `op_<ulid>` minted by the substrate for that invocation — and always appends exactly one `retention.expire` entry carrying it with the exact counts.**

Specifics, all binding once this ADR is accepted:

1. **One identity per sweep, not per record.** A single id covers the whole invocation: every L0 tombstone mutation it writes, every forgotten L1 version it writes, and the one operations-log entry. (`operation_id` is *required* on the L1 version by schema, and a per-record id could never be committed by a per-sweep entry — minting per record would re-create the orphan class this ADR exists to remove.)
2. **Minting convention.** `op_${ulid()}` — the same convention as the sibling host-triggered writers `session.start` / `session.end` (`src/protocol/session.ts:86-97`, `225-235`) and the dream phases (`src/dream/phases.ts:58`). Minted, not derived from the payload: the id identifies *this sweep's commit*, not a replayable request. It satisfies `OPERATION_ID_PATTERN`.
3. **A caller-supplied id keeps its meaning.** It remains the idempotency key: the pre-existing lookup over the operations log replays the recorded counts instead of sweeping again, and no second entry is written. The behaviour of that path is unchanged by this ADR (measured: id verbatim in the entry and on every artifact, one entry, retry replays). Whether that replay is also **payload-strict** — same id with a different `scope`/`as_of` returning `conflict`, spec v1.6.16:126 / protocol v0.5.0:84-85 — is decided separately by kanban `t_06db00ce` (branch `wip/smarty/retention-payload-identity`), which adds `details.payload_hash` to this same entry. When that lands it amends item 5 below; it does not change items 1, 2, 4, 6 or 7, and the minted path is untouched by it either way (a minted id is used once).
4. **One entry per invocation, including a no-op sweep** (counts `0/0`). A sweep that ran is a sweep that ran; spec v1.6.16:654 states the substrate's rule for the analogous case — *"Every phase outcome — including a clean, no-op Verify — records an entry in the canonical operations log."* It is also load-bearing for (3): the entry must exist for the next call with the same id to replay rather than re-sweep.
5. **Entry shape (this replaces ADR-0001 §2.3/§2.5/§4-AC3's description).** The entry is exactly:

   ```json
   {"operation_id":"op_<ulid>","actor_id":"user:owner","timestamp":"<ISO 8601>",
    "op":"retention.expire",
    "details":{"scope":"client:acme#1","observations_expired":3,"claims_retracted":3,
               "as_of":"2026-09-10T00:00:00.000Z"}}
   ```

   There is **no `reason` field** and counts are nested under `details`; the audit marker `reason: 'retention_expiry'` lives in each tombstone observation's `content.body` (and in its `provenance.context`). Pinned by a test on the exact key set. (The payload-strict replay of `t_06db00ce` adds `details.payload_hash` to this entry; nothing else about the shape changes, and the test permits exactly that one addition.)
6. **The result reports the committed id.** `ExpireRetentionResult.operation_id` becomes required (`string`): the id the sweep committed under, whatever the caller supplied. Without it a host cannot correlate its sweep with the audit entry.
7. **Fail-closed on a mid-sweep crash, unchanged in kind.** If the process dies between artifacts and the entry, those artifacts hold an uncommitted id and recovery flags them for manual review — which is the correct disposition, and the reason the sweep does **not** yet use the `operations/intents/` commit protocol of `docs/atomicity.md`. Bringing the sweep onto `runCommit` is a separate change, not a precondition for this one.

## Consequences

- **Tier-1 invariant 5 holds on every reachable path again**, with the one wording correction above: an ops entry is written per *sweep*, always, and the marker is in the tombstone.
- **The substrate stops manufacturing its own orphan class.** After this change a bare sweep's `requiresManualReview` contribution is zero (measured 3 → 0 on the probe instrument), and the forgotten versions it writes carry a pattern-valid id (measured 67 chars/`false` → 29 chars/`true`).
- **The optional path is now honest rather than silent.** A host that sweeps without an id gets an audit entry and a returned id; a host that wants replay-idempotency supplies one. No caller breaks — this is why the minting option was preferred over requiring the id (see *Alternatives*).
- **What becomes harder:** an operations log now grows by one line per sweep invocation per scope, including no-op sweeps. Cadence is host-owned (ADR-0001 §2.5): sweep on a lifecycle cadence, not a hot loop. If log volume ever matters, the lever is a JSONL compaction/rotation policy for the operations surface, not a silent exemption for the sweep.
- **What this forecloses:** the option of leaving a deletion-shaped operation with no committed identity at all. If a future host-triggered lifecycle pass is added, it inherits this rule.
- **Reversal trigger:** if the owner prefers the strict reading of protocol v0.5.0:80 — a sweep is an externally requested mutation and identity must therefore come from the client — the change is subtractive: make `operation_id` required on `ExpireRetentionParams` and the MCP tool schema, delete the mint, and let a bare call fail closed. The conformance test that pins the bare path's entry becomes a test that pins the refusal. Nothing else in this ADR changes; items 1, 2, 5, 6, 7 would each be re-stated in the superseding record.
- **Follow-on:** `t_b739c9ec`'s unmerged sentence in `docs/integration/saas-integration.md` §11 ("the entry is written only when the caller supplies `operation_id`") describes the pre-ADR-0013 behaviour and is **superseded** by this record; it should be rebased onto this change or withdrawn, not merged as-is. The two other lines the same integration text and ADR-0001 carry — "Idempotent per `operation_id`" — are superseded here for the entry shape and by `t_06db00ce` for payload strictness; §11 is rewritten in this change with the id semantics, and gains the "and payload → `conflict`" clause when `t_06db00ce` lands (it is not claimed in this tree, where that check does not exist yet).

## Alternatives considered

- **(a) Keep the id optional and only fix the words (the shape `t_b739c9ec` assumed).** Lost on measurement: the schema-forced uncommitted `OperationId` class on L1 is created by the bare path itself, so the superseding ADR would have to *also* amend the recovery design with a "stamped but never committed" exemption — more machinery and a weaker guarantee than writing the entry. It also leaves protocol v0.5.0:89's commit signal and spec v1.6.16:110's universal rule violated for a mutating operation.
- **(c) Require a caller-supplied `operation_id`, like the sibling lifecycle op `consolidate` (`src/protocol/consolidate.ts:46`, MCP schema without `.optional()`).** The strictest and most protocol-aligned reading (protocol v0.5.0:80; invariant 5 then holds with no carve-out and a bare call fails closed). Lost narrowly, on compatibility and on where it puts the burden: it is a breaking change on a surface shipped since 0.7.0, and it makes "no silent deletion" a property of *caller discipline* rather than of the substrate. Minting keeps the guarantee unconditional for a **host-scheduled lifecycle pass** — a class the substrate already treats as its own identity, as `session.start` / `session.end` show. This alternative remains one subtractive change away (see *Reversal trigger*); it is a live owner choice, not a rejected idea.
- **(b′) Mint one id per forgotten record (the `t_0177d9c3` fix as it stands).** Fixes the *pattern* defect but not the orphan class: a per-record id can never be covered by a per-sweep entry, so every forgotten version would still be an uncommitted-id artifact at recovery. Superseded by item 1 above; the branch's record-shape part (`carryDemotion`) is a separate concern and is unaffected.
- **Make a no-op sweep write nothing.** Lost: it contradicts the substrate's own rule for the analogous dream phase (spec v1.6.16:654) and breaks replay for a caller-supplied id, whose entry must exist for the next call to return the recorded counts.
