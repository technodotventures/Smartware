// Derived SQLite fingerprint index — the O(1) dedup primitive for the
// compile queue (spec §10a / §11.2 binding).
//
// The compile worker's per-claim fingerprint dedup used to scan the growing
// L1 JSONL from scratch once per claim (findByFingerprint) plus the whole
// active-claim store (findSemanticMatch): O(N²) per compile run, measured at
// 189ms/claim @50k (compile 9,468,298ms vs the 5s budget — §11.2). This
// index replaces both scans with one SQLite PK-indexed lookup per claim.
//
// Same pattern as Layer0Index / OpsIndex: the L1 JSONL is canonical; this
// SQLite is derived and can be wiped and rebuilt from it at any time
// (rebuild-equivalence contract, §10a). Incremental catch-up is size-keyed
// per month file (append-only contract, one file per UTC month).
//
// To keep the dedup result byte-identical to a canonical version read, the
// latest version record is stored verbatim (record_json) and returned
// parsed, so extension paths (version+1, derived_from + obs.id) build on the
// same fields find-by-scan would have produced.

import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';
import {
  iterAllClaimVersions,
  type ActiveClaimVersion,
  type ClaimVersionRecord,
} from '../layer1/jsonl.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claim_state (
  claim_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  epistemic_owner TEXT NOT NULL,
  derived_from TEXT NOT NULL,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claim_state_fp ON claim_state(fingerprint);
CREATE INDEX IF NOT EXISTS idx_claim_state_claim ON claim_state(claim_id, version);

CREATE TABLE IF NOT EXISTS fp_sync_state (
  month TEXT PRIMARY KEY,
  lines INTEGER NOT NULL,
  size INTEGER NOT NULL
);
`;

interface ClaimStateRow {
  claim_id: string;
  fingerprint: string;
  version: number;
  state: string;
  epistemic_owner: string;
  derived_from: string;
  record_json: string;
  updated_at: string;
}

export class FingerprintIndex {
  private db: Database.Database;
  /** Cached statements — per-call prepare() is a top compile cost (§11.2). */
  private stmtActiveByFp?: Database.Statement;
  private stmtActiveByClaim?: Database.Statement;
  private stmtUpsert?: Database.Statement;
  /**
   * Batch mode (§11.2b re-scope): each per-claim upsert was an autocommit
   * transaction (50k commits at 50k claims measured ~13% of the pipeline).
   * In batch mode upserts accumulate in this overlay keyed by fingerprint
   * (monotone version per claim — the latest write wins, matching the DB
   * `WHERE excluded.version > claim_state.version` rule), dedup lookups see
   * the overlay first (same-run dedup semantics preserved), and flushBatch()
   * writes the whole set in ONE transaction.
   */
  private batching = false;
  private pending = new Map<string, ClaimVersionRecord>();
  private stmtDelete?: Database.Statement;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') ensurePrivateDirectory(dirname(dbPath));
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') ensurePrivateFile(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  /** Wipe and replay every claim version from the canonical L1 JSONL. */
  rebuild(dataDir: string): void {
    this.db.exec('DELETE FROM claim_state');
    this.db.exec('DELETE FROM fp_sync_state');
    this.catchUp(dataDir, true);
  }

  /**
   * Incrementally replay only months whose byte size changed since the last
   * catch-up (the L1 JSONL is append-only per UTC month — see
   * layer1/jsonl.ts appendClaimVersions). An unchanged month is skipped
   * entirely. Replaying a changed month upserts rows for the claims it
   * references; a claim's latest version always wins.
   */
  catchUp(dataDir: string, force = false): void {
    const claimsDir = join(dataDir, 'claims');
    const seen = new Set<string>();
    if (existsSync(claimsDir)) {
      for (const file of readdirSync(claimsDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const month = file.slice(0, -'.jsonl'.length);
        seen.add(month);
        this.indexMonth(dataDir, month, force);
      }
    }
    // Purge months that no longer exist on the canonical surface so the
    // index never resurrects removed records (mirrors OpsIndex day purge).
    // Only claims whose latest version was written in that month are
    // removed; claims extended in later months keep their latest state.
    const synced = (this.db.prepare('SELECT month FROM fp_sync_state').all() as Array<{ month: string }>)
      .map(row => row.month);
    for (const month of synced) {
      if (seen.has(month)) continue;
      this.db.prepare(
        "DELETE FROM claim_state WHERE updated_at LIKE ?",
      ).run(`${month}-%`);
      this.db.prepare('DELETE FROM fp_sync_state WHERE month = ?').run(month);
    }
  }

  /**
   * O(1)-ish dedup lookup: the latest ACTIVE version for any claim holding
   * this structured fingerprint, or null. Mirrors the old find-by-scan
   * semantics (findByFingerprint + findSemanticMatch): only an active latest
   * version counts; a forgotten latest is absent. In batch mode the pending
   * overlay is consulted first (same-run dedup must see this run's writes).
   */
  activeByFingerprint(fingerprint: string): ActiveClaimVersion | null {
    if (this.batching) {
      const pendingRecord = this.pending.get(fingerprint);
      if (pendingRecord) {
        return pendingRecord.state === 'active' ? pendingRecord as ActiveClaimVersion : null;
      }
      const snapshotList = this.snapshot.get(fingerprint);
      if (snapshotList) {
        for (const record of snapshotList) {
          if (record.state === 'active') return record as ActiveClaimVersion;
        }
      }
      return null;
    }
    const stmt = this.stmtActiveByFp
      ??= this.db.prepare(
        `SELECT record_json FROM claim_state WHERE fingerprint = ? ORDER BY version DESC, claim_id ASC`,
      );
    const rows = stmt.all(fingerprint) as Array<{ record_json: string }>;
    for (const row of rows) {
      const record = JSON.parse(row.record_json) as ClaimVersionRecord;
      if (record.state === 'active') return record as ActiveClaimVersion;
    }
    return null;
  }

  /** Active latest version for one claim, or null. */
  activeByClaimId(claimId: string): ActiveClaimVersion | null {
    if (this.batching) {
      for (const record of this.pending.values()) {
        if (record.claim_id === claimId) {
          return record.state === 'active' ? record as ActiveClaimVersion : null;
        }
      }
    }
    const stmt = this.stmtActiveByClaim
      ??= this.db.prepare(
        'SELECT record_json FROM claim_state WHERE claim_id = ?',
      );
    const row = stmt.get(claimId) as { record_json: string } | undefined;
    if (!row) return null;
    const record = JSON.parse(row.record_json) as ClaimVersionRecord;
    return record.state === 'active' ? record as ActiveClaimVersion : null;
  }

  /**
   * Remove derived state rows for erased claim ids (FORGET.SCOPE erasure,
   * spec §10) so the O(1) dedup index can never produce a purged claim as a
   * "latest active version" — the ghost that would resurrect erased content
   * on the next compile. Returns rows removed.
   */
  removeByClaimIds(claimIds: string[]): number {
    if (claimIds.length === 0) return 0;
    // Pending overlay + snapshot too — an erase observed mid-batch must not
    // leave the purged claim visible to dedup for the remainder of the run.
    for (const [fp, record] of this.pending) {
      if (claimIds.includes(record.claim_id)) this.pending.delete(fp);
    }
    for (const [fp, list] of this.snapshot) {
      const kept = list.filter(r => !claimIds.includes(r.claim_id));
      if (kept.length !== list.length) {
        if (kept.length === 0) this.snapshot.delete(fp);
        else this.snapshot.set(fp, kept);
      }
    }
    let removed = 0;
    const stmt = this.stmtDelete
      ??= this.db.prepare('DELETE FROM claim_state WHERE claim_id = ?');
    for (const claimId of claimIds) removed += stmt.run(claimId).changes;
    return removed;
  }

  /**
   * Begin a batch-commit window: upserts accumulate in memory (same-run
   * dedup semantics preserved via the overlay) and hit the DB in one
   * transaction at flushBatch() — 50k autocommit writes measured as ~13% of
   * the full pipeline (§11.2b re-scope). Also snapshots the index into
   * memory so activeByFingerprint is a pure Map lookup (no per-claim SELECT
   * for empty/no-hit tables — the common fresh-compile case).
   */
  beginBatch(): void {
    if (this.batching) return;
    this.batching = true;
    this.pending.clear();
    this.snapshot = this.loadSnapshot();
  }

  /** Snapshot of claim_state: fingerprint → [latest record rows desc]. */
  private snapshot = new Map<string, ClaimVersionRecord[]>();

  private loadSnapshot(): Map<string, ClaimVersionRecord[]> {
    const snap = new Map<string, ClaimVersionRecord[]>();
    const rows = this.db.prepare(
      'SELECT fingerprint, record_json FROM claim_state ORDER BY version DESC, claim_id ASC',
    ).all() as Array<{ fingerprint: string; record_json: string }>;
    for (const row of rows) {
      const list = snap.get(row.fingerprint);
      const record = JSON.parse(row.record_json) as ClaimVersionRecord;
      if (list) list.push(record);
      else snap.set(row.fingerprint, [record]);
    }
    return snap;
  }

  /** Commit the pending overlay in one transaction; no-op when empty. */
  flushBatch(): void {
    if (!this.batching) return;
    const records = [...this.pending.values()];
    this.pending.clear();
    this.batching = false;
    if (records.length === 0) return;
    this.db.transaction(() => {
      for (const record of records) this.upsertVersion(record);
    })();
  }

  /** Drop the pending overlay without writing (caller error path). */
  discardBatch(): void {
    this.pending.clear();
    this.batching = false;
  }

  /**
   * Record one freshly-committed version. Only newer versions win — replaying
   * an older line cannot regress a claim's state (the JSONL is append-only).
   * In batch mode this only updates the in-memory overlay; the DB write
   * happens at flushBatch() (one transaction for the whole batch).
   */
  upsertVersion(record: ClaimVersionRecord): void {
    if (this.batching) {
      // Keyed by fingerprint: one active claim per structured fingerprint.
      // A same-run extension (version+1) simply replaces the overlay entry,
      // preserving the DB rule that only the latest version is kept.
      this.pending.set(record.fingerprint, record);
      return;
    }
    this.upsertVersionNow(record);
  }

  /** Direct DB write for one version (non-batch path / flushBatch). */
  private upsertVersionNow(record: ClaimVersionRecord): void {
    const stmt = this.stmtUpsert
      ??= this.db.prepare(`
      INSERT INTO claim_state
        (claim_id, fingerprint, version, state, epistemic_owner, derived_from, record_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(claim_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        version = excluded.version,
        state = excluded.state,
        epistemic_owner = excluded.epistemic_owner,
        derived_from = excluded.derived_from,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
      WHERE excluded.version > claim_state.version
    `);
    stmt.run(
      record.claim_id,
      record.fingerprint,
      record.version,
      record.state,
      record.epistemic_owner,
      JSON.stringify(record.derived_from),
      JSON.stringify(record),
      record.version_at,
    );
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM claim_state').get() as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }

  getDB(): Database.Database {
    return this.db;
  }

  private indexMonth(dataDir: string, month: string, force: boolean): void {
    const filePath = join(dataDir, 'claims', `${month}.jsonl`);
    if (!existsSync(filePath)) return;
    const size = statSync(filePath).size;
    const state = this.db.prepare('SELECT lines, size FROM fp_sync_state WHERE month = ?')
      .get(month) as { lines: number; size: number } | undefined;
    if (!force && state && state.size === size) return; // unchanged append-only month

    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean);
    this.db.transaction(() => {
      for (let i = 0; i < lines.length; i++) {
        let record: ClaimVersionRecord;
        try {
          record = JSON.parse(lines[i]!) as ClaimVersionRecord;
        } catch {
          throw new Error(`Malformed L1 JSONL in ${filePath}:${i + 1}`);
        }
        if (typeof record.claim_id !== 'string'
          || typeof record.version !== 'number'
          || typeof record.fingerprint !== 'string'
          || (record.state !== 'active' && record.state !== 'forgotten')) {
          throw new Error(`Malformed L1 JSONL in ${filePath}:${i + 1}`);
        }
        this.upsertVersion(record);
      }
      this.db.prepare(`
        INSERT INTO fp_sync_state (month, lines, size) VALUES (?, ?, ?)
        ON CONFLICT(month) DO UPDATE SET lines = excluded.lines, size = excluded.size
      `).run(month, lines.length, size);
    })();
  }
}

/**
 * Open the derived fingerprint index for a pod's claims and bring it up to
 * date. The DB is derived — delete it freely; catchUp rebuilds from JSONL.
 */
export function openFingerprintIndex(dataDir: string, dbPath: string): FingerprintIndex {
  const index = new FingerprintIndex(dbPath);
  index.catchUp(dataDir);
  return index;
}

/** Conventional derived-DB location: <dataDir>/indices/fingerprints.db. */
export function defaultFingerprintIndexPath(dataDir: string): string {
  return join(dataDir, 'indices', 'fingerprints.db');
}
