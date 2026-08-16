import { createHash } from 'node:crypto';
import type { ClaimType } from './types.js';

export function computeFingerprint(content: string, scope: string, claimType: ClaimType): string {
  const normalized = content.trim().normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
  const input = `${normalized}|${scope}|${claimType}`;
  const hash = createHash('sha256').update(input, 'utf-8').digest('hex').slice(0, 16);
  return `fp_${hash}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

/** Fingerprint a complete structured assertion, not only its object value. */
export function computeStructuredClaimFingerprint(
  subjectName: string,
  predicate: string,
  object: { type: string; value: unknown },
  scope: string,
  claimType: ClaimType,
): string {
  return computeFingerprint(stableJson({ subjectName, predicate, object }), scope, claimType);
}
