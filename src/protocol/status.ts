// Protocol — STATUS handler (owner-only)

import type { Actor } from '../layer0/types.js';
import type { Layer0Index } from '../layer0/index.js';
import type { ClaimStore } from '../layer1/store.js';
import type { SearchIndex } from '../layer3/search.js';
import type { SmartwareConfig } from '../config.js';
import { countWikiPages, writeManifest } from '../layer2/manifest.js';
import { requireOwner } from '../auth/middleware.js';

export interface StatusParams {
  actor: Actor;
}

export interface StatusResult {
  instance_id: string;
  version: string;
  layer0: {
    total: number;
    by_status: Record<string, number>;
    last_sequence: number;
  };
  layer1: {
    claims: number;
    entities: number;
    last_replayed_sequence: number;
  };
  layer2: {
    pages: number;
  };
  layer3: {
    indexed: number;
  };
  grants: number;
}

export async function handleStatus(
  params: StatusParams,
  layer0: Layer0Index,
  store: ClaimStore,
  searchIndex: SearchIndex,
  wikiDir: string,
  config: SmartwareConfig,
): Promise<StatusResult> {
  requireOwner(params.actor.id, config);

  const statusCounts = layer0.countByStatus();
  const total = layer0.totalCount();
  const claims = store.claimCount();
  const entities = store.entityCount();
  const pages = countWikiPages(wikiDir);

  // Refresh the manifest so it reflects the current state
  writeManifest(wikiDir, config, {
    layer0: {
      total,
      accepted: statusCounts['accepted'] ?? 0,
      quarantined: statusCounts['quarantined'] ?? 0,
      tombstoned: statusCounts['tombstoned'] ?? 0,
    },
    layer1: { claims, entities },
    layer2: { pages },
  });

  return {
    instance_id: config.instance_id,
    version: config.version,
    layer0: {
      total,
      by_status: statusCounts,
      last_sequence: layer0.getLastSequence(),
    },
    layer1: {
      claims,
      entities,
      last_replayed_sequence: store.getLastReplayedSequence(),
    },
    layer2: { pages },
    layer3: { indexed: searchIndex.count() },
    grants: config.grants.filter(g => g.status === 'active').length,
  };
}
