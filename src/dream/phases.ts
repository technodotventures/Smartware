import { createHash } from 'node:crypto';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';

import type { CommitContext } from '../ops_log/commit.js';
import { runCommitSync } from '../ops_log/commit.js';
import { runRecovery, type RecoveryContext } from '../ops_log/recovery.js';
import { extractDeterministic } from '../extraction/deterministic.js';
import { readAll } from '../layer0/log.js';
import {
  TERMINAL_STATES,
  TRANSITIONS,
  type EffectiveStatus,
  type Observation,
} from '../layer0/types.js';
import { iterAllClaimVersions, type ClaimVersionRecord } from '../layer1/jsonl.js';
import type { OpType } from '../ops_log/types.js';
import { ensurePrivateDirectory, writePrivateFile } from '../storage/private-fs.js';

export type DreamPhaseOutcome = 'clean' | 'findings' | 'error' | 'skipped';

export interface DreamPhaseResult {
  phase: string;
  op: OpType;
  operation_id: string;
  started_at: string;
  ended_at: string;
  outcome: DreamPhaseOutcome;
  canonical_writes: string[];
  derived_writes: string[];
  errors: string[];
}

export interface DreamResult {
  run_id: string;
  phases: DreamPhaseResult[];
  scope: string;
  started_at: string;
  ended_at: string;
  report_path?: string;
}

type PhaseValue = Pick<DreamPhaseResult, 'canonical_writes' | 'derived_writes' | 'errors'> & {
  outcome?: DreamPhaseOutcome;
};
type PhaseRunner = (scope: string) => PhaseValue;

function runPhase(
  ctx: CommitContext,
  podActorId: string,
  runId: string,
  phaseName: string,
  op: OpType,
  scope: string,
  runner: PhaseRunner,
): DreamPhaseResult {
  const operationId = `op_${ulid()}`;
  const started_at = new Date().toISOString();
  let value: PhaseValue;
  try {
    value = runner(scope);
  } catch (error) {
    value = {
      canonical_writes: [],
      derived_writes: [],
      errors: [(error as Error).message],
      outcome: 'error',
    };
  }
  const outcome = value.outcome
    ?? (value.errors.length > 0
      ? 'error'
      : value.derived_writes.length > 0 || value.canonical_writes.length > 0
        ? 'findings'
        : 'clean');
  const ended_at = new Date().toISOString();

  // Phase work happens first. The canonical operations-log entry is the final
  // write and records only counts/status, never memory content.
  runCommitSync(ctx, {
    operation_id: operationId,
    actor_id: podActorId,
    op,
    details: {
      run_id: runId,
      phase: phaseName,
      scope,
      outcome,
      canonical_write_count: value.canonical_writes.length,
      derived_write_count: value.derived_writes.length,
      error_count: value.errors.length,
    },
  }, () => undefined);

  return {
    phase: phaseName,
    op,
    operation_id: operationId,
    started_at,
    ended_at,
    outcome,
    canonical_writes: value.canonical_writes,
    derived_writes: value.derived_writes,
    errors: value.errors,
  };
}

export interface DreamOptions {
  evidenceDir?: string;
  /** Smartware data directory containing claims/. */
  claimsDir?: string;
  wikiDir?: string;
  quarantineDir?: string;
  /** Derived report directory. No canonical memory is written here. */
  reportDir?: string;
  /** Explicit opt-in for operator-controlled L2 recompilation. Off by default. */
  recompile?: () => void;
}

function latestClaimVersions(dataDir: string): ClaimVersionRecord[] {
  const latest = new Map<string, ClaimVersionRecord>();
  for (const version of iterAllClaimVersions(dataDir)) {
    const previous = latest.get(version.claim_id);
    if (!previous || version.version > previous.version) latest.set(version.claim_id, version);
  }
  return [...latest.values()];
}

const DREAM_REVIEW_CLAIM_LIMIT = 500;
const NEAR_DUPLICATE_THRESHOLD = 0.82;

function reviewTokens(content: string): Set<string> {
  const tokens = content.toLowerCase().normalize('NFC')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(token => token.length > 2)
    .map(token => token.length > 5 ? token.replace(/(?:ing|ed|es|s)$/, '') : token);
  return new Set(tokens);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(',')}}`;
}

function reviewCandidateKey(prefix: string, ids: string[]): string {
  const sorted = [...ids].sort();
  const digest = createHash('sha256').update(sorted.join('\u0000')).digest('hex').slice(0, 16);
  return `${prefix}:${digest}:${sorted.join(',')}`;
}

function nearDuplicateCandidates(claims: ClaimVersionRecord[]): string[] {
  const active = claims.filter((claim): claim is Extract<ClaimVersionRecord, { state: 'active' }> =>
    claim.state === 'active').slice(0, DREAM_REVIEW_CLAIM_LIMIT);
  const parents = active.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const tokens = active.map(claim => reviewTokens(claim.content));
  for (let left = 0; left < active.length; left++) {
    for (let right = left + 1; right < active.length; right++) {
      if (active[left]!.claim_type !== active[right]!.claim_type) continue;
      if (active[left]!.fingerprint === active[right]!.fingerprint) continue;
      if (tokens[left]!.size < 3 || tokens[right]!.size < 3) continue;
      if (jaccard(tokens[left]!, tokens[right]!) >= NEAR_DUPLICATE_THRESHOLD) union(left, right);
    }
  }
  const clusters = new Map<number, string[]>();
  for (let index = 0; index < active.length; index++) {
    const root = find(index);
    const ids = clusters.get(root) ?? [];
    ids.push(active[index]!.claim_id);
    clusters.set(root, ids);
  }
  return [...clusters.values()]
    .filter(ids => ids.length > 1)
    .map(ids => reviewCandidateKey('near_duplicate_cluster', ids));
}

function contradictionCandidates(claims: ClaimVersionRecord[]): string[] {
  const groups = new Map<string, Array<{ id: string; object: string }>>();
  for (const claim of claims.slice(0, DREAM_REVIEW_CLAIM_LIMIT)) {
    if (claim.state !== 'active' || !claim.semantic) continue;
    const key = stableValue({
      subject: claim.semantic.subject_name.trim().toLowerCase(),
      predicate: claim.semantic.predicate.trim().toLowerCase(),
    });
    const alternatives = groups.get(key) ?? [];
    alternatives.push({ id: claim.claim_id, object: stableValue(claim.semantic.object) });
    groups.set(key, alternatives);
  }
  const candidates: string[] = [];
  for (const alternatives of groups.values()) {
    if (new Set(alternatives.map(candidate => candidate.object)).size < 2) continue;
    candidates.push(reviewCandidateKey(
      'contradiction_candidate',
      alternatives.map(candidate => candidate.id),
    ));
  }
  return candidates;
}

function effectiveObservationStatuses(observations: Observation[]): Map<string, EffectiveStatus> {
  const statuses = new Map<string, EffectiveStatus>();
  for (const observation of observations) {
    statuses.set(observation.id, observation.status);
    if (!['tombstone', 'redaction', 'quarantine_review'].includes(observation.type)) continue;

    const body = observation.content.body;
    if (!body || typeof body !== 'object') continue;
    const targetId = (body as Record<string, unknown>)['target_id'];
    const targetKind = (body as Record<string, unknown>)['target_kind'] ?? 'observation';
    if (typeof targetId !== 'string' || targetKind !== 'observation') continue;

    const current = statuses.get(targetId);
    if (!current || TERMINAL_STATES.has(current)) continue;
    const action = (body as Record<string, unknown>)['action'];
    const transition = observation.type === 'quarantine_review'
      ? `quarantine_review:${String(action ?? '')}`
      : observation.type;
    const next = TRANSITIONS[current]?.[transition];
    if (next) statuses.set(targetId, next);
  }
  return statuses;
}

function persistReport(reportDir: string, report: DreamResult): string {
  ensurePrivateDirectory(reportDir);
  const filename = `${report.started_at.replace(/[:.]/g, '-')}-${report.run_id}.json`;
  const reportPath = join(reportDir, filename);
  const tmpPath = `${reportPath}.tmp`;
  const persisted = { ...report, report_path: reportPath };
  writePrivateFile(tmpPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, reportPath);
  return reportPath;
}

/**
 * Run the default operator Dream phases once.
 *
 * This function does not schedule itself. Without an explicit `recompile`
 * callback it writes no canonical L0/L1/L2 data; it records phase outcomes in
 * the operations log and optionally persists a discardable derived report.
 */
export function runDefaultDream(
  ctx: CommitContext,
  podActorId: string,
  scope: string,
  options: DreamOptions = {},
): DreamResult {
  const runId = `dream_${ulid()}`;
  const started_at = new Date().toISOString();
  const phases: DreamPhaseResult[] = [];

  const recoveryContext = (): RecoveryContext => ({
    opsDir: ctx.opsDir,
    evidenceDir: options.evidenceDir ?? '',
    claimsDir: options.claimsDir,
    wikiDir: options.wikiDir,
    quarantineDir: options.quarantineDir ?? '',
  });

  phases.push(runPhase(ctx, podActorId, runId, 'verify', 'dream.verify', scope, () => {
    if (!options.evidenceDir && !options.claimsDir && !options.wikiDir) {
      return { canonical_writes: [], derived_writes: [], errors: [], outcome: 'skipped' };
    }
    const report = runRecovery(recoveryContext());
    const derived_writes = [
      ...report.orphans.map(orphan =>
        `recovery_orphan:${orphan.surface}:${orphan.locator}:${orphan.operation_id ?? 'missing'}`),
      ...report.pendingOperations.map(operationId => `recovery_pending:${operationId}`),
      ...report.intentErrors.map(error =>
        `recovery_intent_error:${createHash('sha256').update(error).digest('hex').slice(0, 16)}`),
    ];
    const errors = [
      ...(report.requiresManualReview.length > 0
        ? [`${report.requiresManualReview.length} operation(s) require manual recovery review`]
        : []),
      ...(report.intentErrors.length > 0
        ? [`${report.intentErrors.length} malformed operation intent(s) require manual review`]
        : []),
    ];
    return { canonical_writes: [], derived_writes, errors };
  }));

  phases.push(runPhase(ctx, podActorId, runId, 'extract_relations', 'dream.extract_relations', scope, () => {
    const derived_writes: string[] = [];
    if (options.evidenceDir) {
      const observations = [...readAll(options.evidenceDir)];
      const effectiveStatuses = effectiveObservationStatuses(observations);
      for (const obs of observations) {
        if (effectiveStatuses.get(obs.id) !== 'accepted' || obs.scope !== scope) continue;
        if (['tombstone', 'redaction', 'quarantine_review'].includes(obs.type)) continue;
        const bodyText = typeof obs.content.body === 'string' ? obs.content.body : JSON.stringify(obs.content.body);
        if (!bodyText || bodyText.length < 10) continue;
        const { relation_proposals } = extractDeterministic(bodyText, obs.scope, 'observation', obs.source.observed_at);
        for (const proposal of relation_proposals) {
          const key = createHash('sha256')
            .update(`${proposal.source_content}\u0000${proposal.target_content}`)
            .digest('hex')
            .slice(0, 16);
          derived_writes.push(`relation_candidate:${obs.id}:${proposal.rule_id}:${key}`);
        }
      }
    }
    return { canonical_writes: [], derived_writes: [...new Set(derived_writes)], errors: [] };
  }));

  phases.push(runPhase(ctx, podActorId, runId, 'detect_conflicts', 'dream.detect_conflicts', scope, () => {
    const derived_writes: string[] = [];
    if (options.claimsDir) {
      const current = latestClaimVersions(options.claimsDir)
        .filter(version => version.state === 'active' && version.scope === scope);
      const byFingerprint = new Map<string, string[]>();
      for (const version of current) {
        const ids = byFingerprint.get(version.fingerprint) ?? [];
        ids.push(version.claim_id);
        byFingerprint.set(version.fingerprint, ids);
      }
      // Identical active fingerprints are data-quality duplicates, not
      // contradictions. Dream surfaces them for review without inventing an
      // epistemic relation.
      for (const ids of byFingerprint.values()) {
        if (ids.length > 1) derived_writes.push(`duplicate_active_claims:${ids.sort().join(',')}`);
      }
      derived_writes.push(...nearDuplicateCandidates(current));
      derived_writes.push(...contradictionCandidates(current));

      // A preview is a bounded source manifest, not generated truth. Hosts can
      // resolve these checkpoint claims into an orientation card for review.
      const checkpoints = current
        .filter(version => version.claim_type === 'checkpoint' || version.claim_role === 'checkpoint')
        .sort((left, right) => right.version_at.localeCompare(left.version_at))
        .slice(0, 8)
        .map(version => version.claim_id);
      if (checkpoints.length > 0) {
        derived_writes.push(reviewCandidateKey('orientation_card_preview', checkpoints));
      }
    }
    return { canonical_writes: [], derived_writes, errors: [] };
  }));

  phases.push(runPhase(ctx, podActorId, runId, 'recompile_pages', 'dream.recompile_pages', scope, () => {
    if (!options.recompile) {
      return {
        canonical_writes: [],
        derived_writes: ['recompile_skipped:canonical_writes_disabled'],
        errors: [],
        outcome: 'skipped',
      };
    }
    try {
      options.recompile();
      return { canonical_writes: ['pages_recompiled'], derived_writes: [], errors: [] };
    } catch (error) {
      return { canonical_writes: [], derived_writes: [], errors: [(error as Error).message] };
    }
  }));

  phases.push(runPhase(ctx, podActorId, runId, 'check_capacity', 'dream.check_capacity', scope, () => {
    const derived_writes: string[] = [];
    if (options.claimsDir) {
      let totalVersions = 0;
      for (const version of iterAllClaimVersions(options.claimsDir)) {
        if (version.scope !== scope) continue;
        totalVersions += 1;
      }
      const currentClaims = latestClaimVersions(options.claimsDir).filter(version => version.scope === scope);
      const activeClaims = currentClaims.filter(version => version.state === 'active').length;
      const forgottenClaims = currentClaims.length - activeClaims;
      derived_writes.push(
        `capacity:${totalVersions}:versions:${activeClaims}:active_claims:${forgottenClaims}:forgotten_claims`,
      );
    }
    return { canonical_writes: [], derived_writes, errors: [] };
  }));

  phases.push(runPhase(ctx, podActorId, runId, 'find_orphans', 'dream.find_orphans', scope, () => {
    if (!options.evidenceDir && !options.claimsDir && !options.wikiDir) {
      return { canonical_writes: [], derived_writes: [], errors: [], outcome: 'skipped' };
    }
    const report = runRecovery(recoveryContext());
    return {
      canonical_writes: [],
      derived_writes: [
        ...report.orphans.map(orphan =>
          `orphan:${orphan.surface}:${orphan.locator}:${orphan.operation_id ?? 'missing'}`),
        ...report.pendingOperations.map(operationId => `pending_operation:${operationId}`),
      ],
      errors: [
        ...(report.requiresManualReview.length > 0
          ? [`${report.requiresManualReview.length} operation(s) require manual recovery review`]
          : []),
        ...(report.intentErrors.length > 0
          ? [`${report.intentErrors.length} malformed operation intent(s) require manual review`]
          : []),
      ],
    };
  }));

  const result: DreamResult = {
    run_id: runId,
    phases,
    scope,
    started_at,
    ended_at: new Date().toISOString(),
  };
  if (options.reportDir) result.report_path = persistReport(options.reportDir, result);
  return result;
}
