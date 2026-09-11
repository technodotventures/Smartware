// Head-to-head comparison: Smartware vs mem0 on the curated company-brain set.
// Reuses the official evaluator (evaluateRetrievalArena) so metric math is
// identical for both engines. Output: .spike-h2h/head-to-head-report.json
import fs from 'node:fs';
import path from 'node:path';
import { evaluateRetrievalArena } from '../dist/core.js';

const ROOT = path.resolve(process.cwd(), '.spike-h2h');
const BENCH = path.resolve(process.cwd(), 'benchmarks/retrieval/mem0-h2h-companybrain-v1.json');
const smartware = JSON.parse(fs.readFileSync(path.join(ROOT, 'results-smartware.json'), 'utf8'));
const mem0 = JSON.parse(fs.readFileSync(path.join(ROOT, 'results-mem0.json'), 'utf8'));

const bench = JSON.parse(fs.readFileSync(BENCH, 'utf8'));
const cases = bench.queries.map((query) => ({
  id: query.id,
  category: query.category,
  query: query.query,
  expected_ids: query.expected_ids ?? [],
  forbidden_ids: query.forbidden_ids ?? [],
  obsolete_ids: query.obsolete_ids ?? [],
  should_abstain: query.should_abstain ?? false,
}));

function observations(run, engineName) {
  return run.results.map((result) => ({
    query_id: result.query_id,
    channel: engineName,
    result_ids: result.result_ids,
    latency_ms: result.latency_ms,
  }));
}

const evaluation = evaluateRetrievalArena(
  cases,
  [...observations(smartware, 'smartware'), ...observations(mem0, 'mem0')],
  [],
);

function summarize(channelSummary) {
  return {
    queries: channelSummary.queries,
    scored_queries: channelSummary.scored_queries,
    pass_rate: channelSummary.pass_rate,
    hit_at_1: channelSummary.hit_at_1,
    recall_at_1: channelSummary.recall_at_1,
    recall_at_5: channelSummary.recall_at_5,
    recall_at_10: channelSummary.recall_at_10,
    mrru: channelSummary.mean_reciprocal_rank,
    ndcg_at_10: channelSummary.ndcg_at_10,
    abstention_accuracy: channelSummary.abstention_accuracy,
    forbidden_hits: channelSummary.forbidden_hits,
    obsolete_hits: channelSummary.obsolete_hits,
  };
}

const sw = evaluation.channels.find((channel) => channel.channel === 'smartware');
const m0 = evaluation.channels.find((channel) => channel.channel === 'mem0');

// Per-query comparison table
const perQuery = sw.queries_detail.map((q) => {
  const other = m0.queries_detail.find((x) => x.query_id === q.query_id);
  return {
    query_id: q.query_id,
    category: q.category,
    smartware: { rank: q.expected_rank, recall5: q.recall_at_5, rr: q.reciprocal_rank, ndcg10: q.ndcg_at_10, forbidden: q.forbidden_hits, obsolete: q.obsolete_hits, passed: q.passed },
    mem0: { rank: other.expected_rank, recall5: other.recall_at_5, rr: other.reciprocal_rank, ndcg10: other.ndcg_at_10, forbidden: other.forbidden_hits, obsolete: other.obsolete_hits, passed: other.passed },
  };
});

const scoredWins = perQuery.filter((entry) => {
  const expected = bench.queries.find((query) => query.id === entry.query_id)?.expected_ids ?? [];
  return expected.length > 0 && !(bench.queries.find((query) => query.id === entry.query_id)?.should_abstain ?? false);
});
const smartwareWins = scoredWins.filter((entry) => entry.smartware.rr > entry.mem0.rr);
const mem0Wins = scoredWins.filter((entry) => entry.mem0.rr > entry.smartware.rr);
const ties = scoredWins.filter((entry) => entry.smartware.rr === entry.mem0.rr);

const smartwareAll = {
  result_ids: smartware.results.map((r) => r.result_ids),
  ranks: smartware.results.map((r) => r.result_ids),
};

const report = {
  benchmark: bench.name,
  pins: bench.pins,
  engines: {
    smartware: {
      metrics: summarize(sw),
      latency_p95_ms: smartware.latency.recall_hybrid_end_to_end_p95_ms,
      latency_p95_engine_only_ms: smartware.latency.recall_hybrid_engine_p95_ms,
      provenance_ok: smartware.provenance_integrity.ok,
      provenance_checked: smartware.provenance_integrity.checked,
      safety_staff_forbidden_hits: smartware.safety_axis.staff_forbidden_hits,
      safety_owner_opt_in: smartware.safety_axis.owner_opt_in_returned_payroll,
      temporal: smartware.temporal_results,
    },
    mem0: {
      metrics: summarize(m0),
      latency_p95_ms: mem0.latency.search_p95_ms,
      provenance: 'NONE: mem0 OSS results carry data+metadata only; no observation/ops lineage object',
      safety_staff_forbidden_hits: mem0.safety_axis.staff_forbidden_hits,
      temporal: mem0.temporal_results,
    },
  },
  scoring: {
    scored_queries: scoredWins.length,
    smartware_wins: smartwareWins.map((entry) => entry.query_id),
    mem0_wins: mem0Wins.map((entry) => entry.query_id),
    ties: ties.map((entry) => entry.query_id),
  },
  per_query: perQuery,
  temporal_axis: {
    smartware: smartware.temporal_results.map((t) => ({ id: t.query_id, top_ids: t.result_ids.slice(0, 3), latency_ms: t.latency_ms })),
    mem0: mem0.temporal_results.map((t) => ({ id: t.query_id, supported: t.supported, classification: t.classification, error: t.error })),
  },
};

fs.writeFileSync(path.join(ROOT, 'head-to-head-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  smartware: report.engines.smartware.metrics,
  mem0: report.engines.mem0.metrics,
  wins: report.scoring,
  latency: {
    smartware_end_to_end_p95: report.engines.smartware.latency_p95_ms,
    mem0_p95: report.engines.mem0.latency_p95_ms,
  },
  safety: {
    smartware_staff_forbidden: report.engines.smartware.safety_staff_forbidden_hits,
    mem0_staff_forbidden: report.engines.mem0.safety_staff_forbidden_hits,
  },
}, null, 2));
