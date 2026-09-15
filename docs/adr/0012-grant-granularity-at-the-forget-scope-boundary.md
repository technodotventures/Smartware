# ADR-0012 — The revocation boundary is the grant row: one row per (actor, client), and the re-grant requirement

- **Date:** 2026-09-15
- **Status:** Accepted
- **Deciders:** tech-head (substrate/decision lane) — card `t_f2b584dc`, confirming
  the finding recorded by ADR-0011 §6 (`grant-row-revocation`) from the gate run
  card `t_9740ae98`
- **Supersedes:** — (amends the Coffee tenant binding in spec §10b.1/§10b.2; the
  protocol surface is untouched)

## Context

Two bindings compose into a silent production incident.

- **§10b.3 (Lifecycle in config terms, binding):** a `FORGET.SCOPE` for
  `reason: offboarding|erasure` sets `status: 'revoked'` on *grants referencing
  the client scope*, in the same commit as the mutation
  (`src/protocol/forget_scope.ts` → `grantsReferencingScope()` → every capability
  array that literally lists the scope). A row is revoked **whole**.
- **§10b.1/§10b.2 (Staff grants, binding):** *one* `Grant` per staff actor, with
  exact scope-id lists ("the cluster IS the exact scope-id list") per capability.

Composed, the revocation boundary is the **row**, not the client the operation is
about. Multi-client staff are the normal case in the Coffee tenant model — the
§10b.4 worked example has `user:gigi` on `client:acme#1` + `client:bcau#1` — and
client churn (offboarding, erasure, DSR) is routine. So offboarding **one** client
silently removes a colleague's access to a **different** client's memory.

Measured by the ADR-0011 gate (the revocations themselves land in checks 6a
offboarding and 6c erasure; the cost to a **second** client is measured in 6n; staff
provisioned at `scripts/coffee-company-brain-fixture.mjs` line 151): ember-group
staff `user:sam` held `[client:meridian#1,
client:arcadia#1]` in one row; erasing `arcadia` flipped his `meridian` recall from
`ok` to `403 insufficient_permission` until he was re-provisioned. Re-measured for
this decision on the public adapter surface (evidence below, S1): the row is
`status:'revoked'` with both scopes still in its arrays, `grants_revoked: 1`.

Why this is a defect and not a choice: the operation is scoped (`FORGET.SCOPE{scope:
client:arcadia#1}`) and its receipt counts what it revoked — but nothing tells the
operator that a *different* client's access died. The failure is silent, it lands
on a client that was never the subject of the operation, and the adapter offers no
re-grant call to undo it. The erasure is correct; the blast radius is not.

Three options were on the table (the card's (a)/(b)/(c)). The obvious structural
fix — narrow the revocation in the substrate — was rejected as the wrong change at
the wrong moment, for the reasons in *Alternatives considered*.

## Decision

**1. The substrate keeps row-scoped revocation, exactly as released.** §10b.3 and
protocol v0.5.0 §FORGET.SCOPE are unchanged: grants referencing the scope are
revoked in the same commit, the receipt's `grants_revoked` is the set of revoked
row ids, offboarding stays revocable, erasure stays terminal. The v0.5.0
conformance surface is not touched, and the 79/79 gate result stands.

**2. Provisioning issues one grant row per (staff actor, client scope).** A row
carries that actor's capability cluster for **one** client (`observe`/`query`/`read`
for it, `correct`/`forget` only where the business grants them). The revocation
boundary then equals the intended access boundary, by construction: forgetting
client A can only revoke A's row. Measured (S2): erase `arcadia` → `grants_revoked`
lists exactly the arcadia row, the meridian row stays `active`, and the actor's
meridian recall answers with no re-provisioning.

**3. The re-grant requirement is part of the contract (binding on the host).** A
host that provisions a multi-client row (§10b.2 permits it) gets row-scoped
revocation for that row: offboarding or erasing any one of its clients removes the
actor's access to all of them. Such a host MUST re-provision the actor's remaining
scopes as part of the same offboarding/erasure step. Re-granting is a **config
provision** — write `config.json` (mode 0600); the adapter reads it on the next
operation. There is no protocol call and no adapter method for it. This is stated
in `docs/integration/coffee-adapter.md` §7 ("Provisioning grants") and carried
verbatim into the Coffee release handoff (paragraph at the end of this ADR).

**4. Two companion changes are implied by (2) and are not optional.** Both are
measured, and both are in card `t_864a5900` (created by this decision):

- **The adapter's degraded-read precheck must union the actor's active rows.** With
  per-client rows, `#precheck` in `examples/coffee-adapter/adapter.mjs` today takes
  the first row with `Array.find()` and denies a scope the actor *is* granted
  (S3, measured: standby `ok` for the first row's client, `403
  insufficient_permission` for the second). Fail-closed, but wrong: the fallback
  path would report a denial for authorized staff reads.
- **`coffeeTenantConfig` must emit the per-client shape.** Today `grantFor()` emits
  one row per actor listing every scope it was handed (S1, `row_count: 1`). Until
  this lands, the shipped template provisions exactly the shape the finding
  describes, and the contract doc says so explicitly.

**5. Normative text amended in this change** (`docs/competitive/mem0-substrate-spec-draft.md`):
§10b.1 `grants[]`, §10b.2 (granularity bullet), §10b.3 (row-scoped pointer on the
offboarding/erasure rows), §10b.4 (note: the worked example still shows the
single-row shape), and a v0.15 drafting-history entry. §10b.4's example, the mirror
`coffee-tenant-config.example.json` and the `scripts/verify-config-shape.mjs`
harness are re-shaped and re-verified by `t_864a5900`, in one change with the
adapter (their §10b.5 "code-verified" claims must move with them).

**6. Test surface this decision implies** (each is a required companion; the
implementation is `t_864a5900`):

| # | Where | Assertion | What it closes |
|---|---|---|---|
| C1 | `scripts/coffee-company-brain-fixture.mjs` (packaged gate, check 6n) | with per-client rows: erasing `arcadia` leaves the staff member's `meridian` recall `ok` **and** refuses `arcadia` — no re-provisioning | the finding itself, on the packaged artifact (today 6n asserts the collateral damage) |
| C2 | same fixture | no active staff/agent row lists two client scopes (provisioning shape) | the regression the gate could only document |
| C3 | `scripts/coffee-adapter-smoke.mjs` | standby/degraded recall allows every scope the actor holds a row for and denies a scope it does not | the S3 first-match defect |
| C4 | `test/protocol/forget-scope.test.ts` | two rows for one actor: forgetting one scope reports exactly that row, the other stays `active`, and the actor's other scope stays authorized | row-scope exactness at unit level |
| C5 | `scripts/verify-config-shape.mjs` + the two example configs | the shipped examples are per-client rows and the §10b.5 facts still hold (union semantics) | keeping "code-verified" claims true |

## Consequences

- **What becomes true.** The revocation boundary is the grant row, and the row is
  per client: offboarding or erasing one client cannot touch another client's
  access. Hosts that follow the shape carry no re-grant bookkeeping on the
  offboarding write path. The released protocol semantics — and the evidence
  behind them — stay exactly as verified.
- **What becomes harder.** Grant rows multiply (staff × clients), so anything that
  reasons about "the actor's grant" must union rows. `getGrantForActor()` is now
  only safe for existence checks and denial *reason* text, never for
  authorization; `evaluateAccess()`'s deny reason is derived from the first row and
  can name the wrong row; `SmartwareCore.ensureTrustedClientGrant()` rewrites the
  **first** row's capabilities and must not be used to provision per-client rows
  (it would collapse them). Recorded as sharp edges for `t_864a5900`.
- **Auditability is preserved.** Revocation is still `status: 'revoked'` on a row,
  counted in the ops entry, reversible on offboarding — the substrate's audit story
  is unchanged. That is the main reason the substrate behaviour was not narrowed
  (see alternatives).
- **Foreclosed / not decided here.** Hosts may still provision wide rows; the
  decision does not forbid the shape, it prices it (re-grant requirement). Nothing
  about the protocol surface changes.
- **Reversal trigger.** Revisit if a host legitimately needs a multi-client row
  (for example a future cluster-wide capability model) and cannot re-grant reliably
  — then the alternative is option (b) below, which changes a **released**
  conformance surface and is therefore an owner escalation, not a builder call.
- **Evidence.** `S1`/`S2`/`S3` in `/opt/data/workspaces/brain-pilot-evidence/adr-0012-20260915T110900Z/`
  (`measure.mjs` + `measure.json` + `raw.log` + `NOTES.md`), re-deriving gate check 6n and measuring
  the decision's mechanism on the public adapter surface at base `e937fab`.

## Alternatives considered

- **(b) Narrow the revocation: strip the forgotten scope from the capability
  arrays, leave the row active — lost on three counts.** (i) It changes a *released*
  conformance surface: protocol v0.5.0 §FORGET.SCOPE's "same-commit grant
  revocation", the meaning of the `grants_revoked` receipt, the ops-log intent
  validation (`src/ops_log/intent.ts`), ≥3 test files
  (`test/protocol/forget-scope.test.ts`, `test/conformance/v050-rebuild-forget-provenance.test.ts`,
  `test/schemas-v0.5.0.test.ts`), the gate fixture and the contract doc — that is a
  protocol version bump and a re-gate, straight into the Coffee handoff. (ii) It
  weakens the audit shape: "revoked, re-activatable" (offboarding) becomes
  "arrays edited", so "who lost access when" has to be reconstructed from a receipt
  field that does not exist yet. (iii) It is an owner escalation
  (`AGENTS.md`: escalate before changing a released protocol surface), so it cannot
  be decided by a builder card at all.
- **(c) Add an adapter re-grant path.** Keeps the coupling and turns it into a
  step on the write path: the host must notice, and until it acts the staff member
  is locked out of an unrelated client — the same silent window, now with a
  documented remedy. Strictly worse than (2): the structural fix removes the window
  and needs no bookkeeping.
- **(d) Documentation only, no provisioning change.** Rejected: it leaves the
  reference template provisioning the footgun, so the failure would still be
  discovered in production — the one outcome the card rules out.
- **Splitting rows per *capability* per client.** Considered and rejected as
  unnecessary: one row per (actor, client) carrying that actor's capability cluster
  for the client is the minimal unit that makes the revocation boundary right;
  more rows add no authority precision and multiply the config surface.

## Handoff text — verbatim for the Coffee release handoff (card `t_46c4acce`)

> **Grant revocation is row-scoped.** `FORGET.SCOPE` revokes every grant row whose
> capability arrays reference that client scope (spec §10b.3), and the reference
> adapter provisions one grant row per (staff member, client), so offboarding or
> erasing one client cannot touch that staff member's other clients. If your
> provisioning instead lists several clients in one grant row (the §10b.4 worked
> example shape), that row is revoked whole and the staff member loses **every**
> client in it — the adapter exposes no re-grant call. Re-provision the actor's
> remaining scopes as part of the same offboarding/erasure step: re-granting is a
> config provision (`config.json`, mode 0600, read on the next operation), never a
> protocol call. Measured before the fix: a `meridian` recall that answered `ok`
> before an `erasure` of `arcadia` answered `403 insufficient_permission` after it.
