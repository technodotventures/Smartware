# Retrieval

Smartware separates canonical memory from derived retrieval infrastructure.
Authorization and lifecycle eligibility are resolved before ranking, and
canonical lexical retrieval remains available whenever an optional semantic
channel is unavailable.

## Canonical retrieval

The production baseline is claim-granular SQLite FTS5 retrieval. Before a
claim can rank, Smartware applies:

- actor and scope authorization;
- owner-only sensitive-memory opt-in;
- forgotten, stale, superseded, and effective-current rules;
- confidence, epistemic, and entity-type filters; and
- explicit valid-time or transaction-time constraints when the embedded API
  supplies one.

Filters run before score normalization and result limits. Ineligible claims
therefore cannot influence visible ranks or consume result slots. Historical
transaction-time reads use an authorized claim snapshot rather than the active
search index, allowing a caller to reconstruct what Smartware knew at a
specific time without exposing out-of-scope history.

The `total_found` / `filtered_out` counts on a recall result are raw
derived-lane hits taken *before* those eligibility filters, and the claim lane
is updated incrementally rather than rebuilt on every mutation. Rows that are
deliberately kept through a lifecycle change — FORGET's claim-FTS rows and the
retention sweep's mirror of them (`src/protocol/forget_scope.ts`) — therefore
still appear in the live counters as filtered hits, while a freshly rebuilt
lane never holds them. The counters can differ from a restart by exactly those
kept rows even though the served result set is rebuild-equivalent; any
re-syncing write (or the next open) removes the difference. Treat the counters
as lane diagnostics, not as an authorization or lifecycle signal — `results`
is the contract.

## Semantic and hybrid retrieval

Semantic retrieval is an opt-in Layer 3 capability. A host supplies an
`EmbeddingAdapter` and a `SemanticRecordStore`; Smartware retains ownership of
claim eligibility, temporal semantics, and channel selection.

The semantic path:

- embeds only policy-eligible claim documents;
- stores vectors in a disposable SQLite index separate from canonical memory;
- partitions records by scope, model, and index version;
- records the complete authorized document-set hash;
- reuses unchanged vectors and rebuilds missing or incompatible records;
- applies temporal constraints before provider work;
- bounds provider work with explicit timeouts; and
- fails back to canonical retrieval when the provider or index is missing,
  corrupt, incomplete, stale, or unavailable.

Hybrid ranking combines lexical and semantic order with reciprocal-rank
fusion. It never mixes raw BM25, cosine similarity, or composite delivery
scores as though they shared a common scale.

## Verification

The deterministic retrieval-kernel contract covers nine scenarios:

- paraphrase ranking;
- current and historical valid time;
- transaction-time knowledge;
- event-start range boundaries;
- forbidden-candidate exclusion;
- rank-safe hybrid fusion;
- provider fallback; and
- a negative query.

Run it with:

```sh
npm run benchmark:retrieval-kernel
```

The evaluator contract verifies quality metrics, abstention, forbidden and
obsolete hits, latency, token use, and cost:

```sh
npm run benchmark:retrieval-arena
```

These checked-in fixtures prove evaluator and orchestration behavior. They are
not a production-quality claim for any embedding model.

## Activation gate

Moving a host from shadow evaluation to semantic fallback requires a sealed,
held-out comparison against canonical retrieval. The activation evaluator
fails closed on:

- any forbidden or obsolete result;
- a missing baseline or candidate observation;
- an aggregate quality regression;
- more per-query losses than policy permits;
- development rather than held-out evidence;
- a changed arena or captured-run digest; or
- an exceeded latency or cost ceiling.

The checked-in activation contract intentionally returns `hold` because its
data is public development evidence:

```sh
npm run benchmark:retrieval-activation-contract
```

Production promotion requires an independently authored, consented or
synthetic held-out corpus with explicit quality, safety, latency, context
budget, and cost thresholds. Passing that gate authorizes a controlled fallback
rollout; canonical retrieval remains the safe path when derived infrastructure
fails.

## Current limits

- Semantic retrieval is not enabled by default.
- Similarity thresholds are model- and corpus-specific.
- Historical reconstruction is available through the embedded retrieval
  constraint, while the frozen v0.4.2 RECALL wire schema still rejects `as_of`.
- Graph expansion and learned salience are not retrieval-ranking inputs.
- The repository fixtures are regression and safety contracts, not held-out
  evidence of general memory quality.
