import { describe, expect, it } from 'vitest';

import {
  evaluateRetrievalActivation,
  evaluateRetrievalArena,
  type RetrievalChannelObservation,
  type RetrievalEvaluationCase,
} from '../../src/evaluation/retrieval.js';

const cases: RetrievalEvaluationCase[] = [
  {
    id: 'current-project-state',
    category: 'current',
    query: 'What is the current state of Project Aster?',
    expected_ids: ['claim_aster_current'],
    forbidden_ids: ['claim_private'],
    obsolete_ids: ['claim_aster_old'],
    max_rank: 5,
  },
  {
    id: 'deployment-procedure',
    category: 'procedural',
    query: 'How do I deploy the worker safely?',
    expected_ids: ['claim_deploy_step_1', 'claim_deploy_step_2'],
    max_rank: 5,
  },
  {
    id: 'unknown-weather',
    category: 'negative',
    query: 'What will the weather be on Mars tomorrow?',
    expected_ids: [],
    should_abstain: true,
  },
];

function observations(
  overrides: Partial<Record<string, Partial<RetrievalChannelObservation>>> = {},
): RetrievalChannelObservation[] {
  const defaults: RetrievalChannelObservation[] = [
    {
      query_id: 'current-project-state',
      channel: 'hybrid',
      result_ids: ['claim_aster_current', 'claim_other'],
      latency_ms: 20,
      input_tokens: 10,
      cost_usd: 0.001,
    },
    {
      query_id: 'deployment-procedure',
      channel: 'hybrid',
      result_ids: ['claim_deploy_step_1', 'claim_other', 'claim_deploy_step_2'],
      latency_ms: 40,
      input_tokens: 20,
      output_tokens: 2,
      cost_usd: 0.002,
    },
    {
      query_id: 'unknown-weather',
      channel: 'hybrid',
      result_ids: [],
      abstained: true,
      latency_ms: 30,
    },
  ];
  return defaults.map(observation => ({
    ...observation,
    ...(overrides[observation.query_id] ?? {}),
  }));
}

describe('retrieval arena evaluation', () => {
  it('reports ranking, safety, abstention, latency, token, and cost metrics', () => {
    const result = evaluateRetrievalArena(cases, observations(), [{
      channel: 'hybrid',
      min_pass_rate: 1,
      min_recall_at_5: 1,
      min_mean_reciprocal_rank: 1,
      min_ndcg_at_10: 0.9,
      min_abstention_accuracy: 1,
      max_forbidden_hits: 0,
      max_obsolete_hits: 0,
      max_missing_observations: 0,
      max_latency_p95_ms: 50,
      max_cost_usd: 0.01,
    }]);

    expect(result.passed).toBe(true);
    expect(result.gates).toEqual([{
      channel: 'hybrid',
      passed: true,
      failures: [],
    }]);
    expect(result.channels).toHaveLength(1);
    const summary = result.channels[0]!;
    expect(summary.queries).toBe(3);
    expect(summary.scored_queries).toBe(2);
    expect(summary.pass_rate).toBe(1);
    expect(summary.hit_at_1).toBe(1);
    expect(summary.recall_at_1).toBe(0.75);
    expect(summary.recall_at_5).toBe(1);
    expect(summary.mean_reciprocal_rank).toBe(1);
    expect(summary.ndcg_at_10).toBeGreaterThan(0.9);
    expect(summary.abstention_accuracy).toBe(1);
    expect(summary.forbidden_hits).toBe(0);
    expect(summary.obsolete_hits).toBe(0);
    expect(summary.latency_p50_ms).toBe(30);
    expect(summary.latency_p95_ms).toBe(40);
    expect(summary.input_tokens).toBe(30);
    expect(summary.output_tokens).toBe(2);
    expect(summary.cost_usd).toBeCloseTo(0.003);
    expect(summary.categories.current?.queries).toBe(1);
    expect(summary.categories.procedural?.recall_at_5).toBe(1);
    expect(summary.categories.negative?.abstention_accuracy).toBe(1);
  });

  it('fails hard when an obsolete or forbidden memory is returned', () => {
    const result = evaluateRetrievalArena(cases, observations({
      'current-project-state': {
        result_ids: ['claim_private', 'claim_aster_old', 'claim_aster_current'],
      },
    }), [{
      channel: 'hybrid',
      max_forbidden_hits: 0,
      max_obsolete_hits: 0,
    }]);

    expect(result.passed).toBe(false);
    expect(result.gates[0]?.failures).toEqual([
      'forbidden_hits 1 exceeds 0',
      'obsolete_hits 1 exceeds 0',
    ]);
    expect(result.channels[0]?.queries_detail[0]).toMatchObject({
      passed: false,
      expected_rank: 3,
      forbidden_hits: ['claim_private'],
      obsolete_hits: ['claim_aster_old'],
    });
  });

  it('treats missing channel observations as failures instead of silently dropping cases', () => {
    const result = evaluateRetrievalArena(cases, observations().slice(0, 2), [{
      channel: 'hybrid',
      max_missing_observations: 0,
    }]);

    expect(result.passed).toBe(false);
    expect(result.channels[0]?.missing_observations).toBe(1);
    expect(result.gates[0]?.failures).toEqual([
      'missing_observations 1 exceeds 0',
    ]);
  });

  it('keeps channels separate so incomparable raw scores cannot be blended', () => {
    const lexical = observations().map(observation => ({
      ...observation,
      channel: 'lexical',
    }));
    const semantic = observations().map(observation => ({
      ...observation,
      channel: 'semantic',
    }));
    const result = evaluateRetrievalArena(cases, [...lexical, ...semantic]);

    expect(result.channels.map(channel => channel.channel)).toEqual([
      'lexical',
      'semantic',
    ]);
    expect(result.channels.every(channel => channel.pass_rate === 1)).toBe(true);
  });

  it('rejects malformed fixtures that could produce misleading scores', () => {
    expect(() => evaluateRetrievalArena([
      {
        ...cases[0]!,
        forbidden_ids: ['claim_aster_current'],
      },
    ], [])).toThrow('both expected and forbidden/obsolete');

    expect(() => evaluateRetrievalArena(cases, [
      observations()[0]!,
      observations()[0]!,
    ])).toThrow('Duplicate retrieval observation');

    expect(() => evaluateRetrievalArena(cases, [{
      query_id: 'unknown-query',
      channel: 'semantic',
      result_ids: [],
    }])).toThrow('Unknown retrieval query id');

    expect(() => evaluateRetrievalArena(cases, observations(), [{
      channel: 'hybrid',
      min_recall_at_5: 2,
    }])).toThrow('hybrid.min_recall_at_5 must be between 0 and 1');
  });
});

describe('retrieval activation evaluation', () => {
  function activationObservations(
    candidateOverrides: Partial<Record<string, Partial<RetrievalChannelObservation>>> = {},
  ): RetrievalChannelObservation[] {
    const candidate = observations(candidateOverrides);
    const baseline = observations({
      'deployment-procedure': {
        result_ids: ['claim_deploy_step_1'],
      },
    }).map(observation => ({
      ...observation,
      channel: 'lexical',
      latency_ms: 5,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    }));
    return [...baseline, ...candidate];
  }

  const activationPolicy = {
    baseline_channel: 'lexical',
    candidate_channel: 'hybrid',
    min_queries: 3,
    min_scored_queries: 2,
    min_query_wins: 1,
    max_query_losses: 0,
    max_candidate_latency_p95_ms: 50,
    max_candidate_cost_usd: 0.01,
  };
  const activationDigests = {
    arena_sha256: 'a'.repeat(64),
    run_sha256: 'b'.repeat(64),
  };

  it('promotes only held-out evidence with lift and no regression', () => {
    const result = evaluateRetrievalActivation(
      cases,
      activationObservations(),
      {
        dataset_status: 'held_out',
        data_classification: 'synthetic_non_user_data',
        ...activationDigests,
      },
      activationPolicy,
    );

    expect(result.decision).toBe('promote');
    expect(result.failures).toEqual([]);
    expect(result.comparison.query_wins).toBe(1);
    expect(result.comparison.query_losses).toBe(0);
    expect(result.comparison.winning_query_ids).toEqual(['deployment-procedure']);
    expect(result.comparison.deltas.recall_at_5).toBeGreaterThan(0);
  });

  it('holds public development evidence even when the candidate wins', () => {
    const result = evaluateRetrievalActivation(
      cases,
      activationObservations(),
      {
        dataset_status: 'development',
        data_classification: 'synthetic_non_user_data',
        ...activationDigests,
      },
      activationPolicy,
    );

    expect(result.decision).toBe('hold');
    expect(result.failures).toEqual([
      'dataset_status development is not held_out',
    ]);
  });

  it('fails closed on safety leaks and per-query regressions', () => {
    const result = evaluateRetrievalActivation(
      cases,
      activationObservations({
        'current-project-state': {
          result_ids: ['claim_private', 'claim_aster_old', 'claim_aster_current'],
        },
      }),
      {
        dataset_status: 'held_out',
        data_classification: 'synthetic_non_user_data',
        ...activationDigests,
      },
      activationPolicy,
    );

    expect(result.decision).toBe('hold');
    expect(result.comparison.losing_query_ids).toContain('current-project-state');
    expect(result.failures).toEqual(expect.arrayContaining([
      'candidate forbidden_hits 1 exceeds 0',
      'candidate obsolete_hits 1 exceeds 0',
      'query_losses 1 exceeds 0',
    ]));
  });
});
