# smartware

One memory for every app and agent: an open, user-owned memory protocol with
provenance, bitemporal truth, policy-first retrieval and deterministic
fallback. TypeScript reference implementation, local-first, SQLite + JSONL +
compiled Markdown.

This map is the first backfill (2026-09-17, Optimus, for the agenttrail
board). Every ticked task cites the source that proves it; the fleet refines
this file as it works.

## Remember what happened, once {#evidence}
tech: L0 append-only observation log and the storage durability around it (integrity chain, idempotency, fencing)
files: [src/layer0/**, src/storage/**, docs/atomicity.md]
links: [claims]
- [x] Append-only observation log with a SHA-256 integrity chain {#evidence-log}
  tech: src/layer0/log.ts + integrity.ts
- [x] Observation intake is idempotent and strips secrets {#evidence-intake}
  tech: src/layer0/idempotency.ts + secrets.ts
- [x] Fence writes at the mutation boundary with a token {#evidence-fence}
  tech: src/storage/fence.ts (ADR-0007, ADR-0010)
- [~] Land the storage fencing residuals {#evidence-fence-residuals}
  by: neo
  from: agent

## Claims that carry their provenance {#claims}
tech: L1 claim store: entities, corroboration, conflicts, fingerprints, replay, tombstones
files: [src/layer1/**]
needs: [evidence]
- [x] Claims record author, method, epistemic status and revision history {#claims-record}
  tech: src/layer1/store.ts + types.ts
- [x] Conflicts and corroboration resolve on the record {#claims-conflicts}
  tech: src/layer1/conflicts.ts + corroboration.ts
- [x] The record writer names the version it replaces; the forgotten branch stops requiring it {#claims-version-names}
  tech: ADR-0014 + docs/journal/2026-09-15-t_3ba3ee39.md
- [~] Finish the L1 replay claim-id fixes (Crockford) {#claims-l1-replay}
  by: tech-head
  from: agent

## Recall under policy, rank-safe {#recall}
tech: L3 retrieval: policy-first filtering, hybrid search with reciprocal-rank fusion, freshness-bound semantic partitions
files: [src/layer3/**, benchmarks/**, src/evaluation/**]
needs: [claims]
- [x] Policy gates retrieval before text can reach an embedding provider {#recall-policy-first}
  tech: src/layer3/search.ts + docs/retrieval.md
- [x] Fuse semantic and lexical ranks instead of mixing raw scores {#recall-rrf}
  tech: src/layer3/hybrid.ts
- [x] Keep the retrieval evaluation harness {#recall-eval}
  tech: src/evaluation/retrieval.ts + benchmarks/retrieval/*.json

## Assemble what an app reads {#context}
tech: L4 context assembly: authorized claims, context planning, scoring, behind read/compile
files: [src/layer4/**, src/protocol/context.ts, src/protocol/compile.ts]
needs: [recall]
- [x] Context assembly plans and scores what an app reads {#context-assembly}
  tech: src/layer4/assembly.ts + context-planning.ts + scoring.ts
- [x] Only authorized claims reach the assembled context {#context-authorized}
  tech: src/layer4/authorized-claims.ts

## Compile memory into pages a person can read {#pages}
tech: L2 compiled Markdown: frontmatter, manifest, git-backed pages and the write boundary
files: [src/layer2/**, src/render/**]
needs: [claims]
- [x] Compile claims into Markdown pages with frontmatter {#pages-compile}
  tech: src/layer2/compiler.ts + frontmatter.ts
- [x] Track the compiled set in a manifest {#pages-manifest}
  tech: src/layer2/manifest.ts
- [~] Close the frontmatter write-boundary losses {#pages-frontmatter-residuals}
  by: neo
  from: agent

## Grants decide what may move {#governance}
tech: auth and scopes: grants, capabilities, trust, proximity, sensitivity; legal hold and retention
files: [src/auth/**, src/scopes/**, src/protocol/grant.ts, src/protocol/forget.ts, src/protocol/forget_scope.ts]
links: [claims, recall]
- [x] Explicit actor, scope and capability grants {#governance-grants}
  tech: src/auth/grants.ts + middleware.ts
- [x] Legal hold composes and releases explicitly {#governance-hold}
  tech: src/protocol/forget.ts (ADR-0008, ADR-0009)
- [~] Retention sweeps carry an op id and payload identity {#governance-retention}
  by: smarty
  from: agent

## Plug an app or agent in {#surfaces}
tech: MCP server, CLI, host adapters and the protocol op surface
files: [src/mcp.ts, src/cli.ts, src/protocol/**]
needs: [context]
links: [governance]
- [x] Serve the protocol over MCP {#surfaces-mcp}
  tech: src/mcp.ts
- [x] Ship a CLI for local use {#surfaces-cli}
  tech: src/cli.ts (bin: smartware)
- [x] Prove the Coffee reference adapter against its gate {#surfaces-coffee}
  tech: scripts/coffee-adapter-smoke.mjs (ADR-0021, ADR-0022)
- [~] Keep the protocol op enums symmetric {#surfaces-ops-enum}
  by: neo
  from: agent

## Prove it before it ships {#substrate}
tech: evidence-gated activation, conformance, and the substrate journal/status loop
files: [benchmarks/**, scripts/substrate-*.mjs, docs/conformance-status.md, docs/journal/**, docs/substrate.json]
links: [claims, recall, governance]
- [x] Activation fails closed until held-out evidence passes every gate {#substrate-gates}
  tech: docs/conformance-status.md + benchmarks/
- [x] STATUS.md is a generated projection, never edited by hand {#substrate-status}
  tech: scripts/substrate-status.mjs (ADR-0016) + docs/STATUS.md header
- [x] The journal records each lane's decisions and completions {#substrate-journal}
  tech: docs/journal/ (37 entries as of the last STATUS regen)
- [ ] Refile the moved ADRs to canonical numbering before merge {#substrate-adr-refile}
  tech: docs/adr (0005→0019, 0008→0020, 0010→0021, 0011→0022, 0013→0023; staged in the working tree)
  from: agent

## decisions
- 2026-09-17: First PLAN.md backfill (Optimus, for the agenttrail board). Every ticked task cites the file or ADR that proves it; where code and prose disagreed, the code won. Six lanes were in flight when this map was drawn and carry their owning lane in a by: line: retention op ids (smarty), L1 replay ids (tech-head), frontmatter write residuals (neo), storage fencing residuals (neo), ops enum symmetry (neo), host lane identity (later merged into the ADR refile below). The ADR renames staged in this tree (0005→0019, 0008→0020, 0010→0021, 0011→0022, 0013→0023) are unlanded; the refile task tracks them. Left unchecked where evidence was not at hand; the fleet should extend the component notes as those lanes land.
