# Research Corpus Entry: HQ for Work — company brain vs Coffee + Smartware

**Status:** TRACKED — adopt selected product patterns; do not copy the architecture  
**Scanner:** @smarty-pants  
**Scan time:** 2026-09-10 12:40–13:00 UTC  
**Smartware baseline:** `release/coffee-v050-surface` at `89b13c9e16560662c990ebe9565d04d14b76d525` (clean tree before this report; fetched from origin)  
**HQ source pin:** `indigoai-us/hq-core` main at `9232758e1d66bbbe568a8158d88d4d351b92c2d9`

## Decision

**Coffee should use HQ's best product lesson — “map first, details on demand” plus a reviewed correction loop — but Smartware must remain a protocol-quality memory substrate, not become a clone of HQ's file-based AI operating system.**

Coffee + Smartware has a credible path to a more trustworthy company brain for small service businesses: typed observations and claims, bitemporal versions, scope-exact authorization, provenance, owner-gated client export, reversible offboarding, and lane-exhaustive erasure. But it is **not yet an end-to-end company brain**. HQ is materially ahead in public product surface: onboarding, team sync, connectors/secrets, cross-tool delivery, reusable workers, persistent agents, meeting capture, and a coherent “one company layer” story.[2][6]

The next release should not claim HQ parity. It should prove one vertical Coffee workflow end to end: capture real work → extract evidence-backed candidate knowledge → human review → task-aware context → correction propagation → client-scoped export/erasure.

## What the X post gets right

The X Article was published on 2026-08-25 at 13:31:06 UTC. The logged-out page reported 777,750 views, 1,283 likes, 164 reposts, 36 replies, and 4,875 bookmarks when fetched on 2026-09-10; those engagement numbers are a discovery signal, not product validation.[1]

The post's strongest claim is not “store everything”; it is selective context routing: “The fix is not more memory in every prompt. It is better navigation.”[1] That aligns directly with Smartware's principle that context quality matters more than quantity.

Three patterns are worth adopting in Coffee:

1. **Workflow-first rollout.** Start with one recurring, reviewable workflow instead of ingesting the whole company.
2. **Map first, details on demand.** Give each task a small map and pull only the context required for the current role and job.
3. **Reviewed compounding.** Route work corrections into facts, decisions, policies, skills, procedures, or safety gates, then review before sharing. The post summarizes this as `work → correction → route → review → share → better future work`.[1]

The article also makes a useful distinction between memory, judgment, capability, and learning. That is good product language, but not a sound reason to collapse memory, policy, and action execution into one protocol.

### Weak assumptions in the post

- **It treats a folder map as an architecture.** A directory is inspectable, but it does not itself define provenance, temporal truth, authorization, deletion propagation, conflict semantics, or conformance across implementations.
- **Its source hierarchy is too coarse.** “Use the newest approved information” and a fixed source order do not resolve valid-time vs record-time, partial conflicts, scoped truth, or contested claims.
- **It understates provenance.** The sentence “Nobody needs the original chat or even needs to know who figured it out” is acceptable as a convenience claim, but unsafe as a truth model.[1] Coffee may hide staff attribution on client-facing surfaces, yet Smartware must retain the source observation and derivation path internally.
- **“Gets smarter every week” is unmeasured.** The article provides a build recipe, not evidence of task-success lift, lower error rate, or safer operations.
- **It mixes memory with action.** “Remember, decide, act, and learn” is a product loop. Smartware should retain the boundary: memory/context in Smartware; explicit actions and replay in Coffee/Expresso unless an RFC demonstrates otherwise.

## What HQ actually is

HQ's first-party description calls it an open-source team AI operating system and shared context/capability layer for Claude Code, Cursor, and Codex.[2][9] The open repository contains HQ Core, a large file-based agent harness, skills/workers, policies, hooks, and tests. The managed suite adds Cloud sync/access, Secrets + Integrations, hosted MCP, Agents, meeting capture, and Deploy.[6]

First-party product claims include:

- company-owned canonical sources and sourced retrieval across people, agents, projects, and AI tools;[3]
- per-client or per-brand company boundaries spanning knowledge, people, agents, tools, credentials, projects, and history;[4]
- role/group-scoped knowledge, tools, secrets, agents, and approval boundaries;[5]
- local-first files plus a managed cloud tenant, encrypted storage, and managed services;[6][7]
- a free Starter tier up to 50 people and a $500/month Workforce tier, with usage-priced agents/outposts/meeting capture.[8]

These are **vendor claims unless reproduced**. This scan inspected public pages and source, but did not install HQ, authenticate to HQ Cloud, inspect a real tenant, or run its test suite.

## HQ shortfalls and unresolved claims

1. **The public ownership story is stronger than the legal wording inspected.** Product pages repeatedly say company-owned sources, and the privacy policy offers access, correction, deletion, and portability requests.[3][7] The extracted Terms page says HQ-provided content is owned by HQ, but it does not explicitly define customer ownership or a licence for customer content.[15] This is an ambiguity to verify, not proof that HQ owns customer data.
2. **Managed portability is underspecified.** HQ Core files are portable in the practical sense, but the managed suite's export format, completeness, import/restore, derived-data handling, and provider-replacement tests were not found. The privacy policy promises a structured data-portability request, not a conformance-tested round trip.[7]
3. **Deletion is account/provider oriented, not proven at client scope.** The privacy policy says many classes are deleted within 30 days after account deletion/request.[7] HQ's own security documentation is candid that production tenant offboarding is still a **soft tombstone** — “a fully automated hard-delete-on-offboarding routine (destroying bucket, per-tenant key, and metadata) is being productionized and is tracked on the roadmap,” with complete deletion performed as an operational procedure on request until then.[18] No public proof was found for exact-count client-scope purge across files, search indexes, embeddings, summaries, caches, backups, and replicas, nor for a deletion certificate.
4. **The epistemic model is thin.** The public ontology classifies documents by type/domain/status (`canonical`, `draft`, `stale`).[11] It does not expose a per-derived-item protocol for observation vs fact vs inference vs preference vs procedure vs decision, bitemporal validity, confidence, consent, derivation, supersession, or legal erasure.
5. **Cloud tenant isolation is strong; Desktop isolation and the public test sandbox are not.** HQ's security documentation describes real, well-engineered cloud isolation: a dedicated S3 bucket and dedicated KMS customer-managed key per organization, with per-request STS sessions scoped to exactly one tenant and a deny-all default.[17] The pinned internal Desktop design document, by contrast, states: “Desktop currently has no company isolation enforcement,”[10] and HQ's own local hook tests pin the cross-company-block and vault-write-deny cases as `KNOWN-DEFECT`/`fails OPEN` because those guarantees are unobservable in the public CI sandbox (enforced only in a live tree with the access manifest present).[20] The honest read: managed-tenant isolation is credible on paper and should not be written off, but its two local enforcement surfaces are not proven by public reproducible tests.
6. **Learning is agent-authored policy mutation.** The public `/learn` skill routes corrections into company/personal/repo policy files and flags contradictions for review.[12] That is pragmatic, but the trusted boundary depends on hooks, path routing, Git review, and model behavior rather than a protocol-level claim/evidence/consent model.
7. **No independent outcome evidence was found.** The sources inspected contain product claims and implementation artifacts, not representative task-success comparisons or independently reproduced security/privacy tests.
8. **Assurance and crypto posture are explicitly incomplete.** HQ states it is not yet SOC 2 or ISO certified, has not completed an independent third-party penetration test, does not offer customer-managed keys (BYOK) or end-to-end (client-side) encryption, and runs Cloud in a single AWS region with no automated cross-region failover.[16] HQ MCP is beta, and the cloud vector index is scaffolded but “not the production source of truth for cloud MCP results yet”; retrieval is currently the content-search service.[19] These are candid self-disclosures, not necessarily defects — but they are the exact gaps Smartware's evidence-first positioning should exploit.

## Comparison: HQ vs current Smartware vs Coffee end-state

| Area | HQ public position | Smartware `0.7.0` branch, verified | Coffee end-state implication |
|---|---|---|---|
| Product scope | Horizontal AI operating system: memory, policies, skills, agents, secrets, integrations, deploy | Memory/context protocol + reference substrate, not a hosted product | Keep Coffee as the vertical product; do not move HQ-like app concerns into the protocol |
| Primary user | Technical teams plus broader users through chat, Slack/email, and deployed outputs | Protocol integrators | Owner + 2–10 staff in a small service business; clients are memory scopes |
| Memory representation | Inspectable files: Knowledge, Skills, Projects, Workers, Policies | Canonical observations, versioned claims, relations, ops log, projections | Render a simple company/client brain while retaining typed truth underneath |
| Context selection | “Company map” plus task-pulled details | `CONTEXT` is an authenticated one-hop bundle keyed by `query`, `scope`, `actor_id`, and `limit` | Major gap: add task/capability intent, budgets, inclusion/exclusion reasons, policy receipts, and source-conflict explanation |
| Corrections | Route correction → shared file/policy/skill → review → Main HQ | `REVISE`, supersession, provenance renderer, operation receipts | Build a Coffee review inbox and approval workflow; do not auto-promote corrections into shared truth |
| Provenance | Sourced answers and visible files are claimed[3] | Explicit source observations, supporting evidence, ops IDs, versions, confidence/epistemic metadata; renderer is covered by 33 tests | Smartware advantage, but only once Coffee exposes “why this answer?” clearly |
| Client isolation | Dedicated S3 bucket + KMS key + scoped STS per org, deny-all default[17]; Desktop isolation unimplemented[10] | Exact versioned client scopes and grants inside one business tenant; Coffee e2e proves no cross-client memory leakage | HQ's managed isolation is broader (tools/secrets/agents); Smartware's is more precise and provable for memory. Coffee must separately scope tools, secrets, actions, and app state |
| Team sync/conflicts | Managed sync; conflicts surface for review[6] | Local single-writer reference implementation; no concurrent multi-writer guarantee | Coffee must own transactional tenant hosting, sync semantics, replicas, and operational recovery |
| Capture/connectors | Meetings, files, Google data, Slack/email, integrations and MCP are productized/claimed[6][7] | OBSERVE accepts data; host supplies adapters | Largest product gap: build ingestion from Coffee-native work before horizontal connectors |
| Extraction | Meeting signals/insights and knowledge gardening are claimed | LLM-backed reflection exists, but deterministic no-LLM prose extraction is narrow | Coffee must operate and evaluate extraction; raw prose cannot be assumed to become useful claims |
| Skills/workers/actions | Shared Skills, Workers, persistent Agents, tools, approvals | Procedures can be represented, but Smartware is not an action runtime | Implement in Coffee/Expresso and reference Smartware context by stable IDs |
| Portability | Core files are inspectable; managed export/import contract not found | Owner-only, scope-exclusive canonical export with checksums; import/restore deferred | Finish round-trip import/restore conformance before claiming full portability |
| Deletion | Soft-tombstone tenant offboarding; hard-delete routine not yet automated[18] | FORGET.SCOPE erasure/offboarding, same-commit grant revocation, every-lane purge, audit marker — but original L0 evidence bytes are tombstoned on disk, not physically deleted | Smartware differentiator, with a caveat: erasure is proven non-retrievability + derived-data purge, not byte-level destruction of the raw evidence log. Coffee must state this precisely and handle hosted replicas/backups |
| Shipping maturity | Public install and managed product pages exist | Branch is green but beta, unmerged to `origin/main`, and unpublished | Do not market as integrated until Coffee ships and pins the exact artifact |

## Smartware latest-branch verification

The current HEAD is `89b13c9` (“release: 0.7.0 — v0.5.0 protocol surface cut on the upstream Node 22/24 gate”), dated 2026-09-10 08:17:21 UTC. **That commit itself is a version/release cut; the substantive Coffee company-brain implementation is primarily in earlier branch commit `edddf63`.** The branch contains seven commits not in `origin/main`. `89b13c9` is present on `origin/release/coffee-v050-surface` but is not an ancestor of `origin/main`.

Reproduced locally on 2026-09-10:

- `npm run build` → pass;
- `npm run verify:schemas` → 31 schemas verified across v0.4.2 and v0.5.0;
- `npx vitest run` → **446/446 tests across 64 files, no failures**.

The verified branch implements:

- one business = one Smartware instance/Pod;
- clients as versioned exact scopes (`client:<id>#n`) under `workspace`;
- exact per-staff/per-agent grant clusters;
- raw observation indexing plus durable asynchronous compilation;
- policy-first recall and hybrid retrieval fallback;
- versioned claims, corrections/supersession, provenance envelopes and a staff-facing renderer;
- owner-only, scope-exclusive export;
- owner-only FORGET.SCOPE with separate offboarding and erasure semantics, same-commit grant revocation, exact counts, recovery intent, and lane-exhaustive purge of L1 claims and every derived/index lane — while the original L0 evidence-log bytes are tombstoned (effective status `erased`) and retained on disk for audit rather than physically destroyed.

The published npm registry still reports `0.6.3` as latest; it does not expose this `0.7.0` branch cut.[14]

## Smartware/Coffee shortfalls before “company brain” is true

### P0 — blockers

1. **No Coffee integration exists in this repository.** The code is a substrate and integration guide; Coffee must still provision tenants, map identities, capture events, host model/provider credentials, enforce user-facing authorization, render provenance, and operate the service.
2. **Free-form learning is not automatic without an extraction lane.** A live probe on this branch observed `Acme prefers email over phone`, compiled with `use_llm:false`, and returned `claims_extracted=0`, `recall_count=0`. The Coffee e2e test obtains recallable memory by inserting structured claims through `ClaimStore`; it explicitly describes that as the path “when extraction runs upstream or LLM-backed” (`test/conformance/coffee-company-brain.test.ts:122–143, 176–187`). Coffee needs an evaluated `reflect.auto` provider or a structured Coffee-side extractor.
3. **Layer 7 is not yet the post's “map first” composer.** `schemas/v0.5.0/context-request.schema.json` declares only query/scope/actor plus flags and limit. `context-bundle.schema.json` returns seeds, one-hop relations, and provenance but no task type, capability request, token budget, inclusion/exclusion rationale, policy decision receipt, fallback reason, or context-quality score.
4. **The Coffee UX is designed but unimplemented.** The owner verification modal, review queue, client export/offboarding/erasure screens, return-client pointer builder, receipts, and “why this answer?” presentation live in docs/specs, not a shipped Coffee surface.
5. **Release availability is incomplete.** The tested branch is remote but not merged to main (`origin/main` is still `14e7082`; PR #3 is open and review-blocked), and npm latest is still `0.6.3`.[14] A local `smartware-0.7.0.tgz` exists, but the CI packaged-surface gate only asserts `dist/core.js`/`dist/mcp.js`/`dist/cli.js` and a v0.4.2 schema — it does not explicitly assert `smartware/render` or `schemas/v0.5.0` are in the tarball (they are present in the local artifact, but the gate should be widened).

### P1 — material gaps

- no concurrent multi-writer serialization guarantee;
- **erasure is not byte-level destruction:** the original L0 evidence JSONL records stay on disk tombstoned as `erased` (`src/protocol/export_scope.ts:13–17`, `src/protocol/forget_scope.ts:458–479`); for a strict legal/DSR “delete the personal data” claim, the raw message bytes are still present on disk and must be accounted for explicitly;
- **vector deletion is host-dependent:** `forgetScope` resets embeddings only when the caller supplies its persisted `semanticStore` (`src/protocol/forget_scope.ts:471–474`); a Coffee adapter that omits its vector store can leave embeddings behind;
- **raw-observation search is not on the MCP surface:** when compile produces zero claims, normal RECALL returns empty even though the message is searchable through the embedded `searchObservations` API — no raw-search tool is registered in `src/mcp.ts`;
- import/restore and re-import-equivalence are deferred;
- automatic quarantine of ambiguous append-only artifacts is not implemented;
- **release docs have stale version text** — `docs/integration/saas-integration.md:10–11` still targets v0.6.x and line 326 says Node ≥ 20 while `package.json` requires Node ≥ 22;
- hosted backup/replica/cache erasure remains Coffee's responsibility;
- integration quality, model extraction accuracy, prompt-injection resistance, and staff comprehension are not yet measured on Coffee workloads;
- client scopes protect Smartware memory, not Coffee's tools, secrets, actions, documents, notifications, or general application state;
- the current tenant config uses file-backed grant lists; Coffee needs safe, transactional lifecycle orchestration around provisioning, staffing changes, client return, and erasure.

## Ranked recommendation

### 1. Trial one Coffee-native company-brain workflow now

Use **client handoff / “What should I know before contacting this client?”** as the first workload. It naturally exercises client isolation, history, preferences, decisions, current work, provenance, corrections, and staff handoff without prematurely adding autonomous actions.

**Success gates:**

- zero cross-client or unauthorized hits under adversarial tests;
- 100% source resolution for consequential claims;
- corrections supersede prior claims and appear in subsequent context within 60 seconds;
- no reviewed correction becomes shared truth without an accountable approver;
- at least 20% improvement in a blinded handoff rubric versus current Coffee context;
- less than 5% stale/unsupported statements in generated handoffs;
- p95 context assembly under 500 ms at the representative tenant size;
- owner export contains only the client scope and erasure leaves zero results in every hosted lane.

### 2. Build the missing capture → candidate → review loop

Coffee should ingest its own messages, notes, meetings, jobs, invoices, and client records into OBSERVE; run bounded extraction into typed **candidate** claims; require review for decisions, policies, preferences, procedures, and consequential facts; and persist the source observation, derivation, confidence, scope, consent/policy, and approver. Do not make “every correction becomes memory” automatic.

### 3. Specify Context Package vNext before adding more stores

Trial these additive fields behind an experimental Coffee adapter before changing the public schema:

- `task_type` and requested capabilities;
- scope and audience/surface;
- token/latency/cost budget;
- inclusion reason and exclusion/policy reason per item;
- source authority and conflict resolution;
- freshness and correction status;
- fallback/degradation state;
- package-level quality/coverage diagnostics.

The smallest falsification test is whether this richer package beats plain scoped RECALL on the handoff workload without increasing leakage or unsupported statements.

### 4. Keep procedures/actions above the protocol

Represent durable procedures and approved preferences in Smartware, but execute workers through Coffee/Expresso. Persist stable references from each execution receipt back to the Smartware procedure/version and context package. Do not turn Smartware into HQ's monolithic operating system.

### 5. Finish portability, then make it a product promise

Implement scope import/restore with re-import-equivalence, schema/version migration, conflict handling, and a Coffee-hosted deletion proof that includes every replica/cache/vector/summary lane. Until then, say **“exportable canonical records”**, not full round-trip portability.

## Technology radar action

- **Adopt:** workflow-first rollout; map-first/details-on-demand UX; reviewed correction routing.
- **Trial:** task/capability-aware context packages in the Coffee handoff workflow.
- **Assess:** HQ's broader company/client boundary model for tools, secrets, agents, and projects.
- **Hold:** horizontal HQ-style agent OS, general connector marketplace, or persistent-agent workforce until Coffee's vertical workflow proves lift.
- **Reject:** provenance-free consolidation, automatic promotion of private chat corrections, and “memory as switching-cost moat” as a Smartware design objective.

## Confidence and gaps

**High confidence** in Smartware branch/test status (reproduced locally: build, schemas, 446/446 tests) and in the HQ public-source files and docs.hq.computer security pages inspected (all load-bearing claims verified verbatim). **Medium confidence** in HQ managed-product behavior because its Cloud, sync, authorization, deletion, and hosted MCP were not reproduced on a live account. **Low confidence** in comparative task outcomes because neither product was tested on the same Coffee workload.

Source classes covered: X article HTML and media, HQ first-party marketing/use-case/FAQ/pricing/privacy/terms pages, public `llms.txt`, docs.hq.computer security/architecture/MCP pages, GitHub README/repository tree and selected implementation/spec/hook files, npm registry, and the Smartware live Git branch/code/tests (full suite run locally). Important gaps: no HQ account or Cloud tenant, no HQ binary execution, no independent customer interviews/benchmarks, no authenticated Coffee integration, no backup/replica deletion test, and no cross-product benchmark. The X subagent task failed on an HTTP 429 rate limit, but the full article text was recovered directly from the logged-out page HTML before that failure, so no X content was lost.

## Sources

[1] https://x.com/VibeMarketer_/status/2092243372929151135
[2] https://hqforwork.com/llms.txt
[3] https://hqforwork.com/build-a-shared-company-brain
[4] https://hqforwork.com/run-isolated-client-and-brand-workspaces
[5] https://hqforwork.com/govern-ai-access-knowledge-and-approvals
[6] https://hqforwork.com/faq
[7] https://hqforwork.com/privacy
[8] https://hqforwork.com/pricing
[9] https://github.com/indigoai-us/hq-core
[10] https://github.com/indigoai-us/hq-core/blob/9232758e1d66bbbe568a8158d88d4d351b92c2d9/core/knowledge/public/hq-core/desktop-company-isolation.md
[11] https://github.com/indigoai-us/hq-core/blob/9232758e1d66bbbe568a8158d88d4d351b92c2d9/core/knowledge/public/hq-core/knowledge-ontology.yaml
[12] https://github.com/indigoai-us/hq-core/blob/9232758e1d66bbbe568a8158d88d4d351b92c2d9/.claude/skills/learn/SKILL.md
[14] https://registry.npmjs.org/smartware
[15] https://hqforwork.com/terms
[16] https://docs.hq.computer/hq/security/1-overview
[17] https://docs.hq.computer/hq/security/3-tenant-isolation
[18] https://docs.hq.computer/hq/security/4-data-security-encryption
[19] https://docs.hq.computer/hq-in-chat
[20] https://github.com/indigoai-us/hq-core/blob/9232758e1d66bbbe568a8158d88d4d351b92c2d9/core/hook-tests/enforce-vault-write-access.yaml
