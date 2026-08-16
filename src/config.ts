// Instance configuration loader

import fs from 'fs';
import path from 'path';
import { ulid } from 'ulid';
import type { ActorType } from './layer0/types.js';
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

export function getDataDir(): string {
  return process.env['SMARTWARE_DATA_DIR'] ?? path.join(process.cwd(), 'data');
}
