// Ingestion — source registry: provenance origins within one business brain.
//
// A *source* is where evidence comes from: a connector (Gmail, calendar), a
// meeting bot, a note stream, an agent run, a manual entry, or the system
// itself. The host (Coffee) owns OAuth, scheduling and connector credentials;
// the brain only accepts *authenticated actor + source context* and fails
// closed when that context is absent, unknown, inactive, or claimed by an
// actor the source does not allow.
//
// The registry lives in `config.json` — the provisioning surface, exactly like
// `scopes` and `grants` — so it is per-brain by construction and owner-managed.
// It is not a second task/wiki system: entries are provenance labels, nothing
// more.

import type { Actor } from '../layer0/types.js';
import type {
  SmartwareConfig,
  SourceEntry,
  SourceKind,
  SourceStatus,
} from '../config.js';
import { loadConfig, saveConfig } from '../config.js';
import { ProtocolError, requireOwner } from '../auth/middleware.js';

export type { SourceEntry, SourceKind, SourceStatus };

/** Stable, host-chosen registry id. Also the observation `app` for its items. */
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const SOURCE_KINDS: readonly SourceKind[] = [
  'connector', 'meeting', 'note', 'agent', 'manual', 'system',
];
const SOURCE_STATUSES: readonly SourceStatus[] = ['active', 'paused', 'revoked'];

export interface RegisterSourceParams {
  actor: Actor;
  id: string;
  kind: SourceKind;
  display_name: string;
  /** Default `active`. `paused` / `revoked` refuse new writes, keep history. */
  status?: SourceStatus;
  /** Optional allow-list of actor ids permitted to write under this source. */
  actor_ids?: string[];
  /** Optional opaque host-side handle (mailbox / account / calendar id). */
  external_ref?: string | null;
}

/** Every registered source in this brain (empty for pre-registry configs). */
export function listSourceEntries(config: SmartwareConfig): SourceEntry[] {
  return [...(config.sources ?? [])];
}

export function getSourceEntry(config: SmartwareConfig, id: string): SourceEntry | null {
  return (config.sources ?? []).find(entry => entry.id === id) ?? null;
}

/**
 * Owner-only upsert. Re-registering an id updates the mutable fields
 * (display name, kind, status, allow-list, external ref) and preserves
 * `created_at` — the entry's identity is its id.
 */
export function registerSourceEntry(dataDir: string, params: RegisterSourceParams): SourceEntry {
  const config = loadConfig(dataDir);
  requireOwner(params.actor.id, config);

  if (!SOURCE_ID_PATTERN.test(params.id)) {
    throw new ProtocolError(
      'invalid_parameter',
      `Invalid source id '${params.id}': expected 1-128 chars of [A-Za-z0-9._:-], starting alphanumeric`,
    );
  }
  if (!SOURCE_KINDS.includes(params.kind)) {
    throw new ProtocolError('invalid_parameter', `Unknown source kind '${params.kind}'`);
  }
  if (!params.display_name || typeof params.display_name !== 'string') {
    throw new ProtocolError('invalid_parameter', 'Source display_name is required');
  }
  const status = params.status ?? 'active';
  if (!SOURCE_STATUSES.includes(status)) {
    throw new ProtocolError('invalid_parameter', `Unknown source status '${status}'`);
  }
  if (params.actor_ids !== undefined
    && (!Array.isArray(params.actor_ids) || params.actor_ids.some(id => typeof id !== 'string' || id.length === 0))) {
    throw new ProtocolError('invalid_parameter', 'Source actor_ids must be a list of non-empty actor ids');
  }

  const sources = config.sources ?? [];
  const existing = sources.find(entry => entry.id === params.id);
  const entry: SourceEntry = {
    id: params.id,
    kind: params.kind,
    display_name: params.display_name,
    status,
    created_at: existing?.created_at ?? new Date().toISOString(),
    ...(params.actor_ids !== undefined ? { actor_ids: [...params.actor_ids] } : {}),
    ...(params.external_ref !== undefined ? { external_ref: params.external_ref } : {}),
  };

  if (existing) {
    Object.assign(existing, entry);
  } else {
    sources.push(entry);
  }
  config.sources = sources;
  saveConfig(dataDir, config);
  return existing ?? entry;
}

/**
 * Resolve a source reference for a write by `actorId` (fail closed):
 *   - unknown id  → `source_unregistered`
 *   - not active  → `source_inactive`
 *   - actor outside the allow-list → `insufficient_permission`
 */
export function requireActiveSource(
  config: SmartwareConfig,
  sourceRef: string,
  actorId: string,
): SourceEntry {
  const entry = getSourceEntry(config, sourceRef);
  if (!entry) {
    throw new ProtocolError(
      'source_unregistered',
      `Source '${sourceRef}' is not registered with this Pod. Register it before writing evidence under it.`,
    );
  }
  if (entry.status !== 'active') {
    throw new ProtocolError(
      'source_inactive',
      `Source '${sourceRef}' is ${entry.status} and cannot write.`,
    );
  }
  if (entry.actor_ids && entry.actor_ids.length > 0 && !entry.actor_ids.includes(actorId)) {
    throw new ProtocolError(
      'insufficient_permission',
      `Actor '${actorId}' is not allowed to write under source '${sourceRef}'`,
    );
  }
  return entry;
}
