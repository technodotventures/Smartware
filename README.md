# Smartware

**One memory for every app and agent.**

[![Smartware gate](https://github.com/technodotventures/Smartware/actions/workflows/ci.yml/badge.svg)](https://github.com/technodotventures/Smartware/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Smartware is an open memory protocol and local-first TypeScript reference
implementation. It gives software a shared, user-owned context layer with
provenance, temporal truth, access control, and deterministic fallback.

Smartware is designed to evolve through governed research loops: candidate
memory behavior is measured against a canonical baseline, and activation fails
closed until held-out evidence passes explicit quality, safety, latency, and
cost gates. “Self-evolving” means evidence-governed protocol development—not
unreviewed self-modification in production.

## Why Smartware

Every app and agent starts from zero. Decisions, preferences, relationships,
and project context become trapped in individual tools, forcing people to
re-explain the same facts repeatedly.

Smartware provides one memory home base that authorized software can:

- `observe` to record source evidence;
- `recall` to retrieve policy-eligible claims;
- `reflect` to derive bounded claims from evidence;
- `read` to consume compiled context;
- `explain` to trace a result back to its evidence;
- `correct`, `revise`, and `forget` without erasing history; and
- share through explicit actor, scope, and capability grants.

## Protocol properties

- **Evidence before inference.** Observations are append-only and chained with
  SHA-256 integrity metadata.
- **Claim-level provenance.** Derived claims retain their source observations,
  author, extraction method, epistemic status, and revision history.
- **Bitemporal memory.** Valid time records when a claim represented reality;
  transaction time records when Smartware knew it.
- **Policy-first retrieval.** Scope, grants, sensitivity, lifecycle, and
  currentness are resolved before semantic text can reach an embedding
  provider.
- **Rank-safe hybrid search.** Semantic and lexical ranks are
  fused with reciprocal-rank fusion rather than mixing incomparable raw scores.
- **Disposable derived indexes.** Search and embedding indexes can be rebuilt
  from canonical evidence and claims.
- **Freshness-bound semantic search.** Each semantic partition records the
  exact authorized document-set hash and completeness. Partial or stale indexes
  cannot silently participate in retrieval.
- **Safe fallback.** Missing, corrupt, incomplete, or unavailable semantic
  infrastructure—and embedding-provider timeouts—fall back to canonical
  retrieval.
- **Local ownership.** SQLite, JSONL evidence, and compiled Markdown remain
  under the operator's control with private local permissions by default.

## Current status

Smartware `0.6.x` is beta software.

- The normative baseline is
  [Specification v1.6.16](docs/spec/smartware-spec-v1.6.16.md),
  [Protocol v0.4.2](docs/protocol/smartware-protocol-v0.4.2.md), and
  Schemas v0.4.2.
- Claim-granular SQLite FTS5 is the canonical production retrieval path.
- Semantic and hybrid retrieval are opt-in protocol capabilities.
- The deterministic retrieval kernel passes 9/9 scenarios with Hit@1 `1.0`,
  MRR `1.0`, and zero forbidden hits.
- The standalone protocol and implementation suite passes 316 tests across
  48 files with no skips.
- Semantic activation remains fail-closed until sealed held-out evaluation
  passes the configured quality, safety, latency, and cost gates.
- The production dependency audit reports zero vulnerabilities.
- The repository gate runs the full protocol suite on Node.js 22 and 24,
  verifies frozen schema checksums and the packed public API, and executes the
  deterministic retrieval kernel, retrieval arena, and activation contracts.

See [retrieval](docs/retrieval.md) and
[implementation conformance](docs/conformance-status.md) for the evidence and
limits.

## Architecture

```text
observations
    │
    ▼
Layer 0: append-only evidence + integrity chain
    │
    ▼
Layer 1: versioned claims, entities, confidence, relations
    │
    ├───────────────┐
    ▼               ▼
Layer 2         Layer 3
Markdown        lexical + semantic derived indexes
    │               │
    └───────┬───────┘
            ▼
Layer 4: authorized retrieval + context planning
            │
            ▼
MCP and embedded-core consumers
```

The protocol remains the authority. Pod, Coffee, and other hosts may supply
model credentials, embedding adapters, and index persistence, but they do not
redefine claim eligibility, temporal meaning, provenance, or activation rules.
New standalone instances use the v0.4.2 actor and scope conventions; existing
Pod-style IDs remain supported through the documented
[compatibility profile](docs/compatibility.md).

## Ecosystem

- **[Smartware Connectors](https://github.com/technodotventures/smartware-connectors)** —
  connector runtime, OAuth management, MCP client pooling, grants, and audit
  logging for Smartware-powered applications.
- **[Smartware MCP Servers](https://github.com/technodotventures/smartware-mcp-servers)** —
  Docker-packaged MCP service adapters used by the connector runtime.
- **Pod** — a personal memory layer and second brain built on Smartware.
- **Coffee** — an agent-powered client workspace extending Smartware toward
  governed team memory.

The companion repositories are linked here as separate components. Their
visibility and release readiness are managed independently from the protocol.

## Install

Requirements: Node.js 22 or newer.

```sh
git clone https://github.com/technodotventures/Smartware.git
cd Smartware
npm ci
npm run build
```

Start the stdio MCP server:

```sh
SMARTWARE_DATA_DIR=./data npm start
```

On first run Smartware creates a local instance, prints its owner ID, and
initializes:

```text
data/
├── config.json
├── evidence/
├── operations/
├── smartware.db
└── wiki/
```

Save the owner ID. Owner authority is required for privileged operations such
as grants, revocation, status, and sensitive review.

### Optional LLM extraction

Smartware defaults to `provider: "none"` and never sends memory to an external
model unless the operator explicitly configures a provider and opts into an
LLM-backed reflection. Sensitive observations and pages are excluded from
external extraction and synthesis even when a provider is configured.

Optional LLM extraction supports Anthropic, OpenAI, OpenRouter, or `none`;
select the provider and model in `data/config.json`, then provide the
corresponding environment variable:

```sh
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
OPENROUTER_API_KEY=...
```

Only configure the key for the selected provider. Never commit credentials.

## MCP configuration

After building, point an MCP client at `dist/cli.js`:

```json
{
  "mcpServers": {
    "smartware": {
      "command": "node",
      "args": ["/absolute/path/to/Smartware/dist/cli.js"],
      "env": {
        "SMARTWARE_DATA_DIR": "/absolute/path/to/smartware-data"
      }
    }
  }
}
```

The stdio server exposes canonical `observe`, `recall`, `reflect`, `context`,
`revise`, `forget`, `read`, and `explain` operations, plus administration,
session, and compatibility tools.

Hosts can also import the embedded core:

```ts
import { SmartwareCore } from 'smartware';

const memory = await SmartwareCore.open({
  dataDir: './smartware-data',
});
```

Transport hosts can import the side-effect-free MCP Adapter separately:

```ts
import { createSmartwareMcpServer } from 'smartware/mcp';

const server = createSmartwareMcpServer(memory);
```

## Development

```sh
npm ci
npm run build
npm run verify:schemas
npm test
npm run benchmark:retrieval-kernel
npm run benchmark:retrieval-arena
npm run benchmark:retrieval-activation-contract
```

The activation contract is expected to report `HOLD` for the checked-in public
development evidence. The command succeeds only when that expected fail-closed
decision is preserved.

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
submitting a pull request. Report vulnerabilities through the process in
[SECURITY.md](SECURITY.md), not a public issue.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

Copyright 2026 Techno Ventures. The license does not grant rights to use the
Smartware name or marks except as required to describe the origin of the work.
