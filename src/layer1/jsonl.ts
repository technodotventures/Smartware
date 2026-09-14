// L1 JSONL canonical surface (PR-14 / A3 carryover).
//
// Per Spec v1.5.4.2, L1 is canonical, append-only JSONL. Each line is one
// claim VERSION (not just one claim). The SQLite index is derived; the
// JSONL is the source of truth on disk.
//
// File layout: pod_data/claims/YYYY-MM.jsonl (one file per UTC month).
//
// Append discipline:
//   - O_APPEND open. flock optional for concurrent-write safety.
//   - Never modify existing lines.
//   - Old files are immutable once the month rolls over.
//
// Recovery semantics:
//   - Each claim_id can have N versions. Latest version with state=active
//     is the current state. state=forgotten supersedes any active version.
//   - LC-04 catastrophic recovery: if the SQLite index is corrupted or a
//     forgotten version's JSONL line is lost, replay the JSONL + L2
//     tombstones to reconstruct.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type {
  ClaimAuthor,
  ClaimTimeValue,
  ClaimRelation,
  ClaimRole,
  ClaimState,
  ClaimType,
  ConfidenceBucket,
  EpistemicLabel,
  EpistemicTag,
} from './types.js';
import type { TypedValue } from '../layer0/types.js';
import { backfillClaimVersion } from './migration.js';

/**
 * Structured meaning produced by extraction.
 *
 * This is intentionally separate from the admitted epistemic fields on the
 * claim version. reflect.auto may retain a high-quality deterministic parse
 * while still bounding the autonomous claim to low-confidence inference.
 */
export interface ClaimSemanticMaterialization {
  subject_name: string;
  subject_type: string;
  predicate: string;
  object: TypedValue;
  t_valid_from: ClaimTimeValue;
  t_valid_to: ClaimTimeValue;
  extracted_epistemic: EpistemicLabel;
  extracted_confidence: number;
  sensitive: boolean;
  extraction: {
    method: 'deterministic' | 'llm' | 'user_input';
    model: string | null;
    compiler_version: string;
    prompt_hash: string | null;
    extracted_at: string;
  };
}

/** Fields shared by both active and forgotten claim versions. */
interface ClaimVersionBase {
  claim_id: string;
  version: number;
  claim_type: ClaimType;
  claim_role: ClaimRole;
  author: ClaimAuthor;
  /** Epistemic + lifecycle protection. Defaults to author; flips to 'user' on adjudication. */
  epistemic_owner: ClaimAuthor;
  /** Deterministic claim identity: hash(normalized_content + scope + claim_type). */
  fingerprint: string;
  confidence: ConfidenceBucket;
  epistemic_tag: EpistemicTag;
  scope: string;
  derived_from: string[];
  relations: ClaimRelation[];
  created_at: string;
  version_at: string;
  operation_id: string;
  actor_id: string;
  tags: string[];
  /** Required when version > 1. */
  supersedes?: number;
  /**
   * Set on a mechanically demoted claim (a resolved duplicate): the surviving claim that
   * supersedes this one, and when the demotion was recorded. Mirrors the derived row's
   * `superseded_by` / `t_invalidated` so that re-materialising this record — compile-path
   * sync or a full canonical replay — reconstructs the demotion instead of restoring the
   * duplicate to the recall-eligible set.
   *
   * This is the substrate's record of the library's duplicate resolution
   * (`resolveFactMatches`), which carries no user warrant and therefore cannot be a
   * canonical `supersedes` relation edge (spec §6: canonical epistemic edges are
   * user-admitted in beta). The demotion does not change `state`: a superseded claim
   * stays `active` for history and audit, exactly as spec §6 says.
   */
  superseded_by?: string;
  /** ISO 8601 commit time of the demotion; present whenever `superseded_by` is. */
  superseded_at?: string;
  /** Set on endorsement-cascade-produced versions. */
  endorsement_source?: string;
  /** Set on revival-produced versions. */
  revived_via?: string;
}

/** Active claim version: content is required. */
export interface ActiveClaimVersion extends ClaimVersionBase {
  state: 'active';
  content: string;
  /** Optional for backwards compatibility with pre-v0.6 materializations. */
  semantic?: ClaimSemanticMaterialization;
}

/** Forgotten claim version: content is omitted (lives in tombstone snapshot). */
export interface ForgottenClaimVersion extends ClaimVersionBase {
  state: 'forgotten';
  tombstone_id: string;
  forgotten_at: string;
  forgotten_by: string;
}

/** One line in the L1 JSONL canonical surface. */
export type ClaimVersionRecord = ActiveClaimVersion | ForgottenClaimVersion;

function monthFilename(commit_ts: string): string {
  return `${commit_ts.slice(0, 7)}.jsonl`; // YYYY-MM
}

export function claimsJsonlPath(dataDir: string, commit_ts: string): string {
  return join(dataDir, 'claims', monthFilename(commit_ts));
}

/**
/** Append one ClaimVersionRecord to the canonical L1 JSONL surface. Caller
 * is responsible for stamping `version_at`/`operation_id`/`actor_id` per
 * the A0 single-commit-timestamp pattern.
 */
export function appendClaimVersion(dataDir: string, record: ClaimVersionRecord): void {
  appendClaimVersions(dataDir, [record]);
}

/**
 * FORGET.SCOPE{reason:erasure} canonical purge (spec §10).
 *
 * Erasure is the ONE sanctioned exception to the append-only L1 discipline:
 * legal/PII erasure physically removes the client's claim version records
 * from the canonical JSONL, because every derived index (Layer1 store, claim
 * FTS, fingerprint index, ops receipts) is regenerated from this log — the
 * record must be gone for wipe-and-rebuild to yield zero results
 * (rebuild-equivalence, §10a). Month files are rewritten atomically
 * (temp + rename) and fsynced; lost lines are not renumbered.
 *
 * Returns the number of claim version records removed.
 */
export function purgeClaimVersionsByScope(dataDir: string, scope: string): number {
  const claimsDir = join(dataDir, 'claims');
  if (!existsSync(claimsDir)) return 0;
  let removed = 0;
  for (const file of readdirSync(claimsDir).filter(f => f.endsWith('.jsonl'))) {
    const filePath = join(claimsDir, file);
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const kept: string[] = [];
    let fileRemoved = 0;
    for (const [i, line] of lines.entries()) {
      let record: { scope?: unknown };
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`Malformed L1 JSONL at ${filePath}:${i + 1}`);
      }
      if (record.scope === scope) {
        fileRemoved++;
        continue;
      }
      kept.push(line);
    }
    if (fileRemoved === 0) continue;
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(tempPath, 'w', 0o600);
    try {
      if (kept.length > 0) writeFileSync(fd, `${kept.join('\n')}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, filePath);
    removed += fileRemoved;
  }
  return removed;
}

/** Append claim versions with one filesystem append per monthly file. */
export function appendClaimVersions(dataDir: string, records: ClaimVersionRecord[]): void {
  if (records.length === 0) return;
  const claimsDir = join(dataDir, 'claims');
  if (!existsSync(claimsDir)) mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
  const linesByPath = new Map<string, string[]>();
  for (const record of records) {
    const recordPath = claimsJsonlPath(dataDir, record.version_at);
    const lines = linesByPath.get(recordPath) ?? [];
    lines.push(JSON.stringify(record));
    linesByPath.set(recordPath, lines);
  }
  for (const [recordPath, lines] of linesByPath) {
    const fd = openSync(recordPath, 'a', 0o600);
    try {
      writeFileSync(fd, lines.join('\n') + '\n', 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/** Iterate every claim version on disk in chronological order. */
export function* iterAllClaimVersions(dataDir: string): Generator<ClaimVersionRecord> {
  const claimsDir = join(dataDir, 'claims');
  if (!existsSync(claimsDir)) return;
  const files = readdirSync(claimsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort(); // YYYY-MM lexicographic = chronological
  for (const file of files) {
    const lines = readFileSync(join(claimsDir, file), 'utf-8').split('\n').filter(Boolean);
    for (const [i, line] of lines.entries()) {
      try {
        yield backfillClaimVersion(JSON.parse(line) as Record<string, unknown>);
      } catch {
        throw new Error(`Malformed L1 JSONL at ${file}:${i + 1}`);
      }
    }
  }
}

/** All versions for a given claim_id in version order. */
export function readClaimHistory(dataDir: string, claimId: string): ClaimVersionRecord[] {
  const versions: ClaimVersionRecord[] = [];
  for (const v of iterAllClaimVersions(dataDir)) {
    if (v.claim_id === claimId) versions.push(v);
  }
  return versions.sort((a, b) => a.version - b.version);
}

/** Latest version of a claim_id, or null if none exists. */
export function readLatestVersion(dataDir: string, claimId: string): ClaimVersionRecord | null {
  let latest: ClaimVersionRecord | null = null;
  for (const v of iterAllClaimVersions(dataDir)) {
    if (v.claim_id !== claimId) continue;
    if (!latest || v.version > latest.version) latest = v;
  }
  return latest;
}

/** Next version number for a claim_id (1 if no history). */
export function nextVersion(dataDir: string, claimId: string): number {
  const latest = readLatestVersion(dataDir, claimId);
  return latest ? latest.version + 1 : 1;
}

/**
 * Reconstruct a claim's full snapshot at v(N) — used by tombstone repair
 * and as-of queries (post-beta). Walks the version chain forward and
 * returns the state at the requested version, or the latest if version
 * is omitted.
 */
export function snapshotAt(
  dataDir: string,
  claimId: string,
  version?: number,
): ClaimVersionRecord | null {
  const history = readClaimHistory(dataDir, claimId);
  if (history.length === 0) return null;
  if (version === undefined) return history[history.length - 1];
  const match = history.find((v) => v.version === version);
  return match ?? null;
}
