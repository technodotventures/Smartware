# mem0 Gap Analysis — Smartware ↔ mem0 Surface Mapping

**Status:** v0.1 · 2026-08-29 · Companion to `mem0-substrate-spec-draft.md`
**Question it answers:** To compete with mem0 as a company-brain substrate, what surface must Smartware speak, and what semantic differences can the adapter absorb vs. must the substrate absorb?

Scope note: this is a *competitive/gap* document. The normative design contract lives in `mem0-substrate-spec-draft.md` (separate doc, per architecture-risk constraint).

---

## 1. The migration wedge is the API surface

Verified from mem0's current docs (Aug 2026):

- **Migration trigger = call-site fixes, not data moves.** mem0's own OSS v2→v3 migration guide is a breaking-changes doc (renamed params, entity IDs into `filters`, `top_k` 100→20, threshold default 0.1, score semantics changed). Payloads stay put.
- **Stored format is not portable anyway.** Payloads are store-specific (Qdrant / PGVector / etc.), embeddings are model-specific, BM25 relies on per-store sparse vectors (`fastembed` on Qdrant), and mem0 itself warns Python/TS collections aren't cross-readable on the lemmatized field.
- **Conclusion:** wedge = adapter over mem0's callable surface, with data import as a secondary, lossy path (re-ingest text + thin metadata; never copy vectors).

### Two surfaces, not one

| Surface | Base path | Auth | Notes |
|---|---|---|---|
| Hosted platform (`api.mem0.ai`) | `/v1/` | `Authorization: Token <key>` | SDK default; history at `/v1/memories/{id}/history/` |
| OSS self-hosted server | **no `/v1/` prefix** | `X-API-Key` / Bearer JWT / legacy `ADMIN_API_KEY`, `AUTH_DISABLED=true` (dev only) | history at `/memories/{id}/history`; `/docs` OpenAPI at `/docs` |

The competitor benchmark is the **OSS self-hosted server surface** (that's the installed base), but SDKs speak to the hosted shape. The adapter must normalize both: optional `/v1/` prefix handling + auth-mode detection (Token vs X-API-Key). Note `history` exists on both; only the prefix differs.

## 2. mem0 callable surface → Smartware verbs

### Core memory operations (v3 contract)

| mem0 op | REST (OSS) | Smartware mapping |
|---|---|---|
| `add(messages \| raw)` | `POST /memories` | `OBSERVE` (raw input, `informed_by` where available) → optional `REFLECT`/`compile` to L1 claims. mem0's `add` *extracts* memories via LLM; our analogue is compile, and extraction quality/verb is the **real differentiator to benchmark**, not the endpoint. |
| `search(query, filters)` | `POST /search` | `RECALL` + L3 hybrid. Smartware eligibility (actor/scope auth, sensitive opt-in, forgotten/stale/superseded, epistemic/entity filters) runs **before** ranking — mem0's filters run after a vector hit in the fused pipeline. This ordering difference is a product claim, not a bug. |
| `get(memory_id)` | `GET /memories/{id}` | `READ` claim lineage → **effective-current leaf** only. |
| `get_all(user/agent/run)` | `GET /memories` | `RECALL` by scope; same exclusion rules. |
| `update(memory_id, ...)` | `PUT /memories/{id}` | `REVISE`: append a supersede claim (L1 bitemporal version), **never in-place**. |
| `delete(memory_id)` | `DELETE /memories/{id}` | `FORGET`: retract/tombstone claim (state → `forgotten`), **never physical delete**. |
| `delete_all` | `DELETE /memories` | Scope-wide retraction (cascade preview + ack — see protocol `cascade_required_ack`). |
| `history(memory_id)` | `GET /memories/{id}/history` | Materialize from L1 versions + L0 observations. |
| `reset` | `POST /reset` | mem0 = destructive wipe. Ours: **snapshot + quarantine**, or refuse with an error code — a compat surface that silently nukes the evidence layer is not acceptable. Decision OPEN (see §6). |
| `configure /`entities` | `GET/POST /configure`, `GET /entities`, `DELETE /entities/{type}/{id}` | Smartware accepts configured `EmbeddingAdapter`s; `/entities` derives from scopes/actors. `/configure/providers` will differ (we're not bundled with theirs) — accept-and-degrade, document the difference. |

### Entity scoping (the v3 contract)

- mem0 scopes: `user_id`, `agent_id`, `run_id`, `app_id`, plus `filters` carrying entity IDs.
- Smartware map: `user_id` → `user:<id>` actor (self scope); `agent_id` → `agent:<id>` actor; `run_id` → session/run scope (Smartware `session/` layer); `app_id` → `workspace`/`project:<id>` scope.
- **One-to-many must be explicit:** one mem0 `user_id` may hold multiple Smartware scopes. Always resolve at the adapter boundary and keep the raw mapping in provenance.

### SDK / CLI / MCP

- SDK methods: `add`, `search`, `get`, `get_all`, `update`, `delete`, `history` (plus `reset`/`configure`) — mirror these exactly, including param names (`user_id`/`agent_id`/`run_id`/`app_id`, `filters`, `top_k`, `threshold`, `rerank`, `explain`).
- CLI: subcommand names per SDK; same mapping.
- MCP: mem0 MCP tools (`add_memory`, `search_memories`, etc.) → Smartware MCP verbs. Smartware ships an MCP entry point already — the adapter is a second MCP surface, or option-gated namespaces.

## 3. The three semantic collisions (what the adapter cannot fake)

### a. `memory_id` is not `claim_id`

mem0 contracts `memory_id` as a stable handle through update/delete; a memory's content changes but the id doesn't. Smartware claims are versioned: each revision is a new claim linked by `supersedes`. **Consequence: the adapter must mint a stable `memory_*` lineage identity per memory, and resolve every compat read to the current leaf.** `memory_id` never renames; the leaf changes. Without this, `get(update-then-read)` and `history` break for every mem0 client.

### b. Byte-clean live materialization

Superceded (`supersedes`/`corrects` from a live source claim) and forgotten/tombstoned claims **must be excluded from `search`/`get`/`get_all`** — this is the single red line. If a deleted memory reappears in any compat read, the delete-path contract is broken. This is a *view* rule (materialized eligibility), not a mantle rule: the append-only L0/L1 files never change; the visible state does.

### c. Score semantics

mem0 v3 score = fused semantic+BM25+entity; docs say "retune any hard thresholds." Smartware L3 hybrid = RRF over lexical + semantic, never raw-score mixing. **Compat clients that threshold on score will misbehave if we proxy a foreign scale.** Options: (i) report rank only and document; (ii) ship a calibration surface but never claim parity. Recommend (i) + `explain` passthrough so clients self-tune. Benchmark must measure **rank/relevance vs mem0, never absolute score parity** (agreed protocol).

## 4. History materialization (provenance for free)

`GET /memories/{id}/history` entries: `input` (the conversation that caused the change), `old_memory`/`new_memory`, `event ∈ {ADD, UPDATE, DELETE}`, `categories`, `metadata`.

- Serve `input` from L0 observations (raw, content-addressed).
- Serve `old/new_memory` from supersede/retract chain.
- Return `previous_embedding_*` / `embedding_*` as `null` — never leak vectors (they're model-specific and disposable).
- This is where "verifiable" shows up as a **feature**, not a compliance sticker: history clients already exist and use this endpoint; our version is deeper (observation provenance) for the same call shape.

## 5. Provenance at query time — the binding question (tech-head's constraint)

Smartware claims provenance needs: per-hit lineage (claim → observations → ops-log entry) must be servable **in the compat payload** if "verifiable" is to be the differentiator. Design posture:

- **Eligibility pre-ranking** is already index-time discipline (authorization + lifecycle resolved before scoring).
- Per-hit provenance envelope should be **O(1) pointer chase** (claim rowid → observation ids → ops-log pk), never a scan/join over the whole mantle.
- **Decision rule (from tech-head):** if mem0's fused retriever beats us head-to-head, fix the retriever/hybrid internals, don't adopt their engine.
- **Open:** p95 budget for query+envelope; whether envelope is on-by-default in compat mode (leaning yes — it's the product claim) with a route to disable for pure-speed parity tests. Awaiting tech-head's benchmark spike.

## 6. Open questions

1. **`/reset` semantics** — refuse, snapshot+quarantine, or implement as scope-wide retraction? (Mantle invariant says: never physical nuke.)
2. **`messages`-based `add` extraction** — mem0 runs LLM extraction on add. Our REFLECT/compile is epistemic-autonomy-safe (agent claims enter as bounded hypotheses, user warrant elevates). Does the adapter run compile on `add` (higher latency, deeper semantics) or defer? Product decision; benchmark includes latency envelope.
3. **Threshold/`top_k` defaults** — accept mem0's (0.1 / 20) as compat defaults even though our scoring scale differs? Default = accept-and-document.
4. **Temporal ranking axis** (`reference_date`, `expiration_date`) — mem0 v3's temporal ranking is a real advantage; keep as a separate benchmark axis (already agreed). Our bitemporal model (valid-time/transaction-time) is the structural answer; ranking formula is open.
5. **`/entities` + cascade delete** — derive from scopes; cascade delete maps to scope-wide retraction (with `cascade_required_ack`).
6. **Data import** — re-ingest memory text + `metadata` + (where present) `input` histories; never copy vectors. Lossy, secondary. Importing `update`/`delete` history events must **preserve the event chain** (replay as revise/forget in order), or history looks sane but evidence is wrong.

## 7. Do-not-fake list

- Do not fake mem0 score scales.
- Do not fake embedding model lineage (`embedding_gpt-4o` etc. → null).
- Do not emulate `add` LLM extraction by pretending; if compile is off, it's off and documented.
- Do not expose `/v1/` on OSS-only installs without a documented normalization layer.

## 8. Sources

- mem0 docs: `/api-reference`, `/open-source/features/rest-api` (fetched 2026-08-29)
- mem0 OSS v2→v3 migration guide (breaking-changes summary, Aug 2026)
- Smartware Spec v1.6.16, Protocol v0.4.2, `docs/retrieval.md` (canonical + semantic + hybrid, eligibility-before-ranking, verification contracts)
