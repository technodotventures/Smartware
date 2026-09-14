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
  operation_id: 'op_01J8ZP5N6Q7R8S9T0V1W2X3Y4Z', // `op_<ULID>` — a UUID is rejected; crash-safe OBSERVE
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
the owner-only Coffee operations `smartware_forget_scope`,
`smartware_export_scope` and `smartware_restore_scope`, and the
shared-workspace set
`smartware_register_source`, `smartware_list_sources`, `smartware_ingest`,
`smartware_sync_status`, `smartware_recall_federated`.

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
   // and/or check the canonical key before minting:
   //   canonicalKey(subjectId, predicate, scope, validityFrom)
   ```

   `canonicalKey` is exported from the package root for exactly this check.

### 1e. Corroboration, not duplication

Re-observing the same fact must strengthen the claim that already asserts it, not mint a twin.
Nothing inside Smartware wires identity to the corroboration helper for you — the host owns
extraction, so the host owns identity. Skipped, every restatement accumulates: measured on a
pilot, one billing preference restated twelve ways produced **14 recall results for 2 distinct
facts**, and recall quality degrades the longer the product runs.

```js
import { canonicalKey } from 'smartware';
import { addCorroborationEvidence } from 'smartware/layer1/corroboration';

const existing = store.findByCanonicalKey(subjectId, predicate, scope, validityFrom);
if (existing) {
  addCorroborationEvidence(existing.id, observation.id, store);  // dedupes, recomputes confidence
  syncSearchFromClaims(store, searchIndex, scope);                // recall must see the new confidence
} else {
  store.insertClaim({ /* ...a new claim... */ });
}
```

`canonicalKey(subjectId, predicate, scope, validityFrom)` is the identity the store looks claims
up by — the same value your `insertClaim` put in `validity.from`.

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

The trap below applies with it: identity includes `validity_from` as an **exact string**. If your extractor stamps a
fresh `new Date().toISOString()` on every write, no two writes ever produce the same key and
corroboration *silently never fires* — you get duplicate accumulation back, with the recipe
apparently followed. Either derive `validity_from` from the fact's own validity start (coarse
enough to be stable), or, when the fact carries no date, resolve to the active claim asserting the
same object instead:

```js
const existing = store.getClaimsBySubject(subjectId, 'active')
  .find(c => c.predicate === predicate && c.scope === scope
          && c.object.value === value && c.validity.to === null);
```

### 1f. Conflicting facts: admit, don't arbitrate

Two staff members (or an agent and a human) can report different values for the same fact.
Smartware has one deterministic policy for that — no LLM, no "last write wins" — and exposes it as
an admission seam so the host does not re-implement it (0.7.0 line, unreleased: the export is not
in the published 0.6.x tarballs; `scripts/saas-integration-smoke.mjs` proves it resolves against
this build):

```js
import { admitClaim } from 'smartware/layer1/conflicts';

const admission = admitClaim(claim, store);
// 'inserted'      first assertion for its canonical key
// 'corroborated'  same key + same value → evidence folded into the existing claim, no twin
// 'contested'     same key + different value → ALL sides retained and marked contested
// 'superseded'    same subject/predicate/scope, later validity_from, target still active →
//                 older claim superseded; validity.to closes at the new start and
//                 t_invalidated records when the brain learned the replacement
syncSearchFromClaims(store, searchIndex, scope);   // recall must see the new lifecycle state
```

Treat `contested` as a first-class product state: **recall returns both sides** with
`status: 'contested'`, `epistemic_tag: 'contested'` and `contested_by` claim ids, so the UI can
surface the disagreement instead of presenting one value as the truth. Superseded and stale claims
never satisfy current recall — read them back with `include_superseded: true` / `include_stale:
true`, or reconstruct a past instant with
`recall({ …, temporal: { mode: 'as_of', axis: 'valid_time' | 'transaction_time', at: iso } })`.

Resolving a contest is a *warranted user action* (REVISE admitting a `supersedes`/`corrects`
edge). Recency never resolves it, and `admitClaim` never supersedes a contested or stale claim.

Identity discipline decides which outcome you get: a restatement must reuse the original
`validity_from` to corroborate, and a conflicting write with a *later* `validity_from` reads as a
successor (superseded) rather than a disagreement (contested). Key `validity_from` to the fact's
claimed validity start — not the extraction time — when you want disagreements detected.

### 1g. Sources and connector ingestion (connectors, scheduled jobs)

Coffee owns the OAuth dance, the scheduler and the connector credentials. The brain owns the
**provenance origin** (a registered source) and one **ingestion contract** so a sync can be
resumed, replayed and audited instead of being a loop of blind writes.

Register the origin once (owner-only; `config.json` is the store, `created_at` is preserved on
update, `paused`/`revoked` refuse new writes without touching old evidence):

```ts
memory.registerSource({
  actor: { type: 'person', id: 'user:ava', display_name: 'Ava' },   // must be the owner
  id: 'src_gmail_ava',                    // stable host-chosen id — also the observation `app`
  kind: 'connector',                      // connector | meeting | note | agent | manual | system
  display_name: 'Gmail — ava@harbor-lane',
  external_ref: 'acct_ava_primary',       // opaque host handle (mailbox / account / calendar)
  // actor_ids: ['substrate:connector-runner'],   // optional: who may claim this provenance
});
```

Then sync one **page per batch** — actor, source, scope, the opaque cursor you reached, and an
`operation_id`:

```ts
const receipt = await memory.ingest({
  actor: { type: 'person', id: 'user:ava', display_name: 'Ava' },   // authenticated identity
  source_id: 'src_gmail_ava',
  scope: 'client:acme#1',                 // the actor still needs an observe grant here
  cursor: 'hist/101',                     // opaque; stored verbatim, never parsed
  operation_id: 'op_01J8ZP5N6Q7R8S9T0V1W2X3Y4Z', // `op_<ULID>`; the batch's idempotency key
  items: page.items.map(item => ({
    external_id: item.id,                 // the source's own id (dedup key)
    type: 'message',
    content: { format: 'text/plain', body: item.body },
    observed_at: item.receivedAt,
  })),
});

// receipt: { status, cursor, cursor_before, accepted, duplicated, quarantined, rejected, items }
//   items[i]: { external_id, status: accepted|duplicate|quarantined|rejected, observation_id?, code? }
```

What the contract guarantees, and what it expects of you:

- **Fail closed.** Missing source → `source_required`; unregistered → `source_unregistered`;
  paused/revoked → `source_inactive`; actor outside the source's allow-list →
  `insufficient_permission`; ungranted scope → the usual grant denial. All of these happen
  **before anything is written**.
- **Replay-safe.** Retry a batch with the same `operation_id` and you get the recorded receipt
  back (`status: 'replayed'`) — nothing is written twice. Retry with a new `operation_id` (e.g.
  after losing your local state) and stored items dedup per item. A crash *mid-batch* converges
  on the retry: the written prefix dedups, the remainder completes.
- **One item, one observation, per scope.** Dedup identity is `(source, external_id, scope)`, so
  resending a page is safe, and the same message that matters to two clients lands in **both**
  client memories instead of being silently shadowed by whichever scope saw it first. If an
  item's content changes at the source, send it under a new `external_id` (e.g. `msg_123:2`) —
  the brain keeps the original bytes and never rewrites history.
- **A bad item does not wedge the batch.** A rejected item (e.g. `secret_detected`) is reported
  with its code and counted; the batch still commits and the cursor advances. Alert on
  `receipt.rejected` and on sync-status counts rather than assuming "ok" means "all stored".
- **The cursor is yours.** Store it on your side too; `cursor_before` in the receipt tells you
  the stream's previous checkpoint, and `syncStatus` (owner-only) reports, per source and scope,
  the current cursor, last sync time, and accepted/duplicated/quarantined/rejected totals:

```ts
const [gmail] = memory.sourceSyncStatus({ actor: owner, source_id: 'src_gmail_ava' });
// gmail.last_sync.cursor, gmail.scopes[i].cursor, gmail.totals.rejected, …
```

Batch size is capped at `MAX_INGEST_ITEMS` (500; exported from `smartware/ingestion`) — chunk
bigger pages. The ledger of receipts/cursors is operational state: if it is ever lost (index
wipe, restore into a fresh data dir), re-sending from your own last checkpoint is safe by
construction; a missing cursor is never a lost write.

Item bodies pass the same gates as any observation (secret detection, attachment safety,
retention/sensitivity policy) — a connector does not get a bypass. Writes from an untrusted or
review-held connector land `quarantined` (counted, hidden from the raw window until a review
approves them), so treat "connector trusted" as a provisioning decision.

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
  operation_id: 'op_01J8ZP5N6Q7R8S9T0V1W2X3Y4Z',
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

**Federated reads (owner and multi-client staff).** When the product needs one
search across several client scopes, use `recallFederated` rather than looping
`recall` and merging in the host:

```ts
const federated = await memory.recallFederated({
  actor: owner,                      // or a staff actor holding several scopes
  query: 'open threads',
  scopes: ['client:acme#1', 'client:bcau#1'],   // optional; omit → actor's readable scopes
});
// federated.scopes      → the scopes actually queried
// federated.results     → scope-tagged rows, ordered scope-major (ranked within each scope)
// federated.per_scope   → { scope, total_found, returned }
```

Two rules are enforced, not advisory: **naming a scope the actor cannot read
denies the whole read** (`insufficient_permission` / `actor_unregistered`) —
a federated read never partially answers a request that named an unauthorized
scope; and **omitting `scopes` queries exactly the actor's readable scopes**
(the owner: every scope in the brain). Scores are comparable within a scope,
not across scopes — do not re-rank the merged list as one scale.

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
- **Restore one client** → `smartware_restore_scope` (ADR-0006). The return path
  for a package: verifies the manifest checksums and declared counts, refuses a
  package that crosses its scope boundary, refuses a non-empty target scope
  (`scope_not_empty` — restore, never merge), and refuses a tampered package
  (`package_corrupt`) **before writing anything**. The same package restored
  twice is idempotent (`already_restored`; receipt under `<data_dir>/imports/`).
  A post-erasure package (deletion certificate, no content) restores as an empty
  package: erasure is never undone by a restore. Run it on the lease holder.

  ```ts
  const restored = await memory.restoreScope({
    actor: owner,                          // owner-only
    package_dir: '/var/lib/smartware/harbor-lane/exports/exp_01J8ZP…',
    operation_id: 'op_01J8ZP5N6Q7R8S9T0V1W2X3Y4Z',
  });
  // { status: 'restored' | 'already_restored' | 'empty_package',
  //   export_id, scope, counts, manifest, receipt_path }
  ```

  Restored = exported, measurably: same claim ids, same `observation_ids`
  provenance, same recall answers — including after the restored brain's derived
  state is wiped and rebuilt (`test/protocol/restore-scope.test.ts`).
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
  operation_id: 'op_01J8ZP5N6Q7R8S9T0V1W2X3Y4Z',
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
npm test             # 520 tests across 72 files, no skips
npm pack             # → smartware-0.7.0.tgz
```

The tarball carries `dist/`, both frozen schema sets (`schemas/v0.4.2`,
`schemas/v0.5.0`), retrieval benchmarks, `docs/` (incl. this guide and the
tenant config example), README, and LICENSE. The `exports` map in
`package.json` is the stable public surface:

```
"."            → dist/core.js   (SmartwareCore)
"./mcp"        → dist/mcp.js    (createSmartwareMcpServer)
"./render"     → dist/render/provenance.js
"./layer0|1|3" → dist/layer*/…   (advanced escape hatches)
"./ingestion"  → dist/ingestion/index.js (source registry + ingestion contract)
"./schemas/v0.4.2/*" and "./schemas/v0.5.0/*"
```

Requires Node.js ≥ 22. `npm start` runs the stdio MCP server.

---

## 9. Verification gates (proof, not prose)

These are the checks that make the deployment claim credible — run them in CI
on the exact version you ship:

- `npm run verify:schemas` — all frozen schema files match their committed
  SHA-256 checksum manifest (31 files across v0.4.2 + v0.5.0).
- `npm test` — 520 tests / 72 files, no skips. The Coffee-specific suites:
  `test/conformance/coffee-company-brain.test.ts`,
  `test/conformance/p0_sources_ingestion.test.ts` (24 tests: source registry,
  fail-closed source context, ingestion cursors/replay/dedup, sync status,
  federated grants, human+agent attribution),
  `test/conformance/v050-rebuild-forget-provenance.test.ts` (14 tests:
  rebuild-equivalence, FORGET.SCOPE zero-results-every-lane against *rebuilt*
  indexes, erasure vs offboarding semantics, provenance integrity), and
  `test/render/provenance-rendering.test.ts` (33 exact-string tests).
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
- **Ingestion** is one page per batch (≤ `MAX_INGEST_ITEMS` = 500) and
  single-writer; its receipt/cursor ledger is documented operational state —
  the canonical record of what a batch wrote is the evidence log. Losing the
  ledger is safe (item dedup is content-safe); losing evidence is not, and
  that is what backup/restore drills are for.
- The suite does **not** prove concurrent multi-writer serialization or
  universal sudden-power-loss durability.
- Automatic quarantine is not implemented; ambiguous append-only artifacts
  remain available for manual review.
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
- Protocol v0.5.0: `docs/protocol/smartware-protocol-v0.5.0.md` (v0.4.2 retained)
- Schemas v0.5.0: `schemas/v0.5.0/`
- Config-shape proof: `scripts/verify-config-shape.mjs`
- Conformance: `docs/conformance-status.md`, `docs/compatibility.md`
- Coffee flows: `docs/competitive/coffee-client-scope-flows.md`,
  `docs/competitive/coffee-tenant-config.example.json`
