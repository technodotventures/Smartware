// Operation intent write-ahead log.
//
// Intent files contain hashes and artifact identities, never memory content.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { OPERATION_ID_PATTERN } from './types.js';

export interface ObservationOperationIntent {
  version: 1;
  operation_id: string;
  actor_id: string;
  op: 'observe';
  payload_hash: string;
  prepared_at: string;
  expected: {
    surface: 'l0';
    observation_id: string;
    observation_hash: string;
    sequence: number;
  };
  result: {
    id: string;
    status: 'accepted' | 'quarantined';
    sequence: number;
  };
  details: {
    scope: string;
    source: string;
  };
}

export interface ReviseOperationIntent {
  version: 1;
  operation_id: string;
  actor_id: string;
  op: 'revise.claim';
  payload_hash: string;
  prepared_at: string;
  expected: {
    surface: 'l1';
    claim_id: string;
    version: number;
    record_hash: string;
    relation_ids: string[];
    /**
     * Present iff the operation is a user re-pick (`repick_survivor`, protocol v0.5.0): the
     * active copies the same commit demotes, each as `(claim_id, version, record_hash)`. The
     * released copy is `claim_id`/`version`/`record_hash` above. Recovery treats the set as the
     * commit's full artifact list — every one exact, or the operation fails closed.
     */
    repick?: {
      demoted: Array<{
        claim_id: string;
        version: number;
        record_hash: string;
      }>;
    };
  };
  result: {
    claim_id: string;
    new_version: number;
    epistemic_owner: 'agent' | 'user';
    operation_id: string;
    status: 'revised';
    /**
     * The surviving claim that supersedes this one, when the revised claim is still a mechanically
     * demoted duplicate (ADR-0003 → *Carry-forward across hand-built version records*). A REVISE
     * changes metadata, never the asserted fact, so the demotion survives it; recording the pointer
     * on the intent keeps a recovered or replayed commit reporting the same result as the original.
     * Never set on a re-pick, which releases the target instead.
     */
    superseded_by?: string;
    /**
     * Present iff the operation is a re-pick: the copies it demoted (claim ids, oldest first;
     * empty in rescue mode). Mirrors `expected.repick.demoted` by claim_id.
     */
    demoted?: string[];
  };
  details: {
    claim_id: string;
    new_version: number;
  };
}

export interface ForgetOperationIntent {
  version: 1;
  operation_id: string;
  actor_id: string;
  op: 'forget';
  payload_hash: string;
  prepared_at: string;
  expected: {
    surface: 'forget';
    audit: {
      observation_id: string;
      observation_hash: string;
      sequence: number;
    };
    claim_version?: {
      claim_id: string;
      version: number;
      record_hash: string;
    };
  };
  result: {
    target_id: string;
    target_kind: 'observation' | 'claim';
    mode: 'tombstone' | 'redact_if_supported';
    claims_retracted: number;
    claims_reduced: number;
    audit_observation_id: string;
    status: 'forgotten';
  };
  details: {
    target_id: string;
    target_kind: 'observation' | 'claim';
    mode: 'tombstone' | 'redact_if_supported';
  };
}

/**
 * FORGET.SCOPE operation intent (protocol v0.5.0, spec §10). The exact
 * L0 audit observation (scope-level mutation marker) is the artifact the
 * recovery layer verifies and finalizes — the derived purges (Layer1 rows +
 * JSONL, claim/entity/obs FTS, vector records, L2 pages) are destructive
 * side-effects the intent's existence vouches for; a matching audit marker
 * + ops-log entry is the completion proof (same pattern as FORGET).
 */
export interface ForgetScopeOperationIntent {
  version: 1;
  operation_id: string;
  actor_id: string;
  op: 'forget.scope';
  payload_hash: string;
  prepared_at: string;
  expected: {
    surface: 'forget.scope';
    audit: {
      observation_id: string;
      observation_hash: string;
      sequence: number;
    };
    scope: string;
    reason: 'erasure' | 'offboarding';
  };
  result: {
    scope: string;
    reason: 'erasure' | 'offboarding';
    claims_retracted: number;
    observations_retracted: number;
    grants_revoked: string[];
    scope_entry_removed: boolean;
    audit_observation_id: string;
    status: 'forgotten';
  };
  details: {
    scope: string;
    reason: 'erasure' | 'offboarding';
    /** Export-before-erasure link (spec §10c.4) — erasure lane only. */
    export_id?: string;
  };
}

export interface ReviveOperationIntent {
  version: 1;
  operation_id: string;
  actor_id: string;
  op: 'revive';
  payload_hash: string;
  prepared_at: string;
  expected: {
    surface: 'l1';
    claim_id: string;
    version: number;
    record_hash: string;
  };
  result: {
    claim_id: string;
    new_version: number;
    operation_id: string;
    invalidated_edges: string[];
    status: 'revived';
  };
  details: {
    claim_id: string;
    tombstone_id: string;
  };
}

export interface EndorseOperationIntent {
  version: 1;
  operation_id: string;
  actor_id: string;
  op: 'endorse';
  payload_hash: string;
  prepared_at: string;
  expected: {
    surface: 'endorse';
    page: {
      page_id: string;
      content_hash: string;
    };
    claims: Array<{
      claim_id: string;
      version: number;
      record_hash: string;
    }>;
  };
  result: {
    page_id: string;
    claims_endorsed: number;
    operation_id: string;
    commit_ts: string;
    status: 'endorsed';
  };
  details: {
    page_id: string;
  };
}

export interface ReflectClaimOperationIntent {
  version: 1;
  operation_id: string;
  actor_id: string;
  op: 'reflect.auto';
  payload_hash: string;
  prepared_at: string;
  expected: {
    surface: 'l1';
    claim_id: string;
    version: number;
    record_hash: string;
  };
  result: {
    claim_id: string;
    version: number;
    status: 'reflected';
  };
  details: {
    claim_id: string;
    fingerprint: string;
  };
}

export type OperationIntent =
  | ObservationOperationIntent
  | ReviseOperationIntent
  | ForgetOperationIntent
  | ForgetScopeOperationIntent
  | ReviveOperationIntent
  | EndorseOperationIntent
  | ReflectClaimOperationIntent;

export interface OperationIntentReadRecord {
  operation_id: string;
  intent?: OperationIntent;
  error?: string;
}

function hasCommonIntentFields(intent: Partial<OperationIntent>): boolean {
  return intent.version === 1
    && typeof intent.operation_id === 'string'
    && OPERATION_ID_PATTERN.test(intent.operation_id)
    && typeof intent.actor_id === 'string'
    && typeof intent.payload_hash === 'string'
    && /^[a-f0-9]{64}$/.test(intent.payload_hash)
    && typeof intent.prepared_at === 'string';
}

function intentsDir(opsDir: string): string {
  return join(opsDir, 'intents');
}

function intentPath(opsDir: string, operationId: string): string {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error(`Invalid operation intent id '${operationId}'`);
  }
  return join(intentsDir(opsDir), `${operationId}.json`);
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch {
    // Some filesystems do not support directory fsync. The file itself was
    // fsynced before rename, so process-kill durability is still preserved.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isObservationIntent(value: unknown): value is ObservationOperationIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<ObservationOperationIntent>;
  const expected = intent.expected as ObservationOperationIntent['expected'] | undefined;
  const result = intent.result as ObservationOperationIntent['result'] | undefined;
  const details = intent.details as ObservationOperationIntent['details'] | undefined;
  return hasCommonIntentFields(intent)
    && intent.op === 'observe'
    && expected?.surface === 'l0'
    && typeof expected.observation_id === 'string'
    && typeof expected.observation_hash === 'string'
    && Number.isInteger(expected.sequence)
    && result?.id === expected.observation_id
    && (result.status === 'accepted' || result.status === 'quarantined')
    && result.sequence === expected.sequence
    && typeof details?.scope === 'string'
    && typeof details.source === 'string';
}

function isReviseIntent(value: unknown): value is ReviseOperationIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<ReviseOperationIntent>;
  const expected = intent.expected as ReviseOperationIntent['expected'] | undefined;
  const result = intent.result as ReviseOperationIntent['result'] | undefined;
  const details = intent.details as ReviseOperationIntent['details'] | undefined;
  const repick = expected?.repick;
  const demoted = result?.demoted;
  const repickWellFormed = repick === undefined || (
    typeof repick === 'object'
    && Array.isArray(repick.demoted)
    && repick.demoted.every(artifact =>
      !!artifact
      && typeof artifact.claim_id === 'string'
      && Number.isInteger(artifact.version)
      && typeof artifact.record_hash === 'string'
      && /^[a-f0-9]{64}$/.test(artifact.record_hash))
  );
  const demotedWellFormed = demoted === undefined || (
    Array.isArray(demoted) && demoted.every(claimId => typeof claimId === 'string')
  );
  const repickConsistent = repick === undefined
    ? demoted === undefined
    : demoted !== undefined
      && repick.demoted.length === demoted.length
      && demoted.every((claimId, index) => claimId === repick.demoted[index]!.claim_id);
  return hasCommonIntentFields(intent)
    && intent.op === 'revise.claim'
    && expected?.surface === 'l1'
    && typeof expected.claim_id === 'string'
    && Number.isInteger(expected.version)
    && typeof expected.record_hash === 'string'
    && /^[a-f0-9]{64}$/.test(expected.record_hash)
    && Array.isArray(expected.relation_ids)
    && expected.relation_ids.every(relationId => typeof relationId === 'string')
    && repickWellFormed
    && demotedWellFormed
    && repickConsistent
    && result?.claim_id === expected.claim_id
    && result.new_version === expected.version
    && (result.epistemic_owner === 'agent' || result.epistemic_owner === 'user')
    && result.operation_id === intent.operation_id
    && result.status === 'revised'
    && (result.superseded_by === undefined || typeof result.superseded_by === 'string')
    // A re-pick releases its target: it never reports `superseded_by`, and its demotions are
    // always named (empty array included, for rescue mode).
    && (repick === undefined || result.superseded_by === undefined)
    && details?.claim_id === expected.claim_id
    && details.new_version === expected.version;
}

function isForgetIntent(value: unknown): value is ForgetOperationIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<ForgetOperationIntent>;
  const expected = intent.expected as ForgetOperationIntent['expected'] | undefined;
  const result = intent.result as ForgetOperationIntent['result'] | undefined;
  const details = intent.details as ForgetOperationIntent['details'] | undefined;
  const claimVersion = expected?.claim_version;
  const validMode = result?.mode === 'tombstone' || result?.mode === 'redact_if_supported';
  const validTargetKind = result?.target_kind === 'observation' || result?.target_kind === 'claim';
  return hasCommonIntentFields(intent)
    && intent.op === 'forget'
    && expected?.surface === 'forget'
    && typeof expected.audit?.observation_id === 'string'
    && typeof expected.audit.observation_hash === 'string'
    && Number.isInteger(expected.audit.sequence)
    && (claimVersion === undefined || (
      typeof claimVersion.claim_id === 'string'
      && Number.isInteger(claimVersion.version)
      && typeof claimVersion.record_hash === 'string'
      && /^[a-f0-9]{64}$/.test(claimVersion.record_hash)
    ))
    && typeof result?.target_id === 'string'
    && validTargetKind
    && validMode
    && Number.isInteger(result.claims_retracted)
    && Number.isInteger(result.claims_reduced)
    && result.audit_observation_id === expected.audit.observation_id
    && result.status === 'forgotten'
    && details?.target_id === result.target_id
    && details.target_kind === result.target_kind
    && details.mode === result.mode
    && (result.target_kind === 'claim') === (claimVersion !== undefined);
}

function isForgetScopeIntent(value: unknown): value is ForgetScopeOperationIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<ForgetScopeOperationIntent>;
  const expected = intent.expected as ForgetScopeOperationIntent['expected'] | undefined;
  const result = intent.result as ForgetScopeOperationIntent['result'] | undefined;
  const details = intent.details as ForgetScopeOperationIntent['details'] | undefined;
  const validReason = expected?.reason === 'erasure' || expected?.reason === 'offboarding';
  const validResultReason = result?.reason === 'erasure' || result?.reason === 'offboarding';
  return hasCommonIntentFields(intent)
    && intent.op === 'forget.scope'
    && expected?.surface === 'forget.scope'
    && typeof expected.audit?.observation_id === 'string'
    && typeof expected.audit.observation_hash === 'string'
    && Number.isInteger(expected.audit.sequence)
    && typeof expected.scope === 'string'
    && validReason
    && typeof result?.scope === 'string'
    && validResultReason
    && result.scope === expected.scope
    && result.reason === expected.reason
    && Number.isInteger(result.claims_retracted)
    && Number.isInteger(result.observations_retracted)
    && Array.isArray(result.grants_revoked)
    && result.grants_revoked.every(id => typeof id === 'string')
    && typeof result.scope_entry_removed === 'boolean'
    && result.audit_observation_id === expected.audit.observation_id
    && result.status === 'forgotten'
    && details?.scope === expected.scope
    && details.reason === expected.reason;
}

function isReviveIntent(value: unknown): value is ReviveOperationIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<ReviveOperationIntent>;
  const expected = intent.expected as ReviveOperationIntent['expected'] | undefined;
  const result = intent.result as ReviveOperationIntent['result'] | undefined;
  const details = intent.details as ReviveOperationIntent['details'] | undefined;
  return hasCommonIntentFields(intent)
    && intent.op === 'revive'
    && expected?.surface === 'l1'
    && typeof expected.claim_id === 'string'
    && Number.isInteger(expected.version)
    && typeof expected.record_hash === 'string'
    && /^[a-f0-9]{64}$/.test(expected.record_hash)
    && result?.claim_id === expected.claim_id
    && result.new_version === expected.version
    && result.operation_id === intent.operation_id
    && Array.isArray(result.invalidated_edges)
    && result.invalidated_edges.every(relationId => typeof relationId === 'string')
    && result.status === 'revived'
    && details?.claim_id === expected.claim_id
    && typeof details.tombstone_id === 'string';
}

function isEndorseIntent(value: unknown): value is EndorseOperationIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<EndorseOperationIntent>;
  const expected = intent.expected as EndorseOperationIntent['expected'] | undefined;
  const result = intent.result as EndorseOperationIntent['result'] | undefined;
  const details = intent.details as EndorseOperationIntent['details'] | undefined;
  return hasCommonIntentFields(intent)
    && intent.op === 'endorse'
    && expected?.surface === 'endorse'
    && typeof expected.page?.page_id === 'string'
    && typeof expected.page.content_hash === 'string'
    && /^[a-f0-9]{64}$/.test(expected.page.content_hash)
    && Array.isArray(expected.claims)
    && expected.claims.every(claim =>
      typeof claim.claim_id === 'string'
      && Number.isInteger(claim.version)
      && typeof claim.record_hash === 'string'
      && /^[a-f0-9]{64}$/.test(claim.record_hash))
    && result?.page_id === expected.page.page_id
    && result.claims_endorsed === expected.claims.length
    && result.operation_id === intent.operation_id
    && result.commit_ts === intent.prepared_at
    && result.status === 'endorsed'
    && details?.page_id === expected.page.page_id;
}

function isReflectClaimIntent(value: unknown): value is ReflectClaimOperationIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<ReflectClaimOperationIntent>;
  const expected = intent.expected as ReflectClaimOperationIntent['expected'] | undefined;
  const result = intent.result as ReflectClaimOperationIntent['result'] | undefined;
  const details = intent.details as ReflectClaimOperationIntent['details'] | undefined;
  return hasCommonIntentFields(intent)
    && intent.op === 'reflect.auto'
    && expected?.surface === 'l1'
    && typeof expected.claim_id === 'string'
    && Number.isInteger(expected.version)
    && typeof expected.record_hash === 'string'
    && /^[a-f0-9]{64}$/.test(expected.record_hash)
    && result?.claim_id === expected.claim_id
    && result.version === expected.version
    && result.status === 'reflected'
    && details?.claim_id === expected.claim_id
    && typeof details.fingerprint === 'string';
}

function parseIntent(raw: string, expectedOperationId: string): OperationIntent {
  const parsed = JSON.parse(raw) as unknown;
  if ((!isObservationIntent(parsed)
    && !isReviseIntent(parsed)
    && !isForgetIntent(parsed)
    && !isForgetScopeIntent(parsed)
    && !isReviveIntent(parsed)
    && !isEndorseIntent(parsed)
    && !isReflectClaimIntent(parsed))
    || parsed.operation_id !== expectedOperationId) {
    throw new Error(`Malformed operation intent '${expectedOperationId}'`);
  }
  return parsed;
}

export function readOperationIntent(
  opsDir: string,
  operationId: string,
): OperationIntent | null {
  const filePath = intentPath(opsDir, operationId);
  if (!existsSync(filePath)) return null;
  return parseIntent(readFileSync(filePath, 'utf8'), operationId);
}

export function readOperationIntentRecords(opsDir: string): OperationIntentReadRecord[] {
  const directory = intentsDir(opsDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => {
      const operationId = file.slice(0, -5);
      try {
        if (!OPERATION_ID_PATTERN.test(operationId)) throw new Error('invalid filename');
        return {
          operation_id: operationId,
          intent: parseIntent(readFileSync(join(directory, file), 'utf8'), operationId),
        };
      } catch (error) {
        return { operation_id: operationId, error: (error as Error).message };
      }
    });
}

export function persistOperationIntent(
  opsDir: string,
  intent: OperationIntent,
  allowMatchingReplacement = false,
): void {
  if (!isObservationIntent(intent)
    && !isReviseIntent(intent)
    && !isForgetIntent(intent)
    && !isForgetScopeIntent(intent)
    && !isReviveIntent(intent)
    && !isEndorseIntent(intent)
    && !isReflectClaimIntent(intent)) {
    throw new Error('Invalid operation intent');
  }
  const directory = intentsDir(opsDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const existing = readOperationIntent(opsDir, intent.operation_id);
  if (existing) {
    const matchingIdentity = existing.op === intent.op
      && existing.actor_id === intent.actor_id
      && existing.payload_hash === intent.payload_hash;
    if (!matchingIdentity || !allowMatchingReplacement) {
      if (JSON.stringify(existing) === JSON.stringify(intent)) return;
      throw new Error(`Operation intent '${intent.operation_id}' already exists with different state`);
    }
  }

  const destination = intentPath(opsDir, intent.operation_id);
  const temporary = join(directory, `.${intent.operation_id}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, destination);
  syncDirectory(directory);
}

export function removeOperationIntent(opsDir: string, operationId: string): void {
  const filePath = intentPath(opsDir, operationId);
  if (!existsSync(filePath)) return;
  unlinkSync(filePath);
  syncDirectory(intentsDir(opsDir));
}
