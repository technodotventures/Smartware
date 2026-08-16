// Agent registry markdown projection (Spec v1.5.4.2 §"Agent Registry").
//
// Per spec, `pod_data/agents/registry.md` is a canonical surface: a
// human-readable markdown table listing every registered actor with its
// kind, capabilities, owner, and notes. Today the substrate's canonical
// grant store is `config.json`'s `grants` array. This module projects
// that into the spec-shaped markdown table.
//
// Migration note (PR-5 / A4 scope):
//   - The markdown file is generated on Pod open and on every grant
//     mutation. It is read-mostly today and authoritative for human
//     readers. Programmatic reads still come from config.json.
//   - A later PR will migrate writes through the markdown surface; that
//     work introduces a parser and round-trip semantics.

import { renameSync } from 'node:fs';
import { join } from 'node:path';

import type { Grant, SmartwareConfig } from '../config.js';
import { ensurePrivateDirectory, writePrivateFile } from '../storage/private-fs.js';

function capabilityList(grant: Grant): string {
  const ops = (Object.keys(grant.capabilities) as Array<keyof Grant['capabilities']>).filter(
    (op) => (grant.capabilities[op] ?? []).length > 0,
  );
  return ops.join(', ') || '(none)';
}

function actorKind(grant: Grant): string {
  // The substrate's actor_type {agent, person, system} ↔ the spec's actor
  // kinds {agent, sidecar, substrate, human, user}. Project conservatively;
  // the alias-map PR will tighten this when forward-only renames land.
  switch (grant.actor_type) {
    case 'person':
      return 'human';
    case 'agent':
      return 'agent';
    case 'system':
      return 'substrate';
    default:
      return String(grant.actor_type);
  }
}

function ownerCell(grant: Grant): string {
  return grant.trusted ? 'self' : 'shared';
}

function escapePipe(value: string): string {
  return value.replace(/\|/g, '\\|');
}

export function renderRegistryMarkdown(config: SmartwareConfig): string {
  const grants = config.grants.filter((g) => g.status === 'active');
  const lines: string[] = [];

  lines.push('# Agent Registry');
  lines.push('');
  lines.push('Auto-generated from `config.json` by the substrate.');
  lines.push('Read-only today (PR-5 / A4); becomes the canonical source in a later PR.');
  lines.push('');
  lines.push('| actor_id | kind | owner | capabilities | added | notes |');
  lines.push('|---|---|---|---|---|---|');

  // Pod owner row first.
  if (config.owner_id) {
    lines.push(
      `| ${escapePipe(config.owner_id)} | human | self | all | - | Pod owner |`,
    );
  }

  for (const grant of grants) {
    lines.push(
      [
        '',
        escapePipe(grant.actor_id),
        actorKind(grant),
        ownerCell(grant),
        escapePipe(capabilityList(grant)),
        grant.created_at.slice(0, 10),
        grant.trusted ? 'trusted' : '',
        '',
      ].join('|'),
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Write the markdown projection to `pod_data/agents/registry.md`.
 * Atomic via tmp+rename so a partial write never appears.
 */
export function writeRegistryMarkdown(dataDir: string, config: SmartwareConfig): string {
  const agentsDir = join(dataDir, 'agents');
  ensurePrivateDirectory(agentsDir);

  const path = join(agentsDir, 'registry.md');
  const content = renderRegistryMarkdown(config);
  const tmpPath = `${path}.tmp`;
  writePrivateFile(tmpPath, content, 'utf-8');
  // renameSync is atomic on the same filesystem.
  renameSync(tmpPath, path);
  return path;
}
