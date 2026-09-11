# Smartware ↔ mem0 Head-to-Head: recall@k · ranking · provenance · p95

**Status:** COMPLETE (G0 exit) · 2026-08-29 · Owner: @tech-head
**Gates:** G0 verdict + numbers recorded. Pre-agreed decision rule applied: *if mem0's fused retriever wins, fix our retriever/hybrid internals — never adopt their engine.*
**Result:** **mem0's fused retriever did NOT win.** Ties on every recall@k; Smartware wins ranking (MRR, NDCG), latency (~2.3×), provenance, safety, and the temporal axis (mem0 OSS cannot do as-of at all). mem0 won exactly **1 of 18** scored queries, and that loss is **fully explained by two identifiable Smartware internals defects** with a concrete fix path (mechanism verified below). Per the decision rule, this is a **fix our internals** verdict — no engine adoption.

---

## 1. Verdict (decision rule applied)

| Axis | Smartware | mem0 (OSS 2.0.19) | What it means |
|---|---|---|---|
| recall@1 / recall@5 / recall@10 | 0.806 / **1.000** / 1.000 | 0.806 / **1.000** / 1.000 | Tie. At this curated n (18 scored queries, 33 memories) recall saturates; the corpus does not discriminate on recall. |
| hit@1 | 0.889 | 0.889 | Tie |
| **MRR** | **0.9444** | 0.9352 | Smartware +0.93% |
| **NDCG@10** | **0.9590** | 0.9517 | Smartware +0.73% |
| pass_rate (strict: forbidden/obsolete/abstention) | **0.85** | 0.80 | Both fail the 2 abstention cases (pin artifact, §4); mem0 additionally fails q04 (obsolete) — q06 strict-forbidden fails both. |
| forbidden_hits / obsolete_hits | 2 / **0** | 3 / **1** | mem0 surfaces the superseded March pricing on "current" query (no effective-current view) |
| Per-query rank wins (RR) | **2** | 1 | 15 ties. mem0's only win: q03-entity-owner (explained, §6) |
| **Latency p95 (steady-state, incl. query embedding)** | **131 ms** (engine-only p95 16 ms) | 308 ms | 2.35× faster; same box, same model |
| Provenance-integrity | **200/200 hits** → observation + ops entry | **none** (payload = data + metadata only) | the product differentiator holds |
| Safety: staff query for sensitive payroll | **0 forbidden hits** (payroll excluded pre-ranking) | **1** (payroll surfaced; no sensitivity concept in OSS) | eligibility-before-ranking = real |
| Temporal axis (as-of / range) | **4/4 expected hits** (incl. superseded history via canonical RECALL) | **N/A** — `reference_date` raises `ValueError` ("Platform-only temporal parameter. Not supported in OSS.") — verified in source (`mem0/memory/main.py:1432-1433`) and at runtime; range constraints have no OSS surface | Our bitemporal axis is a structural advantage, not a score comparable in this engine |

**Decision: do not adopt mem0's engine. Fix Smartware's hybrid internals — two defects found, both with verified mechanisms (see §6).**

---

## 2. Protocol adherence (pins)

All pins honored literally:

| Pin | How |
|---|---|
| `threshold=0.0` | Smartware: `min_similarity: 0.0` in `recallHybrid`; mem0: `threshold=0.0` in `search` |
| `rerank=false` | Smartware has no reranker (not configurable in this path); mem0: `rerank=False` (its default) |
| same `top_k` | **10** for both (`limit: 10` / `top_k: 10`) |
| same embedding model | **BAAI/bge-small-en-v1.5 (384 dims) via fastembed — literally the same library and weights for both engines.** Smartware consumes precomputed fastembed vectors (`.spike-h2h/vectors-fastembed.json`); mem0 computes in-process with the same fastembed `TextEmbedding`. Vector identity is exact by construction — the head-to-head isolates retrieval/fusion engines, not embedding infra. |
| temporal axis SEPARATE from recall@k | Recall axis: temporal-agnostic queries via hybrid. Temporal axis: `temporal_queries` evaluated separately (see §5). |

**Fairness controls (documented, not hidden):**
- **Identical index strings.** mem0's stored memory text = Smartware's claim semantic text (`subject\npredicate: value`) — taken from the same claim fields. The comparison is engine-vs-engine, not representation-vs-representation.
- **Same fact set.** One fact = one claim = one memory. mem0 ingest used `infer=False` (raw add, no LLM extraction) so we measure **retrieval**, not their extraction LLM. mem0's LLM (extraction/add) and reranker are deliberately excluded, like ours.
- **mem0 ran with its full BM25 path**: spaCy + `en_core_web_sm` installed (first run silently no-ops lemmatization without spaCy — a degraded-engine run would be unfair; final numbers are with spaCy).
- Warm-up pass before timing (mem0's lazy spaCy/entity-store cold start excluded); Smartware engine-only p95 reported separately from end-to-end (query embedding time added from the same fastembed run).
- mem0 OSS local qdrant (`path` mode, no server) — payload-index warning noted; the 33-memory corpus makes index internals immaterial. Entity-boost component is effectively inert here (no entity memories were added — mem0's entity store is for its own extraction flow).

---

## 3. Method

- **Corpus + query set:** `benchmarks/retrieval/mem0-h2h-companybrain-v1.json` (single source of truth for both engines).
  - Tenant: Nova Studio (small service business), 33 claims across clients/projects/pricing/incidents/procedures/sensitive-payroll/noise; bi-temporal fields; 2 superseded chains (pricing, Rivertown scope); 1 sensitive claim.
  - 20 recall-axis queries (exact / paraphrase / entity / current / multi_hop / procedural / negative / safety) + 4 temporal-axis queries (as_of × 2, range × 1, current × 1).
  - Ground truth authored per fact (expected ids = claim ids).
- **Smartware:** `scripts/mem0-h2h-smartware.mjs` — real product path: `SmartwareCore.open` → L0 `observe` (evidence + ops entries) → L1 claims (ground-truth controlled) → `syncSearchFromClaims` (FTS) → `syncSemanticIndex` (fastembed vectors) → `recallHybrid` per query (owner; staff actor for q20) → canonical `recall` for temporal queries → provenance resolution per hit (claim → observation ids + ops entry).
- **mem0:** `scripts/mem0-h2h-mem0.py` — `Memory(config)` (qdrant local, fastembed bge-small-en-v1.5, infer=False ingest), fused `search` per query with the pins.
- **Scoring:** `scripts/mem0-h2h-compare.mjs` — reuses the official `evaluateRetrievalArena` so both channels are computed by the same metric code.
- **Artifacts:** `.spike-h2h/results-smartware.json`, `.spike-h2h/results-mem0.json`, `.spike-h2h/head-to-head-report.json`.

---

## 4. Results — recall axis (per-query ranks)

| Query | Category | Smartware rank | mem0 rank | Winner |
|---|---|---|---|---|
| q01 exact-deadline | exact | 1 | 1 | tie |
| q02 paraphrase-editor | paraphrase | 1 | 1 | tie |
| q03 entity-owner | entity | 2 | **1** | **mem0** (§6) |
| q04 current-pricing | current | 1 | 1 (obsolete hit: march surfaced) | tie / lifecycle: SW |
| q05 client-brief | entity | 1 | 1 | tie |
| q06 overdue-invoice | entity | 1 | 2 | **SW** (both forbidden-hit the two other invoice claims — ground truth is deliberately strict; see §7) |
| q07 contact | entity | 1 | 1 | tie |
| q08 availability | paraphrase | 1 | 1 | tie |
| q09 supplier | exact | 1 | 1 | tie |
| q10 multihop-accountable | multi_hop | 1 | 1 | tie |
| q11 client-summary | multi_hop | 1 | 1 | tie |
| q12 offboard | procedural | 1 | 1 | tie |
| q13 backup-verify | procedural | 1 | 1 | tie |
| q14 rivertown-balance | entity | 2 | 3 | **SW** (both rank the scope claims above the invoice; SW closer, and SW does *not* surface the superseded `c_rivertown_before` at #2 like mem0) |
| q15 bloom-manager | entity | 1 | 1 | tie |
| q16 paraphrase-delivery | paraphrase | 1 | 1 | tie |
| q17 aster-kickoff | exact | 1 | 1 | tie |
| q18 tom-site | exact | 1 | 1 | tie |
| q19 negative | negative | n/a (both return junk) | n/a | abstention neutralized by pin (§6c) |
| q20 safety-payroll-staff | safety | 0 forbidden | 1 forbidden (payroll leaked) | **SW** |

Aggregate (official evaluator, 18 scored): see §1 table. **Abstention note:** under the pinned `threshold=0.0`, neither engine can abstain (scores are never filtered); both returned identical junk top-5 for q19 — expected protocol behavior, recorded not scored.

---

## 5. Temporal axis (separate, per protocol)

All four temporal queries evaluated on Smartware only (mem0 N/A — verified):

| Query | Constraint | Smartware top hits | Result |
|---|---|---|---|
| tq1 pricing-may | as_of valid_time 2026-05-15 (incl. superseded history) | `c_pricing_march` first, `c_canvas` 2nd | ✅ expected #1; current excluded |
| tq2 incidents-june | range valid_time 2026-06-01→07-01 | `c_incident_2`, `c_incident_1` | ✅ both expected; July incident excluded |
| tq3 rivertown-before-aug | as_of 2026-07-15 (incl. superseded) | `c_rivertown_before` | ✅ #1; post-Aug version excluded |
| tq4 current-pricing | current at 2026-08-29 | `c_pricing_current` | ✅ #1; march excluded |

mem0 OSS: `reference_date` supported **only on the hosted platform**; OSS raises `ValueError` (source-verified `mem0/memory/main.py:1432-1433`, runtime-verified). No range/valid-time surface at all. Note: mem0's owned ability related to time is `expiration_date` (TTL) — a different concept; not benchmarked here, flagged for the adapter (gap analysis §6.4's "temporal ranking" claim is platform-only in OSS practice).

---

## 6. q03-entity-owner: the single mem0 win — exactly why "fix internals" is the right ruling

Query: *"Who owns Project Aster?"* → expected `c_deliverable_aster` ("Cloudpeak Realty / owns: Project Aster"). mem0 rank 1. Smartware rank 2 (`c_aster_schedule` first).

**Mechanism, with measurements (`.spike-h2h/q03-rootcause.mjs`, `q03-canonical.mjs`):**

1. Our **semantic lane ranked it correctly**: `c_deliverable_aster` cosine **0.8365** (#1) vs `c_aster_schedule` 0.7385 (#2) — same model, same vectors mem0 uses.
2. Our **claim-level lexical lane also ranked it correctly**: FTS `searchClaims` puts `c_deliverable_aster` #1 (rank 9.70) vs `c_aster_schedule` #2 (6.66).
3. **The hybrid's lexical input is the canonical RECALL result order**, which is **entity-aggregated**: canonical ranked entity "Project Aster" #1 (score 0.844 — exact entity-name match) and its payload claim `c_aster_schedule`; entity "Cloudpeak Realty" #2 (0.775) → `c_deliverable_aster`.
4. RRF (k=60, equal weights): deliverable = sem1+lex2, aster_schedule = sem2+lex1 → **exact score tie** → tiebreak cascade: equal channel counts, equal bestRank → **`id.localeCompare`** → `c_aster_schedule` < `c_deliverable_aster` alphabetically.

**Two defects (both are "retriever/hybrid internals in Smartware" — exactly the class the decision rule targets):**

- **D1: Entity-aggregated lexical feed.** The RRF lexical channel is built from canonical RECALL result order, which ranks *entities* (and returns the entity's representative claim). Entity-name matches ("Project Aster") outrank claim-level text matches ("owns: Project Aster"). Fix: feed claim-level FTS ranks (`searchClaims`) as the hybrid lexical channel — verified to put `c_deliverable_aster` #1 here.
- **D2: Non-semantic tiebreak.** `fuseHybridRankings` final tiebreak is `id.localeCompare` (alphabetical). Fix: tiebreak by `semantic_relevance` descending (then id) — on q03 this alone flips the outcome to a win, and it never harms determinism.

**Expected outcome after D1+D2:** q03 → Smartware rank 1; MRR/NDCG edge widens beyond 1%. Nothing here suggests adopting mem0's engine; its rank-1 on q03 is its fused scoring (dense + BM25 on *memory text*, no entity aggregation) handling a case our own internals broke. Also honest: mem0's strong q03 ranking does show their fused **score-mixing** pipeline is not worse at this task; our advantage must come from score-ordering discipline + everything else (provenance, safety, temporal, latency) — per the design posture in gap analysis §3c.

**Post-fix re-run (2026-08-30, dist v0.6.3 + D1/D2, same pins, same vectors):** q03 → **Smartware rank 1 ✅** (`c_deliverable_aster` lex#1 (FTS 9.70-style) + sem#1 (0.8365), RRF 0.032787 vs 0.032258 — no tie at all after D1; the alphabetical id.tiebreak is gone from hybrid.ts:179). Per-query: q03 now a **tie** (both rank 1), `q06-overdue-invoice` flipped to rank 2 (was 1), all other queries unchanged — **mem0 wins 0, Smartware wins q14 only, 17 ties** (was 2-1-15). Aggregate: **MRR 0.9444 / NDCG@10 0.9590 — unchanged** (q03 gain ΔRR +0.5 exactly cancels q06 loss −0.5 at this n). **Why q06 flipped (mirror image, not a fix regression):** on "Which client has an overdue invoice?" the two channels *disagree* — `c_bloom_invoice` lex#1 / sem#2 (0.7890), `c_incident_2` lex#2 / sem#1 (0.8063) → exact RRF tie, and the D2 tiebreak correctly picks the semantic channel's leader, which is *wrong* for this query (semantic-noise: 0.017 cosine gap). q06's pre-fix rank-1 was alphabetical luck ('bloom' < 'incident'), the same luck that broke q03. **Honest status: the "MRR/NDCG edge widens beyond 1%" expectation is NOT demonstrated at n=18** (edge stays +0.93%/+0.77%); the fix ships as bound (principled tiebreak ≥ alphabetical luck), and the measured next knob for q06-style exact-tie cases is the **RRF weights sweep (spec §11.1 item 3, non-binding follow-up)** — a lexical_weight > semantic_weight profile breaks the q06 tie in favor of `c_bloom_invoice` (lex#1 → 2/61+1/62 vs 2/62+1/61) while preserving q03's D1 win.

---

## 7. Honest caveats (do not over-read)

1. **Small, curated n.** 18 scored queries, 33 memories, 1 tenant. recall@k saturates at 1.0 for both — this set discriminates ranking and lifecycle, not recall. Directionally meaningful; statistically thin. A 100-500 query multi-tenant corpus (mirroring GBrain's eval shape per corpus map) is the natural next benchmark; GBrain-numbers-parity goal from gap analysis stands.
2. **Abstention is impossible under the pin.** Both engines return garbage for q19 (identical junk sets — same embeddings). The `threshold=0.0` pin was pre-agreed; abstention quality is a separate axis with its own threshold to test.
3. **Ground truth strictness on q06/q14.** The two "related invoice" claims (rivertown due, acme paid) were authored as forbidden for the overdue query — both engines surface them; that's a fair strictness choice but means q06 failures are shared ground-truth strictness, not retrieval error. Both engines rank `c_bloom_invoice` #1 or #2.
4. **No LLM extraction, no rerank, no filter complexity on either side by design** (pins). mem0's `add`-time extraction and hosted-only features are out of scope for this spike; extraction quality remains the separate differentiator (spec §2/§9).
5. **Embedding time is shared/rounded.** Both engines' p95 include query embedding of the same model; Smartware's is the recorded fastembed time (no subprocess); mem0's is in-process. Neither includes network (all local).
6. **Memory scale.** p95 is measured at 33 memories, not 50k. The compile-latency axis at 50k is the sibling spike (→ G1); the ops-index requirement from spec §7 (derived SQLite ops index; JSONL full-scan ≈107ms p95 @50k) is unaffected and still stands.

---

## 8. What this changes (spec/plan knock-on)

- **G0 verdict: overall WIN by Smartware (ranking + every non-ranking axis), honest loss on q03 with verified fix path.** Per the pre-agreed rule: **fix our internals — never adopt mem0's engine.**
- **Fix path (bind into spec v0.6 as internal-requirements):**
  1. RRF lexical channel from claim-level FTS (`searchClaims`) instead of entity-aggregated canonical order — or expose a claim-ordered canonical variant for the hybrid lane.
  2. `fuseHybridRankings` tiebreak: `semantic_relevance` desc before `id.localeCompare`.
  3. (Optional, untested at this n) candidate_limit/rrf_k/weights sweep with the activation harness (`evaluate-retrieval-activation.mjs`) — record as follow-up, not binding.
- **Spec v0.6 §8 (verification plan)** already pins this benchmark protocol; the query set + harnesses are now concrete: `benchmarks/retrieval/mem0-h2h-companybrain-v1.json`, `scripts/mem0-h2h-{smartware,mem0,compare}.*`, run commands below. G1 should bake the verdict + fix path into the spec and mark the two internals fixes as prerequisites of any mem0-compat hybrid claims.
- **Temporal axis claim from gap analysis §6.4 must be corrected:** mem0 OSS has NO as-of/valid-time query surface (verified source + runtime); platform-only. Our bitemporal support is unique at the substrate level — tighten the wording in the spec.

## 9. Reproduce

```bash
# 1. vectors (fastembed bge-small-en-v1.5; same library+model both engines)
/opt/data/venvs/mem0-h2h/bin/python .spike-h2h/vectors-fastembed.py
# 2. Smartware (build first: npm run build)
node scripts/mem0-h2h-smartware.mjs
# 3. mem0 OSS
/opt/data/venvs/mem0-h2h/bin/python scripts/mem0-h2h-mem0.py
# 4. comparison (official evaluator)
node scripts/mem0-h2h-compare.mjs
```

Environment: mem0ai==2.0.19 (+fastembed 0.8.0, qdrant-client 1.19.0, spacy 3.8.16 + en_core_web_sm), Node v26.5.1, Smartware dist v0.6.3.
