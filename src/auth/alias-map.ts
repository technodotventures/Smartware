// Actor-alias migration record (PR-9 / A4 alias map).
//
// Per Spec v1.5.4.2 Q1 + plan §3 Phase A4 (revised), forward-only actor
// rename works by appending alias entries to `pod_data/agents/aliases.jsonl`.
// Historical L0/L1/ops-log rows retain their original actor_ids; this
// alias map translates at read time.
//
// File format (one JSON object per line):
//   {"legacy_id":"google-drive:connector","spec_id":"sidecar:drive","since":"2026-05-18T..."}
//
// Discipline:
//   - Append-only. Once written, never deleted.
//   - One legacy_id maps to at most one spec_id (last write wins on retry).
//   - resolveActorId() returns the spec_id when legacy_id is known;
//     otherwise returns the input unchanged.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isSpecConformantActorId } from './grants.js';
import { ensurePrivateDirectory, ensurePrivateFile } from '../storage/private-fs.js';

export interface AliasEntry {
  legacy_id: string;
  spec_id: string;
  since: string;
  /** Optional free-text rationale. */
  reason?: string;
}

function aliasesPath(dataDir: string): string {
  return join(dataDir, 'agents', 'aliases.jsonl');
}

/** Read the alias map into an in-memory `legacy → spec` lookup. */
export function loadAliasMap(dataDir: string): Map<string, string> {
  const path = aliasesPath(dataDir);
  if (!existsSync(path)) return new Map();
  const map = new Map<string, string>();
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as AliasEntry;
      if (entry.legacy_id && entry.spec_id) {
        map.set(entry.legacy_id, entry.spec_id);
      }
    } catch {
      // Skip malformed lines; log surface is the file itself.
    }
  }
  return map;
}

/**
 * Append a new alias entry. Idempotent on (legacy_id, spec_id): re-appending
 * the same pair adds a duplicate line; resolveActorId returns the last one.
 */
export function appendAlias(dataDir: string, entry: Omit<AliasEntry, 'since'> & { since?: string }): AliasEntry {
  const final: AliasEntry = {
    legacy_id: entry.legacy_id,
    spec_id: entry.spec_id,
    since: entry.since ?? new Date().toISOString(),
    reason: entry.reason,
  };
  if (!isSpecConformantActorId(final.spec_id)) {
    throw new Error(`Alias spec_id '${final.spec_id}' is not spec-conformant.`);
  }
  const path = aliasesPath(dataDir);
  ensurePrivateDirectory(join(dataDir, 'agents'));
  appendFileSync(path, JSON.stringify(final) + '\n', { encoding: 'utf8', mode: 0o600 });
  ensurePrivateFile(path);
  return final;
}

/**
 * Translate an actor id through the alias map. Returns the spec-conformant
 * id if a mapping exists; otherwise returns the input unchanged.
 */
export function resolveActorId(map: Map<string, string>, actorId: string): string {
  return map.get(actorId) ?? actorId;
}

/**
 * Coffee Pod default aliases. Called from SmartwareCore.open() so existing
 * Pods get the canonical rename mapping without operator intervention.
 *
 * Adding entries here is forward-compatible — running the migration twice
 * just appends duplicate lines, which loadAliasMap collapses on read.
 */
export const COFFEE_POD_DEFAULT_ALIASES: Array<{ legacy: string; spec: string; reason: string }> = [
  { legacy: 'google-drive:connector', spec: 'sidecar:drive', reason: 'PR-9 A4: spec-strict actor id for Drive sidecar' },
  { legacy: 'google-calendar:connector', spec: 'sidecar:calendar', reason: 'PR-9 A4: spec-strict actor id for Calendar sidecar' },
  { legacy: 'person-local', spec: 'user:local', reason: 'PR-9 A4: rename local-Pod owner to spec user:<slug>' },
];

export function ensureDefaultAliases(dataDir: string): void {
  const existing = loadAliasMap(dataDir);
  for (const entry of COFFEE_POD_DEFAULT_ALIASES) {
    if (existing.get(entry.legacy) === entry.spec) continue;
    appendAlias(dataDir, {
      legacy_id: entry.legacy,
      spec_id: entry.spec,
      reason: entry.reason,
    });
  }
}
