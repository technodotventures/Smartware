import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SmartwareCore } from '../src/core.js';
import { ClaimStore } from '../src/layer1/store.js';
import { makeClaim } from './helpers.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SmartwareCore conflict read boundary', () => {
  it('returns contested claims through an authorization-aware read', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartware-conflicts-'));
    temporaryDirectories.push(dataDir);
    const owner = {
      type: 'person' as const,
      id: 'person_owner',
      display_name: 'Owner',
    };
    const scope = 'workspace/default';
    const core = await SmartwareCore.open({ dataDir, ownerId: owner.id });
    const store = new ClaimStore(path.join(dataDir, 'smartware.db'));
    store.setDataDir(dataDir);
    const validAt = '2026-07-25T00:00:00.000Z';

    try {
      store.insertEntity({
        id: 'entity_release',
        canonical_name: 'Release',
        aliases: [],
        type: 'project',
        scope,
        created_at: validAt,
      });
      store.insertClaim(makeClaim({
        id: 'claim_release_open',
        subject_id: 'entity_release',
        subject_name: 'Release',
        predicate: 'status_is',
        object: { type: 'text', value: 'open' },
        scope,
        validity: { from: validAt, to: null },
        status: 'active',
        supporting_evidence: ['obs_release_open'],
      }));
      store.insertClaim(makeClaim({
        id: 'claim_release_cancelled',
        subject_id: 'entity_release',
        subject_name: 'Release',
        predicate: 'status_is',
        object: { type: 'text', value: 'cancelled' },
        scope,
        validity: { from: validAt, to: null },
        status: 'active',
        supporting_evidence: ['obs_release_cancelled'],
      }));
      store.markContested('claim_release_open', 'claim_release_cancelled');

      const snapshot = core.readConflicts({ actor: owner, scopes: [scope] });
      expect(snapshot.claims.map(claim => claim.claim_id).sort()).toEqual([
        'claim_release_cancelled',
        'claim_release_open',
      ]);
      expect(snapshot.claims.every(claim => claim.status === 'contested')).toBe(true);
      expect(snapshot.claims[0]?.contested_by.length).toBe(1);
      expect(snapshot.claims.every(claim => Number.isInteger(claim.version) && claim.version >= 1)).toBe(true);
      const currentClaim = snapshot.claims.find(claim => claim.claim_id === 'claim_release_open')!;
      const otherClaim = snapshot.claims.find(claim => claim.claim_id === 'claim_release_cancelled')!;

      await core.revise({
        actor: owner,
        target: 'claim_release_open',
        expected_base_version: currentClaim.version,
        add_relations: [{
          kind: 'supersedes',
          target: 'claim_release_cancelled',
          valid_at: '2026-07-26T00:00:00.000Z',
          provenance: { origin: 'user', target_claim_version: otherClaim.version },
        }],
        reason: 'The release is still open',
        operation_id: 'op_00000000000000000000000001',
      });

      expect(core.readConflicts({ actor: owner, scopes: [scope] }).claims).toEqual([]);

      // P0-7: an actor with no grant row at all is denied as `actor_unregistered`
      // (unknown identity), which a host can route differently from "known actor,
      // wrong scope" (`insufficient_permission`).
      expect(() => core.readConflicts({
        actor: {
          type: 'agent',
          id: 'agent_unregistered',
          display_name: 'Unregistered',
        },
        scopes: [scope],
      })).toThrow(/is not registered with this Pod/);
    } finally {
      store.close();
      core.close();
    }
  });
});
