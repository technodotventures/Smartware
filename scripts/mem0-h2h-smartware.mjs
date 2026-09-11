// Smartware side of the mem0 head-to-head (G0 spike).
//
// Protocol pins (from docs/competitive/mem0-substrate-spec-draft.md §8):
//   threshold = 0.0 (min_similarity 0.0), rerank = false (no reranker),
//   same top_k as mem0, same embedding model (bge-small-en-v1.5, 384 dims,
//   via transformers.js in Node; parity with mem0's fastembed verified by
//   scripts/mem0-h2h-parity.mjs).
// Temporal axis is measured SEPARATELY (temporal_queries) via the canonical
// RECALL path: hybrid recall deliberately excludes superseded history.
//
// Output: .spike-h2h/results-smartware.json + console summary.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { SmartwareCore } from '../dist/core.js';
import { ClaimStore } from '../dist/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../dist/layer3/search.js';
import { SemanticRecordStore } from '../dist/layer3/semantic-store.js';
import { appendOpLogEntry } from '../dist/ops_log/log.js';

const ROOT = path.resolve(process.cwd(), '.spike-h2h');
const CORE_DIR = path.join(ROOT, 'smartware-core');
const SEMANTIC_DB = path.join(ROOT, 'indices', 'semantic.db');
const BENCH = path.resolve(process.cwd(), 'benchmarks/retrieval/mem0-h2h-companybrain-v1.json');

const TOP_K = 10;
const VECTORS_FILE = path.join(ROOT, 'vectors-fastembed.json');

function claimText(fact) {
  const predicate = fact.predicate.replace(/[_-]+/g, ' ').trim();
  return `${fact.subject_name.trim()}\n${predicate}: ${fact.object.value}`;
}

/**
 * Embedding adapter backed by fastembed's precomputed vectors (the SAME
 * library + model mem0 uses in-process). Queries and claims resolve by exact
 * string; missing strings fail fast so coverage is provable.
 */
function loadFastembedAdapter() {
  const vectors = JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf8'));
  const byText = new Map(Object.entries(vectors.vectors).map(([text, entry]) => [text, entry.vector]));
  return {
    provider: 'fastembed',
    model: vectors.model,
    dimensions: vectors.dimensions,
    embed: async (texts) => texts.map((text) => {
      const vector = byText.get(text);
      if (!vector) throw new Error(`no precomputed vector for: ${JSON.stringify(text).slice(0, 80)}`);
      return vector;
    }),
    embedMs: (text) => {
      const entry = vectors.vectors[text];
      return entry === undefined ? null : entry.embed_ms;
    },
  };
}

function percentile(values, probability) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

async function main() {
  const bench = JSON.parse(fs.readFileSync(BENCH, 'utf8'));
  const pins = bench.pins;
  const topK = pins.top_k;
  fs.rmSync(CORE_DIR, { recursive: true, force: true });

  // ── Open core (owner Maya; grants for staff Ana) ───────────────────────
  const owner = { type: 'person', id: 'maya', display_name: 'Maya' };
  const ana = { type: 'person', id: 'ana', display_name: 'Ana' };
  const scope = bench.tenant.scope;
  const core = await SmartwareCore.open({ dataDir: CORE_DIR, ownerId: owner.id });
  core.ensureTrustedClientGrant(ana.id, 'person', [scope]);
  core.ensureScopes([{ id: scope, parent: null, visibility_default: 'workspace' }]);

  // ── Seed L0 observations (real evidence files + layer0 index) ──────────
  const obsIds = new Map(); // claim id -> observation id
  for (const fact of bench.claims) {
    const observed = await core.observe({
      actor: owner,
      type: 'message',
      content: { format: 'text/plain', body: fact.obs },
      scope,
      observed_at: fact.t_ingested,
      sensitive: fact.sensitive,
    });
    if (observed.status !== 'accepted' && observed.status !== 'duplicate') {
      throw new Error(`observe failed for ${fact.id}: ${JSON.stringify(observed)}`);
    }
    obsIds.set(fact.id, observed.existing_id ?? observed.id);
  }

  // ── Seed L1 claims (direct; ground-truth controlled) ───────────────────
  const dbPath = path.join(CORE_DIR, 'smartware.db');
  const store = new ClaimStore(dbPath);
  const subjectCreated = new Map();
  for (const fact of bench.claims) {
    if (!subjectCreated.has(fact.subject_id)) subjectCreated.set(fact.subject_id, fact.t_ingested);
  }
  for (const [subjectId, created] of subjectCreated) {
    const fact = bench.claims.find((f) => f.subject_id === subjectId);
    store.insertEntity({
      id: subjectId,
      canonical_name: fact.subject_name,
      aliases: [],
      type: fact.subject_type,
      scope,
      created_at: created,
    });
  }
  let opSeq = 0;
  for (const fact of bench.claims) {
    const t = (v) => (v === null ? { value: null, state: 'null', basis: null } : { value: v, state: 'known', basis: null });
    const opId = `op_${String(opSeq).padStart(26, '0')}`;
    opSeq += 1;
    store.insertClaim({
      id: fact.id,
      subject_id: fact.subject_id,
      subject_name: fact.subject_name,
      predicate: fact.predicate,
      object: fact.object,
      scope,
      validity: { from: fact.valid_from, to: fact.valid_to },
      t_ingested: t(fact.t_ingested),
      t_invalidated: { value: null, state: 'null', basis: null },
      t_valid_from: t(fact.valid_from),
      t_valid_to: t(fact.valid_to),
      source_event_id: obsIds.get(fact.id),
      extraction_event_id: obsIds.get(fact.id),
      supporting_evidence: [obsIds.get(fact.id)],
      extraction: { method: 'deterministic', model: null, compiler_version: '0.6.3', prompt_hash: null, extracted_at: fact.t_ingested },
      status: fact.status,
      epistemic: fact.epistemic,
      confidence: fact.confidence,
      sensitive: fact.sensitive,
      superseded_by: fact.superseded_by,
      contested_by: [],
      operation_id: opId,
      version_at: fact.t_ingested,
    });
    appendOpLogEntry(core.opsDir, {
      operation_id: opId,
      actor_id: owner.id,
      timestamp: fact.t_ingested,
      op: 'reflect.auto',
      details: { claim_ids: [fact.id] },
    });
  }
  store.close();

  // ── FTS sync + semantic index with the pinned model ────────────────────
  const searchIndex = new SearchIndex(dbPath);
  const claimStore = new ClaimStore(dbPath);
  const synced = syncSearchFromClaims(claimStore, searchIndex);
  claimStore.close();
  searchIndex.close();

  const adapter = loadFastembedAdapter();
  const semanticStore = new SemanticRecordStore(SEMANTIC_DB);
  const syncResult = await core.syncSemanticIndex(
    { actor: owner, scope },
    { adapter, store: semanticStore },
  );

  // ── Recall axis: hybrid via recallHybrid (pinned protocol) ─────────────
  const results = [];
  for (const query of bench.queries) {
    const actor = query.actor === 'staff' ? ana : owner;
    const start = performance.now();
    const outcome = await core.recallHybrid(
      { actor, query: query.query, scope, limit: topK },
      { adapter, store: semanticStore, min_similarity: pins.threshold, limit: topK },
    );
    const elapsedMs = performance.now() - start;
    if (outcome.selected_channel !== 'hybrid') {
      console.warn(`[smartware] ${query.id}: selected ${outcome.selected_channel} (${outcome.semantic_status})`);
    }
    results.push({
      query_id: query.id,
      category: query.category,
      engine: 'smartware',
      channel: outcome.selected_channel,
      semantic_status: outcome.semantic_status,
      result_ids: outcome.hybrid_results.map((hit) => hit.claim_id),
      ranks: outcome.hybrid_results.map((hit) => hit.claim_id),
      latency_ms: elapsedMs,
      query_embed_ms: adapter.embedMs(query.query),
      latency_end_to_end_ms: elapsedMs + (adapter.embedMs(query.query) ?? 0),
      scores: outcome.hybrid_results.map((hit) => hit.rrf_score),
    });
  }

  // ── Safety axis sanity: owner + sensitive opt-in ───────────────────────
  const optIn = await core.recallHybrid(
    { actor: owner, query: 'What is the private payroll adjustment?', scope, limit: topK, include_sensitive: true },
    { adapter, store: semanticStore, min_similarity: pins.threshold, limit: topK },
  );
  const optInIds = optIn.hybrid_results.map((hit) => hit.claim_id);

  // ── Temporal axis: canonical RECALL (hybrid excludes superseded) ───────
  const temporal = [];
  for (const tq of bench.temporal_queries) {
    const start = performance.now();
    const outcome = await core.recall({
      actor: owner,
      query: tq.query,
      scope,
      limit: topK,
      temporal: tq.temporal,
      include_superseded: tq.include_superseded ?? false,
      include_stale: tq.include_stale ?? false,
    });
    const elapsedMs = performance.now() - start;
    temporal.push({
      query_id: tq.id,
      engine: 'smartware',
      temporal: tq.temporal,
      result_ids: outcome.results.filter((r) => r.claim).map((r) => r.claim.id),
      latency_ms: elapsedMs,
    });
  }

  // ── Provenance-integrity: every hybrid hit resolves obs + ops entry ────
  const claimLookup = new ClaimStore(dbPath);
  const opsLookup = new Map();
  const opsDirEntries = fs.readdirSync(core.opsDir).filter((f) => f.endsWith('.jsonl'));
  for (const file of opsDirEntries) {
    const lines = fs.readFileSync(path.join(core.opsDir, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        opsLookup.set(entry.operation_id, entry);
      } catch { /* skip malformed */ }
    }
  }
  const provenance = [];
  const knownObsIds = new Set(obsIds.values());
  for (const result of results) {
    for (const claimId of result.result_ids) {
      const claim = claimLookup.getClaim(claimId);
      if (!claim) { provenance.push({ claim_id: claimId, ok: false, why: 'claim missing' }); continue; }
      const evidence = claim.supporting_evidence ?? [];
      const obsOk = evidence.length > 0 && evidence.every((id) => knownObsIds.has(id));
      const opOk = Boolean(opsLookup.get(claim.operation_id));
      provenance.push({
        claim_id: claimId,
        ok: obsOk && opOk,
        observation_ids: evidence,
        ops_entry_id: claim.operation_id,
        observation_resolved: obsOk,
        ops_entry_resolved: opOk,
      });
    }
  }
  claimLookup.close();

  const payload = {
    engine: 'smartware',
    benchmark: bench.name,
    pins,
    protocol: {
      threshold: pins.threshold,
      rerank: false,
      top_k: topK,
      embedding_model: adapter.model,
      temporal: 'separate axis via canonical RECALL',
    },
    index: {
      claims_total: bench.claims.length,
      claims_eligible_default: (await core.prepareSemanticDocuments({ actor: owner, scope })).length,
      embedding_model: adapter.model,
      semantic_sync: { embedded: syncResult.embedded, reused: syncResult.reused, count: (await core.prepareSemanticDocuments({ actor: owner, scope })).length },
    },
    results,
    temporal_results: temporal,
    provenance_integrity: {
      checked: provenance.length,
      ok: provenance.filter((p) => p.ok).length,
      failures: provenance.filter((p) => !p.ok),
    },
    safety_axis: {
      staff_forbidden_hits: results.find((r) => r.query_id === 'q20-safety-payroll-staff')?.result_ids.filter((id) => id === 'c_private_payroll').length ?? null,
      owner_opt_in_returned_payroll: optInIds.includes('c_private_payroll'),
    },
    latency: {
      recall_hybrid_engine_p50_ms: percentile(results.map((r) => r.latency_ms), 0.5),
      recall_hybrid_engine_p95_ms: percentile(results.map((r) => r.latency_ms), 0.95),
      recall_hybrid_end_to_end_p50_ms: percentile(results.map((r) => r.latency_end_to_end_ms), 0.5),
      recall_hybrid_end_to_end_p95_ms: percentile(results.map((r) => r.latency_end_to_end_ms), 0.95),
    },
  };
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'results-smartware.json'), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({
    engine: 'smartware',
    recall_hybrid_engine_p95_ms: payload.latency.recall_hybrid_engine_p95_ms,
    recall_hybrid_end_to_end_p95_ms: payload.latency.recall_hybrid_end_to_end_p95_ms,
    results: results.length,
    provenance_ok: `${provenance.filter((p) => p.ok).length}/${provenance.length}`,
    safety_forbidden_hits: payload.safety_axis.staff_forbidden_hits,
    owner_opt_in: payload.safety_axis.owner_opt_in_returned_payroll,
    temporal: temporal.map((tq) => ({ id: tq.query_id, ids: tq.result_ids.slice(0, 5) })),
  }, null, 2));
}

const obsIdsEntries = new Map();
main().catch((error) => { console.error(error); process.exitCode = 1; });
