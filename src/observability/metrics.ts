// Observability — durable operational metrics (P1-3).
//
// This store holds *operational* observations about the brain: refusals the
// boundary denied, latency samples of host-facing calls, and the recovery
// summaries recorded at open. It is not canonical and not regenerable — a
// wiped metrics DB loses history but nothing of the brain's memory (the same
// honesty note as the ingestion ledger). It lives beside the other derived
// SQLite artifacts at `<dataDir>/indices/metrics.db` so it can be deleted
// without touching canonical state.
//
// Privacy: rows here carry codes, operation names and timestamps only. No
// scope, no actor id, no content. That is what lets the health surface report
// denials without leaking tenant structure.

import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';

import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';
import { quantileUpperBoundMs, type LatencyHistogram, type LatencyReport } from './latency.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metric_denials (
  code TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_at TEXT
);

CREATE TABLE IF NOT EXISTS metric_denial_recent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  code TEXT NOT NULL,
  op TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metric_latency (
  op TEXT PRIMARY KEY,
  samples INTEGER NOT NULL DEFAULT 0,
  total_ms REAL NOT NULL DEFAULT 0,
  min_ms REAL,
  max_ms REAL
);

CREATE TABLE IF NOT EXISTS metric_latency_buckets (
  op TEXT NOT NULL,
  upper_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (op, upper_ms)
);

CREATE TABLE IF NOT EXISTS metric_recovery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  committed_operations INTEGER NOT NULL,
  orphans INTEGER NOT NULL,
  pending_operations INTEGER NOT NULL,
  intent_errors INTEGER NOT NULL,
  requires_manual_review INTEGER NOT NULL,
  completed INTEGER NOT NULL,
  quarantined INTEGER NOT NULL,
  aborted INTEGER NOT NULL
);
`;

/** Overflow bucket key: a sample above the largest finite edge. */
export const OVERFLOW_BUCKET_MS = -1;

/** One buffered histogram flush (see observability/latency.ts). */
export interface LatencyBatch {
  op: string;
  samples: number;
  total_ms: number;
  min_ms: number | null;
  max_ms: number;
  /** Edge in ms -> count. `Infinity` is stored as OVERFLOW_BUCKET_MS. */
  buckets: Map<number, number>;
}

export interface RecoveryEvent {
  at: string;
  opened_at: string;
  committed_operations: number;
  orphans: number;
  pending_operations: number;
  intent_errors: number;
  requires_manual_review: number;
  completed: number;
  quarantined: number;
  aborted: number;
}

export interface RecoverySummary {
  events: number;
  last: RecoveryEvent | null;
}

/** How many recent refusals the store keeps (the health report shows fewer). */
export const DENIAL_RECENT_CAPACITY = 20;

export interface DenialRecord {
  at: string;
  code: string;
  op: string;
}

export interface DenialSummary {
  total: number;
  by_code: Record<string, number>;
  recent: DenialRecord[];
}

export class MetricsStore {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  static open(dbPath: string): MetricsStore {
    if (dbPath !== ':memory:') ensurePrivateDirectory(dirname(dbPath));
    const db = new Database(dbPath);
    if (dbPath !== ':memory:') ensurePrivateFile(dbPath);
    return new MetricsStore(db);
  }

  close(): void {
    this.db.close();
  }

  /** Record one refused operation (code + entry point + time; never identity). */
  recordDenial(code: string, op: string, at = new Date().toISOString()): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO metric_denials (code, count, last_at) VALUES (?, 1, ?)
        ON CONFLICT(code) DO UPDATE SET count = count + 1, last_at = excluded.last_at
      `).run(code, at);
      this.db.prepare('INSERT INTO metric_denial_recent (at, code, op) VALUES (?, ?, ?)')
        .run(at, code, op);
      this.db.prepare(`
        DELETE FROM metric_denial_recent
        WHERE id <= (SELECT MAX(id) - ? FROM metric_denial_recent)
      `).run(DENIAL_RECENT_CAPACITY);
    })();
  }

  denials(recentLimit = 5): DenialSummary {
    const rows = this.db.prepare('SELECT code, count FROM metric_denials').all() as Array<{ code: string; count: number }>;
    const byCode: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byCode[row.code] = row.count;
      total += row.count;
    }
    const recent = this.db.prepare(
      'SELECT at, code, op FROM metric_denial_recent ORDER BY id DESC LIMIT ?',
    ).all(recentLimit) as DenialRecord[];
    return { total, by_code: byCode, recent };
  }

  /**
   * Add one buffered histogram flush. Additive and idempotent per batch:
   * samples/total/min/max merge into the op's row, bucket counts accumulate.
   */
  recordLatencyBatches(batches: LatencyBatch[]): void {
    if (batches.length === 0) return;
    const merge = this.db.prepare(`
      INSERT INTO metric_latency (op, samples, total_ms, min_ms, max_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(op) DO UPDATE SET
        samples = samples + excluded.samples,
        total_ms = total_ms + excluded.total_ms,
        min_ms = MIN(COALESCE(min_ms, excluded.min_ms), COALESCE(excluded.min_ms, min_ms)),
        max_ms = MAX(max_ms, excluded.max_ms)
    `);
    const bucket = this.db.prepare(`
      INSERT INTO metric_latency_buckets (op, upper_ms, count) VALUES (?, ?, ?)
      ON CONFLICT(op, upper_ms) DO UPDATE SET count = count + excluded.count
    `);
    this.db.transaction(() => {
      for (const batch of batches) {
        merge.run(batch.op, batch.samples, batch.total_ms, batch.min_ms, batch.max_ms);
        for (const [edge, count] of batch.buckets) {
          bucket.run(batch.op, Number.isFinite(edge) ? edge : OVERFLOW_BUCKET_MS, count);
        }
      }
    })();
  }

  /**
   * Per-operation latency histograms (bucket-resolution quantile upper bounds).
   * Ops with no samples are absent — never reported as a zero-latency pass.
   */
  latency(): Record<string, LatencyReport> {
    const rows = this.db.prepare('SELECT op, samples, max_ms FROM metric_latency ORDER BY op').all() as
      Array<{ op: string; samples: number; max_ms: number | null }>;
    if (rows.length === 0) return {};
    const bucketRows = this.db.prepare(
      'SELECT op, upper_ms, count FROM metric_latency_buckets ORDER BY op, upper_ms',
    ).all() as Array<{ op: string; upper_ms: number; count: number }>;

    const byOp = new Map<string, LatencyHistogram>();
    for (const row of bucketRows) {
      const histogram = byOp.get(row.op) ?? new Map<number, number>();
      histogram.set(row.upper_ms === OVERFLOW_BUCKET_MS ? Infinity : row.upper_ms, row.count);
      byOp.set(row.op, histogram);
    }

    const report: Record<string, LatencyReport> = {};
    for (const row of rows) {
      const histogram = byOp.get(row.op) ?? new Map<number, number>();
      report[row.op] = {
        samples: row.samples,
        buckets: [...histogram.keys()]
          .sort((left, right) => left - right)
          .map(edge => ({ upper_ms: Number.isFinite(edge) ? edge : null, count: histogram.get(edge) ?? 0 })),
        p50_ms_upper_bound: quantileUpperBoundMs(histogram, 0.5, row.samples),
        p95_ms_upper_bound: quantileUpperBoundMs(histogram, 0.95, row.samples),
        p99_ms_upper_bound: quantileUpperBoundMs(histogram, 0.99, row.samples),
        max_ms: row.max_ms,
      };
    }
    return report;
  }

  /** Record one brain-open recovery scan. Counts and timestamps only. */
  recordRecovery(event: RecoveryEvent): void {
    this.db.prepare(`
      INSERT INTO metric_recovery (
        at, opened_at, committed_operations, orphans, pending_operations,
        intent_errors, requires_manual_review, completed, quarantined, aborted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.at, event.opened_at, event.committed_operations, event.orphans,
      event.pending_operations, event.intent_errors, event.requires_manual_review,
      event.completed, event.quarantined, event.aborted,
    );
  }

  /** How many opens ran recovery, and the most recent scan's findings. */
  recovery(): RecoverySummary {
    const events = (this.db.prepare('SELECT COUNT(*) as c FROM metric_recovery').get() as { c: number }).c;
    const row = this.db.prepare(
      'SELECT * FROM metric_recovery ORDER BY id DESC LIMIT 1',
    ).get() as RecoveryEvent | undefined;
    return { events, last: row ?? null };
  }

  getDB(): Database.Database {
    return this.db;
  }
}

/** Conventional location of the operational metrics DB. */
export function defaultMetricsPath(dataDir: string): string {
  return join(dataDir, 'indices', 'metrics.db');
}
