// Instance configuration loader

import fs from 'fs';
import path from 'path';
import { ulid } from 'ulid';
import type { ActorType, RetentionPolicy } from './layer0/types.js';
import { SMARTWARE_VERSION } from './version.js';
import { ensurePrivateDirectory, writePrivateFile } from './storage/private-fs.js';

export interface ScopeEntry {
  id: string;
  parent: string | null;
  visibility_default: 'private' | 'scope' | 'workspace' | 'public';
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

export interface SmartwareConfig {
  instance_id: string;
  owner_id: string;
  writer_id: string;
  version: string;
  data_dir: string;
  scopes: ScopeEntry[];
  grants: Grant[];
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
  entity_resolution?: {
    /** Score at or above this → auto-merge (default 0.92) */
    auto_merge_threshold: number;
    /** Score at or above this but below auto_merge → borderline band (default 0.85) */
    borderline_threshold: number;
    /** If true and LLM is available, borderline matches call LLM to disambiguate (default true) */
    llm_disambiguate: boolean;
  };
}

/**
 * The pod's own lane — the protocol-native `self` scope, spelled once.
 *
 * Spec §7 roots the memory hierarchy at `self` (the pod's private lane); a
 * Core-opened brain registers it with `visibility_default: 'private'`, and
 * FORGET.SCOPE's audit marker resolves to it ("the marker itself lives in the
 * POD scope (self)"). Protocol v0.5.0 → *Conformance boundary* requires schema
 * validity on every canonical write, and `common.schema.json#/$defs/Scope`
 * admits `self` — so every record the substrate writes into its own lane must
 * name this value.
 *
 * `personal` is the pre-fix spelling at the writers that carried it
 * (`grant.ts`, `revoke.ts`, and the `?? 'personal'` fallbacks in
 * `quarantine_review.ts` / `forget.ts`): a legacy name for this lane that no
 * published set admits and that no released version ever registered as a scope
 * (measured on kanban `t_e6fce49a`, ADR-0015's boundary class). Records already
 * on disk keep the spelling they were written with — L0 is append-only.
 */
export const POD_SELF_SCOPE = 'self';

const DEFAULT_CONFIG: Omit<SmartwareConfig, 'instance_id' | 'writer_id' | 'data_dir'> = {
  owner_id: 'user:local',
  version: SMARTWARE_VERSION,
  scopes: [
    { id: POD_SELF_SCOPE, parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    { id: 'project:default', parent: 'workspace', visibility_default: 'scope' },
  ],
  grants: [],
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
  writePrivateFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
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

/**
 * The one substrate ActorId for this instance.
 *
 * Spec §5 *Identifier Types*: every ActorId — including the substrate's own —
 * is `<actor-kind>:<slug>`, and the substrate's slug is the pod/instance
 * (`substrate:coffee`). Protocol v0.5.0 `common.schema.json` `$defs/ActorId`
 * admits `^(user|agent|sidecar|substrate):[a-z0-9-]+$`, so the slug must be
 * lowercase. Crockford base32 ULIDs are case-insensitive in their own right;
 * the published pattern is not.
 *
 * Every autonomous writer (reflect.auto, the compile queue, dream) mints the
 * id through this one function, so one instance carries exactly one substrate
 * identity. The default `smartware_` instance-id prefix is not part of the
 * slug: `smartware_coffee` becomes `substrate:coffee` (the spec's example),
 * and an anonymous ULID instance becomes the lowercased ULID.
 */
export function substrateActorId(config: Pick<SmartwareConfig, 'instance_id'>): string {
  const slug = config.instance_id
    .replace(/^smartware_/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `substrate:${slug || 'instance'}`;
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
