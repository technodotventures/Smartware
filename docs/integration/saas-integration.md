# Smartware SaaS integration guide

**Purpose:** deploy Smartware so any SaaS host (Coffee, Pod, or any other
multi-tenant product) can integrate it as the company/team memory layer for
small businesses across humans and agents. This is the "one memory for every
app and agent" substrate — the same shape as a company brain from GBrain /
mem0, but with provenance, bitemporal truth, policy-first retrieval, and
deletion semantics the product promises.

**Audience:** a SaaS backend engineer integrating Smartware v0.6.x (protocol
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
npm test             # 446 tests across 64 files, no skips
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
"./schemas/v0.4.2/*" and "./schemas/v0.5.0/*"
```

Requires Node.js ≥ 20. `npm start` runs the stdio MCP server.

---

## 9. Verification gates (proof, not prose)

These are the checks that make the deployment claim credible — run them in CI
on the exact version you ship:

- `npm run verify:schemas` — all frozen schema files match their committed
  SHA-256 checksum manifest (31 files across v0.4.2 + v0.5.0).
- `npm test` — 446 tests / 64 files, no skips. The Coffee-specific suites:
  `test/conformance/coffee-company-brain.test.ts`,
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
- The suite does **not** prove concurrent multi-writer serialization or
  universal sudden-power-loss durability.
- Automatic quarantine is not implemented; ambiguous append-only artifacts
  remain available for manual review.
- Passing schemas + behavioral invariants is **not** exhaustive
  requirement-by-requirement conformance to Specification v1.6.16.

---

## References

- Specification v1.6.16: `docs/spec/smartware-spec-v1.6.16.md`
- Protocol v0.5.0: `docs/protocol/smartware-protocol-v0.5.0.md` (v0.4.2 retained)
- Schemas v0.5.0: `schemas/v0.5.0/`
- Config-shape proof: `scripts/verify-config-shape.mjs`
- Conformance: `docs/conformance-status.md`, `docs/compatibility.md`
- Coffee flows: `docs/competitive/coffee-client-scope-flows.md`,
  `docs/competitive/coffee-tenant-config.example.json`
