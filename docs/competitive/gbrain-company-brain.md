# Research Corpus Entry: GBrain (garrytan/gbrain) — Company Brain

**Status:** TRACKED (Assess — distribution + epistemic-model competitor)
**Scanner:** @smarty-pants
**Scan time:** 2026-08-29 (UTC), targeted deep read
**Sources covered:** README.md (raw, master, fetched 2026-08-29; repo pushed_at 2026-08-29T10:06:33Z), docs/tutorials/company-brain.md (raw, master), GitHub API repo metadata (gbrain, gbrain-evals)
**Important gaps:** NOT read: AGENTS.md, SECURITY.md, docs/ethos/*, gbrain-evals scorecard contents (repo confirmed live: MIT, 358 stars, 65 forks, HTML, last push 2026-08-27), `docs/guides/bootstrap.md`. `--remediate`/`--target-score`/`--max-usd` flags cited by @hermes were NOT found in README (0 hits) — mechanism quote comes from a different doc and was not independently verified here. The fuzz claim has no published methodology (README sentence only). Inferred per-repo commit pin: master at scan time; no stable commit hash recorded.

## Repo metadata (GitHub API, fetched 2026-08-29)

- `garrytan/gbrain`: 29,263 stars / 4,342 forks, MIT, TypeScript, created 2026-04-05, pushed 2026-08-29. Description: "Garry's Opinionated OpenClaw/Hermes Agent Brain".
- README self-identifies author as "Garry Tan, President and CEO of Y Combinator" and states production scale: "155,795 pages, 24,589 people, 5,340 companies, 66 cron jobs running autonomously" (**vendor claim, unverified**).
- Tutorial targets OpenClaw AND Hermes and links YC RFS #company-brain ("If you're building in this space ... you might as well build on this").

## Verified primary-source quotes

1. **Autonomous self-modification of memory** (README, exact): *"It fixes its own citations and consolidates memory overnight."* — in the production-brain paragraph. Mechanism: `gbrain autopilot --install` ("installs the cron that runs the loop" — the README's dream cycle). @hermes's `gbrain doctor --remediate --target-score 90 --max-usd 5` is NOT in README (0 hits for remediate/target-score/max-usd) — trace and re-cite before use.
2. **Isolation claim with no methodology** (README, exact): *"We fuzz-tested this across every way you can read the brain (search, list, lookup, multi-source reads) and got zero leaks."* — read paths enumerated; no harness, results, or threat model published in README (SECURITY.md unread).
3. **Deterministic graph lane, zero-LLM** (README): typed edges (`attended`, `works_at`, `invested_in`, `founded`, `advises`, `mentions`), "zero LLM calls", `gbrain graph-query` multi-hop. **Benchmark (vendor-reported, not reproduced):** "P@5 49.1%, R@5 97.9% on a 240-page Opus-generated rich-prose corpus, +31.4 points P@5 over its graph-disabled variant and over ripgrep-BM25 + vector-only RAG by a similar margin." — scorecards claimed in sibling repo `gbrain-evals` (exists, but contents not verified).
4. **Page pattern = Current Understanding + Evidence Timeline** (tutorial-independent, README synthesis example + tutorial's gap-analysis note): synthesis + per-claim source page + explicit gap note ("based on retrieved pages from date X"). Structurally convergent with Smartware's Current Understanding + Evidence Timeline (validates L2 shape hypothesis).
5. **Company-brain scoping** (tutorial): Model A = separate sources + per-teammate OAuth client (`client_credentials`, `--source`, `--federated-read`, read refused at SQL layer); Model B = one source + `partners/<slug>/` convention, write scoping server-enforced via `--bound-slug-prefixes` (v0.42.72.0+) — doc admits without binding, "scoping is convention-only (the agent polices itself)". Mixing A+B is documented; per-person folders can be promoted to a new source (offboarding path).
6. **Trust/provenance wedge (new finding):** GBrain is NOT distributed on npm. README warns `npm install -g gbrain`/`bun add -g gbrain` installs an unrelated package that can shadow the real binary on PATH; `gbrain doctor` detects the shadowing. Supply-chain trust is a self-managed concern, MIT license, no signature/pin scheme described.

## What this means for Smartware

- **Differentiator survives, with citations:** autonomous, budget-capped self-modification of institutional memory is a documented GBrain behavior (quote #1) and is exactly what Smartware's epistemic invariants forbid (agent claims = bounded hypotheses; user warrant elevates; authorship preserved). Bitemporal valid-time beats their "date X" staleness note in theory — unproven in practice against their retrieval.
- **Threat = distribution + brand, not features.** YC RFS taxonomy + CEO-authored, MIT-licensed, 29k-star, tutorial-first GTM (<$100/mo, 90 min). No license moat; default-rollout moat. Smartware's counter is protocol-openness + evidence-layer story + portability, not license.
- **Concrete adopt/vs-reject notes for the substrate spec:**
  - Their Model B (convention-only scoping) is the anti-pattern to test against: scope enforcement must be server-side (already binding in Smartware).
  - Scope *restructuring* (folder→source promotion, offboarding) is a first-class operation in their model; Smartware's §5a scope-restructuring op (intent-backed, preview, ops-log, bitemporal scope-map) covers it — currently a design, not yet spec'd (see tech-head thread).
  - Deterministic no-LLM entity/edge extraction at 49.1 P@5 / 97.9 R@5 (vendor numbers) on a 240-page corpus is the benchmark to mirror for our cost-route lane; edge extraction should be spec'd with bitemporal bounds + authorship (theirs have neither).
  - `gbrain-evals` is the baseline to mirror for retrieval spikes — NOT mem0's PR numbers (note mem0 benchmark on platform only; OSS differs).

## Confidence

- Repo metadata + quotes 1–5: **facts** (primary source, reproduced verbatim).
- Benchmark numbers (P@5/R@5, scale figures): **vendor-reported**, unverified; would change if reproduced via gbrain-evals.
- "Zero leaks": **self-claim**, methodology absent.
- @hermes `--remediate` flags: **sourceless in README** — pending re-citation.

## Relevance axis: Coffee frame (updated 2026-08-29)

Coffee is an end-to-end SaaS for small services businesses (1 tenant = 1 business; owner-as-admin; 2–10 staff; clients as memory subjects). Re-scored against that customer profile:

- **Primary relevance → ingredient library, not mirror.** Features to adopt as patterns: supersession/consolidation, exclusion policy (their security-posture classifier provenance screening), scope isolation (Model A SQL-layer enforcement — the Pattern B convention-only mode is the anti-pattern), staleness honesty gap-notes ("based on retrieved pages from date X" → our `version_at`/`reference_date`), deterministic no-LLM entity extraction (cost lane).
- **Usage pattern to copy:** tutorial-first onboarding under 100 min, plain-language answers with source pages — Coffee's non-technical owner WILL ask "where did AI learn this?"; GBrain's gap-analysis note is the closest competing UX to our provenance envelope. Our advantage (0.05ms envelope; bitemporal) is a UI feature in Coffee, not a dev-tool feature.
- **Irrelevant to Coffee:** per-teammate OAuth client_credentials + federated-read source model (GBrain Model A), API-surface migration parity, npm/self-host install trust, 155k-page scale claims. Mem0-compat adapter = optional ecosystem reach only; Coffee customers will never self-host.
- **Strategic note:** YC now ships two MIT "company brain" products (GBrain, QM). Distribution + brand is their moat. Coffee's moat = vertical trust + provenance-in-plain-language; do not chase their horizontal developer distribution.
