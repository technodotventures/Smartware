// Observability — the Coffee-trial SLO contract (P1-3).
//
// Thresholds are decisions, not measurements, so they are one exported table
// (`COFFEE_TRIAL_SLO`) shared by the evaluator, the tests and
// docs/integration/observability.md. Changing a threshold is a product change,
// and the doc says so.
//
// The evaluator reads a health report and returns objectives with three states:
//
//   pass    — measured, inside the threshold;
//   breach  — measured, outside it;
//   unknown — not enough evidence yet (too few latency samples, nothing synced,
//             no backup configured, a drift check that could not run).
//
// Overall status: `breach` > `unknown` > `ok`. A trial with unmeasured
// objectives is never `ok`: an unmeasured SLO is not a passing SLO.

import type { HealthReport } from '../protocol/health.js';

export interface CoffeeTrialSloPolicy {
  /** Upper bound for the recall latency histogram's p95 estimate, in ms. */
  recall_p95_ms: number;
  /** Upper bound for the write (observe) latency histogram's p95 estimate, ms. */
  write_p95_ms: number;
  /** Samples a latency histogram needs before its objective may claim a state. */
  min_latency_samples: number;
  /** Upper bound for the age of the oldest pending compile job, in seconds. */
  compile_queue_age_s: number;
  /** Terminal compile failures currently visible in the ledger. */
  compile_failures: number;
  /** Upper bound for the stalest ingestion stream lag, in seconds. */
  ingestion_lag_s: number;
  /** Upper bound for the newest backup artifact's age, in seconds (24 h). */
  backup_age_s: number;
  /** Stale-epoch write refusals. Expected only during an ownership takeover. */
  stale_writer_refusals: number;
}

export const COFFEE_TRIAL_SLO: CoffeeTrialSloPolicy = {
  recall_p95_ms: 1000,
  write_p95_ms: 500,
  min_latency_samples: 20,
  compile_queue_age_s: 900,
  compile_failures: 0,
  ingestion_lag_s: 300,
  backup_age_s: 86400,
  stale_writer_refusals: 0,
};

export type SloState = 'pass' | 'breach' | 'unknown';

export interface SloObjective {
  /** Stable id a host alerts on. */
  id: string;
  /** One plain sentence a trial operator can read without the spec. */
  statement: string;
  /** The reported field the objective reads (dotted path). */
  measure: string;
  unit: 'ms' | 's' | 'count';
  comparator: 'lte' | 'eq';
  threshold: number;
  /** Measured value, or null when nothing could be measured. */
  observed: number | null;
  /** Samples behind `observed` (latency objectives only; 0 otherwise). */
  samples: number;
  state: SloState;
  /** Why the state is `unknown`, when it is. */
  note?: string;
}

export interface SloReport {
  trial: 'coffee-trial';
  /** Evaluated against this clock. */
  as_of: string;
  /** The thresholds in force for this report. */
  policy: CoffeeTrialSloPolicy;
  status: 'ok' | 'breach' | 'unknown';
  objectives: SloObjective[];
}

function lte(
  id: string,
  statement: string,
  measure: string,
  unit: SloObjective['unit'],
  threshold: number,
  observed: number | null,
  unknownNote: string,
  samples = 0,
): SloObjective {
  if (observed === null) {
    return { id, statement, measure, unit, comparator: 'lte', threshold, observed: null, samples, state: 'unknown', note: unknownNote };
  }
  return {
    id, statement, measure, unit, comparator: 'lte', threshold, observed, samples,
    state: observed <= threshold ? 'pass' : 'breach',
  };
}

function latencyObjective(
  id: string,
  statement: string,
  p95: number | null,
  threshold: number,
  samples: number,
  minSamples: number,
): SloObjective {
  if (samples < minSamples) {
    return {
      id, statement, measure: `latency.${id === 'recall_p95_ms' ? 'recall' : 'observe'}.p95_ms_upper_bound`,
      unit: 'ms', comparator: 'lte', threshold, observed: null, samples,
      state: 'unknown',
      note: `needs at least ${minSamples} samples (has ${samples})`,
    };
  }
  if (p95 === null) {
    return {
      id, statement, measure: `latency.${id === 'recall_p95_ms' ? 'recall' : 'observe'}.p95_ms_upper_bound`,
      unit: 'ms', comparator: 'lte', threshold, observed: null, samples,
      state: 'unknown',
      note: 'p95 estimate fell in the overflow bucket — above the largest measurable bound',
    };
  }
  return {
    id, statement, measure: `latency.${id === 'recall_p95_ms' ? 'recall' : 'observe'}.p95_ms_upper_bound`,
    unit: 'ms', comparator: 'lte', threshold, observed: p95, samples,
    state: p95 <= threshold ? 'pass' : 'breach',
  };
}

export function evaluateCoffeeTrialSlo(report: HealthReport, now: Date = new Date()): SloReport {
  const objectives: SloObjective[] = [];

  const recall = report.latency?.recall;
  objectives.push(latencyObjective(
    'recall_p95_ms',
    'Recall answers inside the trial budget at the 95th percentile',
    recall?.p95_ms_upper_bound ?? null,
    COFFEE_TRIAL_SLO.recall_p95_ms,
    recall?.samples ?? 0,
    COFFEE_TRIAL_SLO.min_latency_samples,
  ));

  const write = report.latency?.observe;
  objectives.push(latencyObjective(
    'write_p95_ms',
    'Writes (observe) complete inside the trial budget at the 95th percentile',
    write?.p95_ms_upper_bound ?? null,
    COFFEE_TRIAL_SLO.write_p95_ms,
    write?.samples ?? 0,
    COFFEE_TRIAL_SLO.min_latency_samples,
  ));

  const queue = report.compile_queue ?? null;
  objectives.push(lte(
    'compile_queue_age_s',
    'No compile job sits unattended past the queue-age budget',
    'compile_queue.oldest_pending_age_seconds',
    's',
    COFFEE_TRIAL_SLO.compile_queue_age_s,
    queue === null ? null : (queue.oldest_pending_age_seconds ?? 0),
    queue === null ? 'the compile ledger did not open' : '',
  ));

  objectives.push(lte(
    'compile_failures',
    'No compile job is stuck in a terminal failed state',
    'compile_queue.failed',
    'count',
    COFFEE_TRIAL_SLO.compile_failures,
    queue === null ? null : queue.failed,
    'the compile ledger did not open',
  ));

  const ingestion = report.ingestion ?? null;
  objectives.push(lte(
    'ingestion_lag_s',
    'Every connected source has synced within the ingestion budget',
    'ingestion.max_lag_seconds',
    's',
    COFFEE_TRIAL_SLO.ingestion_lag_s,
    ingestion?.max_lag_seconds ?? null,
    ingestion === null ? 'no ingestion block in this report (owner-only)' : 'no source has ever synced',
  ));

  objectives.push(lte(
    'backup_age_s',
    'The newest backup artifact is inside the freshness budget',
    'backup.age_seconds',
    's',
    COFFEE_TRIAL_SLO.backup_age_s,
    report.backup && report.backup.configured ? report.backup.age_seconds : null,
    report.backup && report.backup.configured
      ? 'the backup directory exists but holds no artifact'
      : 'no backup directory configured',
  ));

  // Drift is a boolean check; the objective is `pass` only when every record
  // actually ran and agreed.
  const driftRecords = report.drift?.records ?? [];
  const driftStates = new Set(driftRecords.map(record => record.state));
  const driftUnknown = driftStates.has('unknown') || driftRecords.length === 0;
  const driftBreached = report.drift?.in_sync === false;
  objectives.push({
    id: 'drift',
    statement: 'Every derived projection still agrees with its canonical substrate',
    measure: 'drift.in_sync',
    unit: 'count',
    comparator: 'eq',
    threshold: 1,
    observed: driftRecords.length === 0 ? null : (driftBreached ? 0 : 1),
    samples: driftRecords.length,
    state: driftBreached ? 'breach' : (driftUnknown ? 'unknown' : 'pass'),
    ...(driftBreached
      ? {}
      : (driftUnknown ? { note: 'at least one projection check could not run yet' } : {})),
  });

  const refusals = report.ownership?.refusals ?? null;
  objectives.push(lte(
    'stale_writer_refusals',
    'No write was refused for a stale or missing ownership epoch',
    'ownership.refusals',
    'count',
    COFFEE_TRIAL_SLO.stale_writer_refusals,
    refusals,
    'ownership state was not reported',
  ));

  const status = objectives.some(objective => objective.state === 'breach')
    ? 'breach'
    : (objectives.some(objective => objective.state === 'unknown') ? 'unknown' : 'ok');

  return {
    trial: 'coffee-trial',
    as_of: now.toISOString(),
    policy: COFFEE_TRIAL_SLO,
    status,
    objectives,
  };
}
