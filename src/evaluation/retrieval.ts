export type RetrievalQueryCategory =
  | 'exact'
  | 'paraphrase'
  | 'entity'
  | 'current'
  | 'historical'
  | 'range'
  | 'multi_hop'
  | 'procedural'
  | 'negative'
  | 'safety';

export interface RetrievalEvaluationCase {
  id: string;
  category: RetrievalQueryCategory;
  query: string;
  expected_ids: string[];
  forbidden_ids?: string[];
  obsolete_ids?: string[];
  should_abstain?: boolean;
  max_rank?: number;
}

export interface RetrievalChannelObservation {
  query_id: string;
  channel: string;
  result_ids: string[];
  abstained?: boolean;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

export interface RetrievalQueryEvaluation {
  query_id: string;
  category: RetrievalQueryCategory;
  channel: string;
  passed: boolean;
  result_ids: string[];
  expected_ids: string[];
  expected_rank: number | null;
  hit_at_1: number;
  recall_at_1: number;
  recall_at_5: number;
  recall_at_10: number;
  recall_at_20: number;
  reciprocal_rank: number;
  ndcg_at_10: number;
  forbidden_hits: string[];
  obsolete_hits: string[];
  should_abstain: boolean;
  abstained: boolean;
  abstention_correct: boolean;
  missing_observation: boolean;
  latency_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface RetrievalMetricSummary {
  queries: number;
  scored_queries: number;
  passed: number;
  failed: number;
  pass_rate: number;
  hit_at_1: number;
  recall_at_1: number;
  recall_at_5: number;
  recall_at_10: number;
  recall_at_20: number;
  mean_reciprocal_rank: number;
  ndcg_at_10: number;
  abstention_accuracy: number;
  forbidden_hits: number;
  obsolete_hits: number;
  missing_observations: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface RetrievalChannelSummary extends RetrievalMetricSummary {
  channel: string;
  categories: Partial<Record<RetrievalQueryCategory, RetrievalMetricSummary>>;
  queries_detail: RetrievalQueryEvaluation[];
}

export interface RetrievalQualityGate {
  channel: string;
  min_pass_rate?: number;
  min_recall_at_5?: number;
  min_mean_reciprocal_rank?: number;
  min_ndcg_at_10?: number;
  min_abstention_accuracy?: number;
  max_forbidden_hits?: number;
  max_obsolete_hits?: number;
  max_missing_observations?: number;
  max_latency_p95_ms?: number;
  max_cost_usd?: number;
}

export interface RetrievalGateResult {
  channel: string;
  passed: boolean;
  failures: string[];
}

export interface RetrievalArenaEvaluation {
  passed: boolean;
  channels: RetrievalChannelSummary[];
  gates: RetrievalGateResult[];
}

export type RetrievalActivationDatasetStatus = 'development' | 'held_out';
export type RetrievalActivationDataClassification =
  | 'synthetic_non_user_data'
  | 'consented_user_data';

export interface RetrievalActivationEvidence {
  dataset_status: RetrievalActivationDatasetStatus;
  data_classification: RetrievalActivationDataClassification;
  arena_sha256: string;
  run_sha256: string;
}

export interface RetrievalActivationPolicy {
  baseline_channel: string;
  candidate_channel: string;
  min_queries?: number;
  min_scored_queries?: number;
  min_query_wins?: number;
  max_query_losses?: number;
  min_pass_rate_delta?: number;
  min_recall_at_5_delta?: number;
  min_mean_reciprocal_rank_delta?: number;
  min_ndcg_at_10_delta?: number;
  min_abstention_accuracy_delta?: number;
  max_candidate_latency_p95_ms?: number;
  max_candidate_cost_usd?: number;
}

export interface RetrievalActivationComparison {
  baseline_channel: string;
  candidate_channel: string;
  query_wins: number;
  query_losses: number;
  query_ties: number;
  winning_query_ids: string[];
  losing_query_ids: string[];
  deltas: {
    pass_rate: number;
    recall_at_5: number;
    mean_reciprocal_rank: number;
    ndcg_at_10: number;
    abstention_accuracy: number;
  };
}

export interface RetrievalActivationEvaluation {
  passed: boolean;
  decision: 'promote' | 'hold';
  failures: string[];
  evidence: RetrievalActivationEvidence;
  baseline: RetrievalChannelSummary;
  candidate: RetrievalChannelSummary;
  comparison: RetrievalActivationComparison;
}

const RETRIEVAL_QUERY_CATEGORIES: ReadonlySet<string> = new Set([
  'exact',
  'paraphrase',
  'entity',
  'current',
  'historical',
  'range',
  'multi_hop',
  'procedural',
  'negative',
  'safety',
]);

function assertFiniteNonNegative(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) throw new Error(`${label} must not contain empty ids`);
    if (seen.has(value)) throw new Error(`${label} contains duplicate id: ${value}`);
    seen.add(value);
  }
}

function validateCases(cases: RetrievalEvaluationCase[]): void {
  if (cases.length === 0) throw new Error('Retrieval arena must contain at least one case');
  assertUnique(cases.map(testCase => testCase.id), 'Retrieval case ids');

  for (const testCase of cases) {
    if (!RETRIEVAL_QUERY_CATEGORIES.has(testCase.category)) {
      throw new Error(`${testCase.id}.category is not supported: ${testCase.category}`);
    }
    if (!testCase.query.trim()) throw new Error(`Retrieval case ${testCase.id} has an empty query`);
    assertUnique(testCase.expected_ids, `${testCase.id}.expected_ids`);
    assertUnique(testCase.forbidden_ids ?? [], `${testCase.id}.forbidden_ids`);
    assertUnique(testCase.obsolete_ids ?? [], `${testCase.id}.obsolete_ids`);
    if (testCase.max_rank !== undefined
      && (!Number.isInteger(testCase.max_rank) || testCase.max_rank < 1)) {
      throw new Error(`${testCase.id}.max_rank must be a positive integer`);
    }

    const expected = new Set(testCase.expected_ids);
    for (const id of [...(testCase.forbidden_ids ?? []), ...(testCase.obsolete_ids ?? [])]) {
      if (expected.has(id)) {
        throw new Error(`${testCase.id} marks ${id} as both expected and forbidden/obsolete`);
      }
    }

    const shouldAbstain = testCase.should_abstain ?? testCase.expected_ids.length === 0;
    if (shouldAbstain && testCase.expected_ids.length > 0) {
      throw new Error(`${testCase.id} cannot both expect results and require abstention`);
    }
  }
}

function validateObservations(
  cases: RetrievalEvaluationCase[],
  observations: RetrievalChannelObservation[],
): void {
  const caseIds = new Set(cases.map(testCase => testCase.id));
  const keys = new Set<string>();
  for (const observation of observations) {
    if (!caseIds.has(observation.query_id)) {
      throw new Error(`Unknown retrieval query id: ${observation.query_id}`);
    }
    if (!observation.channel.trim()) {
      throw new Error(`Retrieval observation for ${observation.query_id} has an empty channel`);
    }
    if (observation.channel !== observation.channel.trim()) {
      throw new Error(
        `Retrieval observation channel must not contain surrounding whitespace: ${observation.channel}`,
      );
    }
    const key = `${observation.channel}\u0000${observation.query_id}`;
    if (keys.has(key)) {
      throw new Error(
        `Duplicate retrieval observation for ${observation.channel}/${observation.query_id}`,
      );
    }
    keys.add(key);
    assertUnique(
      observation.result_ids,
      `${observation.channel}/${observation.query_id}.result_ids`,
    );
    assertFiniteNonNegative(observation.latency_ms, 'latency_ms');
    assertFiniteNonNegative(observation.input_tokens, 'input_tokens');
    assertFiniteNonNegative(observation.output_tokens, 'output_tokens');
    assertFiniteNonNegative(observation.cost_usd, 'cost_usd');
  }
}

function validateGates(gates: RetrievalQualityGate[]): void {
  assertUnique(gates.map(gate => gate.channel), 'Retrieval gate channels');
  for (const gate of gates) {
    if (gate.channel !== gate.channel.trim()) {
      throw new Error(`Retrieval gate channel must not contain surrounding whitespace: ${gate.channel}`);
    }
    const proportions: Array<[number | undefined, string]> = [
      [gate.min_pass_rate, 'min_pass_rate'],
      [gate.min_recall_at_5, 'min_recall_at_5'],
      [gate.min_mean_reciprocal_rank, 'min_mean_reciprocal_rank'],
      [gate.min_ndcg_at_10, 'min_ndcg_at_10'],
      [gate.min_abstention_accuracy, 'min_abstention_accuracy'],
    ];
    for (const [value, name] of proportions) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
        throw new Error(`${gate.channel}.${name} must be between 0 and 1`);
      }
    }
    assertFiniteNonNegative(gate.max_forbidden_hits, `${gate.channel}.max_forbidden_hits`);
    assertFiniteNonNegative(gate.max_obsolete_hits, `${gate.channel}.max_obsolete_hits`);
    assertFiniteNonNegative(
      gate.max_missing_observations,
      `${gate.channel}.max_missing_observations`,
    );
    assertFiniteNonNegative(gate.max_latency_p95_ms, `${gate.channel}.max_latency_p95_ms`);
    assertFiniteNonNegative(gate.max_cost_usd, `${gate.channel}.max_cost_usd`);
  }
}

function validateActivationPolicy(policy: RetrievalActivationPolicy): void {
  if (!policy.baseline_channel.trim() || !policy.candidate_channel.trim()) {
    throw new Error('Retrieval activation channels must not be empty');
  }
  if (policy.baseline_channel !== policy.baseline_channel.trim()
    || policy.candidate_channel !== policy.candidate_channel.trim()) {
    throw new Error('Retrieval activation channels must not contain surrounding whitespace');
  }
  if (policy.baseline_channel === policy.candidate_channel) {
    throw new Error('Retrieval activation baseline and candidate channels must differ');
  }
  const counts: Array<[number | undefined, string]> = [
    [policy.min_queries, 'min_queries'],
    [policy.min_scored_queries, 'min_scored_queries'],
    [policy.min_query_wins, 'min_query_wins'],
    [policy.max_query_losses, 'max_query_losses'],
  ];
  for (const [value, name] of counts) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
  const deltas: Array<[number | undefined, string]> = [
    [policy.min_pass_rate_delta, 'min_pass_rate_delta'],
    [policy.min_recall_at_5_delta, 'min_recall_at_5_delta'],
    [policy.min_mean_reciprocal_rank_delta, 'min_mean_reciprocal_rank_delta'],
    [policy.min_ndcg_at_10_delta, 'min_ndcg_at_10_delta'],
    [policy.min_abstention_accuracy_delta, 'min_abstention_accuracy_delta'],
  ];
  for (const [value, name] of deltas) {
    if (value !== undefined && (!Number.isFinite(value) || value < -1 || value > 1)) {
      throw new Error(`${name} must be between -1 and 1`);
    }
  }
  assertFiniteNonNegative(
    policy.max_candidate_latency_p95_ms,
    'max_candidate_latency_p95_ms',
  );
  assertFiniteNonNegative(policy.max_candidate_cost_usd, 'max_candidate_cost_usd');
}

function validateActivationEvidence(evidence: RetrievalActivationEvidence): void {
  if (!['development', 'held_out'].includes(evidence.dataset_status)) {
    throw new Error(`Unsupported retrieval activation dataset status: ${evidence.dataset_status}`);
  }
  if (!['synthetic_non_user_data', 'consented_user_data']
    .includes(evidence.data_classification)) {
    throw new Error(
      `Unsupported retrieval activation data classification: ${evidence.data_classification}`,
    );
  }
  for (const [value, label] of [
    [evidence.arena_sha256, 'arena_sha256'],
    [evidence.run_sha256, 'run_sha256'],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`Retrieval activation ${label} must be a lowercase SHA-256 digest`);
    }
  }
}

function recallAt(
  resultIds: string[],
  expectedIds: string[],
  limit: number,
): number {
  if (expectedIds.length === 0) return 0;
  const expected = new Set(expectedIds);
  const hits = resultIds.slice(0, limit).filter(id => expected.has(id)).length;
  return hits / expectedIds.length;
}

function ndcgAt10(resultIds: string[], expectedIds: string[]): number {
  if (expectedIds.length === 0) return 0;
  const expected = new Set(expectedIds);
  const dcg = resultIds.slice(0, 10).reduce(
    (sum, id, index) => sum + (expected.has(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealCount = Math.min(expectedIds.length, 10);
  const ideal = Array.from({ length: idealCount }, (_value, index) => index).reduce(
    (sum, index) => sum + 1 / Math.log2(index + 2),
    0,
  );
  return ideal === 0 ? 0 : dcg / ideal;
}

function percentile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[index] ?? null;
}

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function evaluateQuery(
  testCase: RetrievalEvaluationCase,
  channel: string,
  observation: RetrievalChannelObservation | undefined,
): RetrievalQueryEvaluation {
  const resultIds = observation?.result_ids ?? [];
  const expected = new Set(testCase.expected_ids);
  const firstExpectedIndex = resultIds.findIndex(id => expected.has(id));
  const expectedRank = firstExpectedIndex === -1 ? null : firstExpectedIndex + 1;
  const forbidden = new Set(testCase.forbidden_ids ?? []);
  const obsolete = new Set(testCase.obsolete_ids ?? []);
  const forbiddenHits = resultIds.filter(id => forbidden.has(id));
  const obsoleteHits = resultIds.filter(id => obsolete.has(id));
  const shouldAbstain = testCase.should_abstain ?? testCase.expected_ids.length === 0;
  const abstained = observation?.abstained ?? resultIds.length === 0;
  const abstentionCorrect = shouldAbstain === abstained;
  const maxRank = testCase.max_rank ?? 5;
  const retrievalCorrect = shouldAbstain
    ? abstained
    : expectedRank !== null && expectedRank <= maxRank && !abstained;
  const passed = Boolean(observation)
    && retrievalCorrect
    && forbiddenHits.length === 0
    && obsoleteHits.length === 0;

  return {
    query_id: testCase.id,
    category: testCase.category,
    channel,
    passed,
    result_ids: [...resultIds],
    expected_ids: [...testCase.expected_ids],
    expected_rank: expectedRank,
    hit_at_1: expectedRank === 1 ? 1 : 0,
    recall_at_1: recallAt(resultIds, testCase.expected_ids, 1),
    recall_at_5: recallAt(resultIds, testCase.expected_ids, 5),
    recall_at_10: recallAt(resultIds, testCase.expected_ids, 10),
    recall_at_20: recallAt(resultIds, testCase.expected_ids, 20),
    reciprocal_rank: expectedRank === null ? 0 : 1 / expectedRank,
    ndcg_at_10: ndcgAt10(resultIds, testCase.expected_ids),
    forbidden_hits: forbiddenHits,
    obsolete_hits: obsoleteHits,
    should_abstain: shouldAbstain,
    abstained,
    abstention_correct: abstentionCorrect,
    missing_observation: observation === undefined,
    latency_ms: observation?.latency_ms ?? null,
    input_tokens: observation?.input_tokens ?? 0,
    output_tokens: observation?.output_tokens ?? 0,
    cost_usd: observation?.cost_usd ?? 0,
  };
}

function summarize(evaluations: RetrievalQueryEvaluation[]): RetrievalMetricSummary {
  const scored = evaluations.filter(result => !result.should_abstain);
  return {
    queries: evaluations.length,
    scored_queries: scored.length,
    passed: evaluations.filter(result => result.passed).length,
    failed: evaluations.filter(result => !result.passed).length,
    pass_rate: evaluations.length === 0
      ? 0
      : evaluations.filter(result => result.passed).length / evaluations.length,
    hit_at_1: average(scored.map(result => result.hit_at_1)),
    recall_at_1: average(scored.map(result => result.recall_at_1)),
    recall_at_5: average(scored.map(result => result.recall_at_5)),
    recall_at_10: average(scored.map(result => result.recall_at_10)),
    recall_at_20: average(scored.map(result => result.recall_at_20)),
    mean_reciprocal_rank: average(scored.map(result => result.reciprocal_rank)),
    ndcg_at_10: average(scored.map(result => result.ndcg_at_10)),
    abstention_accuracy: average(evaluations.map(result => result.abstention_correct ? 1 : 0)),
    forbidden_hits: evaluations.reduce(
      (sum, result) => sum + result.forbidden_hits.length,
      0,
    ),
    obsolete_hits: evaluations.reduce(
      (sum, result) => sum + result.obsolete_hits.length,
      0,
    ),
    missing_observations: evaluations.filter(result => result.missing_observation).length,
    latency_p50_ms: percentile(
      evaluations.flatMap(result => result.latency_ms === null ? [] : [result.latency_ms]),
      0.5,
    ),
    latency_p95_ms: percentile(
      evaluations.flatMap(result => result.latency_ms === null ? [] : [result.latency_ms]),
      0.95,
    ),
    input_tokens: evaluations.reduce((sum, result) => sum + result.input_tokens, 0),
    output_tokens: evaluations.reduce((sum, result) => sum + result.output_tokens, 0),
    cost_usd: evaluations.reduce((sum, result) => sum + result.cost_usd, 0),
  };
}

function summarizeChannel(
  channel: string,
  evaluations: RetrievalQueryEvaluation[],
): RetrievalChannelSummary {
  const categories: RetrievalChannelSummary['categories'] = {};
  for (const category of new Set(evaluations.map(result => result.category))) {
    categories[category] = summarize(
      evaluations.filter(result => result.category === category),
    );
  }
  return {
    channel,
    ...summarize(evaluations),
    categories,
    queries_detail: evaluations,
  };
}

function evaluateGate(
  summary: RetrievalChannelSummary | undefined,
  gate: RetrievalQualityGate,
): RetrievalGateResult {
  if (!summary) {
    return {
      channel: gate.channel,
      passed: false,
      failures: [`channel ${gate.channel} has no observations`],
    };
  }

  const failures: string[] = [];
  const minimums: Array<[number | undefined, number, string]> = [
    [gate.min_pass_rate, summary.pass_rate, 'pass_rate'],
    [gate.min_recall_at_5, summary.recall_at_5, 'recall_at_5'],
    [gate.min_mean_reciprocal_rank, summary.mean_reciprocal_rank, 'mean_reciprocal_rank'],
    [gate.min_ndcg_at_10, summary.ndcg_at_10, 'ndcg_at_10'],
    [gate.min_abstention_accuracy, summary.abstention_accuracy, 'abstention_accuracy'],
  ];
  for (const [required, actual, metric] of minimums) {
    if (required !== undefined && actual < required) {
      failures.push(`${metric} ${actual} is below ${required}`);
    }
  }

  const maximums: Array<[number | undefined, number | null, string]> = [
    [gate.max_forbidden_hits, summary.forbidden_hits, 'forbidden_hits'],
    [gate.max_obsolete_hits, summary.obsolete_hits, 'obsolete_hits'],
    [gate.max_missing_observations, summary.missing_observations, 'missing_observations'],
    [gate.max_latency_p95_ms, summary.latency_p95_ms, 'latency_p95_ms'],
    [gate.max_cost_usd, summary.cost_usd, 'cost_usd'],
  ];
  for (const [required, actual, metric] of maximums) {
    if (required !== undefined && (actual === null || actual > required)) {
      failures.push(`${metric} ${actual ?? 'unreported'} exceeds ${required}`);
    }
  }

  return {
    channel: gate.channel,
    passed: failures.length === 0,
    failures,
  };
}

export function evaluateRetrievalArena(
  cases: RetrievalEvaluationCase[],
  observations: RetrievalChannelObservation[],
  gates: RetrievalQualityGate[] = [],
): RetrievalArenaEvaluation {
  validateCases(cases);
  validateObservations(cases, observations);
  validateGates(gates);

  const channels = [...new Set([
    ...observations.map(observation => observation.channel),
    ...gates.map(gate => gate.channel),
  ])].sort();
  const byKey = new Map(observations.map(observation => [
    `${observation.channel}\u0000${observation.query_id}`,
    observation,
  ]));
  const summaries = channels.map(channel => summarizeChannel(
    channel,
    cases.map(testCase => evaluateQuery(
      testCase,
      channel,
      byKey.get(`${channel}\u0000${testCase.id}`),
    )),
  ));
  const gateResults = gates.map(gate => evaluateGate(
    summaries.find(summary => summary.channel === gate.channel),
    gate,
  ));

  return {
    passed: gateResults.length > 0
      ? gateResults.every(gate => gate.passed)
      : summaries.every(summary => summary.failed === 0),
    channels: summaries,
    gates: gateResults,
  };
}

const ACTIVATION_EPSILON = 1e-12;

function compareQuery(
  baseline: RetrievalQueryEvaluation,
  candidate: RetrievalQueryEvaluation,
): -1 | 0 | 1 {
  const baselineMetrics = baseline.should_abstain
    ? [baseline.abstention_correct ? 1 : 0]
    : [
        baseline.passed ? 1 : 0,
        baseline.recall_at_5,
        baseline.reciprocal_rank,
        baseline.ndcg_at_10,
      ];
  const candidateMetrics = candidate.should_abstain
    ? [candidate.abstention_correct ? 1 : 0]
    : [
        candidate.passed ? 1 : 0,
        candidate.recall_at_5,
        candidate.reciprocal_rank,
        candidate.ndcg_at_10,
      ];
  const regressed = candidateMetrics.some(
    (value, index) => value < baselineMetrics[index]! - ACTIVATION_EPSILON,
  );
  if (regressed) return -1;
  const improved = candidateMetrics.some(
    (value, index) => value > baselineMetrics[index]! + ACTIVATION_EPSILON,
  );
  return improved ? 1 : 0;
}

export function evaluateRetrievalActivation(
  cases: RetrievalEvaluationCase[],
  observations: RetrievalChannelObservation[],
  evidence: RetrievalActivationEvidence,
  policy: RetrievalActivationPolicy,
): RetrievalActivationEvaluation {
  validateActivationEvidence(evidence);
  validateActivationPolicy(policy);
  const arena = evaluateRetrievalArena(cases, observations);
  const baseline = arena.channels.find(
    channel => channel.channel === policy.baseline_channel,
  );
  const candidate = arena.channels.find(
    channel => channel.channel === policy.candidate_channel,
  );
  if (!baseline) {
    throw new Error(`Baseline channel has no observations: ${policy.baseline_channel}`);
  }
  if (!candidate) {
    throw new Error(`Candidate channel has no observations: ${policy.candidate_channel}`);
  }

  const baselineByQuery = new Map(
    baseline.queries_detail.map(result => [result.query_id, result]),
  );
  const winningQueryIds: string[] = [];
  const losingQueryIds: string[] = [];
  for (const candidateQuery of candidate.queries_detail) {
    const baselineQuery = baselineByQuery.get(candidateQuery.query_id);
    if (!baselineQuery) continue;
    const comparison = compareQuery(baselineQuery, candidateQuery);
    if (comparison > 0) winningQueryIds.push(candidateQuery.query_id);
    if (comparison < 0) losingQueryIds.push(candidateQuery.query_id);
  }
  const comparison: RetrievalActivationComparison = {
    baseline_channel: baseline.channel,
    candidate_channel: candidate.channel,
    query_wins: winningQueryIds.length,
    query_losses: losingQueryIds.length,
    query_ties: cases.length - winningQueryIds.length - losingQueryIds.length,
    winning_query_ids: winningQueryIds,
    losing_query_ids: losingQueryIds,
    deltas: {
      pass_rate: candidate.pass_rate - baseline.pass_rate,
      recall_at_5: candidate.recall_at_5 - baseline.recall_at_5,
      mean_reciprocal_rank:
        candidate.mean_reciprocal_rank - baseline.mean_reciprocal_rank,
      ndcg_at_10: candidate.ndcg_at_10 - baseline.ndcg_at_10,
      abstention_accuracy:
        candidate.abstention_accuracy - baseline.abstention_accuracy,
    },
  };

  const failures: string[] = [];
  if (evidence.dataset_status !== 'held_out') {
    failures.push(
      `dataset_status ${evidence.dataset_status} is not held_out`,
    );
  }
  const minQueries = policy.min_queries ?? 1;
  if (candidate.queries < minQueries) {
    failures.push(`queries ${candidate.queries} is below ${minQueries}`);
  }
  const minScoredQueries = policy.min_scored_queries ?? 1;
  if (candidate.scored_queries < minScoredQueries) {
    failures.push(
      `scored_queries ${candidate.scored_queries} is below ${minScoredQueries}`,
    );
  }
  if (baseline.missing_observations > 0) {
    failures.push(
      `baseline missing_observations ${baseline.missing_observations} exceeds 0`,
    );
  }
  const hardCandidateMaximums: Array<[number, string]> = [
    [candidate.forbidden_hits, 'forbidden_hits'],
    [candidate.obsolete_hits, 'obsolete_hits'],
    [candidate.missing_observations, 'missing_observations'],
  ];
  for (const [actual, metric] of hardCandidateMaximums) {
    if (actual > 0) failures.push(`candidate ${metric} ${actual} exceeds 0`);
  }

  const minimumDeltas: Array<[number, number, string]> = [
    [policy.min_pass_rate_delta ?? 0, comparison.deltas.pass_rate, 'pass_rate'],
    [policy.min_recall_at_5_delta ?? 0, comparison.deltas.recall_at_5, 'recall_at_5'],
    [
      policy.min_mean_reciprocal_rank_delta ?? 0,
      comparison.deltas.mean_reciprocal_rank,
      'mean_reciprocal_rank',
    ],
    [policy.min_ndcg_at_10_delta ?? 0, comparison.deltas.ndcg_at_10, 'ndcg_at_10'],
    [
      policy.min_abstention_accuracy_delta ?? 0,
      comparison.deltas.abstention_accuracy,
      'abstention_accuracy',
    ],
  ];
  for (const [required, actual, metric] of minimumDeltas) {
    if (actual < required - ACTIVATION_EPSILON) {
      failures.push(`${metric}_delta ${actual} is below ${required}`);
    }
  }
  const minWins = policy.min_query_wins ?? 1;
  if (comparison.query_wins < minWins) {
    failures.push(`query_wins ${comparison.query_wins} is below ${minWins}`);
  }
  const maxLosses = policy.max_query_losses ?? 0;
  if (comparison.query_losses > maxLosses) {
    failures.push(`query_losses ${comparison.query_losses} exceeds ${maxLosses}`);
  }
  if (policy.max_candidate_latency_p95_ms !== undefined
    && (candidate.latency_p95_ms === null
      || candidate.latency_p95_ms > policy.max_candidate_latency_p95_ms)) {
    failures.push(
      `candidate latency_p95_ms ${candidate.latency_p95_ms ?? 'unreported'}`
      + ` exceeds ${policy.max_candidate_latency_p95_ms}`,
    );
  }
  if (policy.max_candidate_cost_usd !== undefined
    && candidate.cost_usd > policy.max_candidate_cost_usd) {
    failures.push(
      `candidate cost_usd ${candidate.cost_usd} exceeds ${policy.max_candidate_cost_usd}`,
    );
  }

  return {
    passed: failures.length === 0,
    decision: failures.length === 0 ? 'promote' : 'hold',
    failures,
    evidence,
    baseline,
    candidate,
    comparison,
  };
}
