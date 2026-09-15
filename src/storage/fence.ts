// Fencing epoch store — the brain-side half of a host's ownership arbiter (ADR-0007).
//
// A host that arbitrates brain ownership (e.g. a Redis lease with a compare-and-extend
// renewal) issues a monotonic epoch token for each ownership term. This store persists the
// highest epoch the brain has seen and decides whether the presented token may write:
//
//   - claim(token): register a new ownership term. Refused when token < high_water.
//   - guard(token, op): called before every canonical mutation. Refused when the brain is
//     fenced (high_water > 0) and the token is missing or older than high_water. A refusal
//     happens BEFORE any canonical artifact is written; the refusal itself is recorded
//     (count + last refusal) so it is auditable through `SmartwareCore.fencingState()`.
//
// Both decisions are single SQLite statements against the brain's own database
// (`smartware.db`), which every process that opens the brain shares — and SQLite serialises
// writers across processes. A process stalled between its host-side ownership guard and the
// brain call therefore cannot commit: when it resumes, its epoch is already behind the
// high-water mark the new owner claimed.
//
// Storage-level fencing (ADR-0010) extends the boundary guard: the COMMIT SIGNAL itself is
// gated. `guardCommit` is one IMMEDIATE transaction against this same database that refuses a
// writer whose epoch is behind the high-water mark and records the authorization for the
// operation in `writer_fence_commits`. Because the check and the record are one atomic SQLite
// transaction, a process paused INSIDE a mutation — after its boundary check, before its commit
// signal — cannot commit after a handoff: when it resumes, its epoch is behind the mark and the
// gate refuses. Recovery uses the recorded authorization to project a commit whose signal never
// landed, and to reject (never finalize) artifact sets whose epoch is behind the mark.

import Database from 'better-sqlite3';
import { ProtocolError } from '../auth/middleware.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS writer_fence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  high_water INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  refusals INTEGER NOT NULL DEFAULT 0,
  last_refusal_at TEXT,
  last_refusal_op TEXT,
  last_refusal_token INTEGER,
  last_refusal_high_water INTEGER
);

CREATE TABLE IF NOT EXISTS writer_fence_commits (
  operation_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  writer_id TEXT NOT NULL,
  authorized_at TEXT NOT NULL
);
`;

/** The ownership epoch a mutation was prepared under (ADR-0010). */
export interface CommitStamp {
  epoch: number;
  writer_id: string;
}

/** A recorded commit authorization: the commit decision for one operation. */
export interface CommitAuthorization {
  operation_id: string;
  epoch: number;
  writer_id: string;
  authorized_at: string;
}

export interface FenceRefusal {
  op: string;
  token: number | null;
  high_water: number;
  at: string;
}

export interface FenceStoreState {
  high_water: number;
  refusals: number;
  last_refusal: FenceRefusal | null;
}

interface FenceRow {
  high_water: number;
  refusals: number;
  last_refusal_at: string | null;
  last_refusal_op: string | null;
  last_refusal_token: number | null;
  last_refusal_high_water: number | null;
}

function assertToken(token: number, op: string): void {
  if (!Number.isSafeInteger(token) || token < 1) {
    throw new ProtocolError(
      'invalid_parameter',
      `Fencing token must be a positive integer (got ${String(token)}) for '${op}'`,
      { op, token },
    );
  }
}

function staleError(op: string, token: number, highWater: number): ProtocolError {
  return new ProtocolError(
    'fencing_token_stale',
    `Fencing token ${token} is stale for '${op}': this brain has already seen epoch ${highWater}. `
    + 'A newer owner holds the write epoch; the mutation was refused before any artifact was written.',
    { op, token, high_water: highWater },
  );
}

function missingError(op: string, highWater: number): ProtocolError {
  return new ProtocolError(
    'fencing_token_missing',
    `This brain is fenced (high-water epoch ${highWater}) and '${op}' was attempted without a fencing token. `
    + 'Present the epoch issued for your ownership term; the mutation was refused before any artifact was written.',
    { op, token: null, high_water: highWater },
  );
}

export class FenceStore {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.db
      .prepare('INSERT OR IGNORE INTO writer_fence (id, high_water, updated_at) VALUES (1, 0, ?)')
      .run(new Date().toISOString());
  }

  /** Open (creating the one-row state table if needed) on the brain's shared database file. */
  static open(dbPath: string): FenceStore {
    return new FenceStore(new Database(dbPath));
  }

  close(): void {
    this.db.close();
  }

  state(): FenceStoreState {
    const row = this.readRow();
    return {
      high_water: row.high_water,
      refusals: row.refusals,
      last_refusal: row.last_refusal_at === null
        ? null
        : {
            op: row.last_refusal_op ?? '(unknown)',
            token: row.last_refusal_token,
            high_water: row.last_refusal_high_water ?? row.high_water,
            at: row.last_refusal_at,
          },
    };
  }

  /**
   * Register an ownership term. A token at or above the high-water mark is accepted
   * (equal is idempotent); a token below it is refused as stale — a stale owner cannot
   * claim its way back. Runs in an IMMEDIATE transaction so a concurrent claim cannot
   * interleave between the read and the update.
   */
  claim(token: number, op = 'claim'): FenceStoreState {
    assertToken(token, op);
    const outcome = this.db.transaction((): { accepted: boolean; high_water: number } => {
      const { high_water } = this.readRow();
      if (token < high_water) return { accepted: false, high_water };
      this.db
        .prepare('UPDATE writer_fence SET high_water = ?, updated_at = ? WHERE id = 1')
        .run(token, new Date().toISOString());
      return { accepted: true, high_water: Math.max(high_water, token) };
    }).immediate();

    if (!outcome.accepted) {
      this.recordRefusal(op, token, outcome.high_water);
      throw staleError(op, token, outcome.high_water);
    }
    return this.state();
  }

  /**
   * The mutation-boundary check. Returns normally when this writer may proceed:
   *   - an unfenced brain (high_water = 0) and an unfenced writer: unchanged legacy behaviour;
   *   - a token at or above the high-water mark: accepted, advancing the mark when it is newer
   *     (monotone — a conditional update can never regress a concurrent higher claim).
   * Throws (and records the refusal) when the brain is fenced and the writer presents no
   * token (`fencing_token_missing`) or an older one (`fencing_token_stale`).
   */
  guard(token: number | null, op: string): void {
    if (token !== null) assertToken(token, op);
    const { high_water } = this.readRow();

    if (token === null) {
      if (high_water === 0) return; // never fenced: legacy writers keep working
      this.recordRefusal(op, null, high_water);
      throw missingError(op, high_water);
    }

    if (token < high_water) {
      this.recordRefusal(op, token, high_water);
      throw staleError(op, token, high_water);
    }

    if (token > high_water) {
      // Monotone advance. `WHERE high_water < token` makes a concurrent higher claim win.
      this.db
        .prepare('UPDATE writer_fence SET high_water = ?, updated_at = ? WHERE id = 1 AND high_water < ?')
        .run(token, new Date().toISOString(), token);
      const after = this.readRow().high_water;
      if (token < after) {
        this.recordRefusal(op, token, after);
        throw staleError(op, token, after);
      }
    }
  }

  /**
   * The persisted high-water mark (the highest ownership epoch this brain has seen).
   */
  highWater(): number {
    return this.readRow().high_water;
  }

  /**
   * The recorded commit authorization for one operation, or null. Present means the operation's
   * commit decision passed the gate — the commit signal may be projected (ADR-0010).
   */
  authorization(operationId: string): CommitAuthorization | null {
    const row = this.db
      .prepare(
        'SELECT operation_id, epoch, writer_id, authorized_at FROM writer_fence_commits '
        + 'WHERE operation_id = ?',
      )
      .get(operationId) as CommitAuthorization | undefined;
    return row ?? null;
  }

  /**
   * The writer-path commit gate (ADR-0010). One IMMEDIATE transaction that:
   *   - refuses a tokenless writer on a fenced brain (`fencing_token_missing`);
   *   - refuses a writer whose token is behind the high-water mark (`fencing_token_stale`) —
   *     this is what a process resuming from an in-mutation pause across a handoff hits;
   *   - accepts the unfenced legacy writer (high-water mark 0) without recording anything;
   *   - accepts a current token and records one authorization row per operation.
   *
   * The check and the record are atomic with respect to claims and to other processes' commits:
   * SQLite serialises writers on the brain's shared database, so there is no window between
   * "verified current" and "commit authorised".
   */
  guardCommit(operationIds: string[], stamp: CommitStamp | null, op: string): void {
    if (stamp !== null) assertToken(stamp.epoch, op);
    const outcome = this.db.transaction((): { ok: boolean; high_water: number } => {
      const { high_water } = this.readRow();
      if (stamp === null) {
        if (high_water === 0) return { ok: true, high_water }; // never fenced: legacy writer
        return { ok: false, high_water };
      }
      if (stamp.epoch < high_water) return { ok: false, high_water };
      if (stamp.epoch > high_water) {
        // Monotone advance (same conditional update as `guard`).
        this.db
          .prepare('UPDATE writer_fence SET high_water = ?, updated_at = ? WHERE id = 1 AND high_water < ?')
          .run(stamp.epoch, new Date().toISOString(), stamp.epoch);
      }
      const after = this.readRow().high_water;
      if (stamp.epoch < after) return { ok: false, high_water: after };
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO writer_fence_commits (operation_id, epoch, writer_id, authorized_at) '
        + 'VALUES (?, ?, ?, ?)',
      );
      const authorizedAt = new Date().toISOString();
      for (const operationId of operationIds) {
        insert.run(operationId, stamp.epoch, stamp.writer_id, authorizedAt);
      }
      return { ok: true, high_water: after };
    }).immediate();

    if (!outcome.ok) {
      if (stamp === null) {
        this.recordRefusal(op, null, outcome.high_water);
        throw missingError(op, outcome.high_water);
      }
      this.recordRefusal(op, stamp.epoch, outcome.high_water);
      throw staleError(op, stamp.epoch, outcome.high_water);
    }
  }

  /**
   * The recovery-path gate: authorize a set that was prepared under `epoch`, atomically with the
   * high-water mark (a claim landing during a recovery scan therefore cannot be overtaken by a
   * finalization). Returns false when the set's epoch is behind the mark — the caller must
   * reject the set as stale, never finalize it. Unlike `guardCommit` this never throws and never
   * counts a refusal: rejecting a dead writer's artifact set is a disposition, not a write
   * attempt.
   */
  authorizeAtEpoch(operationIds: string[], epoch: number, writerId: string): boolean {
    if (!Number.isSafeInteger(epoch) || epoch < 1) return false;
    return this.db.transaction((): boolean => {
      const { high_water } = this.readRow();
      if (epoch < high_water) return false;
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO writer_fence_commits (operation_id, epoch, writer_id, authorized_at) '
        + 'VALUES (?, ?, ?, ?)',
      );
      const authorizedAt = new Date().toISOString();
      for (const operationId of operationIds) {
        insert.run(operationId, epoch, writerId, authorizedAt);
      }
      return true;
    }).immediate();
  }

  private readRow(): FenceRow {
    const row = this.db
      .prepare(
        'SELECT high_water, refusals, last_refusal_at, last_refusal_op, last_refusal_token, last_refusal_high_water '
        + 'FROM writer_fence WHERE id = 1',
      )
      .get() as FenceRow | undefined;
    if (!row) throw new Error('writer_fence state row is missing');
    return row;
  }

  private recordRefusal(op: string, token: number | null, highWater: number): void {
    this.db
      .prepare(
        'UPDATE writer_fence SET refusals = refusals + 1, last_refusal_at = ?, last_refusal_op = ?, '
        + 'last_refusal_token = ?, last_refusal_high_water = ? WHERE id = 1',
      )
      .run(new Date().toISOString(), op, token, highWater);
  }
}
