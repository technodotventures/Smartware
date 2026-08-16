// Cascade preview store (PR-7 / A6).
//
// Per Protocol Contract v0.4.1 + Reference Impl v0.1.2 §"Cascade preview
// store", the page-endorsement two-phase pattern works as:
//
//   1. Client calls REVISE with dry_run: true and no operation_id.
//   2. Substrate computes the cascade (which claims will be re-authored,
//      which are shared with other pages) and returns a cascade_preview_id.
//   3. Client surfaces the preview to the user, who confirms.
//   4. Client calls REVISE with dry_run: false, a fresh operation_id, and
//      cascade_preview_id from step 2.
//   5. Substrate validates that the cascade set hasn't drifted, then commits.
//
// This module is the cache that holds the preview between (2) and (4).
//
// Key contracts:
//   - 5-minute TTL — older previews return preview_expired, NOT preview_not_found.
//   - Once consumed by a successful commit, the preview_id becomes
//     preview_not_found on any subsequent retrieval (no replay).
//   - The store outlives a Pod restart via SQLite backing so an in-flight
//     UI prompt doesn't lose its preview if the user restarts mid-flow.
//   - Drift detection is the consumer's responsibility: the stored payload
//     includes the snapshots needed to detect cascade changes between
//     preview and commit.

import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { ulid } from 'ulid';
import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';

export const PREVIEW_ID_PATTERN = /^preview_[0-9A-HJKMNP-TV-Z]{26}$/;
export const DEFAULT_TTL_SECONDS = 300; // 5 minutes per spec

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cascade_previews (
  preview_id   TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_preview_expires_at ON cascade_previews(expires_at);
`;

export interface CascadePreviewPayload {
  /** PageId being endorsed. */
  page_id: string;
  /** Snapshot of the page's `sources` (contained ClaimIds) at preview time. */
  sources_snapshot: string[];
  /** Subset of sources_snapshot also cited by other pages — drives confirmation modal. */
  shared_claims_snapshot: string[];
  /** Optional bookkeeping: actor that requested the preview. */
  actor_id?: string;
  /** Optional bookkeeping: reason supplied with the dry-run. */
  reason?: string;
}

export type PreviewLookup =
  | { kind: 'hit'; payload: CascadePreviewPayload; created_at: string }
  | { kind: 'not_found' }
  | { kind: 'expired'; created_at: string; expired_at: string }
  | { kind: 'consumed'; consumed_at: string };

export class CascadePreviewStore {
  private db: Database.Database;
  private readonly ttlSeconds: number;

  constructor(dbPath: string, ttlSeconds: number = DEFAULT_TTL_SECONDS) {
    if (dbPath !== ':memory:') ensurePrivateDirectory(dirname(dbPath));
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') ensurePrivateFile(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.ttlSeconds = ttlSeconds;
  }

  /** Generate a new spec-shaped preview id. */
  static newPreviewId(): string {
    return `preview_${ulid()}`;
  }

  /** Persist a fresh preview and return its id. */
  put(payload: CascadePreviewPayload): string {
    const previewId = CascadePreviewStore.newPreviewId();
    const now = new Date();
    const expires = new Date(now.getTime() + this.ttlSeconds * 1000);
    this.db
      .prepare(
        'INSERT INTO cascade_previews (preview_id, payload_json, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(previewId, JSON.stringify(payload), now.toISOString(), expires.toISOString());
    return previewId;
  }

  /**
   * Look up a preview id, returning a discriminated union the caller maps to
   * the appropriate spec error code:
   *   hit       → use the payload
   *   not_found → preview_not_found
   *   expired   → preview_expired (existed but past TTL)
   *   consumed  → preview_not_found (consumed by a prior successful commit)
   */
  lookup(previewId: string): PreviewLookup {
    const row = this.db
      .prepare(
        'SELECT payload_json, created_at, expires_at, consumed_at FROM cascade_previews WHERE preview_id = ?',
      )
      .get(previewId) as
      | { payload_json: string; created_at: string; expires_at: string; consumed_at: string | null }
      | undefined;
    if (!row) return { kind: 'not_found' };
    if (row.consumed_at) return { kind: 'consumed', consumed_at: row.consumed_at };
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return { kind: 'expired', created_at: row.created_at, expired_at: row.expires_at };
    }
    return {
      kind: 'hit',
      payload: JSON.parse(row.payload_json) as CascadePreviewPayload,
      created_at: row.created_at,
    };
  }

  /**
   * Mark a preview as consumed. Idempotent — re-consuming returns false.
   * Returns true if the preview was active and is now consumed; false if it
   * didn't exist, was already consumed, or was expired.
   */
  consume(previewId: string): boolean {
    const lookup = this.lookup(previewId);
    if (lookup.kind !== 'hit') return false;
    this.db
      .prepare('UPDATE cascade_previews SET consumed_at = ? WHERE preview_id = ?')
      .run(new Date().toISOString(), previewId);
    return true;
  }

  /**
   * Delete expired (and consumed) previews. Safe to run on a timer. Returns
   * the count of rows removed.
   */
  gc(): number {
    // Keep consumed rows around for 24h so debugging "why preview_not_found?"
    // can distinguish "never existed" from "already used". Older than 24h
    // they're not interesting.
    const consumeCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const expireCutoff = new Date(Date.now()).toISOString();
    const result = this.db
      .prepare(
        `DELETE FROM cascade_previews
         WHERE (consumed_at IS NOT NULL AND consumed_at < ?)
            OR (consumed_at IS NULL AND expires_at < ?)`,
      )
      .run(consumeCutoff, expireCutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

export function isValidCascadePreviewId(value: string): boolean {
  return PREVIEW_ID_PATTERN.test(value);
}
