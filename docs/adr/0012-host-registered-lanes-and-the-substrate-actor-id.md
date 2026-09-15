# ADR 0012 — Host-registered lanes are not v0.5.0 scopes, and the substrate has exactly one ActorId

**Status:** Proposed — owner approval is the gate before merge (it states what the v0.5.0 conformance
claim covers; no published schema byte moves)
**Date:** 2026-09-15
**Deciders:** @neo (decision prepared and implemented on kanban `t_9a700aed`, carded out of
`t_229601e4`). Owner sign-off is the merge gate: one half fixes a writer defect, the other writes down
the boundary of the v0.5.0 conformance claim, and the follow-up is a protocol-surface fork the owner
picks.
**Supersedes:** none
**Numbering note:** `0004`–`0011` are held by other in-flight branches and three numbers are already
double-allocated (`0008`, `0010`, `0011`); `0012` was taken to avoid adding a fourth collision.
Branch: `wip/neo/host-lane-identity` (forked from `wip/tech-head/claim-record-semantic` @ `981e5a7`).

## Context

`reflect.auto` appends L1 records whose `scope` is the lane its observation lives in and whose
`actor_id` is the substrate's own. Through the pod profile both fields disagree with the published
contract. Measured on `t_229601e4` (raw JSONL + Ajv against `schemas/v0.5.0/`):

```
[probe reflect.auto:status_is] envelope={"scope":"pod/semantic-probe/workspace",
  "actor_id":"substrate:01M2J9GPNDP8C3CWAHRSRXSBJD", ...}
[probe reflect.auto:status_is] valid=false errors=[
  "/scope:pattern: must match pattern \"^(self|workspace|project:[a-z0-9-]+|agent:[a-z0-9-]+|client:[a-z0-9-]+(?:#[1-9][0-9]*)?)$\"",
  "/actor_id:pattern: must match pattern \"^(user|agent|sidecar|substrate):[a-z0-9-]+$\"" ]
```

The two fields have different causes and different owners.

**The ActorId half is a writer defect.** Spec §5 says every ActorId — including the substrate's own —
is `<actor-kind>:<slug>`, and the substrate's slug is the pod/instance (`substrate:coffee`); the
published `$defs/ActorId` admits `[a-z0-9-]+`. The library minted `substrate:<ULID>` from
`config.instance_id.replace('smartware_','')` in `src/protocol/reflect.ts` and
`src/compile_queue/worker.ts` — and `substrate:smartware-<ulid>` (lowercased, dashes) in
`SmartwareCore.dream`. Crockford base32 is case-insensitive in its own right; the published pattern is
not. So **one instance carried two different substrate identities, and the one on reflect.auto's
claims and operations-log entries was the one the pattern rejects.** The independent probe run for
this card confirmed all three surfaces and both spellings before the fix (raw before/after output:
`probe/*.out` on kanban `t_9a700aed`).

**The Scope half is a vocabulary question.** The protocol's `Scope` grammar is closed and enumerated
(`self | workspace | project:<slug> | agent:<slug> | client:<id> | client:<id>#n`; spec §7 roots it in
the memory hierarchy); the v0.5.0 change history shows how a form enters it — `client:<id>#n` was
*designed* in the Coffee tenant binding (substrate spec §10b) and widened into the schema set in the
same protocol release. Separately, the library lets hosts register their own lanes
(`ensureScopes`: consumers "may register app, project, or domain spaces without adding those concepts
to Smartware's profile contract"), and the reference implementation's own pod-profile helper
(`createPodProfile`) registers `pod/<pod>/personal` and `pod/<pod>/workspace`. That surface is live:
the Pod product extends it with `pod/<podId>/workspaces/<id>` and `pod/<podId>/apps/<app>`, exposes the
resolved ids in its own API responses and grants, and stores them in its data (measured in the Pod
checkout @ `52fd85c`: `src/pod/data-spaces.ts`, `src/routes/workspaces.ts`,
`docs/coffee-staging-integration.md`).

The contract does not leave this to taste. Protocol v0.5.0 → *Conformance boundary* requires "schema
validity on every canonical write", and "If these artifacts disagree, the conflict blocks conformance
until corrected." A brain whose canonical writes carry a scope the schemas reject **cannot claim
v0.5.0 conformance**, however healthy everything else is. AGENTS.md rule 7 makes the normative text
(unlike a schema-accuracy fix) not editable as a side effect of a code change.

## Decision

**Two decisions, one per field.**

1. **The substrate's ActorId is one canonical lowercase `substrate:<slug>` per instance**, minted by
   one function (`substrateActorId`, `src/config.ts`) that every autonomous writer uses — `reflect.auto`
   (synchronous and background compile), and `dream`. The published `ActorId` pattern is correct as
   published; the writers were wrong, and they disagreed with each other. This half is a defect fix,
   not a protocol change. The `smartware_` instance-id prefix is not part of the slug:
   `smartware_coffee` → `substrate:coffee` (the spec's own example), an anonymous ULID instance →
   the lowercased ULID.
2. **Host-registered lanes are not v0.5.0 `Scope` values.** v0.5.0's scope vocabulary stays closed.
   The pod-profile lanes (`pod/<pod>/<lane>`) are **host-registered lanes**: legitimate
   scope-registry ids, but outside the published vocabulary and therefore outside the v0.5.0
   schema-conformance claim. That is now stated where integrators read it
   (`schemas/v0.5.0/README.md`, `docs/conformance-status.md` → *Remaining limits*, and the
   `createPodProfile` docstring), and pinned by tests on both sides: `test/schemas-v0.5.0.test.ts`
   rejects the host-lane spellings, and `test/layer1/pod-profile-conformance.test.ts` asserts that the
   **only** Ajv error a pod-profile record carries is `/scope:pattern` while a protocol-native-lane
   record's complete error list is empty.

Boundaries, precisely:

- **The ActorId fix changes no schema and no protocol text.** Existing records and operations-log
  entries keep the spelling they were written with (canonical surfaces are append-only; nothing is
  rewritten). Historical `substrate:01M2J9…`-style ids are pre-fix artifacts; new writes carry the
  conformant spelling. The alias map (`agents/aliases.jsonl`, forward-only renames) is the existing
  mechanism if a host wants read-time resolution; this change does not append per-instance alias
  entries (nothing in the library consumes the resolution, and pre-seeding rename records for brains
  that never wrote the old spelling would be noise).
- **Disclosure, not migration — and not a widening.** The Pod surface keeps working unchanged; no host
  data, grant, or scope id is touched by this decision. The published `Scope` pattern is unchanged:
  a record in a host lane is honestly outside it rather than silently admitted by a quiet pattern
  edit.
- **The honest consequence for hosts is written down, not softened:** a brain that writes canonical
  records in host-registered lanes does not meet the v0.5.0 conformance boundary
  ("schema validity on every canonical write") unless and until its lanes are protocol-native or a
  later protocol revision admits a host-lane form. Hosts that need v0.5.0 schema-conformant records
  today write `self` / `workspace` / `project:<slug>` / `agent:<slug>` / `client:<id>[#n]` lanes.
- **Not decided here: whether the next protocol revision defines a host-lane form.** Recommendation
  (see *Alternatives*): it should, as a deliberate revision-level change with its own design
  questions — and the pod surface is the wrong place to discover them. The fork is carded for the
  owner.

## Consequences

- **The measured divergence is half closed, half disclosed.** At this branch's tip the probe reports:
  claims → `valid=false`, complete error list `["/scope:pattern"]` (the documented host-lane
  divergence); operations-log entries → `valid=true`, `errors=[]` for reflect.auto *and* dream, both
  carrying the same `substrate:<ulid>` id; protocol-native control flow → claims `valid=true`,
  `errors=[]`. The formerly pinned test in `test/semantic-materialization.test.ts` no longer
  substitutes the actor id (it substitutes only the host lane), and
  `test/layer1/pod-profile-conformance.test.ts` pins the whole error list both ways.
- **One instance, one substrate identity** is now an invariant a test can hold: `reflect.auto` and
  `dream` entries in one brain must agree, and must equal `substrateActorId(config)`.
- **The Scope vocabulary's closedness is enforced by the suite**, so a future widening cannot land by
  accident: `test/schemas-v0.5.0.test.ts` fails if the pattern starts admitting host lanes, and the
  README qualification would have to move with it.
- **`createPodProfile`'s contract is now explicit**: it registers host lanes, and the docs say what
  that means for conformance. A host that reads only the API surface can no longer mistake the ids
  for protocol scopes.
- **Reversal trigger.** Supersede this ADR if the next protocol revision defines a host-lane form
  (then the README qualification, the schema fixtures, and the record-level pin change in that
  revision, and this ADR's decision 2 is superseded while decision 1 stands), or if the Pod product
  migrates onto the protocol-native vocabulary (then the disclosure becomes historical and the
  affected tests lose their host-lane case). If neither happens and a real integrator needs
  schema-valid host lanes, that is the signal the revision is due.
- **Adjacent measurements this decision does not cover** (same probe, different class — the shape of
  the artifact, not its `scope`/`actor_id` values): the raw L0 evidence line and the compiled wiki
  page frontmatter have a *different field shape* than `observation.schema.json` /
  `page-frontmatter.schema.json` — measured for the protocol-native control flow as well, so it is
  not a pod-profile divergence. Whether those schemas describe a different artifact (wire object vs
  canonical line) or the writers diverge is unmeasured; carded separately with the raw dump.

## Alternatives considered

1. **Widen `$defs/Scope` now to admit a host-lane (path) form** — the card's option 1. Rejected *for
   this card*, not on the merits: it is a protocol-surface addition. The contract would need matching
   Scope-grammar text (reserved namespaces, whether a lane must exist in the registry to be valid,
   visibility/hierarchy/erasure semantics, conformance impact on every schema that references
   `Scope`), and AGENTS.md rule 7 forbids moving normative protocol text as a side effect of a
   finding fix. Shipping only the schema half would create exactly the contract-vs-schema mismatch
   the v0.5.0 README forbids. Recommended as the *destination* (see below) with its own ADR and
   revision.
2. **The pod profile writes protocol-native ids** — the card's option 2. Rejected as the immediate
   move: it is a migration of a live product surface (persisted scope ids on both canonical surfaces,
   Pod's own grants, API responses, and tests), and no faithful mapping exists in the current
   grammar — Pod's extra workspaces and per-app lanes are neither `project:` nor `agent:` lanes, and
   collapsing them would mislabel live data. If the owner prefers the closed grammar permanently,
   this becomes the follow-up and its cost should be scoped in the Pod repo, not improvised here.
3. **Do nothing and keep the divergence undocumented** — rejected: the contract's own rule makes a
   silent disagreement block conformance, and `t_229601e4` already had to substitute a placeholder to
   validate a record. An undisclosed divergence is the exact anti-pattern this repository's
   verification discipline exists to prevent.
4. **Recommended destination (owner's fork):** define a host-lane form in the next protocol revision
   — a namespaced, opaque lane id (`<namespace>/<lane>…`) admitted in the Scope pattern and described
   in the contract, with the semantics written down (registry-backed, no protocol hierarchy claim, not
   a FORGET.SCOPE target, host owns its namespace). Reasons: it preserves live product data models,
   gives every host the extension slot the library already offers while keeping the *protocol-named*
   lanes checked, and it can be done once, deliberately, for all hosts — rather than per-host
   migrations. The alternative destination is a Pod migration onto the vocabulary; it is cheaper in
   protocol text and dearer in product change, and it loses the lane taxonomy. Either way the
   decision is the owner's, recorded here so it is not re-litigated from scratch.
