// Ingestion — public contract types (importable as `smartware/ingestion`).

import type { Actor, Observation } from '../layer0/types.js';

/** One source-native item in a batch. `external_id` is the source's own id. */
export interface IngestItem {
  /** Stable id at the source (message id, event id). The per-item dedup key. */
  external_id: string;
  type: Observation['type'];
  content: Observation['content'];
  observed_at?: string;
  visibility?: Observation['visibility'];
  sensitive?: boolean;
  informed_by?: string[];
  parent_ids?: string[];
}

export interface IngestParams {
  /** Authenticated actor (Coffee's scheduler identity). Required — no anonymous ingestion. */
  actor: Actor;
  /** Registered source id (owner-provisioned). Required — checked fail-closed. */
  source_id: string;
  scope: string;
  /**
   * Opaque stream checkpoint AFTER this batch (host's notion of position).
   * Stored verbatim; never parsed. The host resumes from it.
   */
  cursor: string;
  /** ULID — the batch's idempotency key. Replay returns the recorded receipt. */
  operation_id: string;
  items: IngestItem[];
  /**
   * Override for the observation `app` (default: the source id, which
   * namespaces per-source dedup). Most hosts never set this.
   */
  app?: string;
}

export interface IngestItemResult {
  external_id: string;
  status: 'accepted' | 'duplicate' | 'quarantined' | 'rejected';
  /** Observation id for accepted/duplicate/quarantined items. */
  observation_id?: string;
  /** Protocol error code for rejected items (e.g. `secret_detected`). */
  code?: string;
}

export interface IngestResult {
  /** `ok` on first commit; `replayed` when a committed batch was retried. */
  status: 'ok' | 'replayed';
  operation_id: string;
  source_id: string;
  scope: string;
  /** Checkpoint this batch advanced to. */
  cursor: string;
  /** Previous checkpoint for this (source, scope) stream, or null. */
  cursor_before: string | null;
  accepted: number;
  duplicated: number;
  quarantined: number;
  rejected: number;
  items: IngestItemResult[];
  synced_at: string;
}

/** Synchronous fault hooks used by crash-boundary conformance tests. */
export interface IngestHooks {
  afterItem?: (item: IngestItemResult, index: number) => void;
}
