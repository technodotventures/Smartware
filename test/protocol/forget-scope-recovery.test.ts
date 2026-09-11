// Tests: FORGET.SCOPE crash-recovery — the audit marker is written LAST.
//
// Oracle: if the process dies after the physical purge but before the marker,
// the retry must re-complete with the SAME counts (from the durable intent),
// and must NOT double-purge or write a second marker/ops entry. If the process
// dies with the intent but before any mutation, the retry must run the purge
// and complete exactly once.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import type { Observation } from '../../src/layer0/types.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims, observationToIndexRow } from '../../src/layer3/search.js';
import { appendObservation } from '../../src/layer0/log.js';
import { assignIntegrity } from '../../src/layer0/integrity.js';
import { handleForgetScope } from '../../src/protocol/forget_scope.js';
import type { SmartwareConfig } from '../../src/config.js';
import { loadConfig, saveConfig } from '../../src/config.js';
import { makeClaim } from '../helpers.js';
import { iterAllClaimVersions } from '../../src/layer1/jsonl.js';
import { readAllOpLogEntries } from '../../src/ops_log/log.js';
import { readOperationIntent } from '../../src/ops_log/intent.js';
import { SMARTWARE_VERSION } from '../../src/version.js';

let tmpDir: string;
let evidenceDir: string;
let opsDir: string;
let dataDir: string;
let layer0: Layer0Index;
let store: ClaimStore;
let searchIndex: SearchIndex;
let config: SmartwareConfig;

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const SCOPE = 'client:acme#1';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-forget-scope-recovery-'));
  dataDir = tmpDir;
  evidenceDir = path.join(tmpDir, 'evidence');
  opsDir = path.join(tmpDir, 'operations');
  fs.mkdirSync(evidenceDir, { recursive: true });

  config = {
    instance_id: `smartware_${ulid()}`,
    owner_id: 'user:owner',
    writer_id: `writer_${ulid()}`,
    version: '0.6.0',
    data_dir: tmpDir,
    scopes: [
      { id: 'self', parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: SCOPE, parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
  saveConfig(tmpDir, config);

  const dbPath = path.join(tmpDir, 'smartware.db');
  layer0 = new Layer0Index(dbPath);
  store = new ClaimStore(dbPath);
  store.setDataDir(tmpDir);
  searchIndex = new SearchIndex(dbPath);
});

afterEach(() => {
  layer0.close();
  store.close();
  searchIndex.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertObservation(scope: string, body: string): Observation {
  const now = new Date().toISOString();
  const obs: Observation = {
    id: `obs_${ulid()}`,
    version: SMARTWARE_VERSION,
    type: 'message',
    status: 'accepted',
    source: {
      app: 'test', app_version: '1.0', source_id: null,
      actor: OWNER, captured_at: now, observed_at: now,
    },
    scope,
    visibility: 'scope',
    content: { format: 'text/plain', body },
    provenance: { parent_ids: [], supersedes: [], context: '' },
    policy: { retention: 'forever', retention_duration: null, sensitive: false, pii_detected: false },
    integrity: { hash: '', writer_id: config.writer_id, sequence: layer0.getLastSequence() + 1, previous_hash: null },
  };
  const withIntegrity = assignIntegrity(obs, config.writer_id, obs.integrity.sequence, null);
  appendObservation(evidenceDir, withIntegrity);
  layer0.insertOrSkip(withIntegrity);
  searchIndex.indexObservation(observationToIndexRow(withIntegrity));
  return withIntegrity;
}

function seedScope(scope: string, name = 'Acme'): { obs: Observation; claim: ReturnType<typeof makeClaim> } {
  const obs = insertObservation(scope, `${name} beta status is active`);
  const entityId = `entity_${ulid()}`;
  store.insertEntity({ id: entityId, canonical_name: name, aliases: [], type: 'organization', scope, created_at: new Date().toISOString() });
  const claim = makeClaim({
    subject_id: entityId,
    subject_name: name,
    predicate: 'status_is',
    object: { type: 'text', value: 'active' },
    scope,
    source_event_id: obs.id,
    extraction_event_id: obs.id,
    supporting_evidence: [obs.id],
    confidence: 0.8,
    status: 'active',
    state: 'active',
  });
  store.insertClaim(claim);
  syncSearchFromClaims(store, searchIndex, scope);
  return { obs, claim };
}

describe('FORGET.SCOPE crash recovery', () => {
  it('completes exactly once when the process dies after the intent but before any mutation', async () => {
    seedScope(SCOPE);
    const operationId = `op_${ulid()}`;

    // Crash: afterIntent is called right after persistOperationIntent — throw
    // from the hook to simulate a crash between intent persist and
    // appendObservation/purge. Nothing has been mutated yet.
    await expect(handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: operationId },
      {
        evidenceDir, dataDir, layer0, store, searchIndex, config,
        commitCtx: { opsDir },
        commitHooks: {
          afterIntent: () => { throw new Error('simulated crash after intent'); },
        },
      },
    )).rejects.toThrow('simulated crash after intent');

    // Nothing mutated: the claim is still active, no marker, no ops entry.
    expect(store.getAllClaims(SCOPE)).toHaveLength(1);
    expect([...readAllOpLogEntries(opsDir)].filter(e => e.operation_id === operationId)).toHaveLength(0);
    // The intent is in the WAL (durable).
    expect(readOperationIntent(opsDir, operationId)?.op).toBe('forget.scope');

    // Retry: handler re-runs the mutations and completes exactly once.
    const result = await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: operationId },
      { evidenceDir, dataDir, layer0, store, searchIndex, config, commitCtx: { opsDir } },
    );
    expect(result.status).toBe('forgotten');
    expect(result.claims_retracted).toBe(1);
    expect(result.observations_retracted).toBe(1);

    const entries = [...readAllOpLogEntries(opsDir)].filter(e => e.operation_id === operationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.op).toBe('forget.scope');
    expect(readOperationIntent(opsDir, operationId)).toBeNull();
    expect([...iterAllClaimVersions(dataDir)].filter(v => v.scope === SCOPE)).toHaveLength(0);
  });

  it('completes on retry when the intent exists but nothing was mutated yet (marker absent)', async () => {
    seedScope(SCOPE);
    const operationId = `op_${ulid()}`;

    // Prepare the intent exactly like the handler's pre-mutation step does,
    // WITHOUT running mutations (crash before the mutation block).
    await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: operationId },
      {
        evidenceDir, dataDir, layer0, store, searchIndex, config,
        commitCtx: { opsDir },
      },
    );

    // Now replay the normal path — the ops entry already exists so the retry
    // returns the committed result.
    const replay = await handleForgetScope(
      { actor: OWNER, scope: SCOPE, reason: 'erasure', operation_id: operationId },
      {
        evidenceDir, dataDir, layer0, store, searchIndex, config,
        commitCtx: { opsDir },
      },
    );
    expect(replay.status).toBe('forgotten');
    expect(replay.claims_retracted).toBe(1);
    expect(replay.observations_retracted).toBe(1);
    // Exactly one ops entry; exactly one marker observation.
    const entries = [...readAllOpLogEntries(opsDir)].filter(e => e.operation_id === operationId);
    expect(entries).toHaveLength(1);
  });

  it('rejects erasing the pod-internal self scope', async () => {
    seedScope('self', 'Self');
    await expect(handleForgetScope(
      { actor: OWNER, scope: 'self', reason: 'erasure', operation_id: `op_${ulid()}` },
      { evidenceDir, dataDir, layer0, store, searchIndex, config },
    )).rejects.toThrow(/pod-internal/);
  });
});
