// Observability — latency histograms (P1-3).
//
// Recall/write latency is reported to the host as a histogram, not an average:
// a mean hides the tail that makes a trial fail ("it was fine on average" is
// not an SLO). Samples are buffered per process and flushed to the metrics
// store (a) when the buffer grows, (b) when a health report is produced and
// (c) on close — so a SIGKILL can lose at most `flushEvery` samples of
// *operational* history and never a canonical write.
//
// Quantiles are reported as UPPER BOUNDS: the value returned for p95 is the
// smallest bucket edge whose cumulative count reaches 95% of samples, so the
// true p95 is ≤ the reported number. Bucket resolution is the honest limit of
// this measurement and is part of the contract (documented in
// docs/integration/observability.md). A quantile that lands in the overflow
// bucket is reported as null — "above the largest measurable bound" — rather
// than silently rounded down.

import type { MetricsStore, LatencyBatch } from './metrics.js';

/** Bucket edges in milliseconds, ascending. The last bucket is overflow. */
export const LATENCY_BUCKETS_MS: readonly number[] = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

/**
 * Operations whose latency is sampled at the host boundary. Data-plane calls
 * only: recall is the read path a company brain is judged on, the rest are the
 * writes a host performs. Control calls (health, status, sync status) are not
 * sampled — they are how you observe the system, not what it does for users.
 */
export const LATENCY_OPS: readonly string[] = [
  'recall',
  'observe',
  'query',
  'context',
  'correct',
  'endorse',
  'consolidate',
];

/** A bucket map: edge in ms -> count. `Infinity` is the overflow bucket. */
export type LatencyHistogram = Map<number, number>;

/**
 * Smallest bucket edge whose cumulative count reaches `quantile * samples`.
 * Null when there are no samples, or when the quantile falls in overflow.
 */
export function quantileUpperBoundMs(
  histogram: LatencyHistogram,
  quantile: number,
  samples: number,
): number | null {
  if (samples <= 0) return null;
  const target = Math.ceil(quantile * samples);
  let cumulative = 0;
  for (const edge of [...histogram.keys()].sort((left, right) => left - right)) {
    cumulative += histogram.get(edge) ?? 0;
    if (cumulative >= target) return Number.isFinite(edge) ? edge : null;
  }
  return null;
}

/** One operation's histogram as reported to a host. */
export interface LatencyReport {
  samples: number;
  buckets: Array<{ upper_ms: number | null; count: number }>;
  p50_ms_upper_bound: number | null;
  p95_ms_upper_bound: number | null;
  p99_ms_upper_bound: number | null;
  /** The slowest sample observed (not a bound — a measurement). */
  max_ms: number | null;
}

interface Accumulator {
  samples: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  buckets: LatencyHistogram;
}

export class LatencyRecorder {
  private readonly store: MetricsStore;
  private readonly flushEvery: number;
  private readonly buffers = new Map<string, Accumulator>();

  constructor(store: MetricsStore, flushEvery = 500) {
    this.store = store;
    this.flushEvery = flushEvery;
  }

  record(op: string, durationMs: number): void {
    const buffer = this.buffers.get(op) ?? { samples: 0, totalMs: 0, minMs: Infinity, maxMs: 0, buckets: new Map() };
    const edge = LATENCY_BUCKETS_MS.find(candidate => durationMs <= candidate) ?? Infinity;
    buffer.samples += 1;
    buffer.totalMs += durationMs;
    buffer.minMs = Math.min(buffer.minMs, durationMs);
    buffer.maxMs = Math.max(buffer.maxMs, durationMs);
    buffer.buckets.set(edge, (buffer.buckets.get(edge) ?? 0) + 1);
    this.buffers.set(op, buffer);
    if (buffer.samples >= this.flushEvery) this.flush();
  }

  /** Write every buffered sample to the durable store. Idempotent when empty. */
  flush(): void {
    if (this.buffers.size === 0) return;
    const batches: LatencyBatch[] = [];
    for (const [op, buffer] of this.buffers) {
      batches.push({
        op,
        samples: buffer.samples,
        total_ms: buffer.totalMs,
        min_ms: Number.isFinite(buffer.minMs) ? buffer.minMs : null,
        max_ms: buffer.maxMs,
        buckets: buffer.buckets,
      });
    }
    try {
      this.store.recordLatencyBatches(batches);
    } catch {
      // Metrics must never break the brain: a store failure drops the buffer.
      // (Operational history, not canonical memory — documented.)
    }
    this.buffers.clear();
  }

  /**
   * The reportable histograms: flush first, then read the durable rows so the
   * numbers a host sees are the same ones a restart sees.
   */
  report(): Record<string, LatencyReport> {
    this.flush();
    return this.store.latency();
  }

  close(): void {
    this.flush();
  }
}
