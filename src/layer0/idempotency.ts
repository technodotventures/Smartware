// Layer 0 — Idempotency helpers

import { createHash } from 'node:crypto';

import type { Layer0Index } from './index.js';

export type IdempotencyResult =
  | { kind: 'none' }
  | { kind: 'duplicate'; existingId: string }
  | { kind: 'conflict'; existingId: string };

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function computePayloadHash(payload: unknown): string {
  const stable = stableValue(payload);
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function checkIdempotency(
  index: Layer0Index,
  actorId: string,
  key: string | undefined,
  payloadHash: string,
): IdempotencyResult {
  if (!key) return { kind: 'none' };

  const existing = index.checkIdempotency(actorId, key);
  if (!existing) return { kind: 'none' };
  if (existing.payload_hash === payloadHash) {
    return { kind: 'duplicate', existingId: existing.id };
  }
  return { kind: 'conflict', existingId: existing.id };
}

export function checkLegacySourceDedup(
  index: Layer0Index,
  app: string,
  sourceId: string | null,
): { isDuplicate: boolean; existingId?: string } {
  if (!sourceId) return { isDuplicate: false };
  const existingId = index.checkDedup(app, sourceId);
  if (existingId) return { isDuplicate: true, existingId };
  return { isDuplicate: false };
}

