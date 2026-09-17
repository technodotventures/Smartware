// Durable compile queue — the async-compile job ledger (spec §9.1 binding:
// "claims compiled in background on a durable queue").
//
// The OBSERVE write path is synchronous and deterministic (no LLM): raw
// observations land in Layer 0 and are raw-searchable immediately. Claim
// compilation runs later, drained from this durable queue. The queue is
// SQLite-backed and survives process restarts; a job claimed as 'running' by
// a process that died is reset to 'pending' on open (crash recovery), and
// the compile worker's fingerprint dedup makes re-processing idempotent.
//
// Freshness contract (state-based, never time-based — spec §10a):
//   pending/running → 'unverified'  (raw-searchable, compile not resolved)
//   done            → 'EXTRACTED'   (claims rank above; obs kept as evidence)
//   failed          → 'FAILED'      (stays raw-searchable forever; flagged)
//
// The queue is derived-operational state in the same spirit as the Layer0,
// ops, and fingerprint SQLite indices: pending jobs are regenerable from the
// evidence log plus terminal receipts in the ops log (see worker.ts
// syncCompileQueue), and terminal job outcomes are mirrored by durable ops
// entries (reflect.auto receipts / failure markers).

import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';

import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';

export type CompileJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface CompileJob {
  observation_id: string;
  scope: string;
  status: CompileJobStatus;
  attempts: number;
  attempt_started_at: string | null;
  last_error: string | null;
  completed_at: string | null;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS compile_jobs (
  observation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  attempt_started_at TEXT,
  last_error TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compile_jobs_status ON compile_jobs(status, updated_at);
`;

export class CompileQueue {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') ensurePrivateDirectory(dirname(dbPath));
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') ensurePrivateFile(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  /**
   * Enqueue one raw observation for background compilation. Idempotent:
   * existing pending jobs stay; terminal jobs are untouched unless `retry`
   * is set (failed → pending again; done stays done).
   */
  enqueue(observationId: string, scope: string, opts: { retry?: boolean } = {}): 'enqueued' | 'exists' | 'terminal' {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT status FROM compile_jobs WHERE observation_id = ?')
      .get(observationId) as { status: CompileJobStatus } | undefined;
    if (existing && existing.status === 'done') return 'terminal';
    if (existing && existing.status === 'failed' && !opts.retry) return 'terminal';
    if (existing && existing.status === 'failed' && opts.retry) {
      this.db.prepare(`
        UPDATE compile_jobs SET status = 'pending', last_error = NULL,
          attempt_started_at = NULL, completed_at = NULL, updated_at = ?
        WHERE observation_id = ?
      `).run(now, observationId);
      return 'enqueued';
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO compile_jobs
        (observation_id, scope, status, attempts, updated_at)
      VALUES (?, ?, 'pending', 0, ?)
    `).run(observationId, scope, now);
    return 'enqueued';
  }

  /**
   * Atomically claim up to `limit` pending jobs: status → 'running',
   * attempts + 1, attempt_started_at = now. The claim is one transaction so
   * concurrent workers can never claim the same observation.
   */
  claimBatch(limit: number, now = new Date().toISOString()): CompileJob[] {
    if (limit <= 0) return [];
    return this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT observation_id, scope FROM compile_jobs
         WHERE status = 'pending' ORDER BY updated_at ASC, observation_id ASC LIMIT ?`,
      ).all(limit) as Array<{ observation_id: string; scope: string }>;
      if (rows.length === 0) return [] as CompileJob[];
      const update = this.db.prepare(`
        UPDATE compile_jobs SET status = 'running', attempts = attempts + 1,
          attempt_started_at = ?, updated_at = ?
        WHERE observation_id = ?
      `);
      for (const row of rows) update.run(now, now, row.observation_id);
      return rows.map(row => this.get(row.observation_id)!) as CompileJob[];
    })();
  }

  /** Mark a job done (compile resolved; freshness → EXTRACTED). */
  complete(observationId: string, completedAt = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE compile_jobs SET status = 'done', last_error = NULL,
        completed_at = ?, updated_at = ?
      WHERE observation_id = ?
    `).run(completedAt, completedAt, observationId);
  }

  /** Mark a job failed (freshness → FAILED; raw stays searchable). */
  fail(observationId: string, error: string, completedAt = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE compile_jobs SET status = 'failed', last_error = ?,
        completed_at = ?, updated_at = ?
      WHERE observation_id = ?
    `).run(error, completedAt, completedAt, observationId);
  }

  /** Crash recovery: jobs left 'running' (no process claimed them) → pending. */
  resetStale(): number {
    const info = this.db.prepare(`
      UPDATE compile_jobs SET status = 'pending', attempt_started_at = NULL, updated_at = ?
      WHERE status = 'running'
    `).run(new Date().toISOString());
    return info.changes;
  }

  get(observationId: string): CompileJob | null {
    const row = this.db.prepare('SELECT * FROM compile_jobs WHERE observation_id = ?')
      .get(observationId) as Omit<CompileJob, 'scope'> & { scope: string } | undefined;
    return row ? (row as CompileJob) : null;
  }

  stats(): Record<CompileJobStatus, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) as c FROM compile_jobs GROUP BY status')
      .all() as Array<{ status: CompileJobStatus; c: number }>;
    const result: Record<CompileJobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const row of rows) result[row.status] = row.c;
    return result;
  }

  countPending(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM compile_jobs WHERE status = 'pending'")
      .get() as { c: number }).c;
  }

  /**
   * Timing facts for the health surface, derived from the ledger itself.
   *
   * `oldest_pending_at` is the `updated_at` of the oldest pending job (when it
   * was enqueued, or last requeued). `last_completed_at` / `last_failed_at`
   * are the newest completion timestamps among jobs *currently* in that
   * terminal state — a retried job leaves the failed population, so
   * `last_failed_at` falls to null once nothing is failed. Queue age is what
   * tells an operator a drain has stalled; the timestamps alone do not.
   */
  timingStats(): {
    oldest_pending_at: string | null;
    last_completed_at: string | null;
    last_failed_at: string | null;
  } {
    const oldest = this.db.prepare(
      "SELECT MIN(updated_at) as t FROM compile_jobs WHERE status = 'pending'",
    ).get() as { t: string | null };
    const completed = this.db.prepare(
      "SELECT MAX(completed_at) as t FROM compile_jobs WHERE status = 'done'",
    ).get() as { t: string | null };
    const failed = this.db.prepare(
      "SELECT MAX(completed_at) as t FROM compile_jobs WHERE status = 'failed'",
    ).get() as { t: string | null };
    return {
      oldest_pending_at: oldest.t,
      last_completed_at: completed.t,
      last_failed_at: failed.t,
    };
  }

  /**
   * Drop every job of a scope (FORGET.SCOPE erasure, spec §10): erased
   * observations must never be re-derived by the worker, and the queue is a
   * derived artifact whose source rows are now erased. Returns rows removed.
   */
  removeByScope(scope: string): number {
    return this.db.prepare('DELETE FROM compile_jobs WHERE scope = ?').run(scope).changes;
  }

  /** Wipe the ledger — regenerable from evidence + receipts. */
  clear(): void {
    this.db.exec('DELETE FROM compile_jobs');
  }

  close(): void {
    this.db.close();
  }

  getDB(): Database.Database {
    return this.db;
  }
}

/** Conventional derived-DB location: <dataDir>/indices/compile.db. */
export function defaultCompileQueuePath(dataDir: string): string {
  return join(dataDir, 'indices', 'compile.db');
}
