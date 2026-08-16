// Conformance Suite G — Endorsement Cascade (§9)

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import type { ActiveClaimVersion } from '../../src/layer1/jsonl.js';
import { computeFingerprint } from '../../src/layer1/fingerprint.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { CascadePreviewStore } from '../../src/preview_store/store.js';
import { handleEndorse } from '../../src/protocol/endorse.js';
import { serialiseFrontmatter } from '../../src/layer2/frontmatter.js';
import { saveConfig, type SmartwareConfig } from '../../src/config.js';
import type { Frontmatter } from '../../src/layer2/types.js';

function makeAgentClaim(id: string, content: string): ActiveClaimVersion {
  return {
    claim_id: id,
    version: 1,
    state: 'active',
    content,
    claim_type: 'hypothesis',
    claim_role: 'memory',
    author: 'agent',
    epistemic_owner: 'agent',
    fingerprint: computeFingerprint(content, 'personal', 'hypothesis'),
    confidence: 'low',
    epistemic_tag: 'inference',
    scope: 'personal',
    derived_from: ['obs_test1'],
    relations: [],
    created_at: '2026-01-01T00:00:00Z',
    version_at: '2026-01-01T00:00:00Z',
    operation_id: 'op_CREATE0100000000000000000000',
    actor_id: 'substrate:test',
    tags: [],
  };
}

function endorseClaim(claim: ActiveClaimVersion, pageId: string): ActiveClaimVersion {
  return {
    ...claim,
    version: claim.version + 1,
    author: 'user',
    epistemic_owner: 'user',
    endorsement_source: pageId,
    supersedes: claim.version,
    version_at: '2026-02-01T00:00:00Z',
    operation_id: 'op_ENDORSE100000000000000000000',
    actor_id: 'user:owner',
  };
}

describe('Endorsement Cascade', () => {
  it('G1: endorsement_cascade_sets_author_user', () => {
    const original = makeAgentClaim('claim_E1', 'Agent hypothesis');
    const endorsed = endorseClaim(original, 'page_test');
    expect(original.author).toBe('agent');
    expect(endorsed.author).toBe('user');
  });

  it('G2: endorsement_cascade_sets_epistemic_owner_user', () => {
    const original = makeAgentClaim('claim_E2', 'Agent hypothesis');
    const endorsed = endorseClaim(original, 'page_test');
    expect(original.epistemic_owner).toBe('agent');
    expect(endorsed.epistemic_owner).toBe('user');
  });

  it('G3: endorsement_preserves_confidence_tag', () => {
    const original = makeAgentClaim('claim_E3', 'Agent hypothesis');
    const endorsed = endorseClaim(original, 'page_test');
    expect(endorsed.confidence).toBe(original.confidence);
    expect(endorsed.epistemic_tag).toBe(original.epistemic_tag);
  });

  it('G4: endorsed_claim_becomes_agent_immutable', () => {
    const endorsed = endorseClaim(makeAgentClaim('claim_E4', 'Hypothesis'), 'page_test');
    expect(endorsed.epistemic_owner).toBe('user');
    expect(endorsed.author).toBe('user');
  });

  it('G5: cascade_requires_preview_for_shared_claims', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-endorse-cascade-'));
    const wikiDir = path.join(dataDir, 'wiki', 'entities');
    fs.mkdirSync(wikiDir, { recursive: true });
    const config: SmartwareConfig = {
      instance_id: `smartware_${ulid()}`,
      owner_id: 'user:owner',
      writer_id: `writer_${ulid()}`,
      version: '0.6.0',
      data_dir: dataDir,
      scopes: [{ id: 'personal', parent: null, visibility_default: 'private' }],
      grants: [],
      llm: { provider: 'none', model: '' },
      staleness: {
        default_half_life_days: 90,
        scope_overrides: {},
        stale_threshold: 0.3,
      },
    };
    saveConfig(dataDir, config);
    const store = new ClaimStore(path.join(dataDir, 'smartware.db'));
    const previews = new CascadePreviewStore(':memory:');
    const sharedClaim = `claim_${ulid()}`;
    const frontmatter = (entityId: string): Frontmatter => ({
      entity_id: entityId,
      entity: entityId,
      type: 'concept',
      scope: 'personal',
      epistemic: 'observed',
      sensitive: false,
      sources: [],
      claim_ids: [sharedClaim],
      sources_claim_ids: [sharedClaim],
      compiled_at: new Date().toISOString(),
      compiled_by: 'smartware',
      confidence: 0.5,
      supersedes: [],
      related: [],
      page_id: `page_${entityId}`,
    });
    const targetPath = path.join(wikiDir, 'target.md');
    fs.writeFileSync(
      targetPath,
      serialiseFrontmatter(frontmatter('entity_target'), '# Target'),
    );
    fs.writeFileSync(
      path.join(wikiDir, 'other.md'),
      serialiseFrontmatter(frontmatter('entity_other'), '# Other'),
    );

    try {
      await expect(handleEndorse(
        {
          actor: { type: 'person', id: 'user:owner', display_name: 'Alex' },
          page_id: 'page_entity_target',
          page_path: targetPath,
          dry_run: false,
          reason: 'Endorse',
          operation_id: `op_${ulid()}`,
        },
        dataDir,
        store,
        previews,
        config,
      )).rejects.toMatchObject({ code: 'cascade_required_ack' });
    } finally {
      previews.close();
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
