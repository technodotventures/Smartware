# Research Corpus Entry: QM (yc-software/qm) — Memory Design

**Status:** TRACKED (Assess — validation signal + potential host surface)
**Scanner:** @smarty-pants (independent re-verify of @hermes/@tech-head findings via GitHub raw + API)
**Scan time:** 2026-08-29 (UTC)
**Sources covered:** README.md (raw, main branch), GitHub API repo metadata, `src/memory/` contents, `src/memory/strategies/` contents, `src/memory/memory-service.ts` (raw, main, sha d52e3af)
**Important gaps:** NOT read: `src/memory/bench.ts` itself, `notebook.ts` details beyond imports, `postgres-memory-service.ts` body, `strategy.ts`, `policy.ts`, QM docs mentioning "Memory is NOT a file" (quote reported by @hermes; NOT independently located), `wiring.ts` swap site (reported by @tech-head: `wiring.ts:584`).

## Repo metadata (GitHub API, fetched 2026-08-29)

- `yc-software/qm`: 14,314 stars / 1,720 forks, MIT, TypeScript, created 2026-07-29, pushed 2026-08-28, homepage x.com/qm__dev. "Multiplayer agent harness for work."
- README confirms: per-person and per-room scoped memory; "Every substrate (harness, session store, sandbox, memory) sits behind an interface, so production implementations swap in via one wiring file." — **no GBrain/mem0 paths** per @hermes tree check (not re-verified here).
- README also promises "Retrieve information from your company brain" — YC now ships company-brain as a product promise in two products (QM and GBrain).

## Verified findings (primary source)

1. **Module structure confirmed:** `src/memory/` = `bench.ts`, `memory-service.ts`, `notebook.ts`, `policy.ts`, `postgres-memory-service.ts`, `strategy.ts`, `strategies/` (dir). Strategies dir = `agent-only.ts`, `consolidation.ts` (7.2KB), `per-turn.ts` (6.2KB), `scratch-promote.ts` (9.9KB) — matches "four strategies".
2. **MemoryService interface (correction):** declared methods are **11, not 10** — 5 required (`recall`, `capture`, `query`, `read`, `replace`) + 6 optional (`readHead?`, `replaceIfRevision?`, `history?`, `restore?`, `updatedAt?`, `metadata?`). @tech-head's list omitted `readHead`; it is the counterpart to `replaceIfRevision` (sha256 revision token over canonical `memory/MEMORY.md` content) — i.e., CAS-by-revision, not CAS-by-version. File-backed `createMemoryService` implements 7 of them (recall/capture/query/read/replace/readHead/replaceIfRevision).
3. **Capture logic is deterministic, not LLM** (memory-service.ts `foldCapture`): normalizes bullets, dedupes against existing normalized bullets, stamps `- (YYYY-MM-DD) fact`, and — with `MAX_FACTS = 300` — **drops OLDEST bullets on overflow**. This is their entire retention/expiry story: silent oldest-first eviction, no TTL, no bitemporal supersession, no tombstone.
4. **Provenance is textual and shallow:** untrusted facts carry `[claimed source: X]` (from `said in X` and the "on DATE:" prefix); `cc:`-authored cross-room capture writes to the actor's personal scope with `[said in <source>]` tagging and `trustedProvenance=true`. No structured provenance, no author identity beyond an optional `author` string, no derivation chain.
5. **Storage:** file-backed default stores under `memory/MEMORY.md` in the scope workspace (workspace.read/write/remove); `postgres-memory-service.ts` is the alternate backend — consistent with "swap via one wiring file." The "Memory is NOT a file" claim (reported by @hermes) pertains to agent-side MEMORY.md authorship being silently lost, not to storage being non-file — verify the source doc before citing it literally.
6. **Bench:** `src/memory/bench.ts` exists (5.8KB). Per @tech-head clone verification: 6 fixtures (not 5), **LLM-judged** (JUDGE_PROMPT + one-shot judge; signal-to-noise/staleness/inference-vs-observation subjective scores; NO gold labels) — so NOT usable as a deterministic recall@k corpus for our spike. `stale-fact-supersession` + `secrets-exclusion` fixtures worth porting as conversation fixtures for a curation-quality axis (these claims rest on @tech-head's clone inspection; file contents not read by me).

## What this means for Smartware

- **Epistemic-model white space is intact, and now double-confirmed:** the strongest YC-adjacent evidence yet (GBrain AND QM, both MIT, both shipping "company brain" language) that even high-profile in-house memory systems keep NO claims layer, no bitemporal versions, no provenance chain. Our L0–L4 evidence layer remains the only tested-differentiator candidate.
- **QM as a host is feasible:** interface is narrow (5 core methods), backend-agnostic, and a Smartware-backed impl can map capture→OBSERVE/REFLECT, query→RECALL, replace→REVISE lineage while keeping their `read`/`replace` semantics (rendered bullet notebook) on top of the mantle. Because their revision CAS is a sha256 over the **rendered** notebook, our implementation can emit the same tokens without exposing claim IDs — a clean drop-in. Costs to watch: (a) their capture's oldest-first eviction at MAX_FACTS=300 must be intercepted or it will delete mantle *i.e.* view — eviction should target rendered bullets, never claims; (b) their textual `[claimed source: X]` attribution is weaker than our structured provenance — in drop-in mode it remains a compat rendering, not a replacement.
- **Notebook-vs-mantle renders again:** they chose server-owned notebook (governance, no portability); we chose file-based canonicals + portability. For a company brain, portability is the stronger promise — and the QM corpus gives us a concrete counterfactual: their "consolidation" is a strategy with no durable record of what was consolidated.
- **Eval axis:** their bench (LLM-judged) and mem0's bench (platform-only numbers) both fail our deterministic spike; Smartware's kernel-contract fixtures with `expected_id` remain the right tool. Port QM's `stale-fact-supersession` and `secrets-exclusion` as curation-quality conversation fixtures.

## Confidence

- Repo metadata, module layout, interface shape, foldCapture/MAX_FACTS, file-backed default: **facts** (primary source, verified).
- Strategies semantics, bench fixture count/LLM-judging, wiring.ts:584: **reported by @tech-head via clone; consistent with structure I verified; file-level re-verification pending.**
- "Memory is NOT a file": quote not located by me — **sourced claim**, verify before strategic use.

## Relevance axis: Coffee frame (updated 2026-08-29)

Coffee = end-to-end SaaS for small services businesses (1 tenant = 1 business, owner-admin, 2–10 staff, clients as memory subjects). Re-scored:

- **QM is the closest structural cousin** (scoped durable memory, capture policy, consolidation, supersession-aware fixtures, MIT) — and the strongest evidence that even YC's in-house design keeps no evidence layer. Use as: (a) host-surface proof for a drop-in (`MemoryService` = 5 core methods; Smartware backend feasible with 0 contract changes), (b) fixture source for curation quality (`stale-fact-supersession`, `secrets-exclusion`), (c) anti-model for their design flaws.
- **Anti-models for Coffee:** MAX_FACTS=300 oldest-first silent eviction (their only retention semantics — a 15-person shop's client notes MUST NOT silently age out: Coffee needs explicit TTL + expiry + correction story); textual `[claimed source: X]` as the entire provenance model (we ship structured provenance + plain-language rendering); wholesale notebook `replace` with no derivation (we retain lineage via REVISE); server-owned notebook with no portability (ours: file-based canonicals + export).
- **Irrelevant to Coffee:** per-scope governance/admin-gating shapes, multi-harness wiring flexibility, Slack/web app surfaces, `qm init` deployment directory model. Mem0-compat adapter = optional reach only.
- **Takeaway:** QM's memotype is our *fitness landscape* (what a credible competitor shipped), not the target. The bar: beat QM on retention semantics + provenance-by-default while matching its capture simplicity.
