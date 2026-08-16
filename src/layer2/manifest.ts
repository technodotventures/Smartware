// Layer 2 — Instance manifest (smartware.md)

import fs from 'fs';
import path from 'path';
import type { SmartwareConfig } from '../config.js';
import { writePrivateFile } from '../storage/private-fs.js';

export interface ManifestStats {
  layer0: { total: number; accepted: number; quarantined: number; tombstoned: number };
  layer1: { claims: number; entities: number };
  layer2: { pages: number };
}

export function generateManifest(config: SmartwareConfig, stats: ManifestStats): string {
  const now = new Date().toISOString();
  const scopeList = config.scopes.map(s =>
    `  - \`${s.id}\` (${s.visibility_default}${s.parent ? `, parent: ${s.parent}` : ''})`
  ).join('\n');

  return `# Smartware Instance Manifest

Generated: ${now}

## Instance

- **ID**: \`${config.instance_id}\`
- **Version**: ${config.version}
- **Owner**: \`${config.owner_id}\`
- **Writer**: \`${config.writer_id}\`
- **Data directory**: \`${config.data_dir}\`

## Statistics

| Layer | Metric | Count |
|-------|--------|-------|
| Layer 0 | Total observations | ${stats.layer0.total} |
| Layer 0 | Accepted | ${stats.layer0.accepted} |
| Layer 0 | Quarantined | ${stats.layer0.quarantined} |
| Layer 0 | Tombstoned | ${stats.layer0.tombstoned} |
| Layer 1 | Active claims | ${stats.layer1.claims} |
| Layer 1 | Entities | ${stats.layer1.entities} |
| Layer 2 | Compiled pages | ${stats.layer2.pages} |

## Scopes

${scopeList}

## LLM Configuration

- Provider: ${config.llm.provider}
- Model: ${config.llm.model}

## Staleness Policy

- Default half-life: ${config.staleness.default_half_life_days} days
- Stale threshold: ${config.staleness.stale_threshold}
`;
}

export function writeManifest(wikiDir: string, config: SmartwareConfig, stats: ManifestStats): void {
  const content = generateManifest(config, stats);
  writePrivateFile(path.join(wikiDir, 'smartware.md'), content, 'utf-8');
}

export function readManifest(wikiDir: string): string | null {
  const p = path.join(wikiDir, 'smartware.md');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

/** Count .md files in the wiki directory tree (excluding only the root manifest) */
export function countWikiPages(wikiDir: string): number {
  let count = 0;
  const rootManifest = path.resolve(path.join(wikiDir, 'smartware.md'));
  const scan = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        scan(full);
      } else if (entry.name.endsWith('.md')) {
        if (path.resolve(full) === rootManifest) continue;
        count++;
      }
    }
  };
  scan(wikiDir);
  return count;
}
