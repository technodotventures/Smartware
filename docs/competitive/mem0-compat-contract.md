# Smartware mem0-compat adapter — G3 decision: contract pin, packaging, versioning, conformance, hosting

**Status:** DECISION v1 · 2026-08-29 · Author: @smarty-pants (kanban t_0724f1dc)
**Scope:** This record defines WHAT the optional mem0-compat reach is pinned to, HOW it is packaged/versioned, WHERE it is hosted, and HOW conformance is judged. It is the G3 evidence that resolves the `mem0-compat drift` risk row in `company-brain-plan.md` and the adapter-hosting decision in spec §9.5.
**Companion docs:** `mem0-substrate-spec-draft.md` (v0.7 NORMATIVE — the design contract), `mem0-gap-analysis.md` (analysis), `mem0-h2h-recall.md` (G0 verdict).
**Fixture:** `docs/competitive/fixtures/mem0-v3-contract.v1.json` — machine-readable pin, regenerable, source-traceable line-by-line.

---

## 0. Decision summary (what changed vs the spec today)

1. **Contract generation pin = mem0 v3** (the "new memory algorithm": single-pass ADD-only extraction, multi-signal hybrid retrieval, entity linking; graph memory is Platform-only). Anchors are mem0's OWN migration guides (they are the normative fixture set), not third-party summaries.
2. **The spec (§2, §4, §8) currently describes the mem0 v2 surface.** Real v3 differs materially: entity IDs move inside `filters`; TypeScript SDK is fully camelCase (`topK`, `userId`); `limit`→`topK`; defaults changed (`top_k` 100→20, `threshold` None→0.1, `rerank` True→False); `add()` returns ADD-only events (OSS) / `{event_id, status:"PENDING"}` (Platform); `get_all` returns a paginated envelope; graph + `enable_graph` removed; Platform v3 endpoints are `/v3/memories/add/`, `/v3/memories/search/`, `/v3/memories/`. **Spec §2 requires a resync (drafted in §5 below) and MUST ship before anyone implements the adapter against the spec.**
3. **Hosting: separate package confirmed** — `smartware-mem0-compat`, hosted **in this repo at `packages/mem0-compat/`** (own package.json/tsconfig/CHANGELOG/vitest), NOT a standalone repo, NOT part of the core package. Own semver, decoupled from protocol. Reversal is cheap and recorded (§3).
4. **Versioning:** semver is self-owned and honest: MAJOR = any change that breaks a repointing mem0 client (or a new pinned contract generation); MINOR = additive surface (new tool/route/param accepted); PATCH = behavior-preserving fixes. The supported protocol version is expressed as a peerDependency range + tested-version matrix — **never** baked into the package version.
5. **Conformance:** fixture-driven against mem0's own migration-guide documents (`oss-v2-to-v3`, `platform-v2-to-v3`), CLI README, and the Node SDK v3.0.0 release notes — pinned to mem0ai/mem0 commit `19cb89aff472325c707f64b2f34ae6afdbf7faf7` (2026-08-29). Conformance tests assert **behavioral shape** (accepted/rejected params, defaults, response shapes, error semantics), never retrieval parity — G0 verdict (fix our internals; never adopt their engine) is unchanged by this decision.

---

## 1. Contract pin

### 1.1 Version anchors (all verified 2026-08-29, primary sources)

| Anchor | Value | Verification |
|---|---|---|
| mem0ai/mem0 source-of-truth commit | `19cb89aff472325c707f64b2f34ae6afdbf7faf7` (main, 2026-08-29) | GitHub API `commits/main` |
| mem0 license | Apache-2.0 | repo README §License (vendoring with attribution is permitted) |
| npm `mem0ai` (TS OSS + TS Platform client) | **3.1.7** (published 2026-08-24; 3.0.0 2026-04-16 = Node SDK v3.0.0 milestone) | npm registry |
| PyPI `mem0ai` (Python OSS + Python Platform client) | **2.0.19** — ⚠️ **no 3.x published as of 2026-08-29** | PyPI JSON (no 3.x release strings) |
| PyPI `mem0-cli` / npm `@mem0/cli` | 0.2.12 / 0.2.13 | registries |
| MCP endpoint (official, hosted) | `https://mcp.mem0.ai/mcp` | docs.mem0.ai/platform/mem0-mcp |
| `mem0ai/mem0-mcp` repo | **archived: true** (official MCP is now cloud-hosted only) | GitHub API |
| npm `@mem0/mcp` | **404** (docs' `npx @mem0/mcp` snippet does not resolve today — open note, see §6) | npm registry |

**Critical asymmetry (must be recorded, not smoothed over):** mem0's OSS v3 is **documented but not yet published on PyPI** while the TS SDK (3.1.7) and the Platform v3 REST contract are live. Therefore the v3 pin is anchored to **the migration-guide documents + the released TS SDK**, and the Python conformance tests must be honest about what they can and cannot exercise (§4, T2).

### 1.2 REST surface (what the compat server implements)

Platform v3 — primary (from `platform-v2-to-v3`):

| Operation | Endpoint | Request | Response |
|---|---|---|---|
| Add | `POST /v3/memories/add/` | `{messages: [...], user_id?, agent_id?, run_id?, app_id?}` | `{event_id, status: "PENDING"}` (async); poll `GET /v1/event/{event_id}/` → SUCCEEDED/FAILED |
| Search | `POST /v3/memories/search/` | `{query, filters: {user_id?, agent_id?, run_id?...}, top_k? (1-1000, default 10), threshold? (default 0.1, [0,1], 0.0 disables), rerank? (default false)}` | `{results: [{id, memory, score, metadata, categories, created_at, updated_at}]}` |
| List | `POST /v3/memories/?page=N&page_size=M` | `{filters}` (+ pagination query params) | `{count, next, previous, results: [...]}` |

- Entity IDs at top level of search/list **raise 400** (mirrors guide; SDKs raise `ValueError`/throw).
- v1/v2 endpoints **continue to work** (mem0's own backward-compat promise): legacy OSS-shape routes (`POST /memories`, `GET /memories`, `GET/PUT/DELETE /memories/{id}`, `DELETE /memories`, `GET /memories/{id}/history`, `POST /search`, `POST /reset`, `GET|POST /configure`, `GET /entities`, `DELETE /entities/{type}/{id}`) and `/v1/` prefixed hosted-shape routes stay implemented as the **legacy** surface (per spec §2.1/§2.2, G1-derived from mem0ai 2.x server; re-verify at implementation against the 2.0.19 sdist).
- `relations` field is **no longer returned** in v3 (graph was Platform-only) — compat must not fabricate it.
- We never report mem0's fused score (§6 of spec): our scores are ours, labeled via `explain` extension.

### 1.3 SDK method surface (pin = names are correct; shapes are v3)

Methods attested across guides/CLI/MCP: `add`, `search`, `get`, `get_all`, `update`, `delete`, `delete_all`, `history` (via CLI event/history + REST legacy), `reset`. V3 shape rules (binding for the adapter's input validation):

| Rule (from oss-v2-to-v3 + platform-v2-to-v3 + ts-v3.0.0) | Consequence for compat |
|---|---|
| Entity IDs for `search`/`get_all` are **inside `filters`**; top-level raises | Accept only filters-form; top-level → 400 / ValueError-style error, exactly like mem0 |
| `add()`/`delete_all()` keep top-level entity IDs | Same as above — asymmetry is part of the contract |
| TS: all params camelCase (`userId`, `agentId`, `topK`, `customInstructions`); `limit` → `topK` | The HTTP/JSON wire format keeps snake_case (our server speaks the API); the adapter-layer SDK shim (if any) converts like mem0's does |
| Python OSS: `search(query, filters=..., top_k=, threshold=, rerank=)` | Wire format: `filters`, `top_k`, `threshold`, `rerank` |
| Defaults: `top_k` 20 (Platform API default 10), `threshold` 0.1, `rerank` false | Adapter must accept defaults identically; `threshold` validation `[0,1]` — out of range rejected |
| `add` returns **ADD-only** events (OSS) / `{event_id, status:"PENDING"}` (Platform SDKs) | Compat maps Platform async semantics onto Smartware's durable compile queue: `event_id` ↔ queue job id; status poll maps `unverified/EXTRACTED/FAILED` → PENDING/SUCCEEDED/FAILED (spec §9.1 state semantics — no invented states) |
| `get_all` returns `{count, next, previous, results}` | pagination envelope is binding |
| Removed params (must be rejected with clear errors, not silently ignored): `api_version`, `output_format`, `async_mode`, `enable_graph`/`enableGraph`, `graph_store`/`graphStore`, `immutable`, `filter_memories`, `batch_size`, `force_add_only`, `includes`, `excludes`, `keyword_search`, `org_id`/`project_id`, `org_name`/`project_name`, `custom_fact_extraction_prompt`/`customPrompt` (renamed `custom_instructions`/`customInstructions`), `custom_update_memory_prompt` | Mirror mem0's rejection semantics (the guide is the fixture); rejecting loudly beats silently accepting what mem0 no longer accepts |
| Entity ID validation: trimmed, empty/whitespace rejected, no internal spaces | Adapter applies the same validation |
| `messages` in `add` must be str/dict/list[dict] (else `Mem0ValidationError` `VALIDATION_003`) | Same |

### 1.4 CLI surface

Real mem0 CLI (from `cli/README.md` @ pinned commit; verified: PyPI 0.2.12, npm 0.2.13): commands `init`, `add`, `search`, `list`, `get`, `update`, `delete`, `import`, `config`, `entity`, `event`, `status`; plus `version`, `whoami`, `agent-rush` (Platform-only: `whoami` = server-issued identity, `agent-rush` = Platform competition wrapping `/v1/agent-rush/` — **excluded** from compat, documented as such). Global agent-friendly flags: `--agent`/`--json` (sanitized JSON output, errors as JSON, exit codes), `--output {text,json,quiet,table}`; `mem0 help --json` command tree.

**Repoint path (verified): `MEM0_BASE_URL` env var (cli/README.md line 115) — the existing mem0 CLI can point at the compat server with one env var, no code change.** This is the strongest "repoint without code changes" story: CLI users change one env var.

Compat CLI decision (per spec §9.4: compat package only, core CLI untouched): ships `smartware-mem0` bin (no `mem0` name collision with mem0-cli), same command grammar above minus platform-only exclusions.

### 1.5 MCP surface

Official MCP = cloud-hosted `https://mcp.mem0.ai/mcp`; `mem0ai/mem0-mcp` repo is **archived**. Tools (docs table): `add_memory`, `search_memories`, `get_memories`, `get_memory`, `update_memory`, `delete_memory` (docs page extraction truncated after `update_memory`; the listed set is complete per the docs table structure — **verify via live `tools/list` at implementation** and pin in the fixture, §6 open note). Auth: API key bearer / browser sign-in; `401 Authentication required` otherwise.

Namespace resolution for the spec's §9.3: core Smartware MCP tools are all `smartware_*` (verified in `src/mcp.ts`, 17 tools) — **no collision with mem0 tool names**. Recommendation (small spec refinement, needs @hermes sign-off in the §2 resync): when the mem0 namespace is enabled (default **off**), register the six tools under their **exact mem0 names**, not `mem0_`-prefixed — preserves the "repoint without code changes" promise for MCP agents while still being an option-gated, non-default group. The core server needs **one generic extension hook** to let the compat package register tools (`SmartwareMcpServerOptions` today exposes no registration surface; only `createSmartwareMcpServer` is exported). That hook is protocol-generic (not mem0-specific) — a tiny, justified core addition; contingency if it cannot ship: compat ships its own MCP entry wrapping the core (second-server mode, documented fallback only, §9.3 preference stands).

### 1.6 Explicit exclusions (mirroring spec §1 non-goals, verified against v3 docs)

- No reimplementation of mem0's extraction/fusion pipeline; no score conversion to mem0's fused scale.
- No graph store, no `relations` field (v3 graph = Platform-only; OSS removed ~4000 lines of graph drivers).
- No `whoami`/`agent-rush` (Platform-only), no org/project scoping (removed in v3 clients), no Platform dashboard/webhooks/events API beyond the one polling endpoint needed for `add` semantics.
- Memory expiration/cleanup (Platform feature) is not emulated; Smartware's own state-based freshness (§9.1) is the honest equivalent.

---

## 2. Package charter & versioning

**Name:** `smartware-mem0-compat` (npm). **License:** Apache-2.0 (same as core). **Bin:** `smartware-mem0`.

**Versioning (own semver, decoupled from protocol):**
- **MAJOR** = any change that breaks a repointing mem0 client (a shipped surface stops accepting what mem0 accepts, or accepts less) OR a new pinned contract generation (mem0 v4, or a v3.x semantic rupture that the guides confirm).
- **MINOR** = additive surface: new route/tool/param accepted, new mem0 minor pinned, dependency updates within behavior.
- **PATCH** = fixes that change no observable contract behavior.
- The protocol version is carried ONLY as: (a) `peerDependencies: { "smartware": "^0.5.0" }` (initial range; documented), (b) a tested-version matrix in the README. **Never** in the package version. Protocol v0.5.0 ships without the compat package; compat ships independently.
- Every release pins its fixture: each package version's README row declares `mem0 contract anchor (commit) + npm mem0ai tested version + mem0-cli tested version` so a broken pin is a release-blocking CI failure, not a changelog line.
- Dependency direction: compat depends on smartware (peer + dev); **smartware never depends on compat; core contains zero mem0 identifiers** (except the one generic MCP hook described in §1.5, if accepted).

**Package layout at implementation time (tech-head):**
```
packages/mem0-compat/
  package.json        (name smartware-mem0-compat, bin smartware-mem0, peer smartware ^0.5.0)
  tsconfig.json       (standalone; own build, no root coupling)
  vitest.config.ts
  CHANGELOG.md        (own; entry per release)
  README.md           (compat matrix: contract anchor, tested SDK/CLI/MCP versions)
  NOTICE              (mem0 fixture attribution, Apache-2.0)
  src/                (server, cli, mcp-namespace, transport adapters)
  test/               (contract/, golden/, repoint/, e2e/)
  fixtures/           (resolved copy of docs/competitive/fixtures/mem0-v3-contract.v1.json at test time)
```

---

## 3. Hosting resolution (core vs separate — RESOLVED here)

**Decision: separate package, in-repo sub-package `packages/mem0-compat/`; NOT a standalone repo; NOT merged into the core npm package.**

Rationale (ranked):
1. Spec §9.5 is confirmed: "separate package, own semver, decoupled from protocol; core library stays lean" — the core has **no HTTP server today** (package.json deps: MCP SDK, better-sqlite3, simple-git, ulid, zod — zero server frameworks), so the compat package must bring its own HTTP layer. That alone forces a separate package: adding an HTTP framework to the core contradicts "protocol, not monolithic database" and would grow core's attack surface for optional reach.
2. **In-repo rather than standalone repo:** conformance fixtures + contract docs live next to the protocol they validate; one security disclosure and CI surface; no new repo admin; the decoupling that matters is semantic (package boundary + peer dep + semver), not physical.
3. **Reversal is cheap and recorded:** the package has no circular dependencies; extraction = move directory + add publish config + repoint docs. If real third-party adoption materializes, flip to a standalone repo — this decision record is the trigger condition.

---

## 4. Conformance design ("mem0's own migration-guide fixtures")

**Principle:** the normative fixture is mem0's own documentation/release material, vendored with provenance, not our paraphrase. The fixture JSON (`docs/competitive/fixtures/mem0-v3-contract.v1.json`) records: source URL/path, pinned commit, extraction date, and the extracted facts. A drift job (see below) re-extracts and diffs.

**Test classes (all in `packages/mem0-compat/test/`):**
- **T1 — contract-shape tests (migration-guide rows as assertions).** Every breaking-change row from `oss-v2-to-v3` (Python + TS tables), `platform-v2-to-v3` (endpoint table, param table, response shapes), `ts-v3.0.0` release notes, and the CLI README command table becomes a test: e.g. top-level `user_id` on search → 400; `limit` param rejected, `topK` accepted (HTTP: `top_k`); `threshold` = 0.1 default, 0.0 disables, out-of-range rejected; `get_all` returns `{count,next,previous,results}`; `add` returns `{event_id,status:"PENDING"}` then poll succeeds; removed params rejected with clear error codes; entity-ID validation applied.
- **T2 — golden-response tests with real mem0 clients.** TypeScript: install `mem0ai@3.1.7` in CI, repoint its Platform client at the compat server (base URL config), and run a full CRUD round trip asserting schema validity. Python: **honest limitation — mem0ai PyPI is 2.0.19 (v2)**; Python golden tests validate the legacy-surface handling with 2.0.19 and the v3 Python semantics are asserted from the doc fixture only. Recorded, not hidden.
- **T3 — repoint tests:** `mem0-cli` (0.2.12) with `MEM0_BASE_URL` → compat server: `add/search/list/get/update/delete` round trip; MCP: `tools/list` against the compat MCP namespace returns the six mem0 tool names; error-envelope mapping (spec §8) asserted 1:1.
- **T4 — drift watch:** CI (or a bounded scheduled job) re-fetches mem0 repo main + registries, compares to the fixture anchors, and opens a drift alert when: npm `mem0ai` minor that changes a guide table, new migration guide release, or PyPI 3.x publication. Fixture regeneration is manual, reviewed, and recorded in the CHANGELOG.

**Gate:** T1–T3 green is required to tag a release of `smartware-mem0-compat`. Conformance is about **behavioral shape**, and the anti-metric rule from the G0 spike applies: no retrieval-parity claim is made, and spec §6 scoring rules are unchanged (scores are ours, labeled; `explain` transparent; benchmark reads rank/relevance never absolute scores).

---

## 5. Spec §2/§4/§8 resync required (handoff for @hermes — verbatim items)

1. §2.1/§2.2 REST: add the v3 endpoints (`/v3/memories/add/`, `/v3/memories/search/`, `/v3/memories/` + `GET /v1/event/{id}`) as the primary surface; retitle the current OSS-shape routes as **legacy (v2, kept for backward compatibility, mirroring mem0's own promise)**; note the paginated list envelope and async add.
2. §2.3 SDK params: replace v2-era top-level entity IDs/defaults with the v3 table (§1.3 here): filters-embedded entity IDs, TS camelCase, `topK`, defaults `top_k=20` (Platform API default 10) / `threshold=0.1` / `rerank=false`, ADD-only events, removed-params rejection list, entity-ID validation, `VALIDATION_003` for bad `messages`.
3. §2.4 CLI: replace "mirroring SDK subcommands" with the real command table (init/add/search/list/get/update/delete/import/config/entity/event/status + global `--agent`/`--json`/`--output`), `MEM0_BASE_URL` repoint, exclusions (`whoami`, `agent-rush`).
4. §2.5 MCP: actual tool names (`add_memory`, `search_memories`, `get_memories`, `get_memory`, `update_memory`, `delete_memory`); note `mem0-mcp` repo archived + cloud-hosted only; refine the namespace wording (§1.5 recommendation: exact mem0 tool names, option-gated, default off; `mem0_`-prefix only if a collision ever appears).
5. §4 mapping: `add` maps Platform async `{event_id, PENDING}` → Smartware durable compile queue with state-based status (`unverified`→PENDING, EXTRACTED→SUCCEEDED, FAILED→FAILED); no invented states.
6. §8 verification: pin the fixture client matrix (`mem0ai@3.1.7` TS, `mem0-cli@0.2.12`, MCP `tools/list`) and add the T1 migration-guide-row tests; keep the honest Python-2.0.19 note.

---

## 6. Open notes / items to close at implementation time (low risk, recorded)

- **MCP tool list truncation:** docs page extraction ended at `update_memory`; verify the exact tool set via live `tools/list` at implementation time and update the fixture (expected: the six listed; typingmind directory shows a larger set from the archived server — authoritative source is the live hosted server).
- **npm `@mem0/mcp` 404:** the docs' `npx -y @mem0/mcp` snippet does not resolve as of 2026-08-29. Not our blocker (we pin the host URL, not their npm package), but flagged as mem0-docs drift.
- **PyPI OSS v3 unpublished:** when `mem0ai` 3.x publishes, re-run the fixture extraction (T4 job) and re-verify the Python conformance path; update anchors.
- **mem0 v3.1.x churn:** npm 3.1.7 shipped 2026-08-24 — contract may move again; the fixture + drift watch is the containment, and the tests are doc-derived precisely because doc anchors are stable.

---

## 7. Smallest next actions

1. **@hermes (not a kanban profile — route via Stevie):** spec §2/§4/§8 resync per §5 of this record (one review pass; content is drafted).
2. **@tech-head (kanban):** after G2 (protocol v0.5.0) lands green, implement `packages/mem0-compat/` skeleton + T1/T2/T3; gate = conformance green before any release tag. Optional reach — never blocks Coffee.
3. **@user:** no decision needed now; this stays optional reach, decoupled, and does not change the G2 cadence. If/when mem0-compat becomes a real GTM lever (e.g. third-party clients asking for a repoint target), the hosting flip trigger in §3 applies.
