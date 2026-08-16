import { createHash } from 'node:crypto';

import { OPERATION_ID_PATTERN } from '../ops_log/types.js';

export const SESSION_CHECKPOINT_KIND = 'session_checkpoint' as const;
export const SESSION_CHECKPOINT_VERSION = 1 as const;

export const SESSION_CHECKPOINT_LIMITS = {
  totalChars: 16_384,
  idChars: 256,
  scopeChars: 256,
  summaryChars: 4_000,
  listItems: 20,
  listItemChars: 1_000,
} as const;

export const SESSION_CHECKPOINT_TRIGGERS = [
  'post_turn',
  'pre_compaction',
  'shutdown',
  'manual',
] as const;

export type SessionCheckpointTrigger = typeof SESSION_CHECKPOINT_TRIGGERS[number];

/**
 * Bounded v1 payload carried through OBSERVE as application/json.
 * It is not a new protocol verb: hosts validate this envelope, then write it
 * with their normal OBSERVE operation and operation_id semantics.
 */
export interface SessionCheckpointV1 {
  kind: typeof SESSION_CHECKPOINT_KIND;
  version: typeof SESSION_CHECKPOINT_VERSION;
  operation_id: string;
  checkpoint_id: string;
  session_id: string;
  scope: string;
  trigger: SessionCheckpointTrigger;
  generation: number;
  summary: string;
  decisions: string[];
  open_loops: string[];
  source_digest: string;
}

export class SessionCheckpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionCheckpointValidationError';
  }
}

export function deriveSessionCheckpointId(
  sessionId: string,
  trigger: SessionCheckpointTrigger,
  generation: number,
): string {
  const digest = createHash('sha256')
    .update(`${sessionId}\u0000${trigger}\u0000${generation}`, 'utf8')
    .digest('hex');
  return `checkpoint_${digest}`;
}

export function isSessionCheckpointContent(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && (value as Record<string, unknown>)['kind'] === SESSION_CHECKPOINT_KIND;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxChars: number,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SessionCheckpointValidationError(`${field} must be a non-empty string`);
  }
  if (value.length > maxChars) {
    throw new SessionCheckpointValidationError(`${field} exceeds ${maxChars} characters`);
  }
}

function requireBoundedList(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new SessionCheckpointValidationError(`${field} must be an array`);
  }
  if (value.length > SESSION_CHECKPOINT_LIMITS.listItems) {
    throw new SessionCheckpointValidationError(
      `${field} exceeds ${SESSION_CHECKPOINT_LIMITS.listItems} items`,
    );
  }
  for (let index = 0; index < value.length; index++) {
    requireBoundedString(
      value[index],
      `${field}[${index}]`,
      SESSION_CHECKPOINT_LIMITS.listItemChars,
    );
  }
}

/** Validate identity, scope, idempotency and hard size bounds for checkpoint v1. */
export function validateSessionCheckpoint(value: unknown): SessionCheckpointV1 {
  if (!isSessionCheckpointContent(value)) {
    throw new SessionCheckpointValidationError(`kind must be '${SESSION_CHECKPOINT_KIND}'`);
  }
  if (value['version'] !== SESSION_CHECKPOINT_VERSION) {
    throw new SessionCheckpointValidationError(`version must be ${SESSION_CHECKPOINT_VERSION}`);
  }

  requireBoundedString(value['operation_id'], 'operation_id', 29);
  if (!OPERATION_ID_PATTERN.test(value['operation_id'])) {
    throw new SessionCheckpointValidationError('operation_id is not a valid Smartware operation ID');
  }
  requireBoundedString(value['session_id'], 'session_id', SESSION_CHECKPOINT_LIMITS.idChars);
  requireBoundedString(value['scope'], 'scope', SESSION_CHECKPOINT_LIMITS.scopeChars);
  requireBoundedString(value['summary'], 'summary', SESSION_CHECKPOINT_LIMITS.summaryChars);
  requireBoundedList(value['decisions'], 'decisions');
  requireBoundedList(value['open_loops'], 'open_loops');
  requireBoundedString(value['source_digest'], 'source_digest', 71);
  if (!/^sha256:[a-f0-9]{64}$/.test(value['source_digest'])) {
    throw new SessionCheckpointValidationError('source_digest must be sha256:<64 lowercase hex characters>');
  }
  if (!SESSION_CHECKPOINT_TRIGGERS.includes(value['trigger'] as SessionCheckpointTrigger)) {
    throw new SessionCheckpointValidationError(
      `trigger must be one of ${SESSION_CHECKPOINT_TRIGGERS.join(', ')}`,
    );
  }
  if (!Number.isSafeInteger(value['generation']) || (value['generation'] as number) < 0) {
    throw new SessionCheckpointValidationError('generation must be a non-negative safe integer');
  }

  const expectedId = deriveSessionCheckpointId(
    value['session_id'],
    value['trigger'] as SessionCheckpointTrigger,
    value['generation'] as number,
  );
  if (value['checkpoint_id'] !== expectedId) {
    throw new SessionCheckpointValidationError(
      'checkpoint_id must be deterministically derived from session_id, trigger, and generation',
    );
  }

  const serialized = JSON.stringify(value);
  if (serialized.length > SESSION_CHECKPOINT_LIMITS.totalChars) {
    throw new SessionCheckpointValidationError(
      `checkpoint exceeds ${SESSION_CHECKPOINT_LIMITS.totalChars} serialized characters`,
    );
  }

  return value as unknown as SessionCheckpointV1;
}

/** Human-readable L1 projection; the complete envelope remains in L0 and semantic metadata. */
export function renderSessionCheckpoint(checkpoint: SessionCheckpointV1): string {
  const sections = [`Checkpoint: ${checkpoint.summary}`];
  if (checkpoint.decisions.length > 0) {
    sections.push(`Decisions:\n${checkpoint.decisions.map(item => `- ${item}`).join('\n')}`);
  }
  if (checkpoint.open_loops.length > 0) {
    sections.push(`Open loops:\n${checkpoint.open_loops.map(item => `- ${item}`).join('\n')}`);
  }
  return sections.join('\n\n');
}
