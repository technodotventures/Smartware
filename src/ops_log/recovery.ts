// Operations-log recovery.
//
// Recovery finalizes only one exact, hash-valid canonical artifact described
// by a durable operation intent. Every mismatch remains fail-closed.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { computeHash, verifyChain } from '../layer0/integrity.js';
import { readAll } from '../layer0/log.js';
import type { Observation } from '../layer0/types.js';
import { computePayloadHash } from '../layer0/idempotency.js';
import { iterAllClaimVersions, type ClaimVersionRecord } from '../layer1/jsonl.js';
import {
  readOperationIntentRecords,
  removeOperationIntent,
  type ForgetOperationIntent,
  type ForgetScopeOperationIntent,
  type EndorseOperationIntent,
  type ObservationOperationIntent,
  type ReviseOperationIntent,
  type ReviveOperationIntent,
  type ReflectClaimOperationIntent,
  type OperationIntent,
} from './intent.js';
import { appendOpLogEntry, readAllOpLogEntries } from './log.js';

export interface RecoveryReport {
  committedOperations: number;
  orphans: OrphanArtifact[];
  /** Operations that have intent but no canonical artifact yet. */
  pendingOperations: string[];
  /** Malformed intent records that cannot be interpreted automatically. */
  intentErrors: string[];
  /** OperationIds that cannot be completed or quarantined deterministically. */
  requiresManualReview: string[];
  /** Exact intent-backed operations finalized during this scan. */
  completed: string[];
  /**
   * ADR-0010: uncommitted artifact sets whose ownership epoch is behind the brain's high-water
   * mark (or unknown on a fenced brain). Rejected as a set — never finalized, never merged,
   * never resumable — and reported here for review. Not a writer refusal: the writer is gone.
   */
  staleEpochRejected: StaleEpochRejection[];
  /** Reserved until an append-only quarantine transition is specified. */
  quarantined: string[];
  /** Prepared internal REFLECT claims with no artifact; safe to recompute. */
  aborted: string[];
}

export type StaleEpochReason = 'epoch_behind_high_water' | 'unstamped_on_fenced_brain';

export interface StaleEpochRejection {
  operation_id: string;
  reason: StaleEpochReason;
  /** The epoch the set was prepared under; null when the intent carries no stamp. */
  epoch: number | null;
  high_water: number;
  /** Canonical artifacts found for this operation across the scanned surfaces. */
  artifacts: number;
}

/**
 * The recovery-path fence surface (ADR-0010) — a subset of the writer-path `CommitFence`.
 * Absent = legacy caller (unfenced brain: dispositions are unchanged and byte-identical).
 */
export interface RecoveryFence {
  highWater(): number;
  authorization(operationId: string): { epoch: number } | null;
  /**
   * Atomically authorize a set prepared under `epoch` (re-checked against the high-water mark
   * inside the transaction). False = the epoch is behind the mark: reject the set as stale.
   */
  authorizeAtEpoch(operationIds: string[], epoch: number, writer_id: string): boolean;
}

export interface OrphanArtifact {
  surface: 'l0' | 'l1' | 'l2' | 'tombstone';
  locator: string;
  operation_id: string | null;
}

export interface RecoveryContext {
  opsDir: string;
  evidenceDir: string;
  /** Smartware data directory containing claims/. */
  claimsDir?: string;
  wikiDir?: string;
  /** Storage-level fencing (ADR-0010). Absent = legacy scan (no epoch dispositions). */
  fence?: RecoveryFence;
  /** Reserved for future intent-backed quarantine. */
  quarantineDir: string;
}

function markdownFiles(root: string): string[] {
  if (!root || !existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(candidate);
  }
  return files;
}

function pageOperationId(filePath: string): string | null {
  const raw = readFileSync(filePath, 'utf8');
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!frontmatter) return null;
  const match = frontmatter.match(/^(?:operation_id|endorsement_operation_id):\s*["']?([^\s"']+)["']?\s*$/m);
  return match?.[1] ?? null;
}

interface PageArtifact {
  page_id: string | null;
  content_hash: string;
  locator: string;
}

function groupPagesByOperation(wikiDir: string): Map<string, PageArtifact[]> {
  const grouped = new Map<string, PageArtifact[]>();
  for (const filePath of markdownFiles(wikiDir)) {
    const operationId = pageOperationId(filePath);
    if (!operationId) continue;
    const raw = readFileSync(filePath, 'utf8');
    const pageId = raw.match(/^page_id:\s*["']?([^\s"']+)["']?\s*$/m)?.[1] ?? null;
    const matches = grouped.get(operationId) ?? [];
    matches.push({
      page_id: pageId,
      content_hash: computePayloadHash(raw),
      locator: filePath,
    });
    grouped.set(operationId, matches);
  }
  return grouped;
}

function groupL0ByOperation(observations: Observation[]): Map<string, Observation[]> {
  const grouped = new Map<string, Observation[]>();
  for (const observation of observations) {
    if (!observation.operation_id) continue;
    const matches = grouped.get(observation.operation_id) ?? [];
    matches.push(observation);
    grouped.set(observation.operation_id, matches);
  }
  return grouped;
}

function groupL1ByOperation(versions: ClaimVersionRecord[]): Map<string, ClaimVersionRecord[]> {
  const grouped = new Map<string, ClaimVersionRecord[]>();
  for (const version of versions) {
    if (!version.operation_id) continue;
    const matches = grouped.get(version.operation_id) ?? [];
    matches.push(version);
    grouped.set(version.operation_id, matches);
  }
  return grouped;
}

function isExactObservationIntent(
  intent: ObservationOperationIntent,
  observation: Observation,
  allObservations: Observation[],
): boolean {
  if (observation.id !== intent.expected.observation_id
    || observation.operation_id !== intent.operation_id
    || observation.actor_id !== intent.actor_id
    || observation.integrity.hash !== intent.expected.observation_hash
    || observation.integrity.sequence !== intent.expected.sequence
    || observation.id !== intent.result.id
    || observation.status !== intent.result.status
    || observation.integrity.sequence !== intent.result.sequence
    || computeHash(observation) !== observation.integrity.hash) {
    return false;
  }

  const writerChain = allObservations
    .filter(candidate => candidate.integrity.writer_id === observation.integrity.writer_id)
    .sort((left, right) => left.integrity.sequence - right.integrity.sequence);
  const position = writerChain.findIndex(candidate => candidate.id === observation.id);
  return position >= 0 && verifyChain(writerChain.slice(0, position + 1)).valid;
}

function isExactReviseIntent(
  intent: ReviseOperationIntent,
  version: ClaimVersionRecord,
): boolean {
  return version.state === 'active'
    && version.claim_id === intent.expected.claim_id
    && version.version === intent.expected.version
    && version.operation_id === intent.operation_id
    && version.actor_id === intent.actor_id
    && version.version_at === intent.prepared_at
    && version.epistemic_owner === intent.result.epistemic_owner
    && computePayloadHash(version) === intent.expected.record_hash;
}

function isExactForgetAudit(
  intent: ForgetOperationIntent,
  observation: Observation,
  allObservations: Observation[],
): boolean {
  if (observation.id !== intent.expected.audit.observation_id
    || observation.operation_id !== intent.operation_id
    || observation.actor_id !== intent.actor_id
    || observation.integrity.hash !== intent.expected.audit.observation_hash
    || observation.integrity.sequence !== intent.expected.audit.sequence
    || computeHash(observation) !== observation.integrity.hash) {
    return false;
  }
  const writerChain = allObservations
    .filter(candidate => candidate.integrity.writer_id === observation.integrity.writer_id)
    .sort((left, right) => left.integrity.sequence - right.integrity.sequence);
  const position = writerChain.findIndex(candidate => candidate.id === observation.id);
  return position >= 0 && verifyChain(writerChain.slice(0, position + 1)).valid;
}

/**
 * FORGET.SCOPE audit-marker exactness (protocol v0.5.0, spec §10): the
 * single L0 observation of the operation's intent is the completion proof.
 * The body must identify the same scope/reason the intent was prepared for
 * — a marker with a different scope is NOT this operation's artifact.
 */
function isExactForgetScopeAudit(
  intent: ForgetScopeOperationIntent,
  observation: Observation,
  allObservations: Observation[],
): boolean {
  if (observation.id !== intent.expected.audit.observation_id
    || observation.operation_id !== intent.operation_id
    || observation.actor_id !== intent.actor_id
    || observation.integrity.hash !== intent.expected.audit.observation_hash
    || observation.integrity.sequence !== intent.expected.audit.sequence
    || computeHash(observation) !== observation.integrity.hash) {
    return false;
  }
  const body = observation.content.body as Record<string, unknown> | undefined;
  const bodyReason = body?.['reason'];
  if (targetScopeFromAudit(body) !== intent.expected.scope
    || bodyReason !== intent.expected.reason) {
    return false;
  }
  const writerChain = allObservations
    .filter(candidate => candidate.integrity.writer_id === observation.integrity.writer_id)
    .sort((left, right) => left.integrity.sequence - right.integrity.sequence);
  const position = writerChain.findIndex(candidate => candidate.id === observation.id);
  return position >= 0 && verifyChain(writerChain.slice(0, position + 1)).valid;
}

/** The scope a scope-level audit/marker observation targets. */
function targetScopeFromAudit(body: Record<string, unknown> | undefined): string | null {
  if (!body) return null;
  if (typeof body['scope'] === 'string') return body['scope'];
  const target = body['target'] as Record<string, unknown> | undefined;
  if (target && typeof target['scope'] === 'string') return target['scope'];
  return null;
}

function isExactForgetClaim(
  intent: ForgetOperationIntent,
  version: ClaimVersionRecord,
): boolean {
  const expected = intent.expected.claim_version;
  return expected !== undefined
    && version.state === 'forgotten'
    && version.claim_id === expected.claim_id
    && version.version === expected.version
    && version.operation_id === intent.operation_id
    && version.actor_id === intent.actor_id
    && version.version_at === intent.prepared_at
    && computePayloadHash(version) === expected.record_hash;
}

function isExactReviveIntent(
  intent: ReviveOperationIntent,
  version: ClaimVersionRecord,
): boolean {
  return version.state === 'active'
    && version.claim_id === intent.expected.claim_id
    && version.version === intent.expected.version
    && version.operation_id === intent.operation_id
    && version.actor_id === intent.actor_id
    && version.version_at === intent.prepared_at
    && computePayloadHash(version) === intent.expected.record_hash;
}

function isExactEndorseClaims(
  intent: EndorseOperationIntent,
  versions: ClaimVersionRecord[],
): boolean {
  if (versions.length !== intent.expected.claims.length) return false;
  const byIdentity = new Map(versions.map(version => [`${version.claim_id}@${version.version}`, version]));
  return intent.expected.claims.every(expected => {
    const version = byIdentity.get(`${expected.claim_id}@${expected.version}`);
    return !!version
      && version.state === 'active'
      && version.operation_id === intent.operation_id
      && version.actor_id === intent.actor_id
      && version.version_at === intent.prepared_at
      && computePayloadHash(version) === expected.record_hash;
  });
}

function isExactEndorsePage(
  intent: EndorseOperationIntent,
  pages: PageArtifact[],
): boolean {
  return pages.length === 1
    && pages[0]!.page_id === intent.expected.page.page_id
    && pages[0]!.content_hash === intent.expected.page.content_hash;
}

function isExactReflectClaimIntent(
  intent: ReflectClaimOperationIntent,
  version: ClaimVersionRecord,
): boolean {
  return version.state === 'active'
    && version.claim_id === intent.expected.claim_id
    && version.version === intent.expected.version
    && version.operation_id === intent.operation_id
    && version.actor_id === intent.actor_id
    && version.version_at === intent.prepared_at
    && computePayloadHash(version) === intent.expected.record_hash;
}

export function runRecovery(ctx: RecoveryContext): RecoveryReport {
  const entries = [...readAllOpLogEntries(ctx.opsDir)];
  const committed = new Set(entries.map(entry => entry.operation_id));
  const observations = ctx.evidenceDir && existsSync(ctx.evidenceDir)
    ? [...readAll(ctx.evidenceDir)]
    : [];
  const claimVersions = ctx.claimsDir && existsSync(ctx.claimsDir)
    ? [...iterAllClaimVersions(ctx.claimsDir)]
    : [];
  const l0ByOperation = groupL0ByOperation(observations);
  const l1ByOperation = groupL1ByOperation(claimVersions);
  const pagesByOperation = groupPagesByOperation(ctx.wikiDir ?? '');
  const completed: string[] = [];
  const pendingOperations: string[] = [];
  const manualReview = new Set<string>();
  const intentErrors: string[] = [];
  const aborted: string[] = [];
  const staleEpochRejected: StaleEpochRejection[] = [];
  const staleRejectedIds = new Set<string>();

  // ── Storage-level fencing (ADR-0010) ───────────────────────────────────────────────────────
  // An uncommitted artifact set whose epoch is behind the high-water mark (or unknown on a
  // fenced brain) is rejected as a set: never finalized, never merged, never resumable. A set
  // whose commit was already AUTHORIZED at the gate is projected instead — the authorization
  // row is durable proof the commit decision happened while the epoch was current.
  const highWater = ctx.fence ? ctx.fence.highWater() : 0;
  const intentStamp = (intent: OperationIntent): { epoch: number; writer_id: string } | null =>
    (intent as { fence?: { epoch: number; writer_id: string } }).fence ?? null;
  const staleReason = (intent: OperationIntent): StaleEpochReason | null => {
    if (!ctx.fence) return null; // legacy caller: no epoch dispositions
    if (ctx.fence.authorization(intent.operation_id)) return null; // authorized: project
    const stamp = intentStamp(intent);
    if (!stamp) return highWater > 0 ? 'unstamped_on_fenced_brain' : null;
    return stamp.epoch < highWater ? 'epoch_behind_high_water' : null;
  };
  const recordStale = (intent: OperationIntent, reason: StaleEpochReason): void => {
    if (staleRejectedIds.has(intent.operation_id)) return;
    staleRejectedIds.add(intent.operation_id);
    staleEpochRejected.push({
      operation_id: intent.operation_id,
      reason,
      epoch: intentStamp(intent)?.epoch ?? null,
      high_water: highWater,
      artifacts: (l0ByOperation.get(intent.operation_id)?.length ?? 0)
        + (l1ByOperation.get(intent.operation_id)?.length ?? 0)
        + (pagesByOperation.get(intent.operation_id)?.length ?? 0),
    });
  };
  /** Finalize one exact set: gate the commit decision atomically, then append the signal. */
  const finalizeRecovered = (intent: OperationIntent, entry: Parameters<typeof appendOpLogEntry>[1]): boolean => {
    if (ctx.fence && !ctx.fence.authorization(intent.operation_id)) {
      const stamp = intentStamp(intent);
      const authorized = stamp
        ? ctx.fence.authorizeAtEpoch([intent.operation_id], stamp.epoch, stamp.writer_id)
        : highWater === 0;
      if (!authorized) {
        // The epoch went stale during the scan (a claim landed): reject, do not finalize.
        recordStale(intent, staleReason(intent) ?? 'epoch_behind_high_water');
        return false;
      }
    }
    const stamp = intentStamp(intent);
    appendOpLogEntry(
      ctx.opsDir,
      stamp ? { ...entry, details: { ...(entry.details ?? {}), fence: stamp } } : entry,
    );
    return true;
  };

  for (const record of readOperationIntentRecords(ctx.opsDir)) {
    if (!record.intent) {
      intentErrors.push(`${record.operation_id}:${record.error ?? 'malformed intent'}`);
      if (record.operation_id.startsWith('op_')) manualReview.add(record.operation_id);
      continue;
    }
    const intent = record.intent;
    const existing = entries.filter(entry => entry.operation_id === intent.operation_id);

    // ADR-0010: reject (never finalize, never merge) an uncommitted artifact set whose epoch is
    // behind the high-water mark — or unknown on a fenced brain. A set with no artifacts is
    // left to the existing dispositions: none of them finalize without artifacts.
    if (existing.length === 0) {
      const artifacts = (l0ByOperation.get(intent.operation_id)?.length ?? 0)
        + (l1ByOperation.get(intent.operation_id)?.length ?? 0)
        + (pagesByOperation.get(intent.operation_id)?.length ?? 0);
      const reason = artifacts > 0 ? staleReason(intent) : null;
      if (reason) {
        recordStale(intent, reason);
        continue;
      }
    }

    if (intent.op === 'forget') {
      const auditArtifacts = l0ByOperation.get(intent.operation_id) ?? [];
      const claimArtifacts = l1ByOperation.get(intent.operation_id) ?? [];
      const exactAudit = auditArtifacts.length === 1
        && isExactForgetAudit(intent, auditArtifacts[0]!, observations);
      const expectsClaim = intent.expected.claim_version !== undefined;
      const exactClaim = !expectsClaim || (claimArtifacts.length === 1
        && isExactForgetClaim(intent, claimArtifacts[0]!));
      const unexpectedCounts = auditArtifacts.length > 1
        || claimArtifacts.length > (expectsClaim ? 1 : 0);

      if (existing.length > 0) {
        const matchingCommit = existing.some(entry =>
          entry.op === 'forget'
          && entry.actor_id === intent.actor_id
          && entry.details?.['payload_hash'] === intent.payload_hash
          && entry.details?.['audit_observation_id'] === intent.expected.audit.observation_id
          && entry.details?.['claim_record_hash'] === intent.expected.claim_version?.record_hash);
        if (matchingCommit && exactAudit && exactClaim && !unexpectedCounts) {
          removeOperationIntent(ctx.opsDir, intent.operation_id);
        } else {
          manualReview.add(intent.operation_id);
        }
        continue;
      }

      const hasAudit = auditArtifacts.length > 0;
      const hasClaim = claimArtifacts.length > 0;
      if (unexpectedCounts || (hasAudit && !exactAudit) || (hasClaim && !exactClaim)) {
        manualReview.add(intent.operation_id);
        continue;
      }
      if (!exactAudit || !exactClaim) {
        pendingOperations.push(intent.operation_id);
        continue;
      }

      if (!finalizeRecovered(intent, {
        operation_id: intent.operation_id,
        actor_id: intent.actor_id,
        timestamp: intent.prepared_at,
        op: 'forget',
        details: {
          payload_hash: intent.payload_hash,
          audit_observation_id: intent.result.audit_observation_id,
          observation_hash: intent.expected.audit.observation_hash,
          claim_record_hash: intent.expected.claim_version?.record_hash,
          target_id: intent.result.target_id,
          target_kind: intent.result.target_kind,
          mode: intent.result.mode,
          claims_retracted: intent.result.claims_retracted,
          claims_reduced: intent.result.claims_reduced,
          recovered: true,
        },
      })) continue;
      committed.add(intent.operation_id);
      completed.push(intent.operation_id);
      removeOperationIntent(ctx.opsDir, intent.operation_id);
      continue;
    }

    if (intent.op === 'forget.scope') {
      const auditArtifacts = l0ByOperation.get(intent.operation_id) ?? [];
      const exactAudit = auditArtifacts.length === 1
        && isExactForgetScopeAudit(intent, auditArtifacts[0]!, observations);
      if (existing.length > 0) {
        const matchingCommit = existing.some(entry =>
          entry.op === 'forget.scope'
          && entry.actor_id === intent.actor_id
          && entry.details?.['payload_hash'] === intent.payload_hash
          && entry.details?.['audit_observation_id'] === intent.expected.audit.observation_id);
        if (matchingCommit && exactAudit) {
          removeOperationIntent(ctx.opsDir, intent.operation_id);
        } else {
          manualReview.add(intent.operation_id);
        }
        continue;
      }
      const hasAudit = auditArtifacts.length > 0;
      if (hasAudit && !exactAudit) {
        manualReview.add(intent.operation_id);
        continue;
      }
      if (!hasAudit) {
        pendingOperations.push(intent.operation_id);
        continue;
      }
      if (!finalizeRecovered(intent, {
        operation_id: intent.operation_id,
        actor_id: intent.actor_id,
        timestamp: intent.prepared_at,
        op: 'forget.scope',
        details: {
          payload_hash: intent.payload_hash,
          audit_observation_id: intent.result.audit_observation_id,
          observation_hash: intent.expected.audit.observation_hash,
          scope: intent.result.scope,
          reason: intent.result.reason,
          claims_retracted: intent.result.claims_retracted,
          observations_retracted: intent.result.observations_retracted,
          grants_revoked: intent.result.grants_revoked,
          scope_entry_removed: intent.result.scope_entry_removed,
          recovered: true,
          export_id: intent.details.export_id ?? null,
        },
      })) continue;
      committed.add(intent.operation_id);
      completed.push(intent.operation_id);
      removeOperationIntent(ctx.opsDir, intent.operation_id);
      continue;
    }

    if (intent.op === 'revive') {
      const artifacts = l1ByOperation.get(intent.operation_id) ?? [];
      const exactArtifact = artifacts.length === 1
        && isExactReviveIntent(intent, artifacts[0]!);
      if (existing.length > 0) {
        const matchingCommit = existing.some(entry =>
          entry.op === 'revive'
          && entry.actor_id === intent.actor_id
          && entry.details?.['payload_hash'] === intent.payload_hash
          && entry.details?.['claim_id'] === intent.expected.claim_id
          && entry.details?.['new_version'] === intent.expected.version
          && entry.details?.['record_hash'] === intent.expected.record_hash);
        if (matchingCommit && exactArtifact) removeOperationIntent(ctx.opsDir, intent.operation_id);
        else manualReview.add(intent.operation_id);
        continue;
      }
      if (artifacts.length === 0) {
        pendingOperations.push(intent.operation_id);
        continue;
      }
      if (!exactArtifact) {
        manualReview.add(intent.operation_id);
        continue;
      }
      if (!finalizeRecovered(intent, {
        operation_id: intent.operation_id,
        actor_id: intent.actor_id,
        timestamp: intent.prepared_at,
        op: 'revive',
        details: {
          payload_hash: intent.payload_hash,
          claim_id: intent.result.claim_id,
          new_version: intent.result.new_version,
          tombstone_id: intent.details.tombstone_id,
          invalidated_edges: intent.result.invalidated_edges,
          record_hash: intent.expected.record_hash,
          recovered: true,
        },
      })) continue;
      committed.add(intent.operation_id);
      completed.push(intent.operation_id);
      removeOperationIntent(ctx.opsDir, intent.operation_id);
      continue;
    }

    if (intent.op === 'endorse') {
      const claimArtifacts = l1ByOperation.get(intent.operation_id) ?? [];
      const pageArtifacts = pagesByOperation.get(intent.operation_id) ?? [];
      const exactClaims = isExactEndorseClaims(intent, claimArtifacts);
      const exactPage = isExactEndorsePage(intent, pageArtifacts);
      if (existing.length > 0) {
        const matchingCommit = existing.some(entry =>
          entry.op === 'endorse'
          && entry.actor_id === intent.actor_id
          && entry.details?.['payload_hash'] === intent.payload_hash
          && entry.details?.['page_id'] === intent.expected.page.page_id
          && entry.details?.['page_hash'] === intent.expected.page.content_hash);
        if (matchingCommit && exactClaims && exactPage) {
          removeOperationIntent(ctx.opsDir, intent.operation_id);
        } else {
          manualReview.add(intent.operation_id);
        }
        continue;
      }
      const claimsPresent = claimArtifacts.length > 0;
      const pagePresent = pageArtifacts.length > 0;
      const claimsInvalid = claimsPresent && !isExactEndorseClaims({
        ...intent,
        expected: {
          ...intent.expected,
          claims: intent.expected.claims.filter(expected =>
            claimArtifacts.some(version =>
              version.claim_id === expected.claim_id && version.version === expected.version)),
        },
      }, claimArtifacts);
      if (claimsInvalid || (pagePresent && !exactPage)) {
        manualReview.add(intent.operation_id);
        continue;
      }
      if (!exactClaims || !exactPage) {
        pendingOperations.push(intent.operation_id);
        continue;
      }
      if (!finalizeRecovered(intent, {
        operation_id: intent.operation_id,
        actor_id: intent.actor_id,
        timestamp: intent.prepared_at,
        op: 'endorse',
        details: {
          payload_hash: intent.payload_hash,
          page_id: intent.result.page_id,
          page_hash: intent.expected.page.content_hash,
          claims: intent.expected.claims,
          claims_endorsed: intent.result.claims_endorsed,
          recovered: true,
        },
      })) continue;
      committed.add(intent.operation_id);
      completed.push(intent.operation_id);
      removeOperationIntent(ctx.opsDir, intent.operation_id);
      continue;
    }

    if (intent.op === 'reflect.auto') {
      const artifacts = l1ByOperation.get(intent.operation_id) ?? [];
      const exactArtifact = artifacts.length === 1
        && isExactReflectClaimIntent(intent, artifacts[0]!);
      if (existing.length > 0) {
        const matchingCommit = existing.some(entry =>
          entry.op === 'reflect.auto'
          && entry.actor_id === intent.actor_id
          && entry.details?.['payload_hash'] === intent.payload_hash
          && entry.details?.['claim_id'] === intent.expected.claim_id
          && entry.details?.['record_hash'] === intent.expected.record_hash);
        if (matchingCommit && exactArtifact) removeOperationIntent(ctx.opsDir, intent.operation_id);
        else manualReview.add(intent.operation_id);
        continue;
      }
      if (artifacts.length === 0) {
        removeOperationIntent(ctx.opsDir, intent.operation_id);
        aborted.push(intent.operation_id);
        continue;
      }
      if (!exactArtifact) {
        manualReview.add(intent.operation_id);
        continue;
      }
      if (!finalizeRecovered(intent, {
        operation_id: intent.operation_id,
        actor_id: intent.actor_id,
        timestamp: intent.prepared_at,
        op: 'reflect.auto',
        details: {
          payload_hash: intent.payload_hash,
          claim_id: intent.result.claim_id,
          version: intent.result.version,
          fingerprint: intent.details.fingerprint,
          record_hash: intent.expected.record_hash,
          recovered: true,
        },
      })) continue;
      committed.add(intent.operation_id);
      completed.push(intent.operation_id);
      removeOperationIntent(ctx.opsDir, intent.operation_id);
      continue;
    }

    if (existing.length > 0) {
      const matchingCommit = intent.op === 'observe'
        ? existing.some(entry =>
          entry.op === intent.op
          && entry.actor_id === intent.actor_id
          && entry.details?.['payload_hash'] === intent.payload_hash
          && entry.details?.['observation_id'] === intent.expected.observation_id)
        : existing.some(entry =>
          entry.op === intent.op
          && entry.actor_id === intent.actor_id
          && entry.details?.['payload_hash'] === intent.payload_hash
          && entry.details?.['claim_id'] === intent.expected.claim_id
          && entry.details?.['new_version'] === intent.expected.version
          && entry.details?.['record_hash'] === intent.expected.record_hash);
      const matchingArtifact = intent.op === 'observe'
        ? true
        : (l1ByOperation.get(intent.operation_id) ?? []).filter(version =>
          isExactReviseIntent(intent, version)).length === 1;
      if (matchingCommit && matchingArtifact) removeOperationIntent(ctx.opsDir, intent.operation_id);
      else manualReview.add(intent.operation_id);
      continue;
    }

    const artifacts = intent.op === 'observe'
      ? l0ByOperation.get(intent.operation_id) ?? []
      : l1ByOperation.get(intent.operation_id) ?? [];
    if (artifacts.length === 0) {
      pendingOperations.push(intent.operation_id);
      continue;
    }
    const exact = intent.op === 'observe'
      ? isExactObservationIntent(intent, artifacts[0]! as Observation, observations)
      : isExactReviseIntent(intent, artifacts[0]! as ClaimVersionRecord);
    if (artifacts.length !== 1 || !exact) {
      manualReview.add(intent.operation_id);
      continue;
    }

    if (intent.op === 'observe') {
      if (!finalizeRecovered(intent, {
        operation_id: intent.operation_id,
        actor_id: intent.actor_id,
        timestamp: intent.prepared_at,
        op: 'observe',
        details: {
          payload_hash: intent.payload_hash,
          observation_id: intent.result.id,
          scope: intent.details.scope,
          source: intent.details.source,
          status: intent.result.status,
          sequence: intent.result.sequence,
          recovered: true,
        },
      })) continue;
    } else {
      if (!finalizeRecovered(intent, {
        operation_id: intent.operation_id,
        actor_id: intent.actor_id,
        timestamp: intent.prepared_at,
        op: 'revise.claim',
        details: {
          payload_hash: intent.payload_hash,
          claim_id: intent.result.claim_id,
          new_version: intent.result.new_version,
          epistemic_owner: intent.result.epistemic_owner,
          record_hash: intent.expected.record_hash,
          recovered: true,
        },
      })) continue;
    }
    committed.add(intent.operation_id);
    completed.push(intent.operation_id);
    removeOperationIntent(ctx.opsDir, intent.operation_id);
  }

  const orphans: OrphanArtifact[] = [];
  for (const observation of observations) {
    if (observation.operation_id && !committed.has(observation.operation_id)
      && !staleRejectedIds.has(observation.operation_id)) {
      orphans.push({
        surface: 'l0',
        locator: observation.id,
        operation_id: observation.operation_id,
      });
    }
  }

  if (ctx.claimsDir) {
    for (const version of claimVersions) {
      if (version.operation_id && !committed.has(version.operation_id)
        && !staleRejectedIds.has(version.operation_id)) {
        orphans.push({
          surface: 'l1',
          locator: `${version.claim_id}@${version.version}`,
          operation_id: version.operation_id,
        });
      }
    }
  }

  if (ctx.wikiDir) {
    for (const filePath of markdownFiles(ctx.wikiDir)) {
      const operationId = pageOperationId(filePath);
      if (!operationId || committed.has(operationId) || staleRejectedIds.has(operationId)) continue;
      orphans.push({
        surface: filePath.includes(`${join('', 'tombstones')}/`) ? 'tombstone' : 'l2',
        locator: relative(ctx.wikiDir, filePath),
        operation_id: operationId,
      });
    }
  }

  const pendingSet = new Set(pendingOperations);
  for (const orphan of orphans) {
    if (orphan.operation_id && !pendingSet.has(orphan.operation_id)) {
      manualReview.add(orphan.operation_id);
    }
  }

  return {
    committedOperations: committed.size,
    orphans,
    pendingOperations: [...new Set(pendingOperations)].sort(),
    intentErrors,
    requiresManualReview: [...manualReview].sort(),
    completed: [...new Set(completed)].sort(),
    staleEpochRejected: [...staleEpochRejected].sort((a, b) => (a.operation_id < b.operation_id ? -1 : 1)),
    quarantined: [],
    aborted: [...new Set(aborted)].sort(),
  };
}

/**
 * Legacy compatibility helper. Without a matching OBSERVE intent, the only
 * safe automatic classification remains quarantine; runRecovery does not yet
 * apply that disposition to append-only surfaces.
 */
export function classifyOrphan(_orphan: OrphanArtifact): 'completable' | 'quarantine' {
  return 'quarantine';
}
