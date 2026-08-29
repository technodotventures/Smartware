# Smartware → Coffee Company Brain: Execution Plan

**Status:** v2 · 2026-08-29 · Source material: `mem0-substrate-spec-draft.md` (v0.7 NORMATIVE), `mem0-gap-analysis.md`, corpus entries (`gbrain-company-brain.md`, `qm-memory.md`)
**Product frame:** Coffee — end-to-end SaaS for small service businesses. One business = one tenant.

**Decision state:** all strategic questions RESOLVED (see spec §7, §9, §10, §10a). G0 spike COMPLETE (verdict + both axes recorded); no blocking unknowns remain; the rest of the plan is sequence plus the G2 conformance gate.

---

## Gates

### G0 — Spike completion — owner: @tech-head — **COMPLETE 2026-08-29**
- mem0 head-to-head recall comparison: recall@k on curated company-brain query set + provenance-integrity + p95.
- Pinned protocol: `threshold=0.0`, `rerank=false`, same `top_k`, same embedding model; temporal axis **separate** from recall@k.
- Metric: rank/relevance vs mem0, never absolute score parity.
- Added axis: compile latency (sync-raw + async-compile target: sync p95 <100ms, compile p95 ≤5s @50k claims).
- **Decision rule (pre-agreed):** if mem0's fused retriever beats us head-to-head, the fix is our retriever/hybrid internals inside Smartware — never adopting their engine.
- **Exit:** numbers in + verdict recorded; NOT "all green" — an honest loss with the fix path is also an exit.
- **Result (record: `mem0-h2h-recall.md`, `.spike/compile-latency/`):**
  - Head-to-head — **mem0's fused retriever did NOT win.** recall@k ties (1.0@5 both); Smartware leads MRR 0.9444 vs 0.9352, NDCG@10 0.9590 vs 0.9517, p95 latency 131ms vs 308ms (2.35×), provenance 200/200 vs none, safety 0 payroll leaks vs 1, temporal 4/4 correct vs N/A. mem0 won 1/18 (q03) — fully explained by two verified Smartware internals defects (D1 entity-aggregated lexical feed, D2 alphabetical tiebreak) with a BINDING fix path (spec §11.1). **Verdict: fix internals, never adopt engine.**
  - Compile-latency — sync-raw write p95 = **1.868ms** @50k obs (target <100ms, VALIDATED, no LLM on write path); async compile p95 = **9,468,298ms** @50k claims (target ≤5s, INVALIDATED — 1,893.7× over) with root cause pinned to O(N²) per-claim fingerprint dedup + per-claim fsync appends; freshness semantics validated at scale and under forced failure (spec §11.2).

### G1 — Spec final — owner: @hermes (spec + corpus), @smarty-pants (GTM/relevance framing) — **spec side COMPLETE 2026-08-29 (v0.7 NORMATIVE); remaining: corpus sync + GTM framing (@smarty-pants)**
- Spec moves from DRAFT to normative: closes remaining small items (MCP namespace, CLI scope, adapter hosting) and bakes in G0 verdict.
- Corpus entries carry "Relevance axis: Coffee frame" (smarty-pants) + any G0-derived adjustments.
- **Exit:** spec version bump + corpus sync, reviewed by both.

### G2 — v0.5.0 release (FORGET.SCOPE + both indexes + compile-queue fixes) — owner: @tech-head (impl), @hermes (spec/conformance)
- Protocol v0.5.0 core intent: FORGET.SCOPE w/ erasure|offboarding, one ops-log entry + counts, same-commit grant revocation, lane-exhaustive purge (vector/BM25/graph + derived summaries), non-reusable `client:<id>#n` markers.
- Cut scope (bound, not follow-up): **observation FTS index** + **derived ops index** (compile-queue prerequisites; the G0 compile spike makes the ops index data-backed load-bearing, not optional).
- **Compile-queue fixes (v0.5.0-bound, G0-invalidated):** fingerprint→claim_id index (hash/SQLite, O(1) dedup) + batched claim/ops appends (one fsync per N) + explicit `unverified`/`EXTRACTED`/`FAILED` labels in the compile/recall payload contract. **Re-run the compile-latency spike after the fix** — compile ≤5s @50k is a G2 exit condition, not a review comment.
- Clients-as-scopes config shape lands with it: `client:<id>` under `workspace`, `visibility_default: 'scope'`, staff via Grant capabilities.
- sync-raw + async-compile write path + state-based freshness (`unverified` / EXTRACTED / FAILED).
- Hybrid retrieval fixes D1+D2 (spec §11.1: claim-level FTS lexical feed; semantic_relevance-desc tiebreak) land in the same cut — they are prerequisites of any mem0-compat hybrid claims.
- **Conformance suite (must pass):** rebuild-equivalence (wipe/rebuild from JSONL, byte-equal to canonical log); FORGET.SCOPE "zero results in every lane" asserted against **rebuilt** indexes; erasure/offboarding semantics tests; provenance-integrity tests.
- v0.4.x migration note (five-verb backward compat; scope-erasure non-conformant) — never a break (anti-pattern: mem0 v2→v3 churn).
- **Exit:** conformance green + migration note shipped + compile-latency spike re-run green (≤5s @50k).

### G3 — Slot against Coffee's release window — owner: @user decision
- After G2, plan the client-scope UX: staff-facing attribution rendering ("learned from Maya, May 12; corrected May 13" — default for consequential/recent facts; "why this answer?" toggle), erasure/offboarding flows, export-one-client portability.
- No dates until Coffee's window is known.

---

## Ownership map

| Area | Owner |
|---|---|
| Spec (design contract) + corpus entries | @hermes |
| Spike / measurements / implementation | @tech-head |
| GTM + relevance framing, corpus verification | @smarty-pants |
| Dates, priorities, Coffee window | @user |

## Out of scope (this plan)

- mem0 data import beyond the secondary lossy path (re-ingest text + thin metadata; never vectors).
- mem0-compat adapter release (optional reach, own versioning, decoupled from protocol).
- QM hosting appendix (deferred; interface verified, 11 methods, sha256-CAS via `readHead?`).
- Self-hosted company-brain product (GBrain Model A shape) — Coffee is the product; that shape is not.

## Known risks (with mitigations already bound)

| Risk | Mitigation |
|---|---|
| LLM outage during compile → memory silently ages out | State-based freshness: FAILED stays raw-searchable forever with `unverified`; never time-based expiry |
| Stale index ghost resurfaces purged client | Rebuild-equivalence conformance; purge asserted against rebuilt indexes |
| Compile latency blows p95 at 50k | **CONFIRMED DATA-BACKED (G0): 1,893.7× over at 50k, O(N²) fingerprint dedup + per-claim fsync.** Mitigation: both indexes + fingerprint→claim_id index + batched appends in the v0.5.0 cut (not follow-up); spike re-run green is a G2 exit condition |
| Head-to-head retrieval loss vs mem0 | **G0 verdict: mem0 did NOT win (1/18, fully explained).** Fix path D1+D2 bound in spec §11.1 as v0.5.0-scope prerequisites; never adopt their engine |
| Tenant/small-business scale (2–10 staff, constant churn) | Client scopes + FORGET.SCOPE erasure/offboarding as weekly ops, audited |
| Mem0-compat adapter drifts from protocol | Separate `smartware-mem0-compat` package with own semver, decoupled from protocol v0.5.0 |

## Source of truth

`docs/competitive/mem0-substrate-spec-draft.md` — this plan defers to it on every technical binding; if they conflict, the spec wins and this file gets updated.