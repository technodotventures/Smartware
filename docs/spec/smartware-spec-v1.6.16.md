# Smartware

**A memory and context substrate. A generative, evolving source of truth. Co-authored by you and your agents.**

*By Techno Ventures · Open Source (Apache-2.0) · v1.6.16 Spec*

---

## Current normative baseline

This document is the complete Smartware Specification v1.6.16. Protocol v0.4.2
and the versioned schemas define its beta wire contract.

## 1. What Smartware Is

Smartware is open-source infrastructure that sits beneath applications and remembers for them. It does four things:

1. **Records every observation** to an append-only log on your machine.
2. **Compiles understanding** from those observations into a canonical claim store with typed relations and human-readable markdown pages. Agent-authored claims enter as **bounded hypotheses** that user warrant elevates (§6).
3. **Preserves your voice.** Content you author directly is protected: agents can read, link, and build supporting material around it, but cannot overwrite it.
4. **Serves context** to any application that asks, shaped by the compiled understanding, the active persona, and your authored synthesis.

The canonical artifacts are files. The protocol is a small set of verbs over MCP. Your data lives where you choose.

Smartware ships as a standalone TypeScript library (`smartware`, Apache-2.0). It exposes a programmatic core (`SmartwareCore`) and an MCP server entry point. Consumers vendor or depend on the library; the first consumer is Coffee Pod, which wraps the library with HTTP/OpenAPI routes, an Electron desktop shell, and Coffee-specific adapters.

---

## 2. Why This Exists

Every app and agent starts from zero. Users perform slightly different versions of themselves across Claude, ChatGPT, Coffee agents, IDEs, and calendars. Existing memory systems either store raw events without understanding, produce understanding without provenance, or model the user inside one product without portability. None produce a *generative, evolving source of truth*.

Smartware is that layer.

---

## 3. Design Principles

1. **User-owned.** Your memory is a folder of files.
2. **Human-readable canonicals.** L0 is JSONL. L1 is JSONL. L2 is markdown. Operations log is text. Agent registry is markdown.
3. **Provenance by construction.** Every claim links back to observations; every page links back to claims; every operation links to an actor; every relationship is typed, directional, and temporally bounded.
4. **Modular and semantically discriminating.** Infrastructure is interchangeable; semantic adapters are composable, not substitutable.
5. **Living, not static.** Plasticity is concrete and bounded by authorship.
6. **Personalisation is structural.** Each scope carries a Profile anchor.
7. **Co-authored, not agent-owned.** The user's direct synthesis is preserved with the same care as the system's compiled understanding.
8. **Honest about what's proven.** Lexical search can match or exceed vector retrieval on harness-dependent tasks. The compile, profile, voice, and relation-graph layers are bets that need to demonstrate value beyond that baseline.

---

## 4. Architecture

Five layers. Three canonical surfaces (L0, L1, L2) plus a canonical operations log plus a small agent registry. Derived layers (L3, L4) rebuild from canonicals at any time.

```
┌─────────────────────────────────────────────────────────┐
│  Layer 4 — Working Context (ephemeral, derived)          │
│  Hot tier + cold tier. Shaped by Profile and Voice.      │
├─────────────────────────────────────────────────────────┤
│  Layer 3 — Indices and Adapters (derived, disposable)    │
│  Infrastructure: lexical, vector, graph.                 │
│  Derived structure: entity views, relation traversal,    │
│    page-link index, contradiction edges (rebuilt).       │
│  Semantic adapters: persona, voice protection, fencing.  │
├─────────────────────────────────────────────────────────┤
│  Layer 2 — Compiled Knowledge (CANONICAL artifact)       │
│  Markdown Pages by category. Two regions per page:       │
│    Current Understanding + Evidence Timeline (cached).   │
├─────────────────────────────────────────────────────────┤
│  Layer 1 — Claim Store (CANONICAL)                       │
│  JSONL. Versioned claims with state, type, role,         │
│  authorship, version_at, and typed temporal relations.   │
├─────────────────────────────────────────────────────────┤
│  Layer 0 — Observation Log (CANONICAL)                   │
│  JSONL files. Content-addressed over canonical payload.  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Operations Log (CANONICAL, parallel to L0/L1/L2)        │
│  Append-only. Entries carry OperationId and ActorId.     │
├─────────────────────────────────────────────────────────┤
│  Agent Registry (CANONICAL, small)                       │
│  Markdown. Stable ActorIds with capabilities and owner.  │
└─────────────────────────────────────────────────────────┘
```

The library's source mirrors this directly: `layer0/`, `layer1/`, `layer2/`, `layer3/`, `layer4/`, plus `auth/` (registry, grants, middleware), `scopes/`, `session/`, `extraction/`, and `protocol/`.

**Canonical surfaces:** L0, L1, L2, operations log, agent registry. All five sync; all are human-readable; all are append-only or auditably-versioned. L2 is a canonical *artifact* surface but is **not** epistemically authoritative over L0/L1.

**Derived layers:** L3 and L4. Rebuild from canonicals at any time.

---

## 5. Canonical Surfaces and Integrity

### L0 — Observation Log

Append-only JSONL, content-addressed. One file per day per source. The `ObservationId` (`obs_<content-hash>`) is a hash over the **canonical observation payload** — `content` **plus** `actor_id`, `scope`, `source`, and an optional client `idempotency_key` — not text alone. Consequence: a genuine re-ingest (the same source re-syncing the same item under the same key) dedups to a single ObservationId, while the same text observed by a *different* actor, in a *different* scope, or from a *different* source is correctly a distinct observation. Observations are never modified or deleted in steady state; FORGET never touches L0. (Genuine erasure of sensitive raw content is a separate, deliberate operation, not part of FORGET — see §16 deferred list.)

### L1 — Claim Store

Append-only JSONL. Each line is a claim version. Mutations are new versions; never in-place edits. (Detailed in §6.)

### L2 — Compiled Knowledge

Markdown pages under `wiki/`, version-controlled with Git (`simple-git`). A canonical *artifact* surface but never epistemically authoritative over L0/L1 — a page is a compiled projection. Each page has two regions (§9): a **Current Understanding** region (canonical artifact, epistemically *derived* — on any conflict, L0/L1 win) and an **Evidence Timeline** (a cached rendered view, never an authority surface). (Conventions in §9.)

### Operations Log

Canonical, append-only. Every mutating operation records an entry.

```
operation_id   actor_id           timestamp              op               details
op_01HX1A...   agent:slack-sync   2026-05-15T08:30:00Z   observe          obs_abc123  scope=project:platform-q1
op_01HX1B...   substrate:coffee   2026-05-15T08:35:00Z   reflect.auto     scope=project:platform-q1  outcome=silent
op_01HX1C...   substrate:coffee   2026-05-15T09:12:00Z   reflect.profile  scope=self  result=updated  delta=+15
op_01HX1D...   user:owner         2026-05-15T09:14:00Z   endorse          page_coffee-thesis  cascade=[claim_xyz,claim_abc]  shared=[claim_abc]
op_01HX1E...   user:owner         2026-05-15T09:20:00Z   forget           claim_abc456  l1_version=3  blast_radius=3
op_01HX1F...   substrate:coffee   2026-05-15T09:22:00Z   access.deny      requester=agent:research  op=REVISE  scope=workspace
op_01HX1G...   substrate:coffee   2026-05-15T09:30:00Z   dream.verify     phase=verify  result=clean  manifest=derived
```

### Integrity invariants

- **Append-only on L0 and L1.** Mutations are new versions, never in-place edits. Derived adjacency (L3) is rebuilt to reflect the latest version.
- **OperationId idempotency is strict.** Same ID + same payload → prior result. Same ID + different payload → `conflict`. Reads and dry-runs do not consume OperationIds.
- **Single `commit_ts` per operation.** The operations-log entry `timestamp` equals the `version_at` of any L1 version it produced. Computed once at transaction start, reused.
- **Schema validation on every canonical write** (via `zod`). No silent acceptance of malformed data.
- **No PII in operations-log details.** Use IDs, not content.
- **Catastrophic recovery from canonical surfaces is allowed** (e.g., L2 tombstone → reconstruct L1 row) when L1 has lost data, but L1 is not rebuildable from L0+L2 in steady state.

### Identifier Types

| Type | Format | Identifies | Surface |
|---|---|---|---|
| `ObservationId` | `obs_<content-hash>` | An immutable observation | L0 |
| `ClaimId` | `claim_<ulid>` | A structured assertion | L1 |
| `PageId` | `page_<slug>` | An L2 markdown artifact | L2 |
| `BlockId` | `block_<page-slug>_<seq>` | A block within a page (post-beta) | L2 |
| `TombstoneId` | `tomb_<claim-ulid>` | A forgotten claim's record | L2 |
| `OperationId` | `op_<ulid>` | A single operation | Operations log |
| `ActorId` | `<actor-kind>:<slug>` | A registered writing identity | Agent registry |
| `CascadePreviewId` | `preview_<ulid>` | A dry-run endorsement preview | Preview store |

All ActorIds — including the substrate's own — conform to `<actor-kind>:<slug>`. `substrate` is a reserved actor-kind for substrate-internal/autonomous operations (dream, guardian, autonomous reflect); its slug is the pod/instance, e.g. `substrate:coffee`. Actor-kinds in use: `user`, `agent`, `sidecar`, `substrate`.

### Integrity manifest (post-beta, optional)

Hash-chained verification across `surface: L0 | L1 | L2 | operations | agent_registry` (L2 subsumes tombstones). Append-only, lives alongside canonical surfaces. Not required for beta — Git history and the operations log provide sufficient audit. Opt-in hardening for regulated/audit-heavy contexts.

---

## 6. The Claim Model

L1 is a canonical, append-only JSONL store. Each line is a claim version.

```jsonl
{
  "claim_id": "claim_01HXYZ",
  "version": 1,
  "state": "active",
  "content": "Alex prefers concise outputs and pushes back on sycophancy.",
  "claim_type": "preference",
  "claim_role": "memory",
  "author": "user",
  "epistemic_owner": "user",
  "fingerprint": "fp_3a9c1e7b",
  "confidence": "high",
  "epistemic_tag": "opinion",
  "scope": "self",
  "derived_from": ["obs_abc123", "obs_xyz789"],
  "relations": [
    {"relation_id": "rel_7c2f9a1d", "kind": "supports", "target": "claim_communication_style", "valid_at": "2026-05-15T09:12:00Z", "invalid_at": null, "provenance": {"origin": "user", "asserted_in_source_version": 1, "target_claim_version": 2}}
  ],
  "created_at": "2026-05-15T09:12:00Z",
  "version_at": "2026-05-15T09:12:00Z",
  "operation_id": "op_01HX1",
  "actor_id": "user:owner",
  "tags": ["communication-style"]
}
```

### Fields

| Field | Purpose |
|---|---|
| `claim_id` / `version` / `state` | Identity, version number, status (`active` / `forgotten`) |
| `content` | The assertion text |
| `claim_type` | `decision`, `constraint`, `correction`, `lesson`, `preference`, `hypothesis`, `checkpoint`, `handoff`, `finding` |
| `claim_role` | `memory`, `working`, `summary`, `checkpoint`, `audit`, `retrospective` |
| `author` | `agent` or `user` — **voice/body ownership** (mutability of the claim text) |
| `epistemic_owner` | `agent` or `user` — **epistemic + lifecycle protection** (who owns `confidence`/`epistemic_tag`/epistemic relations and FORGET). Defaults to `author`; set to `user` on user adjudication (§9) |
| `fingerprint` | Stable claim identity over the normalized assertion + `scope` + `claim_type`; the autonomous-creation idempotency key (distinct from `derived_from` provenance) |
| `confidence` | `high` / `medium` / `low` (bucketed in beta; numeric post-beta) |
| `epistemic_tag` | `fact` / `inference` / `opinion` / `stale` / `contested` |
| `scope` | Where this claim lives |
| `derived_from` | ObservationIds (claim-to-observation **support** provenance; many-to-many — not an identity key) |
| `relations` | Typed temporal claim-to-claim links |
| `created_at` | Claim's original birth (equal across versions) |
| `version_at` | This version's commit timestamp (as-of queries filter on this) |
| `operation_id` | Operation that produced this version |
| `actor_id` | Registered identity that authored this version |
| `tags` | Lowercase-hyphenated |
| `supersedes` (when present) | Prior version number this supersedes |
| `tombstone_id` (when forgotten) | Reference to L2 tombstone |
| `endorsement_source` (when cascaded) | PageId that triggered cascade |
| `revived_via` (when revived) | TombstoneId of revival source |

**`created_at` vs `version_at`:** `created_at` is the claim's first creation, equal across all versions. `version_at` is *this* version's commit time, differs across versions, and always equals the operations-log `timestamp` of its `operation_id`. As-of queries filter by `version_at`. For v1, `created_at == version_at`.

### Four independent metadata dimensions

| Dimension | Captures | Values |
|---|---|---|
| `claim_type` | What kind of assertion | decision, constraint, correction, lesson, preference, hypothesis, checkpoint, handoff, finding |
| `claim_role` | How the system uses it | memory, working, summary, checkpoint, audit, retrospective |
| `epistemic_tag` | Epistemic **status / category** | fact, inference, opinion, stale, contested |
| `confidence` | **Strength** of belief | high, medium, low |

These are independent: `epistemic_tag` classifies *what kind of knowledge* a claim is (a verified fact vs an inference vs an opinion), while `confidence` is *how strongly* it is held — a low-confidence fact and a high-confidence inference are both coherent. REFLECT and RECALL route on all four independently. (Implementation note: the library carries richer internal representations — a numeric confidence reduced to a bucket via `confidenceToBucket`, and a finer epistemic label reduced to the tag via `epistemicToTag` — but the canonical, spec-level values are the bucketed confidence and the five-value `epistemic_tag`.)

### State semantics

A claim's current status is the `state` of its latest version. `active` = retained and addressable; `forgotten` = tombstoned. RECALL excludes forgotten by default, and also excludes **superseded** active claims by default (see the effective-current rule below).

Claim `state` is exactly `{active, forgotten}`. **Supersession is not a state.** It is expressed two ways, neither of which changes `state`: the `supersedes` relation kind (claim-to-claim, §"Typed claim relations") and the `supersedes` version-chain field (the prior version number this version replaces). A superseded claim remains `active` unless it is separately forgotten.

**Effective-current rule.** An active claim that is the **target** of a valid *admitted* (canonical, non-invalidated) `supersedes` or `corrects` edge is **superseded**: it stays `active` for history and audit, but is **excluded from default Current Understanding and ordinary RECALL** (the source claim — the replacement — is what surfaces). A request with `include_superseded: true` (audit mode) returns it. Only an *admitted* edge has this effect; a derived/candidate `supersedes`/`corrects` proposal does not hide anything until the user warrants it (§9). This is how the beta correction workflow replaces current truth without deleting the prior assertion.

Two validity rules keep this graph well-behaved:
- **Acyclic.** Admitting a `supersedes`/`corrects` edge that would create a cycle among active such edges is rejected (`effective_current_cycle`). This prevents a pair like `A supersedes B` + `B supersedes A` from hiding both claims from default truth.
- **Suppression follows a live source.** A suppressing edge is in force only while it is active (`invalid_at: null`) **and its source claim is not forgotten**. If the source (the replacement) is forgotten, the edge stops suppressing — the prior claim **returns to current truth** unless another active edge still suppresses it (consistent with the context relation-filter, which drops a relation whose endpoint is forgotten).

### Claim creation and the bounded-hypothesis rule

Gating *epistemic admission* (relations, confidence elevation, tag changes) does **not** gate *claim creation* — the core memory act. The two are different, and conflating them would leave L1 with no autonomous population path while the substrate's whole purpose is to compile observations into claims.

- **Agents may originate canonical L1 claims** from observations. In beta, **`reflect.auto` is the sole autonomous creator of bounded L1 claims** — OBSERVE writes L0 only, and the extraction subsystem handles relations, not claim synthesis (§8, §10). `reflect.auto` is idempotent on a stable **`fingerprint`** — the autonomous-creation key (normalized assertion + `scope` + `claim_type`) — **and consults fact identity before creating**: when the extraction's assertion is one the store already holds as an active claim (same subject, predicate, `scope`, normalized object value, and open validity; `claim_type` is classification metadata and is **not** part of fact identity), the observation attaches as corroboration to that claim instead of minting a duplicate — a **demoted** duplicate is not such a claim: a fingerprint match on one is routed by fact identity to the surviving active claim, and extends the matched claim only when no active claim asserts the fact. Re-compiling yields no duplicate when either key holds (new corroborating observations attach to the existing claim, extending `derived_from` — **but only while the claim is unprotected, `epistemic_owner: agent`**; once protected, the autonomous path neither attaches nor duplicates — corroboration is a derived signal, §"Adjudication and protection"), while one observation that yields several distinct assertions produces several claims (distinct fingerprints). Each run carries its own `operation_id` and `actor_id: substrate:<pod>`. Such a claim is a **bounded hypothesis**: `author: agent`, `epistemic_owner: agent`, grounded in observations (`derived_from` non-empty), created with constrained initial epistemic status — `epistemic_tag: inference` and `confidence: low` (the beta ceiling; the cap is tunable post-beta, the principle is not). It may carry any `claim_type` / `claim_role` (categorisation is not a truth judgment) and any deterministically-verified `references` relation (§6 gate). **Fingerprint stability:** in beta a claim's body is immutable after creation, so `fingerprint` is stable for the claim's life — REVISE adjudicates/adopts but never rewrites `content`, and revival restores the body as-is. Content correction is modeled as a *new* claim with a `corrects`/`supersedes` relation, not an in-place body rewrite (in-place correction with fingerprint recomputation is post-beta).
- **Creation may NOT do autonomously** (these require user warrant): elevate `confidence` above the ceiling; promote `epistemic_tag` to a stronger status (e.g. `inference → fact`); add or admit an **epistemic** relation (the six kinds); or touch user-authored (protected) voice.
- **Canonical-but-unendorsed.** A bounded hypothesis *is* canonical — it lives in L1, is queryable by RECALL, carries full provenance, and persists across sessions — but it is epistemically marked as an unendorsed agent inference (`author: agent`, `epistemic_owner: agent`, `epistemic_tag: inference`, low confidence, no user endorsement). RECALL and compilation may use it but must treat and present it as tentative. **User warrant, via `REVISE` (§9), elevates it** — raising confidence, promoting the tag, or admitting epistemic relations from/to it. Adjudicating these metadata fields **keeps the body `author: agent`** (the user vouches for the agent's claim; the warrant is recorded by the version's `actor_id`/`operation_id` and `origin: user` on edges) but sets **`epistemic_owner: user`**, which *protects* the adjudicated state: while it holds, agents may not change `confidence`/`epistemic_tag`, alter epistemic relations, or FORGET the claim — they may only propose (derived) and add verified `references` (§8, §11). The body becomes `author: user` only on explicit adoption (`adopt_body`) or page endorsement (§9).

This keeps L0 the ground-truth evidence, L1 the agent's bounded interpretations plus user-warranted truth, and the warrant gate exactly where it belongs — on epistemic elevation and judgment, not on the act of remembering.

**Authoring authoritative content (beta).** There is no direct user claim-creation verb in beta; authoritative new or corrected content follows one sequence: (1) the user **OBSERVE**s the content (L0); (2) **`reflect.auto`** compiles it into a bounded replacement claim (`author: agent`, `inference`, `low`, a fresh `fingerprint`); (3) the user **REVISE**s that claim with `adopt_body: true` (→ `author: user`, `epistemic_owner: user`) and, when it replaces a prior assertion, admits a `corrects` / `supersedes` relation to the old claim (`origin: user`). The prior claim remains as superseded history, or the user FORGETs it. Because content is never rewritten in place, `fingerprint` stays stable per claim and the correction is an explicit, provenance-linked new claim rather than a silent edit.

### Typed claim relations

Relations are typed, directional, temporally-bounded edges in the claim graph. Claim-to-claim only — observation provenance lives in `derived_from`.

```yaml
relations:
  - relation_id: rel_<ulid>      # stable identity; server-stamped once at admission, immutable, preserved on carry-forward
    kind: <relation-kind>
    target: claim_<ulid>
    valid_at: <iso8601>
    invalid_at: <iso8601 | null>   # null = still valid; set by user invalidate_relations (§9, epistemic edges) or — post-beta — autonomous mechanical references reconciliation (§10)
    provenance:                    # REQUIRED on every canonical relation edge (the origin gate must be checkable); minimal for user-authored references (origin: user, rest inherited)
      origin: deterministic | model | reviewed | user   # who/what produced this edge (required)
      rule_id: <string | null>          # REQUIRED when origin=deterministic (the verifying rule)
      model_id: <string | null>         # discovery source when a model proposed the edge; NOT canonical-admissible alone (must be verified or reviewed)
      reviewed_by: <actor | null>       # REQUIRED when origin=reviewed (the REFLECT/review actor)
      review_operation_id: <op | null>  # REQUIRED when origin=reviewed
      asserted_in_source_version: <int> # source-claim version where this edge was first admitted (server-stamped once; preserved on carry-forward)
      target_claim_version: <int>       # target-claim assertion-version this edge judges (immutable)
      observation_ids: [obs_...]        # evidence specific to THIS edge
      source_spans: [ ... ]             # optional: char offsets / quoted spans
```

**Direction rule:** the source claim (holding the `relations` list) has relation `kind` to the target. If claim A's list contains `{kind: supports, target: claim_B}`, then **A supports B**.

| Kind | Meaning (source → target) |
|---|---|
| `supports` | Source provides evidence for target |
| `contradicts` | Source conflicts with target |
| `supersedes` | Source replaces target as the current assertion |
| `corrects` | Source is a correction to target |
| `invalidates` | Source makes target no longer applicable |
| `summarizes` | Source aggregates target (with other claims) |
| `references` | Source mentions target without other semantic |

`RelationKind` is exactly these seven epistemic/documentary kinds. Domain predicates (`works_at`, `owns`, `attended`, `has_deadline`) live inside claim **content** or app-specific projections — never in the enum.

**Mechanically-verifiable vs epistemic kinds.** `references` — an explicit, resolvable mention or citation from one claim to another — is *mechanically verifiable* from text. The other six kinds (`supports`, `contradicts`, `supersedes`, `corrects`, `invalidates`, `summarizes`) are *epistemic judgments*.

**Who may write a canonical edge.** Provenance audits an edge; it does not warrant it. Warrant — not just audit — gates canonical L1:

- A **canonical epistemic edge** (any of the six) requires `origin ∈ {reviewed, user}`: it became canonical through an **explicit review/commit** (§9) or user authorship, which supplies the warrant. Autonomous phases — including autonomous REFLECT (`reflect.auto`) — may only *propose* epistemic edges as candidates (derived, §10B); they never write them to canonical L1. **In beta, admission is user-only** (`origin: user`, via `REVISE`); `origin: reviewed` and delegated agent review are post-beta (§7, §9).
- A **canonical `references` edge** requires `origin ∈ {deterministic, reviewed, user}` — where `deterministic` means a verifier confirmed the link actually resolves. A model may *discover* a candidate reference (recorded with `model_id`), but discovery is not admission: `origin: model` is candidate/derived only, and the edge becomes canonical only once a deterministic rule verifies it (`origin: deterministic`, optionally retaining `model_id` as the discovery source) or a review admits it.

**Provenance block.** Every relation inherits its containing claim version's provenance (`actor_id`, `operation_id`, `version_at`, the claim's `derived_from`). **The `provenance` block is required on every canonical relation edge** — so the `origin` admission gate is always schema-checkable, never inferred. For a user-authored **`references`** edge the block may be minimal: just `origin: user` (the user is the warrant; the containing version's provenance covers the audit). For a user-authored **epistemic** edge the block is `origin: user` **plus** `asserted_in_source_version` and `target_claim_version` — user warrant replaces *evidence-of-production* (no `rule_id`/`reviewed_by` needed) but it does **not** erase the record of *which assertion-version* was endorsed, contradicted, or corrected. For everything else the block MUST identify a producer: `origin` is required; `origin=deterministic` requires a non-null `rule_id`; `origin=reviewed` a non-null `reviewed_by` + `review_operation_id`; `model_id` records a model discovery but never alone admits an edge. `observation_ids` (plus optional `source_spans`) carry the evidence. `asserted_in_source_version` is the **immutable admission anchor** — the source-claim version at which the edge was first admitted, **server-stamped once and preserved verbatim when the relations list is carried forward** to later versions (including FORGET versions); it is never client-supplied. The version a copied edge is *stored* in is simply the containing claim version (you know it because you are reading that version), so no field records it. `target_claim_version` identifies the target assertion-version being judged and is supplied by the writer/admitter. Together these answer *what evidence, which producer, and — for epistemic edges — which review* admitted the edge.

Each L1 version states its full `relations` list; the latest version is current. On FORGET, relations targeting the forgotten claim are **not** auto-invalidated — the target's `state: forgotten` is authority, and RECALL filters them by default (`include_forgotten: true` surfaces them). This avoids write cascades on forget.

---

## 7. Scopes and Access

### Scopes

```
Self ← preferences, history, patterns, persona
  └─ Workspace ← team knowledge (post-beta)
       └─ Project ← project state, decisions, project persona
            └─ Agent ← task-specific context for a single session
```

> **Beta scope:** Self and Project.

### Agent Registry

A small canonical surface (`agents/registry.md`) listing identities that can write.

```markdown
# Agent Registry

| actor_id              | kind      | owner | capabilities             | added       | notes             |
|-----------------------|-----------|-------|--------------------------|-------------|-------------------|
| user:owner            | human     | self  | all                      | 2026-05-01  | Pod owner         |
| agent:claude-research | agent     | self  | observe, recall          | 2026-05-10  | Research workflow |
| agent:coffee-coder    | agent     | self  | observe, recall, reflect | 2026-05-12  | Coding agent      |
| agent:slack-sync      | sidecar   | self  | observe                  | 2026-05-12  | Slack integration |
| substrate:coffee      | substrate | self  | all (internal)           | 2026-05-01  | Autonomous ops    |
```

- Every ActorId is registered before first use; registration is owner-managed (agents don't self-create).
- All writes and operations-log entries reference registered ActorIds only.
- An unregistered ActorId attempting a write is rejected by the access model.

### The access model (formerly "ACCESS")

Access control is not a single verb. It is realized by two callable operations plus enforcement middleware:

- **`grant`** — the owner grants an ActorId a capability set over a set of scopes.
- **`revoke`** — the owner withdraws a grant.
- **Enforcement middleware** — evaluated on *every* operation: it resolves the actor, checks the grant for the requested operation and scope, and denies (logging `access.deny`) when unauthorized.

The library also resolves human-friendly aliases to canonical ActorIds (`alias-map`), so consumers can present readable names while the substrate records spec-conformant IDs.

> **Beta scope:** Agent registry and grant/revoke enforcement are in beta. Full policy-engine expressiveness is post-beta — and because of that, **epistemic admission (§9) is user-only in beta**: there is no agent admission capability. Delegated agent review/commit requires a distinct admission capability with scope enforcement and separation-of-duty (so an agent cannot both propose and admit), which is part of the deferred policy engine.

---

## 8. The Protocol

Smartware's protocol is delivered over MCP (primary), with HTTP and CLI bindings. The operations decompose into five groups.

### Core memory verbs

| Verb | Library op | Target | Notes |
|---|---|---|---|
| **OBSERVE** | `observe` | — (writes new ObservationId) | Writes **L0 only**; never creates L1 claims. Client supplies `operation_id`, `actor_id` |
| **RECALL** | `recall` | scope + query | Search; + tombstone-inclusion flag; + delivery mode; + `as_of` (post-beta) |
| **REFLECT** | `reflect` | scope, optional ClaimId/PageId | Autonomous (`reflect.auto`) compiles pages, creates bounded agent claims (§6), and proposes candidates — it does **not** admit. Beta admission is via user `REVISE` (§9); a dedicated review/commit operation is post-beta. Externally-requested REFLECT supplies client `operation_id`/`actor_id`; autonomous `reflect.auto` uses a **substrate-generated** `operation_id` and the registered substrate ActorId (`substrate:<pod>`). |
| **REVISE** | `revise` | ClaimId / PageId / TombstoneId | User-authored ClaimId REVISE is user-only; PageId REVISE cascades (§9). In beta REVISE is also the **admission** path: a user revision may add an `origin: user` relation and set `confidence`/`epistemic_tag` on the target, with `reason` + `operation_id` (payload in §9; normative in v0.4.2). |
| **FORGET** | `forget` | ClaimId | Produces tombstone; preserves history (§11) |

(The internal compilation engine retains the term "compile" — REFLECT is the verb that triggers a compile operation. The renames at the protocol surface — `query`→`recall`, `compile`→`reflect`, `correct`→`revise` — do not change the architectural "compile" vocabulary in Layer 2.)

### The RECALL family

Retrieval is four distinct operations, not one:

| Operation | Returns |
|---|---|
| `recall` | Ranked search over canonical content (the RECALL verb proper) |
| `read` | Direct fetch of a specific page or scope |
| `explain` | Provenance trace for a claim or page (Page → Claim → Observation) |
| `context` | A working-context bundle assembled for a task (Layer 4) |

#### Context bundle structure

A `context` call returns a 1-hop bundle in beta. Direction rule throughout: *source claim has relation `kind` to target claim.* The field set below is **normative for the v0.4.2 schemas** — implementations must not omit `version`, `state`, `version_at`, `epistemic_owner`, relation `relation_id`, or relation `valid_at` / `invalid_at`. **Relation endpoint expansions resolve the *pinned* version** — `target_claim_version` for an outbound target, `asserted_in_source_version` for an inbound source — i.e. the assertion version the warrant actually applied to, not necessarily the latest. The optional `*_current` summary surfaces the latest version when it differs, so a consumer never mistakes a newer body for what was warranted.

```yaml
seeds:                 # top-N claims directly matching the query
  - claim_id: claim_<ulid>
    version: <int>
    state: active
    content: "..."
    confidence: high | medium | low
    epistemic_tag: fact | inference | opinion | stale | contested
    author: agent | user
    epistemic_owner: agent | user
    scope: <scope>
    claim_type: <type>
    claim_role: <role>
    version_at: <iso8601>

outbound_relations:    # FROM seed TO others — seed is the source
  - relation_id: rel_<ulid>
    seed: claim_<ulid>
    kind: <relation-kind>
    target: claim_<ulid>
    valid_at: <iso8601>
    invalid_at: <iso8601 | null>
    provenance: { ... }            # present when the edge carries it (§6)
    target_claim: { claim_id, version, state, content, confidence, epistemic_tag, author, epistemic_owner, scope, version_at }   # version = the PINNED target_claim_version
    target_current: { version, state, version_at }   # optional: the latest current version, if it differs from the pinned one

inbound_relations:     # FROM others TO seed — seed is the target
  - relation_id: rel_<ulid>
    source: claim_<ulid>
    kind: <relation-kind>
    seed: claim_<ulid>
    valid_at: <iso8601>
    invalid_at: <iso8601 | null>
    provenance: { ... }
    source_claim: { claim_id, version, state, content, confidence, epistemic_tag, author, epistemic_owner, scope, version_at }   # version = the PINNED asserted_in_source_version
    source_current: { version, state, version_at }   # optional: the latest current version, if it differs from the pinned one

provenance:            # observations underlying any claim in the bundle
  - observation_id: obs_<hash>
    source: <source>
    content: "..."
    timestamp: <iso8601>
```

Tombstone/stale filtering is consistent with RECALL: a relation is excluded if **either endpoint** is forgotten — the seed *or* the other claim (source on inbound, target on outbound) — unless `include_forgotten: true`. **Effective-current filtering also applies (§6):** superseded claims (targets of an admitted, active `supersedes`/`corrects` edge) are excluded from `seeds` and from relation expansion by default, surfaced only with `include_superseded: true` — so `context` never delivers as working truth a claim that RECALL and Current Understanding already treat as obsolete. Beta is **1-hop only**; deeper traversal is post-beta.

### Lifecycle and operational

| Operation | Purpose |
|---|---|
| `session` | Session lifecycle: start / describe / end (§13) |
| `status` | Pod status and capability report |
| `quarantine_review` | Review path for sensitive/quarantined content before it enters canonical surfaces |

### Access

`grant`, `revoke` (plus enforcement middleware) — see §7.

### WATCH — a transport/event-binding concern

There is no core `watch` operation. Change subscription is a binding-layer capability — see Transport Bindings (§14), not a core verb.

### Cross-cutting verb rules

- Externally-requested mutating verbs (`observe`, `reflect`, `revise`, `forget`, `grant`, `revoke`) require client-supplied `operation_id` and `actor_id`. **Autonomous substrate operations** (`reflect.auto`, dream phases) instead use a substrate-generated `operation_id` and the registered substrate ActorId (`substrate:<pod>`) — there is no client to supply them.
- OperationId idempotency: same ID + same payload → idempotent; same ID + different payload → `conflict`.
- Claims with `author: user` **or** `epistemic_owner: user` are **fully agent-immutable**: agents append **no** version of them — not to change the protected state (the body when `author: user`; `confidence`/`epistemic_tag`/epistemic relations when `epistemic_owner: user`) and **not to extend `derived_from`**. Agents may only propose (derived signals) and add deterministically-verified `references` **from their own claims** targeting the protected claim — the edge lives on the agent's claim; no version of the protected claim is written. New corroborating observations for a protected claim become a derived support signal until the user incorporates them via REVISE. Only the user may REVISE or FORGET it.

---

## 9. Compilation, the Wiki, and Co-Authorship

### REFLECT: modes and context fencing

REFLECT compiles observations and claims into L2 pages with full provenance. It **excludes observations whose existence is only explained by prior context** — the `informed_by` field on OBSERVE; REFLECT filters against it, so the system doesn't compile its own context back into canon.

REFLECT runs in two modes, and the distinction is the spec's admission boundary:

- **Autonomous REFLECT (`reflect.auto`)** — a background compilation pass over existing canon. It (re)compiles pages, **creates bounded agent claims** (§6: `author: agent`, `inference`, `low`), and **proposes**: candidate epistemic edges and derived review-queue / attention signals. It does **not** admit epistemic relations and does **not** elevate canonical `confidence` or `epistemic_tag`. An autonomous pass is never its own reviewer.
- **Explicit review/commit** — an explicitly-invoked, accountable operation that **admits** candidate epistemic edges and commits canonical `confidence` / `epistemic_tag` changes. **In beta this is user-only and rides the existing `REVISE` path:** the user reviews a candidate and REVISEs to admit it, and the resulting edge carries `origin: user`. **Post-beta**, a dedicated review/commit operation may let an agent *explicitly granted review authority* admit candidates (recording `origin: reviewed`, `reviewed_by`, `review_operation_id`) — but that requires a distinct admission capability with separation-of-duty in the access model (§7) and a defined wire contract (§17), neither of which beta provides. That gap is exactly why beta keeps admission user-only: an agent must never both propose a candidate and admit it under a broad `reflect` grant.

**Terminal observation checkpoint.** Each accepted, in-scope observation that
autonomous REFLECT considers produces one content-free `reflect.auto`
operations-log receipt after its terminal outcome is known. Outcomes distinguish
context-fenced input, content too short to extract, a completed extraction with
no candidates, and completed candidate processing. The receipt records the
ObservationId, scope, outcome, and optional candidate/write counts—never memory
content. Claim writes retain their own operation identities. If the process
terminates before the terminal receipt, deterministic fingerprints make the
observation safe to reconsider; after the receipt, later passes skip it. This
prevents permanent rescanning of valid no-op observations without turning a
no-op into an L0/L1/L2 mutation.

Throughout this spec, **"warrant" means the user (authorship, endorsement, explicit `REVISE`) or — post-beta — an explicit review/commit as defined here; never an autonomous pass, including `reflect.auto`.** (The agent Profile is a separate surface — the agent's own continuously-updated self-model, user-correctable via `profile-correction` observations — and is not canonical claim epistemic metadata; autonomous profile compilation does not fall under this rule.)

### Admission via REVISE (beta)

In beta, the user admits a candidate epistemic edge or elevates a bounded hypothesis (§6) through `REVISE` on a ClaimId. This extends REVISE's contract with an admission payload:

```yaml
revise:
  target: claim_<ulid>                  # the claim being admitted/elevated
  expected_base_version: <int>          # REQUIRED; the version the client last saw (optimistic concurrency)
  add_relations:                        # optional: epistemic edges to admit
    - kind: <relation-kind>
      target: claim_<ulid>
      valid_at: <iso8601>
      invalid_at: <iso8601 | null>
      provenance: { origin: user, target_claim_version: <int> }   # asserted_in_source_version is server-stamped on append
  set_confidence: high | medium | low   # optional
  set_epistemic_tag: fact | inference | opinion | stale | contested  # optional
  add_derived_from: [obs_...]           # optional; user folds corroborating observations into derived_from (append-only); valid only when target is epistemic_owner: user or this op adjudicates
  invalidate_relations: [rel_...]       # optional; user-only, append-only; sets invalid_at on the named admitted edges (withdraws a suppression/epistemic edge without FORGETing the claim)
  adopt_body: false                     # optional; true = adopt the claim body as user voice (sets author: user)
  reason: "<why>"                       # REQUIRED
  operation_id: op_<ulid>               # REQUIRED (idempotency, §5)
  actor_id: user:<slug>                 # REQUIRED; must be a user in beta
```

It appends a new L1 version of the target; the server stamps the new `version` and each admitted relation's `asserted_in_source_version`. By default the version **keeps the claim's existing `author`** — adjudicating an agent claim's metadata or relations does **not** convert its body to user voice; the user's warrant is recorded by the version's `actor_id` (the user), `operation_id`, and `origin: user` on admitted edges. The operation **sets `epistemic_owner: user`** on the target whenever it adjudicates an epistemic field or relation, protecting that state from later agent override (§6, §11). `adopt_body: true` (or page endorsement, below) additionally takes the body as protected user voice, setting **both `author: user` and `epistemic_owner: user`** (confidence/tag values carry forward unless this same operation sets them). A stale `expected_base_version` returns `conflict`; OperationId idempotency follows §5. `add_derived_from` is the user-only path to **incorporate corroboration** into a protected claim (the observations agents could only surface as derived support, §8): it appends them to `derived_from` and changes no epistemic value unless `set_confidence`/`set_epistemic_tag` is also given. It is valid **only when the target already has `epistemic_owner: user`**, or when the same REVISE performs an adjudicating action (admitting a relation, setting confidence/tag, or `adopt_body`) that sets it — it never silently protects an otherwise-agent-mutable claim. (On an unprotected agent claim no user action is needed: `reflect.auto` already folds corroboration into `derived_from`, §6.) `invalidate_relations` is the user-only, append-only path to **withdraw an admitted epistemic edge** (the six kinds) by `relation_id`: it appends a version of the source claim setting that edge's `invalid_at`, which is itself an epistemic adjudication (so it sets `epistemic_owner: user` on the source). Withdrawing a `supersedes`/`corrects` edge **releases its previously-suppressed target** back into default RECALL, Current Understanding, and `context` (§6) — the way to undo a mistaken correction while keeping the still-useful replacement claim, distinct from FORGETing the replacement. The edge remains in history (invalidated, not deleted). Mechanical withdrawal of a deterministic `references` edge is **not** this path — extraction reconciles those autonomously on unprotected claims with no `epistemic_owner` change (§10). **This is the only epistemic-admission path in beta;** the dedicated review/commit operation (which would let a delegated agent admit, `origin: reviewed`) is post-beta (§17). The payload above is normative for the v0.4.2 schemas and conformance suite.

### Layer 2 conventions

```
wiki/
├── _index.md
├── concepts/      (agent or user)
├── entities/      (agent or user)
├── decisions/     (agent or user)
├── synthesis/     (predominantly user)
├── tombstones/    (canonical record of forgotten claims)
└── profiles/      (always agent-authored)
```

Page frontmatter:

```yaml
---
title: "Article title"
page_id: page_<slug>
category: concept | entity | decision | synthesis | profile | tombstone
author: agent | user            # 'mixed' is post-beta (depends on block-level authorship)
sources: [claim_xyz, claim_abc]
supporting_claims: [claim_def, claim_ghi]
created: 2026-05-12
updated: 2026-05-15
scope: self | workspace | project:<id>
tags: [lowercase-hyphenated]
aliases: [alternate names]
confidence: high | medium | low
epistemic_tag: fact | inference | opinion | stale | contested
summary: "2-3 sentence summary"
notices: []
---
```

`sources` is locked at endorsement on user-authored pages;
`supporting_claims` is where agent-added corroboration lives post-endorsement.
Dual links carry both a wiki form such as
`[[auth-refactor|Auth refactor]]` and a relative path such as
`../decisions/auth-refactor.md`.

### Page structure: two regions

Each compiled page has two regions, with different epistemic status:

- **Current Understanding** — the compiled current view of the active, **non-superseded** L1 claims for the page's subject (a claim that is the target of an admitted `supersedes`/`corrects` edge is excluded — effective-current rule, §6). A canonical *artifact*, but epistemically **derived**: on any conflict, **L0/L1 win**. Editable under authorship/voice rules.
- **Evidence Timeline** — a rendered, **cached** view of the supporting L1/L0 history. **Not an authority surface.** Each timeline entry carries cached-view metadata — `compiled_at`, `source_claim_id`, and `source_observation_ids` (plural — a claim may derive from several observations) where applicable — and renders with visible "cached view" language so it is never mistaken for canonical state. The timeline is rebuildable; deleting it loses nothing. Because it is a **derived render, not authored voice, it is an agent-managed cached region**: `Recompile Pages` may refresh it on **any** page, including endorsed/protected ones (voice protection, §9, covers the Current Understanding prose and `sources`, not this cache).

### Voice and co-authorship

Authorship governs *mutability*; confidence and epistemic tags govern *epistemic status*. Independent. On user-authored pages, agents may maintain `_index.md` entries, post `notices`, append `supporting_claims`, refresh the **cached Evidence Timeline** region (a derived render, not authored voice — §11), and update the `updated` timestamp — `sources` and the Current Understanding prose are locked; everything else is flag-only. A persisted page `notice` is a canonical L2 annotation (frontmatter), so it is written under a warranted action — an explicit/user operation — **not** by an autonomous pass. **Autonomous detection (e.g. Detect Conflicts) surfaces its findings in a derived review queue, not by writing page notices**; a notice reaches the page when a warranted action persists it. Deterministic extraction obeys the same discipline: on user-authored claims and prose it emits derived candidates/review-queue entries only (§10) — never appended versions, prose edits, or autonomous page notices.

Stated precisely, to remove any ambiguity: **no phase appends a new version *of* a user-authored claim, and no phase edits user-authored prose; but an agent-authored claim may add a relation *to* a user-authored claim.** The annotation lives on the agent's claim; the user's claim record is untouched.

### Endorsement cascade

REVISE on a PageId with `author: user`:

1. Page-level record updated to `author: user`.
2. New L1 versions appended for each ClaimId in `sources` with `author: user`, **`epistemic_owner: user`**, `supersedes: <prior-version>`, `endorsement_source: <page_id>`.
3. Single operations-log entry with the full cascade.

Endorsement adopts the claim body as user voice and sets **both `author: user` and `epistemic_owner: user`** (the epistemic state becomes user-owned and agent-protected); it does **not** by itself change `confidence` or `epistemic_tag` *values* — those carry forward unless the same REVISE also sets them (`set_confidence` / `set_epistemic_tag`). Adopting a hypothesis's text is not the same as asserting it is high-confidence fact.

All-or-nothing. Shared-claim cascade is global. Preview via `dry_run: true`, which returns a `CascadePreviewId`; commit consumes that ID. A commit on a page with shared claims but no preview ID returns `cascade_required_ack`; an expired preview returns `preview_expired`.

> **Beta scope:** Page-level authorship. Block-level (and `mixed` pages) post-beta.

### Profile anchors

The Profile is the agent's continuously-updated model of the persona at a scope. Always `author: agent`; user corrections arrive as `profile-correction` observations. Profile ≠ Voice (the agent's model vs the user's writing).

> **Beta scope:** Self profile only.

---

## 10. Extraction

The `extraction` subsystem derives **typed claim-to-claim relations** (the seven kinds in §6) from new and changed observations and claims. It does **not** synthesise claims — bounded L1 claim creation is `reflect.auto`'s job (§6, §9); extraction operates on existing claims and observations to derive relations. Its contract:

- **Deterministic-first.** A deterministic pass (pattern matching, role priors, declared precedence) produces relations without an LLM where possible. Identical inputs produce identical outputs.
- **Canonical writes are deterministically-verified `references` only.** Autonomous extraction may write a *canonical* L1 edge only for `references`, and only with `origin: deterministic` — i.e. a verifier confirmed the link actually resolves. A model may *discover* a candidate reference (recorded with `model_id`), but it stays a candidate until a deterministic rule verifies it. The six epistemic kinds are **never** written to canonical L1 by extraction — they are emitted as candidates (§10B) for an explicit review/commit or the user to promote (§9; becoming `origin: reviewed | user`). This keeps autonomous code from minting unreviewed epistemic edges or unverified references.
- **Idempotent, with mechanical stale-link reconciliation.** Re-running over unchanged input is a no-op; when source content changes such that a prior deterministic `references` edge no longer resolves, extraction **invalidates its own `references` edge** (sets `invalid_at` by appending a new L1 version — never a destructive edit). This is **mechanical, not epistemic**: it is permitted **autonomously on unprotected agent claims** (`epistemic_owner: agent`) and carries **no `epistemic_owner` transition**. On a **protected** source claim (`author: user` or `epistemic_owner: user`) extraction does not write — the stale reference becomes a **derived review item**. Epistemic-edge withdrawal is never autonomous; that is the user-only `invalidate_relations` path (§9). **Beta scope:** because beta claim bodies are immutable (§6), a deterministic `references` edge cannot go stale through any beta operation — so content-change-triggered reconciliation, and with it the protected-source review-item branch, are **post-beta** (they presuppose in-place body correction). Specified here for completeness; **not** in the beta conformance suite.
- **LLM fallback is logged, not silent.** Cases the deterministic pass cannot resolve may use an LLM, but each fallback is recorded — `model_id` on the edge, surfaced by `doctor` (§12) — so the deterministic rules can improve over time.
- **User-authored material is read-only to extraction.** No phase appends a new version *of* a user-authored claim or edits user prose; extraction emits derived candidates and review-queue entries only — never autonomous page notices (§9). (An agent-authored claim may still hold a relation *to* a user-authored claim — that annotation lives on the agent's claim. §9, §11.)

Extraction may append canonical `references` edges only when deterministically verified (`origin: deterministic`, §6), and rebuilds the derived adjacency graph (L3) from canonical relations. Epistemic edges reach L1 only through an explicit review/commit or user review (§9).

### Deterministic-extraction scope (three decisions)

These bound how far the gbrain-style deterministic technique is adopted. The lesson taken is operational discipline, not product shape or domain ontology.

**A. L2 page-link resolution — a derived L3 navigation index.**
*Recommendation: implement now only if a consumer (UI/navigation) surfaces it; otherwise trivial post-beta.*
- It is a derived L3 index — e.g. `page_links(source_page_id, target_page_id)` — rebuilt from L2, **not** "read-only" (it writes rebuildable derived state).
- It parses **explicit L2 links only**: wikilinks, dual-links, markdown links, with code-fence stripping.
- It creates no truth claims, assigns no relation meaning, and **never mutates page prose**.
- Auto-backlink **insertion into prose** remains deferred, especially on user-authored pages.

**B. Deterministic candidate-generator feeding REFLECT / Extract Relations — deferred.**
*Recommendation: defer until evals show REFLECT/Extract Relations is missing relations or costing too much.*
- Regex / co-occurrence / pattern matching may later produce **candidate reports**.
- Candidate reports are **derived hints only**; they never append to canonical L1 directly.
- A later epistemic phase may promote a candidate **only after** attaching provenance, confidence, temporal validity, `actor_id`, `operation_id`, and an audit trail.
- The gbrain-style typed-inference cascade (assigning a relation type from surface patterns) is acceptable **only as a discardable hint**, never as author of record.
- **Scope distinction:** what is deferred is the *general* candidate-generator across all relation kinds. The narrow, purpose-built **conflict-candidate detection** in the Detect Conflicts dream phase (§12) — which emits candidate `contradicts` edges + derived review-queue entries, never canonical — **is in beta**. Beta ships specific candidate detection, not a general candidate engine.

**C. Separate structural entity→entity graph — rejected as a standalone surface.**
- Do not add a maintained entity→entity graph with its own relation ontology.
- Smartware's canonical graph is **claim→claim**.
- If entity-centric views are ever needed, derive them as **L3 projections over L1 claims** — not a second authoritative graph.
- Domain predicates live in claim content or app-specific projections, not the `RelationKind` enum.

---

## 11. Plasticity, FORGET, and Tombstones

### Plasticity mechanisms

| Loop | Touches user-authored content? |
|---|---|
| Contradiction detection | Proposes a candidate `contradicts` edge + derived attention/ranking signal + derived **review-queue** entry; the canonical edge, any confidence change, **and** any persisted page notice require a warranted action (§9); never modifies prose |
| Capacity-driven densification | Exempt |
| Context fencing | Operates on observations |
| Confidence updates | User-set on user claims. On agent claims, asymmetric transitions apply **only via an explicit review/commit or the user** (§9), not autonomously; unreviewed signals move only derived attention/ranking |
| Autonomous reflection | Cannot author into user pages |
| Gap detection | Flags only |
| Consolidation | Runs in REFLECT; **proposes** `summarizes` edges (candidates). In beta the user admits them via `REVISE` (`origin: user`); post-beta an explicit review/commit may admit (`origin: reviewed`). `reflect.auto` never admits |
| Structural guardian | Indices and bookkeeping only |

Single rule: **agents modify their own work; agents only annotate the user's work.** Adding a relation that targets a user-authored claim is annotation — the relation lives on the agent's claim; the user's claim is untouched.

Confidence is canonical epistemic metadata — it affects RECALL and compilation — so it moves only under warrant. Asymmetric transitions on agent-authored claims (corroboration up, contradiction down) are applied **only by an explicit review/commit or the user** (§9), never by an autonomous pass including `reflect.auto`. Autonomous conflict/corroboration detection produces **derived** attention/ranking signals and review-queue entries; those become canonical confidence changes only when an explicit review/commit or the user acts (or as part of a reviewed operation driven by an already-canonical relation). User-authored claims are user-set, with contradictions surfaced in `notices`. **Temporal decay is disabled by default in beta** (consistent with the Decay Staleness dream phase, §12); post-beta it applies only under an explicit user-enabled decay policy, which is itself the warrant (§12). Bucketed in beta.

### FORGET and tombstones

FORGET on a ClaimId:

1. Read the latest active version from L1.
2. Append a new L1 version with `state: forgotten`, **carrying forward all non-content metadata** (`claim_type`, `claim_role`, `author`, `epistemic_owner`, `fingerprint`, `confidence`, `epistemic_tag`, `scope`, `derived_from`, `relations` — each relation's `relation_id` and `asserted_in_source_version` preserved — `tags`, `created_at`, and `endorsement_source` when present) and adding forget fields (`supersedes`, `tombstone_id`, `forgotten_at`, `forgotten_by`, `operation_id`, `version_at`, `actor_id`). `content` is omitted (the snapshot lives in the tombstone). Carry-forward ensures the schema's required set is satisfied.
3. Map blast radius via `sources`/`supporting_claims` page references and inbound relations.
4. Write the tombstone to `wiki/tombstones/<claim-ulid>.md` — a **full snapshot of the prior active version** (every field including `content`), reconstructable into a valid L1 version under catastrophic recovery.
5. Clean up agent-authored references.
6. Notify user-authored pages via `notices`.
7. Log to operations log; the entry `timestamp` equals the forgotten version's `version_at` (single commit timestamp).
8. Optionally recompile affected agent-authored pages.

Reason required. Observations remain in L0. (FORGET tombstones a *claim*; it does not erase raw observations. True erasure of sensitive raw L0 content is a separate deliberate operation — see §16.)

**Revival:** `revise({tombstone_id, new_state: {revived: true}, reason, operation_id})` restores the same ClaimId via a new `state: active` version **reconstructed from the tombstone snapshot — preserving all claim metadata** (`author`, `epistemic_owner`, `fingerprint`, `confidence`, `epistemic_tag`, `scope`, `derived_from`, `relations` with each relation's `relation_id` and `asserted_in_source_version`, `tags`, `created_at`, and `endorsement_source` when present), the body restored **as-is** (no content rewrite, so `fingerprint` is preserved). Only the revival lifecycle fields are written fresh: `state: active`, `supersedes: <forgotten-version>`, `revived_via: <tombstone_id>`, and a new `version` / `operation_id` / `actor_id` / `version_at`. A formerly protected claim (`author: user` or `epistemic_owner: user`) therefore **returns protected**. **Revival authorization is evaluated against the tombstone snapshot, not the TombstoneId surface:** if the snapshotted claim was `author: user` or `epistemic_owner: user`, revival is **user-only** in beta — an agent cannot revive a formerly protected claim, since doing so would append a new version of that protected claim through tombstone indirection. **The reactivated `supersedes`/`corrects` edges are re-validated against the effective-current graph (§6):** any reactivated edge that would form a cycle is restored **inactive** (`invalid_at` stamped at the revival) and reported in the operation result, so revival never silently recreates a suppression cycle — the user may re-admit such an edge via `REVISE`, where the normal cycle gate applies. Page links are **not** auto-restored.

---

## 12. Maintenance and Operator Commands (dream / doctor / repair)

`dream`, `doctor`, and `repair` are **operator commands**, not core memory verbs. They orchestrate or inspect existing loops; they introduce no new canonical surface. The core memory verbs remain exactly OBSERVE / RECALL / REFLECT / REVISE / FORGET.

### dream

`smartware dream` runs maintenance phases over a scope. It is a wrapper that sequences existing plasticity and compilation loops; every canonical *data* write it makes is a write some core verb could already make. **Every phase outcome — including a clean, no-op Verify — records an entry in the canonical operations log** (the operation ran; this is distinct from any L0/L1/L2 data write). The detailed **phase manifest** is a derived/output artifact, not a canonical surface; `canonical_writes: none` in a manifest means the phase wrote no L0/L1/L2 *data*, not that the run went unlogged.

Manifest schema (one entry per phase):

```yaml
phase: <name>
actor_id: substrate:<pod>           # who ran it
operation_ids: [op_...]             # operations this phase produced
started_at: <iso8601>
ended_at: <iso8601>
inputs: [...]                       # scopes / claim sets / page sets read
outputs: [...]                      # human-facing summary of what changed
canonical_writes: [...]             # L0/L1/L2 writes, by id (empty if none)
derived_writes: [...]               # L3 / report writes (empty if none)
skipped: [{ item, reason }]         # what was intentionally not touched
errors: [...]
warnings: [...]
```

Phases, with explicit canonical/derived write classification (the **Canonical writes** column lists L0/L1/L2 *data* writes only; every phase additionally logs its outcome to the operations log, per above):

| Phase | Canonical writes | Derived writes | Notes |
|---|---|---|---|
| **Verify / Guardian** | none | none | Read-only. Validates schemas, references, operations-log consistency. Repair is **not** part of dream — see `repair`. |
| **Extract Relations** | canonical `references` edges only (with provenance block, §6) | candidate epistemic edges; rebuilt adjacency graph | Mechanically-verifiable `references` only. The six epistemic kinds are emitted as candidates for an explicit review/commit or the user (§9) — never written canonically here (§6, §10). |
| **Detect Conflicts** | none | candidate `contradicts` edges + derived attention/ranking signal + derived review-queue entries | Writes **nothing** canonical — no `contradicts` edge, no `contested` tag, no confidence change, **no page notices** (persisted notices are L2 and require a warranted action, §9). All epistemic changes require an explicit review/commit or the user (§9). Never flips `state`; never touches user claims. |
| **Decay Staleness** | confidence/epistemic transitions **only under an explicit user-enabled decay policy** (that policy is the warrant); none otherwise | derived stale/attention signals | **Disabled by default in beta.** Decay applies a deterministic, time-based, user-defined rule; the user enabling the policy warrants its (mechanical) transitions. Absent the policy, decay emits derived signals only. Never touches user-authored claims absent that policy. |
| **Recompile Pages** | L2 pages + cached Evidence-Timeline render metadata | — | Idempotent. Respects voice protection (Current Understanding prose + `sources`); refreshes the agent-managed Evidence Timeline cache even on protected pages (§9, §11). |
| **Check Capacity** | none | capacity reports | Identifies densification candidates; does not delete or archive. |
| **Find Orphans** | none | suggestion reports | Flags broken refs, missing pages, unresolved links. |
| **Prune** | via existing mechanisms only — FORGET tombstones + operations-log entries | export archive (derived) + pre/post report | **Opt-in only; never in default dream.** Removes nothing directly: claims go through FORGET (tombstoned, recoverable). The pruned-content archive is a **derived export artifact**, not a new canonical surface. Requires explicit pre/post report. |

Default `dream` runs Verify, Extract Relations, Detect Conflicts, Recompile Pages, Check Capacity, and Find Orphans. **Decay Staleness and Prune are opt-in** and off by default.

### doctor

`smartware doctor` inspects extraction and retrieval health. `doctor patterns` reports on deterministic-extraction behaviour. Privacy defaults:

- Default output is **structural**: pattern summaries, regex/rule suggestions, hit-rate trends. No raw content.
- Raw matched snippets require an **explicit flag** and are restricted to **user-owned data only**.
- **No cross-user aggregation** in shared deployments.

### repair

`smartware repair` is the **opt-in** companion to Verify. Where Verify only reports, repair may rewrite **derived** state (rebuild indices, regenerate `_index.md`, reconcile adjacency) and may **propose** canonical fixes for explicit confirmation. It never silently mutates canonical surfaces.

### Design boundaries (non-negotiable)

- Core memory verbs are exactly OBSERVE / RECALL / REFLECT / REVISE / FORGET.
- `dream` / `doctor` / `repair` are operator commands; ACCESS is middleware + grant/revoke. None are memory verbs.
- L1 is canonical claim history. L2 is a canonical artifact surface but **not** epistemically authoritative over L0/L1. L3 is rebuildable.
- No universal domain ontology; `RelationKind` stays the seven epistemic/documentary kinds.
- No skills framework or `wiki/skills/` convention in core.
- Autonomous output (deterministic or model) is never an authoritative *epistemic* edge. It reaches canonical L1 only as a deterministically-verified `references` edge, or after an explicit review/commit or user review (§9). **Provenance audits; review warrants.**
- Canonical epistemic metadata — the six epistemic relation kinds, `confidence`, and `epistemic_tag` — changes only under warrant: an explicit review/commit or the user (§9), never an autonomous pass including `reflect.auto`. Autonomous loops move only **derived** signals (attention, ranking, notices); they never mutate remembered truth.

---

## 13. Sessions

A session scopes a unit of agent work and its working context.

| Operation | Effect |
|---|---|
| `session` start | Opens a session bound to an actor and scope; freezes a hot-tier snapshot of working context |
| `session` describe | Reports current session state |
| `session` end | Closes the session; durable outcomes are summarized into claims per the memory policy |

Sessions back the Pod's session-lifecycle routes and the working-context delivery (Layer 4 / §14). The memory policy attached to a profile governs what a session persists (e.g., durable summary on end, sensitive content gated to a confirm step).

---

## 14. Transport Bindings

| Binding | Role |
|---|---|
| **MCP** | Primary. The library exposes an MCP server entry (`./mcp`); verbs surface as MCP tools. Tool discovery is dynamic, so tool names track the canonical verb set (`observe`, `recall`, `reflect`, `revise`, `forget`, `read`, `explain`, `context`, `grant`, `revoke`, `session`, `status`, `quarantine_review`). |
| **HTTP / OpenAPI** | Consumer-provided (e.g., Coffee Pod via Fastify). May expose stable external paths that map to verbs without 1:1 naming; mappings are documented, not implicit. |
| **CLI** | The library ships a `smartware` binary (also fronts the operator commands of §12). |

### WATCH — event subscription (binding layer)

WATCH is not a core memory verb; it is a transport/event-subscription binding.

**Which operations emit events.** Any operation that produces an observable state change: `observe`, `reflect`, `revise`, `forget`, `grant`, `revoke`, `session` (start/end), and `quarantine_review` resolution. Read-only operations (`recall`, `read`, `explain`, `context`, `status`, Verify) do not emit.

**Event envelope.**

```yaml
event_id: evt_<ulid>          # idempotency key for delivery
op: <operation>
actor_id: <actor>
scope: <scope>
target: <id>                  # claim / page / obs / etc.
operation_id: op_<ulid>       # the source operation
emitted_at: <iso8601>
payload: { ... }              # operation-specific, access-filtered, IDs not content
```

**Idempotency.** `event_id` dedups redelivery; subscribers must tolerate at-least-once delivery.

**Access filtering.** Events are filtered by the subscriber's grants — a subscriber sees only the scopes/operations it is authorized for. Payloads carry IDs, not restricted content.

**Heartbeat / reconnect.** The binding sends periodic heartbeats; on reconnect a subscriber may request best-effort replay from a last-seen `event_id`. The event stream is a transport convenience, not a canonical log — the operations log (§5) remains the audit record.

> **Beta scope:** Mutation classes emitting events in beta: `observe`, `reflect`, `revise`, `forget`. Events for `grant` / `revoke` / `session` / `quarantine_review` are post-beta.

---

## 15. Sync and Deployment

Single-Pod local for beta. The canonical surfaces (L0, L1, L2, operations log, agent registry) are the unit of sync; derived layers (L3, L4) rebuild locally. Post-beta: sync-replication and cross-Pod citation.

**Consumer/vendoring model.** Smartware is a standalone library. Consumers depend on or vendor it (Coffee Pod vendors a built snapshot at `vendor/smartware` and wraps `SmartwareCore` with an adapter, HTTP routes, and a desktop shell). The library is the source of truth for substrate behavior; consumer-specific routes are adapter conveniences that write through the same canonical surfaces.

Stack: TypeScript, Node ≥20, `better-sqlite3` (L0/L1/L3 indices), `simple-git` (L2 versioning), `ulid` (identifiers), `zod` (schema validation), `@modelcontextprotocol/sdk` (transport), `@anthropic-ai/sdk` (REFLECT/extraction LLM calls).

---

## 16. Beta Posture

The beta proves the substrate:

- Protocol surface is implementable and stable, with explicit identifier types, a canonical claim store with typed relations, and locked lifecycle invariants.
- L0, L1, L2, operations log, and agent registry work as canonical surfaces.
- Grep + FTS5 + relation traversal over canonical content is the production retrieval path.
- REFLECT produces useful compiled pages (two-region: Current Understanding + cached Evidence Timeline) with full provenance and typed inter-claim relations.
- Agents populate L1 autonomously by creating **bounded hypotheses** (`author: agent`, `inference`, `low`, observation-grounded); user `REVISE` elevates them and admits epistemic relations. The canonical-but-unendorsed lifecycle works end to end.
- Autonomous extraction writes only **deterministically-verified** `references` edges to canonical L1 (`origin: deterministic`); the six epistemic relation kinds and all canonical `confidence` / `epistemic_tag` changes are admission-gated to the **user** in beta (via `REVISE`, `origin: user`), with autonomous REFLECT (`reflect.auto`) and dream phases proposing only. Delegated agent review (`origin: reviewed`) and a dedicated review/commit operation are **post-beta** (§7, §9, §17). Autonomous conflict-candidate detection (Detect Conflicts) ships in beta but emits only derived signals, candidates, and review-queue entries. Every canonical relation edge carries an `origin`-tagged provenance block.
- Self profile is a generative input.
- Page endorsement cascades correctly with shared-claim acknowledgement (two-phase preview/commit).
- FORGET produces self-contained tombstones; revival restores ClaimId without auto-restoring page links.
- All mutating operations are idempotent via OperationId + ActorId — client-supplied for externally-requested calls, substrate-generated for autonomous `reflect.auto` / dream phases.
- Context bundles deliver compiled understanding as graphs (1-hop, outbound and inbound).
- Agent registry enforces stable identities for all writes; grant/revoke enforcement denies unauthorized operations.
- `dream` runs maintenance with phase manifests (Verify, Extract Relations, Detect Conflicts, Recompile Pages, Check Capacity, Find Orphans).
- Coffee Pod demonstrates cold-start elimination, cross-session continuity, a logged endorsement loop, and multi-agent coordination via registered actors.

**Beta does not include:** as-of RECALL (historical reconstruction); block-level authorship and `mixed` pages; auto-backlink insertion into prose; deterministic candidate-generator extraction (§10B); separate entity→entity graph (§10C); temporal decay (default-off, §11/§12); the Prune dream phase (opt-in); a dedicated review/commit operation and delegated agent epistemic admission (beta admission is user-only via `REVISE`, §9); broad multi-scope peek; deep relation traversal (>1 hop); WATCH events for grant/revoke/session/quarantine_review; cross-Pod citation; multi-user workspaces; Workspace/Project profile anchors; full numeric confidence scoring; polished endorsement-review UX; scope-target REFLECT; integrity manifest; L0 erasure path for sensitive raw content; branch/fork/merge chains; versioned skill registry; full policy-engine expressiveness. The deterministic page-link index (§10A) is in beta only if a consumer surfaces it.

---

## 17. Versioning and Conformance

- **Spec** at `v1.6.16`. Next freeze at `v1.7` (post-beta features) or `v2.0` (breaking changes).
- **Protocol contract** at `v0.4.2` (carries the verb-naming reconciliation and the WATCH/ACCESS redefinitions from v1.6.0). The **REVISE admission payload** (§9) — adding an `origin: user` relation, setting `confidence`/`epistemic_tag`, with `reason` + `operation_id` — is normative in v0.4.2 and covered by conformance. The dedicated **review/commit** operation — mode discriminator, candidate identifiers, accept/reject decisions, required reason, `operation_id`, actor authorization, and error cases — is a **post-beta** protocol addition; beta admission rides the existing user `REVISE` flow (§9).
- **Schemas** track protocol versions.
- **Conformance** is the binary suite over canonical surfaces, idempotency, the endorsement cascade, FORGET/tombstone recovery, relation traversal, the **bounded-hypothesis ceiling** on autonomous claim creation (no autonomous claim exceeds `inference`/`low`), **claim-fingerprint idempotency** (one observation → multiple claims; multiple observations → one claim), **epistemic-owner protection** (agents cannot change the protected state of, or FORGET, an `epistemic_owner: user` claim), **protected-claim full immutability** (no agent version append of a protected claim, including `derived_from` extension), **FORGET field preservation** (`epistemic_owner` / `fingerprint` / `endorsement_source` carried into the forgotten version), **revival restores protection** (a revived `author: user` / `epistemic_owner: user` claim returns protected, with all metadata reconstructed from the tombstone snapshot), **revival authorization** (an agent cannot revive a snapshot that was `author: user` / `epistemic_owner: user`), **effective-current exclusion** (a claim targeted by an admitted `supersedes`/`corrects` edge is excluded from default RECALL, Current Understanding, **and `context`** unless `include_superseded`), **effective-current acyclicity** (an edge creating a `supersedes`/`corrects` cycle is rejected) and **forgotten-source release** (a forgotten replacement stops suppressing its target), **suppression withdrawal** (user `invalidate_relations` on a `relation_id` returns the previously-suppressed target to default RECALL, Current Understanding, and `context`, without FORGETing the replacement), **revival cycle re-validation** (the forget → reverse-correction → revive path restores the conflicting edge inactive rather than forming a cycle), **timeline cache exemption** (`Recompile Pages` refreshes the Evidence Timeline on protected pages without violating voice protection), **substrate-ID generation** (autonomous `reflect.auto` / dream operations carry substrate-generated `operation_id` + `substrate:<pod>` ActorId, not client-supplied), `asserted_in_source_version` and `relation_id` **immutability across carry-forward**, and the **REVISE admission payload** (including user-only `add_derived_from`, valid only on an `epistemic_owner: user` target or with a same-op adjudication, and user-only `invalidate_relations`). The central negative test: no autonomous phase produces a canonical write bearing an epistemic relation kind, a `confidence`/`epistemic_tag` elevation, or a page notice; no agent appends any version of — including `derived_from` on — a claim that is `author: user` or `epistemic_owner: user`, nor FORGETs, revives, or invalidates relations on one; and in beta, only the user (via `REVISE`) admits or withdraws epistemic edges or elevates epistemic status.

### Eval harness (outside core)

A small eval harness **lives outside Smartware core** and is not a canonical surface. Three suites:

1. **Schema / conformance suite** — canonical-surface validity, idempotency, cascade, FORGET/tombstone recovery, relation traversal.
2. **Deterministic relation-extraction fixture suite** — fixed inputs → fixed expected relations; guards the determinism and idempotency contracts of §10.
3. **Recall-replay suite** — retrieval quality over recorded sessions (the substrate's value-over-grep bet).

Scorecards are published once the suites are stable.

---

*Smartware. Living memory, for life. Co-authored, with typed relations.*
