# Smartware Company-Brain Substrate Specification

**Status:** v0.7 NORMATIVE · 2026-08-29 · G0 verdict + compile-latency evidence baked in (§11); all §9 decisions closed; supersedes DRAFT (v0.3–v0.6)
**Companion:** `mem0-gap-analysis.md` (this doc is the design contract; that doc is the analysis).
**Product frame:** Coffee — end-to-end SaaS for small service businesses. The mem0-compat surface (§2–§8) is optional ecosystem reach; the Coffee tenant model (§10) is the primary product frame.
**Binding decisions — all CLOSED 2026-08-29:** provenance-at-query-time (spike, §7); client-scope erasure semantics (§10); `add` compile-default (§9.1); FORGET.SCOPE versioning (§9.2); MCP namespace / CLI scope / adapter hosting (§9.3–9.5). G0 spike evidence: §11.

---

## 1. Goals / non-goals

- **Primary goal (Coffee frame):** one small business = one tenant; client-scoped memory the owner can trust and explain (see §10). This is what ships first.
- **Reach goal (optional):** Smartware speaks the mem0 v3 callable surface faithfully enough that a mem0 client (SDK, REST, CLI, MCP) can repoint without code changes — while the substrate underneath remains append-only, bitemporal, and provenance-true.
- **Non-goals:** reimplementing mem0's fuse pipeline, matching its score scale, importing its stored vectors/embeddings, or cloning hosted-only features (orgs/projects dashboard, webhooks, events API) in v0.1.

## 2. Compatibility surfaces (normative set for v0.1)

1. REST, OSS shape (no `/v1/` prefix): `POST /memories`, `GET /memories`, `GET /memories/{memory_id}`, `PUT /memories/{memory_id}`, `DELETE /memories/{memory_id}`, `DELETE /memories`, `GET /memories/{memory_id}/history`, `POST /search`, `POST /reset`, `GET|POST /configure`, `GET /entities`, `DELETE /entities/{entity_type}/{entity_id}`.
2. REST, hosted shape: same routes prefixed `/v1/`.
3. SDK method surface (names + params): `add`, `search`, `get`, `get_all`, `update`, `delete`, `history`, `reset`, `configure`. Params honor: `user_id`, `agent_id`, `run_id`, `app_id`, `filters`, `top_k`, `threshold`, `rerank`, `explain`.
4. CLI: mem0 subcommand names mirroring §3.
5. MCP: mem0 tool names, option-gated namespace on the existing Smartware MCP server.

Auth: accept `Authorization: Token <key>` (hosted shape) and `X-API-Key: <key>` (OSS shape, admins/per-user); map to Smartware's existing grant middleware. `AUTH_DISABLED=true` is never honored (security posture); local dev only.

## 3. The memory identity model (binding)

- A **memory** in compat mode = a **lineage root**, identified by a stable `memory_id` (minted once; never renames, never reused).
- Each content revision = a new L1 **claim** version joined to the root by `supersedes`; the **effective-current leaf** is the claim that is active, not superseded, not corrected, not forgotten.
- Compat reads (`get`, `get_all`, `search` results) resolve to the **effective-current leaf** only. Client-visible `memory_id` is ALWAYS the root.
- History endpoints enumerate the full revision chain under the root, in `version_at` order.

**Byte-clean rule (binding):** superseded, corrected, forgotten, or stale claims MUST NOT appear in `search` / `get` / `get_all` results — this is a *view* rule over the append-only mantle. The mantle never physically deletes; the view never resurrects. (Re-delete-after-update is still a delete; tombstone-on-latest, not tombstone-on-all-versions.) `delete_linked` also retracts derived relation edges (tombstone, not remove) so graph traversal stays evidence-true; the counted set is lineage claims + relations.

## 4. Operation semantics (binding mappings)

| mem0 op | Smartware behavior | Notes |
|---|---|---|
| `add(messages)` | `OBSERVE` raw input; adapter MAY trigger `REFLECT`/`compile` per configuration (`x-compile: on\|off` header / config), default `off` for latency parity | mem0 `add` returns per-extracted-memory ids; our response returns per-claim roots after compile, or a single observation root if compile off |
| `add(raw, content)` | `OBSERVE` with explicit content | body `content` supported (mem0 `content` field) |
| `search` | `RECALL` via L3 hybrid; eligibility filter set runs BEFORE ranking; `filters` map to claim entity-type/attribute filters | `rerank=true` → accepted but degraded (re-rank uses own reranker or documented no-op with `explain` hint); `threshold` accepted, applied on our calibrated score only |
| `update` | `REVISE`: append supersede claim | conflict policy: if old content unchanged, return success idempotently; if `memory_id` unknown → `not_found` |
| `delete` | `FORGET`: retract via tombstone on the current leaf chain root | never physical; history keeps the DELETE event |
| `delete` (with `delete_linked=true`, hosted) | `FORGET`: retract lineage root + **tombstone derived graph links** (relations), never physical removal; report `cascade_count` = exactly the number of retracted lineage claims + retracted links, never silently expanded | `delete_linked` count must be faithful, or clients trusting it mispredict blast radius |
| `delete all` | scope-wide retraction with cascade ack | requires `cascade_required_ack` (protocol); refused without it |
| `history` | materialize {`input` from L0, `old_memory`/`new_memory` from chain, `event` from ops-log, `categories`/`metadata` from claim metadata}; `previous_embedding_*`/`embedding_*` → `null` | never leak vectors |
| `reset` | **LOCKED: snapshot + quarantine** (flag-gated; default denies with `forbidden` unless explicit `x-allow-reset`; snapshot remains restorable) | precedent: mem0 OSS issue #3928 — `delete_all()` called `vector_store.reset()` and wiped *all* users' memories; fixed PR #4349 (merged 2026-03-16). OSS `reset()` is a distinct call from `delete_all()`; both get explicit flag-gated mappings. GTM: "the call mem0 shipped a data-loss bug in is the one we make reversible." |
| `configure` | store provider config for our embed/LLM adapters; unknown providers → `400` with clear code (same as mem0 rejecting unbundled) | `/configure/providers` lists ours only |
| `entities` | derived from Smartware scope/actor registries | cascade delete = scope retraction |

## 5. Scope mapping (binding)

- `user_id` → `user:<id>`; `agent_id` → `agent:<id>`; `run_id` → run/session scope; `app_id` → `workspace`/`project:<id>`.
- Resolution happens at adapter boundary; raw mapping recorded in provenance. One mem0 id may map to multiple Smartware scopes — always resolve explicitly, never default.
- Filter entity IDs (v3 `filters`) → claim entity types + attributes, intersected with caller grants, never widened.

## 6. Scoring contract (binding)

- Scores reported to compat clients are **Smartware's own** (RRF fusion output), normalized; never claimed to equal mem0's fused score.
- `explain=true` supported: return our score components (lexical, semantic, fused) with labels — mem0 clients using `explain` get *more* transparency, same shape.
- **Benchmark reads rank/relevance, not absolute scores** (protocol, already agreed).

## 7. Provenance envelope (CLOSED — spike 2026-08-29)

- **Result @50k claims/obs/ops:** envelope materialization p95 = 0.195ms vs 0.146ms baseline `getClaim` → **+~0.05ms; the envelope is effectively free** (all four fields already inline on the claim row). Default-ON passes; decision gate closes.
- **Landmine (storage note, binding):** resolving ops entry *content* via today's JSONL full scan is p95 ~107ms at 50k ops (~12,800x slower than SQLite PK at 0.008ms). Envelope stays cheap only because `operation_id` is inline. **A derived SQLite ops index (same pattern as Layer0Index over JSONL) is REQUIRED** before `history`/`explain` resolve ops payloads. Tracked as a build prerequisite.
- Payload shape: per-hit `{claim_id, observation_ids, ops_entry_id, version_at}` inside `metadata.origin` (extension field; does not break mem0 clients that ignore unknown metadata).
- Storage delta: provenance is already canonical (no duplication); envelope is a read-path cost, not a write cost.

## 8. Verification plan

- **Compat conformance suite:** golden-response tests per endpoint against a fixture mem0 client (typescript & python SDKs) — responses schema-valid for mem0 clients without edits.
- **Byte-clean tests:** update → search excludes old content; delete → search excludes; history still shows events; re-add after delete creates NEW root, old chain intact; `delete_linked` → `cascade_count` equals actual retracted lineage claims + relations (fidelity, never expansion); relations tombstoned, not removed; `reset` → snapshot restorable, quarantine visible, default deny without `x-allow-reset`.
- **FORGET.SCOPE tests (Coffee §10):** `erasure` → zero `RECALL` results for the client in EVERY lane (vector, BM25, graph); claim rows purged, vector entries removed, derived summaries flagged for re-derivation; ops-log entry carries exact `claims_retracted`/`observations_retracted` counts; grant revocation same commit. `offboarding` → tombstone+revoke, reversible; owner-approved non-PII pointer may carry into `client:<id>#2`; re-opened scope never inherits tombstoned history; `client:<id>#1` marker non-reusable.
- **Provenance-integrity tests:** every search hit can reproduce source observation + ops entry; superseded claims never satisfy `get`; timestamp order correct after multi-version history.
- **Benchmark:** recall@k on curated company-brain query set + provenance-integrity + p95; pin `threshold=0.0`, `rerank=false`, same `top_k`, same embedding model; temporal axis separate (see gap analysis §6.4 — with the correction in §11.1: mem0 OSS as-of is platform-only, so our bitemporal axis is structural, not score-comparable). Concrete G0 suite + numbers recorded in `mem0-h2h-recall.md` (harnesses `scripts/mem0-h2h-{smartware,mem0,compare}.*`, query set `benchmarks/retrieval/mem0-h2h-companybrain-v1.json`).
- **Error-envelope mapping:** mem0 HTTP codes (404/400/401/409/500) ↔ Smartware error codes with `details` preserved.

## 9. Open decisions — ALL CLOSED (history retained; none blocking)

1. `add` compile-default: **RESOLVED 2026-08-29 — sync-raw + async-compile** (smarty-pants, accepted by tech-head). Observations written synchronously to L0 (deterministic, sub-100ms, no LLM on write path); claims compiled in background on a durable queue; retrieval includes raw observations for a state-based window with an `unverified` flag in the RECALL payload contract — "learning in progress", never silent omission; FAILED compile → stays raw-searchable forever with `unverified` (an LLM outage must not age out a memory); EXTRACTED → claim ranks above, obs kept as evidence. Metrics: sync write p95 <100ms; compile p95 ≤5s @50k claims. Compile latency axis added to the spike.
2. FORGET.SCOPE protocol versioning: **RESOLVED 2026-08-29 — protocol v0.5.0 core intent** (smarty-pants): changes conformance semantics (atomicity + same-commit grant revocation + lane-exhaustive purge), so it is NOT an extension slot. v0.4.x servers: backward-compatible on the five verbs, non-conformant on scope-erasure — migration note, not a break (anti-pattern cited: mem0 v2→v3 churn). Protocol doc note: v0.5.0 schemas + contract ship together; mismatch blocks conformance.
3. MCP namespace strategy: **RESOLVED 2026-08-29 — option-gated namespace on the existing Smartware MCP server** (default off; mem0 tool names under a `mem0_`-prefixed namespace when enabled). Avoids a second MCP server's tool-collision + double-init cost; compat is a mode, not a surface.
4. CLI surface scope for v0.1: **RESOLVED 2026-08-29 — mem0-compat CLI ships in the compat package only** (`smartware-mem0-compat`), mirroring SDK subcommands (`add/search/get/get_all/update/delete/history` + flag-guarded `reset`); core `smartware` CLI untouched.
5. Adapter hosting: **RESOLVED 2026-08-29 — separate package `smartware-mem0-compat`** with its own semver, decoupled from protocol (a mem0 surface drift never bumps protocol). Core library stays lean.
6. QM hosting appendix (deferred): `MemoryService` is 11 methods (5 required + 6 optional incl. `readHead?` = sha256-revision CAS); drop-in feasible — capture→OBSERVE/REFLECT, query→RECALL, replace→REVISE; intercept `MAX_FACTS=300` oldest-first eviction at the render layer; QM's `memory/MEMORY.md` file-backed store note (tool-only warning is about agent-side authorship, not storage).

## 10. Coffee tenant binding: client scopes · FORGET.SCOPE (PRIMARY — binding)

**Context:** Coffee = end-to-end SaaS for small service businesses. One business = one tenant. Owner = `owner_id`; staff = `Grant` capabilities over `workspace` (grant middleware already exists). Verified: **zero protocol changes needed — only config shape** (tech-head, code-verified).

- **Clients as scopes, not subjects (binding):** `client:<id>` scopes under `workspace` with `visibility_default: 'scope'`. Scope-boundary leak is fixable by construction; subject+filter isolation is a discipline bug that resurfaces in every new retrieval path. Staff hold grants per client-scope cluster. (Also: 2–10 staff means the §5a promote/demote is a weekly event, not quarterly.)
- **Erasure boundary = client scope (binding):** one audited operation for "client left / disputed / erasure request"; "export everything about Acme" = one scope (portability + data rights + trust).
- **FORGET.SCOPE (substrate-required op, binding):** intent-backed mutation `FORGET.SCOPE { scope: client:<id>, reason: erasure | offboarding }`:
  - plans retraction over all claims + observations in the scope;
  - **one ops-log entry** carrying `claims_retracted` / `observations_retracted` counts;
  - executes **grant revocation in the same commit** (atomic);
  - **reason semantics DETERMINE behavior:** `erasure` (legal/PII) = content purge — claim rows purged, **vector entries removed, derived summaries flagged for re-derivation** (embeddings/summaries are part of the leak surface; post-erasure conformance = zero `RECALL` results in EVERY lane: vector, BM25, graph); `offboarding` = tombstone + grant revoke, auditably reversible;
  - **Non-reusable scope marker:** scope ids are versioned — `client:<id>#1`, `client:<id>#2` — so a returned client can never inherit tombstoned history. `erasure` → fresh scope inherits nothing; `offboarding` → may carry an explicit owner-approved non-PII pointer ("client since 2023, 4 jobs, no disputes") into `#2` — an audited choice, never silent resurrection.
- **Provenance rendering rule (Coffee UI, product rule):** the envelope (≈0.05ms, §7) makes per-answer attribution free. Attribution renders **staff-facing only** — never client-facing UI ("Maya said" is a loyalty liability) — and **by default for consequential or recently-changed facts**, with a "why this answer?" toggle for everything else (avoid footnote-wall).

## 10a. v0.5.0 cut scope — indexes and freshness contract (binding)

- **Observation FTS index (v0.5.0-bound):** `searchObservations` is a full JSONL scan + substring match today (core.ts:665) — the sync-raw freshness promise ("raw is searchable") would cost ~O(N) per RECALL and blow the §7 p95 budget. Raw-searchability requires an observations index (existing claims-FTS + Layer0Index patterns apply).
- **Derived SQLite ops index (v0.5.0-bound, not just a history nicety):** the compile worker's intent matching (`reflect.ts` → `readAllOpLogEntries`) hits the same JSONL scan measured at 107ms p95 @50k ops → compile p95 ≤5s (and history/explain) require it. Both indexes are in the v0.5.0 cut, not follow-up.
- **Compile-queue fingerprint index + batched appends (v0.5.0-bound, G0-backed):** compile @50k measured 9,468,298ms (1,893.7× over the 5s budget; §11.2) — root cause is O(N²) per-claim fingerprint dedup plus per-claim fsync JSONL appends. The compile-queue build MUST also land (a) a fingerprint→claim_id index (hash/SQLite) so dedup is O(1) per claim, and (b) batched claim/ops appends (one fsync per N); then **re-run the compile-latency spike** against the ≤5s @50k budget before G2 closes. §11.2 makes the ±0.1ms/claim arithmetic concrete: 5s / 50k = 0.1ms of work per claim.
- **Freshness payload labels (binding):** the runtime currently does not emit literal `unverified`/`EXTRACTED`/`FAILED` labels — the compile/recall payload contract MUST expose them explicitly (per §9.1) so clients assert state instead of inferring it from search behavior. (§11.2, freshness-validation section.)
- **Freshness window is STATE-based, never time-based:** observation stays raw-searchable (`unverified`) until its compile job resolves — EXTRACTED → claim ranks above it, obs retained as evidence; FAILED → searchable forever with `unverified`; job never resolves → flagged, not hidden. A time window would desync from what durably happened.
- **Rebuild-equivalence conformance (consistency contract):** FTS and ops indexes are regenerable artifacts. v0.5.0 conformance includes wipe-and-rebuild from JSONL asserting byte-level equivalence with the canonical log, and **FORGET.SCOPE "zero results in every lane" is asserted against a REBUILT index** — stale FTS entry = the ghost that resurfaces a purged client; purge proof is only valid if index regeneration is part of the conformance suite.

## 11. G0 spike evidence — verdicts and bindings (CLOSED 2026-08-29)

### 11.1 mem0 head-to-head (record: `mem0-h2h-recall.md`)

**Verdict (pre-agreed decision rule applied): mem0's fused retriever did NOT win. Fix Smartware hybrid internals — never adopt mem0's engine.**

Pinned protocol honored by both engines: `threshold=0.0`, `rerank=false`, `top_k=10`, same embedding model (BAAI/bge-small-en-v1.5 384d via fastembed — exact vector identity by construction), temporal axis separate. 18 scored queries / 33 memories, 1 tenant; mem0 ran with full BM25 path (spaCy + en_core_web_sm), `infer=False` ingest, warm-up excluded from timing.

| Axis | Smartware | mem0 OSS 2.0.19 |
|---|---|---|
| recall@1 / recall@5 / recall@10 | 0.806 / **1.000** / 1.000 | 0.806 / **1.000** / 1.000 (tie — curated set saturates; discriminates ranking/lifecycle) |
| hit@1 | 0.889 | 0.889 (tie) |
| **MRR** | **0.9444** | 0.9352 (+0.93%) |
| **NDCG@10** | **0.9590** | 0.9517 (+0.73%) |
| **Latency p95** (incl. query embedding; same box) | **131 ms** (engine-only 16 ms) | 308 ms (2.35× faster) |
| Provenance integrity | **200/200** hits → observation + ops entry | **none** (payload = data + metadata only) |
| Safety (staff query, sensitive payroll) | **0** forbidden hits (excluded pre-ranking) | 1 forbidden hit (no sensitivity concept in OSS) |
| Temporal axis (as-of / range / current) | **4/4** correct (incl. superseded history) | **N/A** — `reference_date` raises `ValueError` in OSS; platform-only (source + runtime verified). Range has no OSS surface |
| Per-query rank wins | 2 | 1 (15 ties; abstention neutralized by the `threshold=0.0` pin — recorded, not scored) |

**The one mem0 win (q03-entity-owner) is fully explained by two Smartware internals defects — the "fix internals" ruling is correct, not "their engine is better":**

- **D1 (lexical feed):** the RRF lexical channel is built from canonical RECALL order, which is **entity-aggregated** — exact entity-name match ("Project Aster") ranks above claim-level text match ("owns: Project Aster"). Claim-level FTS `searchClaims` ranks the right claim #1 (9.70 vs 6.66) — verified by measurement.
- **D2 (tiebreak):** `fuseHybridRankings` final tiebreak is `id.localeCompare` (alphabetical); semantic_relevance (0.8365 vs 0.7385) would flip the result, and never harms determinism.

**Fix path — BINDING (hybrid internals; prerequisites of any mem0-compat hybrid claims):**

1. Feed claim-level FTS ranks (`searchClaims`) as the RRF lexical channel (or expose a claim-ordered canonical variant for the hybrid lane).
2. Tiebreak `fuseHybridRankings` by `semantic_relevance` desc before `id`.
3. (Follow-up, not binding) candidate_limit / rrf_k / weights sweep via the activation harness — record only.

Expected outcome after 1+2: q03 → rank 1; MRR/NDCG edge widens. Honest caveat in the record: mem0's fused score-mixing is not worse at this task — our edge must come from score-ordering discipline + provenance/safety/temporal/latency, per the design posture (gap analysis §3c). Also corrected: gap analysis §6.4's "temporal ranking" claim is platform-only in OSS practice; our bitemporal axis is structural (see §8).

### 11.2 compile-latency (record: `.spike/compile-latency/README.md`, `report.json`)

| Axis | Result vs target |
|---|---|
| **Sync-raw write** @50k obs | **VALIDATED** — p95 **1.868ms** (p50 1.035, p99 4.829, mean 1.197) vs <100ms; no LLM on write path; raw searchable before compile |
| **Async compile** @50k claims | **INVALIDATED** — **9,468,298ms** vs 5s target = **1,893.7× over** |
| Freshness semantics | **VALIDATED** at 5k/10k/50k and under forced failure (EACCES): raw searchable before compile (unverified), claims queryable after (EXTRACTED), forced failure → zero claims, raw stays searchable (FAILED); correctness asserts `claims_created == N`, `active_claims_after == N` passed at all scales |

- Growth: ms/claim 18.5 @5k → 31.4 @10k → **189.4 @50k** (10.2× for 10× claims = **O(N²)**). The 5s budget implies **≤0.1ms/claim**; current impl is ~3–4 orders of magnitude above — **a data-structure problem, not tuning**.
- Root cause (verified): per-claim fingerprint dedup (`findByFingerprint`/`findSemanticMatch` — scans growing claim log + active-claim set once per claim) plus two fsync-backed JSONL appends per claim.
- Bindings (also in §10a): (a) fingerprint→claim_id index (O(1) dedup), (b) batched appends (one fsync per N), (c) derived ops index is **load-bearing for the compile queue, not optional** — removes per-claim ops/idempotency scans; (d) explicit `unverified`/`EXTRACTED`/`FAILED` labels in the compile/recall payload contract; (e) re-run this spike after the fix before G2 closes.
- Method note: fresh fixture per scale, full `handleCompile` timed (extraction → version writes → L1 sync → L2 compile → search index → manifest), n=1 per scale, 4vCPU/7GB single box, Smartware dist v0.6.3, Node v26.5.1.

## 12. Drafting history

- v0.1 (2026-08-29): initial draft from gap analysis; shape agreed with tech-head (separate doc) / smarty-pants (history contract, byte-clean rule, benchmark protocol).
- v0.2 (2026-08-29): `reset` LOCKED to snapshot+quarantine (precedent mem0 #3928 / PR #4349 per @smarty-pants); `delete_linked=true` mapping added with strict `cascade_count` fidelity; relation edges tombstoned on linked delete; verification extended.
- v0.3 (2026-08-29): Coffee frame adopted (Stevie) — mem0-compat demoted to reach; §7 provenance envelope CLOSED via tech-head spike (≈0.05ms; derived SQLite ops index required for ops payloads); §10 Coffee tenant binding added: clients-as-scopes, FORGET.SCOPE (erasure vs offboarding, lane-exhaustive purge), non-reusable `client:<id>#n` markers, staff-facing attribution rule.
- v0.4 (2026-08-29): FORGET.SCOPE versioning RESOLVED — protocol v0.5.0 core intent (per smarty-pants conformance-semantics test); single ops-log entry + counts, same-commit grant revocation, lane-exhaustive purge are normative for every implementation; v0.4.x gets a migration note (five-verb backward compat, scope-erasure non-conformant).
- v0.5 (2026-08-29): `add` compile-default RESOLVED — sync-raw + async-compile (per smarty-pants/tech-head); v0.5.0 cut scope bound: observation FTS index + derived ops index (both are compile-queue prerequisites, not follow-up), state-based freshness window (`unverified`/EXTRACTED/FAILED semantics in RECALL payload), rebuild-equivalence conformance incl. FORGET.SCOPE against REBUILT indexes.
- v0.6 (2026-08-29): remaining spec items RESOLVED — MCP namespace = option-gated namespace on existing Smartware MCP server (default off); mem0 CLI ships in compat package only; adapter hosting = separate `smartware-mem0-compat` package with own semver. All §9 items closed except deferred QM appendix.
- v0.7 (2026-08-29): **DRAFT → NORMATIVE.** G0 verdicts baked in (§11): mem0 head-to-head — mem0's fused retriever did NOT win (recall@k ties, Smartware leads MRR/NDCG, latency 2.35×, provenance 200/200, safety, temporal); the single mem0 win (q03) traced to Smartware internals defects D1 (entity-aggregated lexical feed) + D2 (alphabetical tiebreak) with concrete BINDING fix path. Compile-latency: sync-raw write p95 1.868ms @50k VALIDATED, async compile 9,468,298ms @50k INVALIDATED (1,893.7× over 5s; O(N²) fingerprint dedup + per-claim fsync) → fingerprint index + batched appends bound to the v0.5.0 compile-queue cut; explicit `unverified`/`EXTRACTED`/`FAILED` labels bound in the compile/recall payload contract; spike re-run required before G2 closes. Records: `mem0-h2h-recall.md`, `.spike/compile-latency/`.
