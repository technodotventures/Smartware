# Smartware SaaS integration guide

**Purpose:** deploy Smartware so any SaaS host (Coffee, Pod, or any other
multi-tenant product) can integrate it as the company/team memory layer for
small businesses across humans and agents. This is the "one memory for every
app and agent" substrate — the same shape as a company brain from GBrain /
mem0, but with provenance, bitemporal truth, policy-first retrieval, and
deletion semantics the product promises.

**Audience:** a SaaS backend engineer integrating Smartware 0.7.0 (protocol
v0.5.0, specification v1.6.16, schemas v0.5.0).

---

## 0. What you are integrating

Smartware is a **memory substrate**, not an end-to-end hosted product. The
protocol and reference implementation run **local-first** (SQLite + JSONL +
compiled Markdown) inside your service. Your SaaS owns:

- per-tenant persistence (one Smartware instance per business, we call it a
  *Pod*);
- the transport (HTTP/WebSocket/MCP) your app speaks to it;
- model credentials (`llm.provider` / embedding adapters) — Smartware reads
  them, it never redefines eligibility, temporal meaning, provenance, or
  activation rules;
- user-facing authorization, beyond the substrate grants.

Smartware provides:

| Capability | Surface |
|---|---|
| In-process memory engine | `SmartwareCore` (`import { SmartwareCore } from 'smartware'`) |
| MCP server (stdio, or hosted in-process) | `createSmartwareMcpServer(memory)` (`smartware/mcp`) |
| Standalone MCP daemon | `dist/cli.js` (via `npm start`) |
| Provenance/attribution rendering | `smartware/render` |
| Frozen schema sets | `schemas/v0.4.2` (retained), `schemas/v0.5.0` (current) |
| Canonical retrieval kernel contract | `benchmarks/retrieval/*.json` |

The protocol is the authority. Your host supplies credentials, adapters, and
persistence — never the memory rules.

---

## 1. Pick an integration mode

### 1a. Embedded core (recommended for a trusted in-process service)

```ts
import { SmartwareCore } from 'smartware';

const memory = await SmartwareCore.open({
  dataDir: '/var/lib/smartware/harbor-lane', // one per business
});

await memory.observe({
  actor: { type: 'person', id: 'user:maya', display_name: 'Maya' },
  type: 'meeting',
  content: { format: 'text/markdown', body: 'Acme wants quarterly payroll.' },
  scope: 'client:acme#1',
  visibility: 'scope',
  operation_id: crypto.randomUUID(), // crash-safe OBSERVE
});

const hits = await memory.recall({
  actor: { type: 'agent', id: 'agent:coffee-assistant' },
  query: 'Acme payroll',
  scope: 'client:acme#1',
});
```

`SmartwareCore.open` wires the whole pipeline: layer-0 evidence, layer-1
claims, layer-3 search, durable compile queue, and startup recovery. It opens
a `better-sqlite3` connection set you must `close()` on shutdown to avoid a
leaked native handle.

### 1b. MCP adapter (in-process, side-effect-free)

```ts
import { SmartwareCore } from 'smartware';
import { createSmartwareMcpServer } from 'smartware/mcp';

const memory = await SmartwareCore.open({ dataDir });
const server = createSmartwareMcpServer(memory); // exposes every tool
```

The adapter is transport-agnostic — call `server.tool(...)`-registered handlers
or attach it to your own transport. Tools include the canonical verbs
`smartware_observe`, `smartware_recall`, `smartware_reflect`,
`smartware_revise`, `smartware_forget`, plus `smartware_context`, `read`,
`explain`, `correct`, `quarantine_review`, `grant`/`revoke`, `session_*`,
and the two owner-only Coffee operations `smartware_forget_scope` and
`smartware_export_scope`.

### 1c. Standalone MCP daemon (stdio)

```sh
SMARTWARE_DATA_DIR=/var/lib/smartware/harbor-lane node dist/cli.js
```

Point an MCP client at `dist/cli.js` (see README "MCP configuration"). First
run initializes the Pod and prints the owner ID — save it; owner authority is
required for grants, revocation, status, sensitive review, FORGET.SCOPE, and
export.

---

### 1d. Host-side claim persistence (when you already own extraction)

If your product already has an extractor — for example an LLM pipeline you already run — you do
not have to use Smartware's compile path. You can persist claims yourself and index them. This is
the path with the fewest moving parts, and it is the one to choose if you do not want a model
credential inside the memory layer.

Everything below is reachable from the **published package** — that is deliberate, and the
repository's own smoke test imports exactly these paths so they cannot silently stop being public:

```ts
import { SmartwareCore, knownTime, nullTime } from 'smartware';  // core + claim time helpers
import { ClaimStore } from 'smartware/layer1';                   // claim persistence
import { SearchIndex, syncSearchFromClaims } from 'smartware/layer3'; // indexing for recall
```

Four things that will otherwise cost you an afternoon:

1. **Index, or recall returns nothing.** Inserting claims is not enough — call
   `syncSearchFromClaims(store, index, scope)` after inserting, or `recall` has nothing to rank.
   The observable symptom is a claim you can read by id but that no query ever returns.

2. **`setDataDir` exists on `ClaimStore` and NOT on `SearchIndex`.** They look symmetric and are
   not: the claim store needs the data directory for the canonical JSONL surfaces, the search
   index takes its database path in the constructor and nothing else. Calling `setDataDir` on the
   index throws `TypeError: index.setDataDir is not a function`.

3. **Build the time fields with the exported helpers** — `knownTime(value)` and `nullTime()`.
   `ClaimTimeValue` is `{ value, state }` with `state: 'known' | 'inferred' | 'null'`, so it is
   constructible by hand, but using the helpers keeps you aligned if the shape moves.

4. **Re-observed evidence must not mint a second claim.** `observe` deduplicates: re-observing the
   same content returns the original observation with `status: 'duplicate'` rather than creating a
   new one. `insertClaim` does **not** merge on canonical key, so an extractor that mints a claim
   per observation will accumulate duplicate claims for a single piece of evidence — measurably, a
   re-sent message took a scope from 3 claims to 4 with the observation count unchanged.

   Guard it in your extraction step:

   ```ts
   const obs = await memory.observe({ /* … */ });
   if (obs.status === 'duplicate') return;      // same evidence, already in the brain
   // and/or resolve the fact before minting — see §1e:
   const matches = store.findActiveFactMatches(subjectId, { predicate, scope, object });
   ```

   `ClaimStore.findActiveFactMatches` and `resolveFactMatches` are exported for exactly this check
   (§1e). `canonicalKey` is not a substitute for it — see the trap in §1e.

### 1e. Corroboration, not duplication

Re-observing the same fact must strengthen the claim that already asserts it, not mint a twin.
Skipped, every restatement accumulates: measured on a pilot, one billing preference restated twelve
ways produced **14 recall results for 2 distinct facts**, and recall quality degrades the longer the
product runs.

Smartware ships the identity rule **for this write path**, so you do not have to reimplement it
there. Resolve the fact — the subject, predicate, scope and object value — rather than the canonical
key:

```js
import { resolveFactMatches } from 'smartware/layer1/corroboration';

const matches = store.findActiveFactMatches(subjectId, { predicate, scope, object });
if (matches.length > 0) {
  const res = resolveFactMatches({ store, matches, observationId: observation.id });
  // res = { claimId, ambiguous_matches, ambiguity_resolved, superseded_claims,
  //         supporting_evidence, confidence }
  syncSearchFromClaims(store, searchIndex, scope);   // recall must see the union
} else {
  store.insertClaim({ /* ...a new claim... */ });     // nothing asserts this fact yet
  syncSearchFromClaims(store, searchIndex, scope);
}
```

`findActiveFactMatches(subjectId, { predicate, scope, object })` returns **every** active claim
asserting that fact (same subject, predicate, scope and object value, `validity.to === null`), in
survivor order — so `matches[0]` is the survivor even if you only need the id.

`resolveFactMatches` then applies one rule, in both directions:

- **One match is corroboration.** The new observation is more evidence for the claim that already
  asserts the fact; its id is added to `supporting_evidence` and confidence is recomputed.
- **Several matches is ambiguity, and it is resolved — never picked.** When a store already holds
  two active claims for one fact, the survivor is the **lexicographically smallest claim id**. Claim
  ids are ULIDs (time-ordered), so that means *earliest minted wins*, independent of the row order
  the store happens to return.
- **Evidence is unioned into the survivor before the losers are demoted.** A duplicate is the same
  fact observed again, so dropping its observations would lose provenance the brain already has.
- **Losers are demoted, never deleted** — `status: 'superseded'`, `superseded_by: <survivor>`,
  timestamped. They stay auditable on disk and leave the recall-eligible set (`status === 'active'`),
  which is what stops recall answering the same question twice.
- **The decision is reported.** `ambiguous_matches` and `superseded_claims` come back to the caller
  instead of a choice being made silently.

Measured end to end on a brain seeded with the pre-fix duplicate shape: recall answered **2 results
for one fact** before resolution and **1** after, with the duplicate superseded and its evidence
unioned into the survivor. `scripts/saas-integration-smoke.mjs` reproduces that against the
published package surface. The rule and the reasoning behind it are recorded in
[ADR-0003](../adr/0003-claim-fact-identity.md).

**Which surface this rule governs — read this if you also run the compile path.** The identity above
is the rule for **the host write path**: the moment you decide whether an extracted fact restates a
claim you already hold. Smartware carries a **second, different key over the same `claims` rows**:
the structured claim fingerprint
(`computeStructuredClaimFingerprint` — `subject_name`, `predicate`, `object`, `scope` **and**
`claim_type`), which `reflect.auto` uses for autonomous-creation idempotency (spec §193/§238). It is
a *creation key*, not a fact verdict: the two rules still disagree in both measured directions, so
do not read one as evidence about the other.

- Two active rows asserting one fact that differ only in `claim_type` (say `'preference'` vs
  `'finding'`) have **different** fingerprints and **the same** fact identity —
  `findActiveFactMatches` returns **2** and resolves them into one. A host that leaves `claim_type`
  unset lives here: `reflect.auto` defaults it to `'hypothesis'`, `ClaimStore` to `'finding'`.
- Two rows whose text values differ only in case (`'Quarterly'` vs `'quarterly'`) have the **same**
  fingerprint and **different** fact identities (fact identity does not case-fold a `text` value) —
  one claim to a Rule-B consumer, two facts to the write path.

**The creation path no longer mints that twin.** Before creating a claim, the autonomous path
(`reflect.auto`) consults fact identity: when the store already holds the fact as an active claim it
attaches the observation as corroboration (extending `derived_from`) instead of creating a second
one — same protection rule as above, and against a protected (`epistemic_owner: user`) claim it
writes nothing at all. That closes the *creation* path: it does not retro-repair a store that
already holds duplicates (the §1e sweep above converges those), and it does not make the two rules
one rule.

So a host running both surfaces must not assume the two agree: a Rule-B consumer can report
differently from the write path on the same rows, and duplicates that predate the creation-side fix
stay until a §1e write or sweep converges them. Nothing is silently wrong — `resolveFactMatches`
reports what it merged — but do not build policy on the assumption that one key answers both
questions. The relationship, its measured cases, its limits and its reversal trigger are recorded
in [ADR-0005](../adr/0005-protocol-claim-identity.md); the write-path contract itself stays
[ADR-0003](../adr/0003-claim-fact-identity.md). Both are pinned by tests
(`test/layer1/fact-identity.test.ts`, `test/protocol/reflect-auto-fact-identity.test.ts`).

**Do not do this** — it is what this guide used to teach:

```js
// WRONG: `getClaimsBySubject` has no ORDER BY, so this hands back whichever duplicate row SQLite
// happens to return first. The survivor becomes row-order dependent, nothing reports that a choice
// was made, the losers keep their evidence, and recall keeps answering twice for one fact.
const existing = store.getClaimsBySubject(subjectId, 'active')
  .find(c => c.predicate === predicate && c.scope === scope
          && c.object.value === value && c.validity.to === null);
```

**The canonical key is not the fact identity.** `canonicalKey(subjectId, predicate, scope,
validityFrom)` includes `validity_from` as an **exact string**. If your extractor stamps a fresh
`new Date().toISOString()` on every write, no two writes ever produce the same key,
`findByCanonicalKey` *silently never fires*, and you get duplicate accumulation back with the recipe
apparently followed. Use the key only when `validity_from` is derived from the fact's own validity
start (coarse enough to be stable). When the fact carries no date — the usual case for a preference
or a decision extracted from a message — the fact *is* the identity:
`findActiveFactMatches` + `resolveFactMatches` above. `scripts/saas-integration-smoke.mjs` asserts
that two rows for one fact carry two different canonical keys.

**Repairing a store that already accumulated duplicates.** The recipe above runs on the write path,
so a brain built before this rule existed keeps its duplicates until the next write touching that
fact. To converge one, sweep it — resolve every fact that has more than one active claim, with no
new observation, so nothing is added to `supporting_evidence` that was not observed:

```js
for (const claim of store.getActiveClaims(scope)) {
  const matches = store.findActiveFactMatches(claim.subject_id, {
    predicate: claim.predicate, scope: claim.scope, object: claim.object,
  });
  if (matches.length > 1) resolveFactMatches({ store, matches });   // no observationId
}
syncSearchFromClaims(store, searchIndex, scope);                    // drop the demoted rows
```

**Confidence is derived, not stored input.** `addCorroborationEvidence` recomputes it from the
claim's own fields (epistemic, evidence, recency, extraction), so a value you hand-set when
inserting is *replaced* the first time the claim is corroborated — a pilot that inserted `0.9` saw
`0.51`, the formula's answer for that claim. Set the initial value with the same formula so the two
agree:

```js
import { computeConfidence } from 'smartware/layer1/confidence';

const claim = { /* ...fields... */ };
claim.confidence = computeConfidence(claim);   // don't hand-set what the library will recompute
store.insertClaim(claim);
```

## 2. Model one SaaS tenant = one Pod, clients = scopes

Coffee's binding shape (spec §10b) — proved by
`scripts/verify-config-shape.mjs`:

- **One business = one Pod** (one `data_dir`, one `config.json`).
- A business's **client** (e.g. "Acme") is a *scope*, not a grant.
- **Staff and agents** are *grants*: exact **scope-id lists** per capability.
- `client:<id>` is versioned with a **non-reusable marker** `#n`
  (`client:acme#1`, `client:acme#2`). A grant on `#2` never authorizes `#1`;
  `client:*`, `client/*`, and `client:acme#*` are **never issued** to staff and
  **never match** (`scopeMatches` supports exact ids, `*`, and `prefix/*` only).
- A returning client gets a fresh `#N` and **inherits nothing**.

Worked example (ship this as your default tenant template):

```jsonc
{
  "instance_id": "smartware_01kxw9f2v3",
  "owner_id": "user:ava",                       // the business owner
  "version": "0.7.0",
  "scopes": [
    { "id": "self", "parent": null, "visibility_default": "private" },
    { "id": "workspace", "parent": null, "visibility_default": "workspace" },
    { "id": "client:acme#1", "parent": "workspace", "visibility_default": "scope" },
    { "id": "client:bcau#1", "parent": "workspace", "visibility_default": "scope" }
  ],
  "grants": [
    {
      "id": "grant_01kxw9f2v5",
      "actor_type": "person", "actor_id": "user:gigi",
      "capabilities": {
        "observe": ["client:acme#1", "client:bcau#1"],
        "query":   ["client:acme#1", "client:bcau#1"],
        "compile": [], "correct": ["client:acme#1"], "forget": [],
        "read":    ["client:acme#1", "client:bcau#1"]
      },
      "trusted": false, "quarantine": false,
      "created_at": "2026-08-29T09:00:00.000Z", "expires_at": null, "status": "active"
    }
  ],
  "llm": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
  "staleness": { "default_half_life_days": 90, "scope_overrides": {}, "stale_threshold": 0.3 }
}
```

`scripts/verify-config-shape.mjs` asserts (against the built `dist`) that
exact-id grants grant, that `#1` is unreachable from a `#2` grant, that
wildcards never leak, that the owner bypasses grants, and that the
`coffee-tenant-config.example.json` resolves.

---

## 3. Write path: observe once, compound asynchronously

OBSERVE is **crash-safe** when you pass `operation_id`, and **never runs the
LLM on the write path** (spec §9.1). On accept the raw observation is indexed
for full-text search **immediately** (sync-raw freshness), marked
`unverified`, and enqueued on the **durable compile queue** so it compounds
into claims without blocking the write.

```ts
await memory.observe({
  actor: { type: 'agent', id: 'agent:coffee-assistant', display_name: 'Coffee' },
  type: 'message',
  content: { format: 'text/markdown', body: 'Acme moved to quarterly billing.' },
  scope: 'client:acme#1',
  visibility: 'scope',
  sensitive: false,
  operation_id: crypto.randomUUID(),
});
```

Do not gate on synchronous compilation. If you need the derived claim now,
call `reflect` explicitly; otherwise the worker drains the queue on an interval
(`drainCompileQueue`).

---

## 4. Read path: policy-first retrieval

Recall resolves scope, grants, sensitivity, lifecycle, and currentness *before*
any semantic text reaches an embedding provider. Hybrid search fuses semantic
and lexical ranks with reciprocal-rank fusion; missing/corrupt/unavailable
semantic infrastructure falls back to canonical retrieval instead of hanging.

```ts
const hits = await memory.recall({
  actor: { type: 'agent', id: 'agent:coffee-assistant', display_name: 'Coffee' },
  query: 'Acme current billing cadence',
  scope: 'client:acme#1',
  limit: 10,
});
```

Freshness is **state-based, never time-based**: a failed compile stays
raw-searchable forever with `unverified`. There is no silent "ages out of
memory" based on a clock.

---

## 5. Staff-facing attribution (REQUIRED to render provenance)

`smartware/render` is the executable conformance anchor for spec §10d.
**Coffee must render attribution through it**, not re-implement the rule.

```ts
import { showAttributionByDefault, attributionLine, badge, whySentence } from 'smartware/render';

const input = {
  surface: 'staff',                    // staff-facing only
  freshness: 'unverified',             // raw evidence, not yet extracted
  compileState: 'failed',              // a failed compile forces FAILED wording
  actorKind: 'person',
  actorDisplay: 'Maya',                // resolved first name, never a raw actor id
  sourceDate: new Date('2026-05-12T00:00:00Z'),
  claimType: 'decision',
  epistemicTag: 'fact',
  confidence: 'high',
  tags: ['price'],                     // consequential → default-on
};

const show = showAttributionByDefault(input); // surface === 'client' → always false
if (show) {
  const line = attributionLine(input); // "learned from <actor> <date>; corrected <date>"
  const why  = whySentence(input);     // one-line freshness / correction / conflict reason
}
```

Rules bound by the suite (`test/render/provenance-rendering.test.ts`):

- Attribution is **staff-facing only**. Client-facing UI never shows sources,
  staff names, badges, or the why-panel — the single exception is a
  client-owned "From your messages" citation.
- Default **on** for: corrections/revise/conflict/superseded, freshness
  `unverified` or `failed`, and `version_at ≤ 14d`.
- Everything else defaults **off** behind a "Why this answer?" toggle.
- Wording is normative (e.g. flagship "Learned from Maya, May 12; corrected by
  owner May 13."), with a fixed badge set: New / Not verified / May be stale /
  Conflict / Unconfirmed. Dates render deterministically in UTC.

---

## 6. Data rights: export, offboarding, erasure (owner-only)

These are the flows a company brain must expose to small businesses that move
clients on and off. All three are **owner-gated in the substrate** — staff
never see the affordance.

- **Export one client** → `smartware_export_scope` (spec §10c.4). Produces a
  canonical package under `<data_dir>/exports/<export_id>/` with
  `observations/claims/evidence/operations/entities.jsonl` + `manifest.json`
  (per-file sha256 + aggregate, asserts `scope_exclusive: true`). Derived
  indexes excluded. **Idempotent** per `operation_id`.
- **Offboarding (reversible)** → `FORGET.SCOPE { reason: 'offboarding' }`.
  Tombstones, revokes grants same-commit, records exact retraction counts, and
  persists an owner-approved non-PII `owner_pointer` for a later `#N` return.
- **Erasure (terminal)** → `FORGET.SCOPE { reason: 'erasure' }`. Physical
  purge in every lane. **Erasure never fires under dispute** — the hold lane is
  offboarding + export snapshot; erasure only after owner attestation. The
  audit marker is the deletion certificate.

```ts
await memory.forgetScope({
  actor: { type: 'person', id: 'user:ava', display_name: 'Ava' },
  scope: 'client:acme#1',
  reason: 'offboarding',          // or 'erasure'
  operation_id: crypto.randomUUID(),
  owner_pointer: '{"relationship_length":"client since 2023","job_categories":["bookkeeping","tax"],"satisfaction":"positive"}',
});
```

---

## 7. Security posture to preserve

- **Local ownership by default:** SQLite, JSONL evidence, compiled Markdown,
  and `config.json` sit under the operator's control with private perms from
  `ensurePrivateDirectory`. `npm audit --omit=dev` reports zero production
  vulns.
- **No ambient egress:** `llm.provider: 'none'` by default; nothing goes to a
  model unless you opt in and configure a provider + key. Sensitive
  observations and pages are excluded from external extraction/synthesis even
  when a provider is configured.
- **Exact-id grants; never wildcards to staff.** `client:acme#1` is a single
  boundary; `*` is reserved to the owner.
- **Owner subject:** `user:ava` in the config is the privilege boundary for
  grants, status, sensitive review, FORGET.SCOPE, and export.
- **Treat model output as untrusted input.** Smartware never surfaces a
  derived claim as authoritative raw truth; it carries provenance +
  epistemic status + freshness, which is exactly what `smartware/render`
  renders.

---

## 8. Deploy the package

```sh
npm ci
npm run build        # tsc → dist/
npm run verify:schemas
npm test             # 497 tests across 70 files, no skips
npm pack             # → smartware-0.7.0.tgz
```

The tarball carries `dist/`, both frozen schema sets (`schemas/v0.4.2`,
`schemas/v0.5.0`), retrieval benchmarks, `docs/` (incl. this guide and the
tenant config example), README, and LICENSE. The `exports` map in
`package.json` is the stable public surface:

```
"."            → dist/core.js   (SmartwareCore, knownTime/nullTime/canonicalKey)
"./mcp"        → dist/mcp.js    (createSmartwareMcpServer)
"./render"     → dist/render/provenance.js
"./layer0|1|3" → dist/layer*/…   (advanced escape hatches)
"./layer1/corroboration" → addCorroborationEvidence, resolveFactMatches (§1e)
"./layer1/confidence"    → computeConfidence (still exported — confidence is derived)
"./schemas/v0.4.2/*" and "./schemas/v0.5.0/*"
```

Requires Node.js ≥ 22. `npm start` runs the stdio MCP server.

---

## 9. Verification gates (proof, not prose)

These are the checks that make the deployment claim credible — run them in CI
on the exact version you ship:

- `npm run verify:schemas` — all frozen schema files match their committed
  SHA-256 checksum manifest (31 files across v0.4.2 + v0.5.0).
- `npm test` — 497 tests / 70 files, no skips. The Coffee-specific suites:
  `test/conformance/coffee-company-brain.test.ts`,
  `test/conformance/v050-rebuild-forget-provenance.test.ts` (14 tests:
  rebuild-equivalence, FORGET.SCOPE zero-results-every-lane against *rebuilt*
  indexes, erasure vs offboarding semantics, provenance integrity),
  `test/render/provenance-rendering.test.ts` (33 exact-string tests),
  `test/layer1/fact-identity.test.ts` (22 tests: the §1e identity contract —
  every duplicate found, earliest-minted survivor in both insertion orders,
  evidence unioned, losers demoted not deleted, sweep without a new observation —
  plus 3 tests pinning the *crossing* between fact identity and
  `computeStructuredClaimFingerprint`, decided in ADR-0005), and
  `test/protocol/reflect-auto-fact-identity.test.ts` (4 tests: the autonomous path
  consults fact identity before creating — corroboration instead of a duplicate,
  protection respected, the fingerprint control, and creation unchanged when no
  claim holds the fact).
- `npm run verify:saas` — public-API smoke on the packaged surface, including the
  §1e duplicate contract end to end: 2 recall results for one fact → 1 after
  resolution, duplicate superseded with its evidence unioned.
- `npm run benchmark:retrieval-kernel` — 9/9 scenarios, Hit@1 1.0, MRR 1.0,
  zero forbidden hits.
- `npm run benchmark:retrieval-activation-contract` — expects **HOLD**; the
  command succeeds only because semantic activation fails closed on public
  development evidence, as required.

---

## 10. Honest limits

- Smartware is **not** a general ACID filesystem transaction layer; the tested
  guarantee is *idempotent, crash-consistent local mutation commits that
  recover after one process terminates and the operation is retried*, plus
  reason-aware scope erasure/offboarding with lane-exhaustive purge and
  exact-count audit.
- The suite does **not** prove concurrent multi-writer serialization or
  universal sudden-power-loss durability.
- Automatic quarantine is not implemented; ambiguous append-only artifacts
  remain available for manual review.
- Duplicate-claim convergence is a **write-path or sweep** action, not a background
  guarantee. The autonomous path no longer mints a claim for a fact the store already
  holds (it attaches corroboration — `§1e`), but a store that **already** holds two
  active claims for one fact keeps both until a write touching that fact runs
  `resolveFactMatches`, or a host sweeps the scope (`§1e`). Identity is
  `(subject, predicate, scope, object value)` — two rows asserting the same fact in
  **different scopes** are never merged, so scope isolation always wins over
  deduplication.
- Passing schemas + behavioral invariants is **not** exhaustive
  requirement-by-requirement conformance to Specification v1.6.16.

---

## 11. Retention lifecycle + consolidation (post-0.7.0)

Two host-triggered lifecycle surfaces, both owner/staff-gated and receipt-backed
(see `docs/adr/0001-retention-expiry-archival.md` and `docs/adr/0002-consolidation.md`):

- **Retention expiry** — `memory.expireRetention({ actor, scope, operation_id?, as_of? })`
  (MCP `smartware_expire_retention`). Optional `retention` config (additive; absent ⇒
  `forever`, today's behavior). Tombstones elapsed `duration`-policy observations and
  retracts their sole-evidence claims, with one `retention.expire` ops entry. Idempotent;
  run it on a host scheduler (like `drainCompileQueue`). Physical storage reclaim is
  `forgetScope({ reason: 'erasure' })` — there is no separate record-level purge.
- **Consolidation** — `memory.consolidate({ actor, claim_ids[], summary, subject_name,
  predicate, scope, operation_id })` (MCP `smartware_consolidate`, user-only). Collapses
  2+ active claims into one reviewed current-understanding claim whose `derived_from` is
  a superset of the inputs' evidence lineage; inputs are tombstoned, never deleted.

## References

- Specification v1.6.16: `docs/spec/smartware-spec-v1.6.16.md`
- Claim fact identity (ADR-0003): `docs/adr/0003-claim-fact-identity.md`
- Protocol claim identity vs the autonomous-creation key (ADR-0005): `docs/adr/0005-protocol-claim-identity.md`
- Protocol v0.5.0: `docs/protocol/smartware-protocol-v0.5.0.md` (v0.4.2 retained)
- Schemas v0.5.0: `schemas/v0.5.0/`
- Config-shape proof: `scripts/verify-config-shape.mjs`
- Conformance: `docs/conformance-status.md`, `docs/compatibility.md`
- Coffee flows: `docs/competitive/coffee-client-scope-flows.md`,
  `docs/competitive/coffee-tenant-config.example.json`
