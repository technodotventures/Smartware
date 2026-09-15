// Instance configuration loader

import fs from 'fs';
import path from 'path';
import { ulid } from 'ulid';
import type { ActorType, RetentionPolicy } from './layer0/types.js';
import { SMARTWARE_VERSION } from './version.js';
import { ensurePrivateDirectory, writePrivateFileDurable } from './storage/private-fs.js';

export interface ScopeEntry {
  id: string;
  parent: string | null;
  visibility_default: 'private' | 'scope' | 'workspace' | 'public';
}

/** Provenance origin kind for a registered source (Coffee parity contract). */
export type SourceKind = 'connector' | 'meeting' | 'note' | 'agent' | 'manual' | 'system';
export type SourceStatus = 'active' | 'paused' | 'revoked';

/**
 * A registered provenance origin within one business brain: the connector,
 * meeting, note stream, agent run or system pipeline evidence came from.
 *
 * The registry is provisioning state (like `scopes` and `grants`) and is
 * owner-managed. Coffee owns OAuth, scheduling and connector credentials; the
 * brain only accepts authenticated actor + source context and fails closed
 * when it is missing, unknown, inactive, or claimed by a disallowed actor.
 */
export interface SourceEntry {
  id: string;
  kind: SourceKind;
  display_name: string;
  status: SourceStatus;
  created_at: string;
  /** Optional allow-list of actor ids permitted to write under this source. */
  actor_ids?: string[];
  /** Optional opaque host-side handle (mailbox / account / calendar id). */
  external_ref?: string | null;
}

export interface Grant {
  id: string;
  actor_type: ActorType;
  actor_id: string;
  capabilities: {
    observe: string[];
    query: string[];
    compile: string[];
    correct: string[];
    forget: string[];
    read: string[];
  };
  trusted: boolean;
  quarantine: boolean;
  created_at: string;
  expires_at: string | null;
  status: 'active' | 'revoked';
}

/** Retention policy for a scope (lifecycle, distinct from staleness/freshness). */
export interface RetentionSetting {
  policy: RetentionPolicy;
  /** Resolved duration in days when policy === 'duration'; otherwise null. */
  duration_days: number | null;
}

/** Optional, additive retention config. Absent ⇒ `forever` everywhere (today's behavior). */
export interface RetentionConfig {
  default: RetentionSetting;
  scope_overrides?: Record<string, RetentionSetting>;
  /** v0.6.0 only supports 'tombstone'; 'archive' is reserved. */
  expire_action?: 'tombstone' | 'archive';
}

/**
 * A legal-hold record on a client scope (ADR-0009). Opened by the hold lane
 * (FORGET.SCOPE `offboarding`) in the same commit as its tombstone + grant
 * revocation; released only by an audited owner act (`hold.release`). While
 * open it refuses scope erasure and skips the retention sweep. The record is
 * content-free (ids, timestamps, a non-PII statement).
 */
export interface LegalHold {
  scope: string;
  opened_at: string;
  opened_by: string;
  /** The hold-lane operation that opened it (null when called without one). */
  operation_id: string | null;
  released_at: string | null;
  released_by: string | null;
  release_operation_id: string | null;
  release_statement: string | null;
}

export interface SmartwareConfig {
  instance_id: string;
  owner_id: string;
  writer_id: string;
  version: string;
  data_dir: string;
  scopes: ScopeEntry[];
  grants: Grant[];
  /** Registered provenance origins (owner-managed; absent in pre-0.7.0 configs). */
  sources?: SourceEntry[];
  llm: {
    provider: 'anthropic' | 'openai' | 'openrouter' | 'none';
    model: string;
  };
  staleness: {
    default_half_life_days: number;
    scope_overrides: Record<string, number>;
    stale_threshold: number;
  };
  /** Optional retention config (lifecycle). Absent ⇒ `forever` everywhere. */
  retention?: RetentionConfig;
  /**
   * Legal-hold state per client scope (ADR-0009). Absent ⇒ no hold state
   * (pre-marker configs load unchanged). An entry exists once a scope has taken
   * the hold lane; open ⇔ `released_at == null`.
   */
  holds?: Record<string, LegalHold>;
  entity_resolution?: {
    /** Score at or above this → auto-merge (default 0.92) */
    auto_merge_threshold: number;
    /** Score at or above this but below auto_merge → borderline band (default 0.85) */
    borderline_threshold: number;
    /** If true and LLM is available, borderline matches call LLM to disambiguate (default true) */
    llm_disambiguate: boolean;
  };
}

const DEFAULT_CONFIG: Omit<SmartwareConfig, 'instance_id' | 'writer_id' | 'data_dir'> = {
  owner_id: 'user:local',
  version: SMARTWARE_VERSION,
  scopes: [
    { id: 'self', parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    { id: 'project:default', parent: 'workspace', visibility_default: 'scope' },
  ],
  grants: [],
  sources: [],
  llm: {
    provider: 'none',
    model: '',
  },
  staleness: {
    default_half_life_days: 90,
    scope_overrides: {
      self: 365,
      'project:*': 30,
    },
    stale_threshold: 0.3,
  },
};

export function loadConfig(dataDir: string): SmartwareConfig {
  const configPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found at ${configPath}. Run init first.`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as SmartwareConfig;
}

export function saveConfig(dataDir: string, config: SmartwareConfig): void {
  ensurePrivateDirectory(dataDir);
  const configPath = path.join(dataDir, 'config.json');
  // Durable (tmp + fsync + rename): config is provisioning state read by every
  // operation, and its writers pair with canonical ops entries (e.g. the
  // ADR-0009 hold release). A torn or lost config write would be a divergence
  // no replay could distinguish from a real state — so it must not happen.
  writePrivateFileDurable(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function createDefaultConfig(dataDir: string): SmartwareConfig {
  const config: SmartwareConfig = {
    ...DEFAULT_CONFIG,
    instance_id: `smartware_${ulid()}`,
    writer_id: `writer_local_${ulid()}`,
    data_dir: dataDir,
  };
  return config;
}

export function getDataDir(): string {
  return process.env['SMARTWARE_DATA_DIR'] ?? path.join(process.cwd(), 'data');
}

/** Resolve the retention setting for a scope: override → default → `forever`. */
export function resolveRetention(config: SmartwareConfig, scope: string): RetentionSetting {
  const r = config.retention;
  const override = r?.scope_overrides?.[scope];
  if (override) return override;
  if (r?.default) return r.default;
  return { policy: 'forever', duration_days: null };
}

/** ISO 8601 duration string for a resolved setting, or null when not time-bound. */
export function toRetentionDurationString(setting: RetentionSetting): string | null {
  if (setting.policy !== 'duration') return null;
  const days = setting.duration_days;
  return days != null && days > 0 ? `P${days}D` : null;
}

/**
 * True when a scope has an OPEN legal hold (ADR-0009): an entry exists and has
 * not been released. Consulted by FORGET.SCOPE erasure (refused while true) and
 * by the retention sweep (skipped while true).
 */
export function isScopeHeld(config: SmartwareConfig, scope: string): boolean {
  const hold = config.holds?.[scope];
  return hold != null && hold.released_at == null;
}
