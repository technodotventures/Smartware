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
// The residual this deliberately does not claim to close: a pause INSIDE a mutation after
// its guard passed can still leave partial artifacts (never an ops-log commit — the durable
// commit signal is written last, and recovery reports unmatched sets). Storage-level fencing
// is the follow-on; see ADR-0007.

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
`;

export interface FenceRefusal {
  op: string;
  token: number | null;
  high_water: number;
  at: string;
}

export interface FenceStoreState {
  high_water: number;
  /** When the high-water epoch last advanced (or the store was created). */
  updated_at: string;
  refusals: number;
  last_refusal: FenceRefusal | null;
}

interface FenceRow {
  high_water: number;
  updated_at: string;
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
      updated_at: row.updated_at,
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

  private readRow(): FenceRow {
    const row = this.db
      .prepare(
        'SELECT high_water, updated_at, refusals, last_refusal_at, last_refusal_op, last_refusal_token, last_refusal_high_water '
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
