import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SmartwareCore } from '../../src/core.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { SemanticRecordStore } from '../../src/layer3/semantic-store.js';
import type { EmbeddingAdapter } from '../../src/layer3/semantic.js';
import type { Claim, ClaimTimeValue } from '../../src/layer1/types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SmartwareCore semantic document boundary', () => {
  it('applies query authorization and sensitive opt-in before exposing embedding text', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartware-semantic-core-'));
    temporaryDirectories.push(dataDir);
    const owner = {
      type: 'person' as const,
      id: 'person_owner',
      display_name: 'Owner',
    };
    const core = await SmartwareCore.open({ dataDir, ownerId: owner.id });

    try {
      await core.observe({
        actor: owner,
        type: 'message',
        content: {
          format: 'text/plain',
          body: 'Public release deadline: 2026-08-01.',
        },
        scope: 'workspace/default',
        observed_at: '2026-07-01T00:00:00.000Z',
      });
      await core.observe({
        actor: owner,
        type: 'message',
        content: {
          format: 'text/plain',
          body: 'Secret migration deadline: 2026-09-01.',
        },
        scope: 'workspace/default',
        observed_at: '2026-07-02T00:00:00.000Z',
        sensitive: true,
      });
      await core.compile({
        actor: owner,
        scope: 'workspace/default',
        use_llm: false,
      });

      const defaultDocuments = core.prepareSemanticDocuments({
        actor: owner,
        scope: 'workspace/default',
      });
      expect(defaultDocuments.some(document => document.text.includes('2026-08-01')))
        .toBe(true);
      expect(defaultDocuments.some(document => document.text.includes('2026-09-01')))
        .toBe(false);

      const optedIn = core.prepareSemanticDocuments({
        actor: owner,
        scope: 'workspace/default',
        include_sensitive: true,
      });
      expect(optedIn.some(document => document.text.includes('2026-09-01')))
        .toBe(true);

      const ownerSession = await core.sessionStart({
        actor: owner,
        client_id: 'semantic-test',
        client_version: '1.0.0',
        declared_trust_level: 'verified',
        declared_capabilities: {
          can_tag_sensitivity: true,
          can_provide_intent: true,
          can_request_user_confirmation: true,
        },
        requested_scopes: ['workspace/default'],
      });
      expect(core.prepareSemanticDocuments({
        actor: {
          type: 'agent',
          id: 'agent:forged',
          display_name: 'Forged',
        },
        session_id: ownerSession.session_id,
        scope: 'workspace/default',
      })).toEqual(defaultDocuments);

      const untrustedSession = await core.sessionStart({
        actor: {
          type: 'agent',
          id: 'agent:unregistered',
          display_name: 'Unregistered',
        },
        client_id: 'semantic-test-untrusted',
        client_version: '1.0.0',
        declared_trust_level: 'verified',
        declared_capabilities: {
          can_tag_sensitivity: false,
          can_provide_intent: false,
          can_request_user_confirmation: false,
        },
        requested_scopes: ['workspace/default'],
      });
      expect(() => core.prepareSemanticDocuments({
        actor: owner,
        session_id: untrustedSession.session_id,
        scope: 'workspace/default',
      })).toThrow(/does not allow reads/);

      expect(() => core.prepareSemanticDocuments({
        actor: {
          type: 'agent',
          id: 'agent_unregistered',
          display_name: 'Unregistered',
        },
        scope: 'workspace/default',
      })).toThrow(/does not have 'query' permission/);
    } finally {
      core.close();
    }
  });

  it('evaluates hybrid recall opt-in and selects canonical results on provider failure', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartware-hybrid-core-'));
    temporaryDirectories.push(dataDir);
    const owner = {
      type: 'person' as const,
      id: 'person_owner',
      display_name: 'Owner',
    };
    const core = await SmartwareCore.open({ dataDir, ownerId: owner.id });
    const semanticStore = new SemanticRecordStore(
      path.join(dataDir, 'indices', 'semantic.db'),
    );
    let providerUnavailable = false;
    const adapter: EmbeddingAdapter = {
      provider: 'fixture',
      model: 'hybrid-core-v1',
      dimensions: 2,
      async embed(texts) {
        if (providerUnavailable) throw new Error('provider unavailable');
        return texts.map(() => [1, 0]);
      },
    };

    try {
      await core.observe({
        actor: owner,
        type: 'message',
        content: {
          format: 'text/plain',
          body: 'Public release deadline: 2026-08-01.',
        },
        scope: 'workspace/default',
        observed_at: '2026-07-01T00:00:00.000Z',
      });
      await core.observe({
        actor: owner,
        type: 'message',
        content: { format: 'text/plain', body: 'Coffee Pod is active.' },
        scope: 'workspace/default',
        observed_at: '2026-07-02T00:00:00.000Z',
      });
      await core.compile({
        actor: owner,
        scope: 'workspace/default',
        use_llm: false,
      });

      const documents = core.prepareSemanticDocuments({
        actor: owner,
        scope: 'workspace/default',
      });
      expect(documents.length).toBeGreaterThan(1);
      const partial = await core.syncSemanticIndex(
        { actor: owner, scope: 'workspace/default' },
        { adapter, store: semanticStore, max_documents: 1 },
      );
      expect(partial).toMatchObject({
        indexed_document_count: 1,
        source_document_count: documents.length,
        coverage: 'partial',
      });
      const partialRecall = await core.recallHybrid(
        {
          actor: owner,
          query: 'When do we ship?',
          scope: 'workspace/default',
          limit: 10,
        },
        { adapter, store: semanticStore, min_similarity: 0.4, limit: 10 },
      );
      expect(partialRecall.semantic_index_status).toBe('degraded');
      expect(partialRecall.semantic_index_error).toMatch(/partial/);
      expect(partialRecall.selected_channel).toBe('canonical');

      const synced = await core.syncSemanticIndex(
        { actor: owner, scope: 'workspace/default' },
        { adapter, store: semanticStore },
      );
      expect(synced.embedded).toBeGreaterThan(0);
      expect(synced.prior_status).toBe('degraded');
      await expect(core.syncSemanticIndex(
        { actor: owner, scope: 'workspace/default' },
        { adapter, store: semanticStore, max_documents: 0 },
      )).rejects.toThrow(/max documents/);

      const hybrid = await core.recallHybrid(
        {
          actor: owner,
          query: 'When do we ship?',
          scope: 'workspace/default',
          limit: 10,
        },
        {
          adapter,
          store: semanticStore,
          min_similarity: 0.4,
          limit: 10,
        },
      );
      expect(hybrid.semantic_index_status).toBe('ready');
      expect(hybrid.semantic_status).toBe('ok');
      expect(hybrid.selected_channel).toBe('hybrid');
      expect(hybrid.hybrid_results.some(result => result.text.includes('2026-08-01')))
        .toBe(true);

      await core.observe({
        actor: owner,
        type: 'message',
        content: { format: 'text/plain', body: 'Coffee Beta is planned.' },
        scope: 'workspace/default',
        observed_at: '2026-07-03T00:00:00.000Z',
      });
      await core.compile({
        actor: owner,
        scope: 'workspace/default',
        use_llm: false,
      });
      const stale = await core.recallHybrid(
        {
          actor: owner,
          query: 'When do we ship?',
          scope: 'workspace/default',
          limit: 10,
        },
        { adapter, store: semanticStore, min_similarity: 0.4, limit: 10 },
      );
      expect(stale.semantic_index_status).toBe('degraded');
      expect(stale.semantic_index_error).toMatch(/stale/);
      expect(stale.selected_channel).toBe('canonical');
      await core.syncSemanticIndex(
        { actor: owner, scope: 'workspace/default' },
        { adapter, store: semanticStore },
      );

      const unconfigured = await core.recallHybrid(
        {
          actor: owner,
          query: 'release deadline',
          scope: 'workspace/default',
          limit: 10,
        },
        {
          adapter: null,
          store: null,
          min_similarity: 0.4,
          limit: 10,
        },
      );
      expect(unconfigured.semantic_index_status).toBe('not_configured');
      expect(unconfigured.semantic_status).toBe('unavailable');
      expect(unconfigured.selected_channel).toBe('canonical');

      const canonical = await core.recall({
        actor: owner,
        query: 'release deadline',
        scope: 'workspace/default',
        limit: 10,
      });
      expect(canonical.results.length).toBeGreaterThan(0);
      providerUnavailable = true;
      const fallback = await core.recallHybrid(
        {
          actor: owner,
          query: 'release deadline',
          scope: 'workspace/default',
          limit: 10,
        },
        {
          adapter,
          store: semanticStore,
          min_similarity: 0.4,
          limit: 10,
        },
      );
      expect(fallback.semantic_status).toBe('fallback');
      expect(fallback.selected_channel).toBe('canonical');
      expect(fallback.canonical.results.map(result => result.claim?.id))
        .toEqual(canonical.results.map(result => result.claim?.id));

      providerUnavailable = false;
      const hangingAdapter: EmbeddingAdapter = {
        ...adapter,
        async embed() {
          return new Promise<number[][]>(() => {});
        },
      };
      const timedOut = await core.recallHybrid(
        {
          actor: owner,
          query: 'release deadline',
          scope: 'workspace/default',
          limit: 10,
        },
        {
          adapter: hangingAdapter,
          store: semanticStore,
          min_similarity: 0.4,
          limit: 10,
          semantic_timeout_ms: 10,
        },
      );
      expect(timedOut.semantic_status).toBe('fallback');
      expect(timedOut.semantic_error).toMatch(/timed out/);
      expect(timedOut.selected_channel).toBe('canonical');

      await expect(core.recallHybrid(
        {
          actor: owner,
          query: 'release deadline',
          scope: 'workspace/default',
          include_forgotten: true,
        },
        {
          adapter,
          store: semanticStore,
          min_similarity: 0.4,
        },
      )).rejects.toThrow(/does not support superseded or forgotten history/);
    } finally {
      semanticStore.close();
      core.close();
    }
  });

  it('q03-class entity-owner query: claim-level FTS lexical feed + semantic tiebreak (spec §11.1 D1+D2)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartware-hybrid-q03-'));
    temporaryDirectories.push(dataDir);
    const owner = {
      type: 'person' as const,
      id: 'person_owner',
      display_name: 'Owner',
    };
    const scope = 'workspace/default';
    const core = await SmartwareCore.open({ dataDir, ownerId: owner.id });
    const dbPath = path.join(dataDir, 'smartware.db');

    try {
      // Ground-truth-controlled seeding of the q03 pair (same shape the G0
      // spike used). The entity-name claim ("Project Aster" owning a kickoff
      // date) must NOT outrank the claim-level text ("Cloudpeak Realty owns
      // Project Aster") for the query "Who owns Project Aster?".
      const store = new ClaimStore(dbPath);
      store.insertEntity({
        id: 'ent_cloudpeak',
        canonical_name: 'Cloudpeak Realty',
        aliases: [],
        type: 'client',
        scope,
        created_at: '2026-02-01T00:00:00.000Z',
      });
      store.insertEntity({
        id: 'ent_aster',
        canonical_name: 'Project Aster',
        aliases: [],
        type: 'concept',
        scope,
        created_at: '2026-08-18T00:00:00.000Z',
      });
      const truth = (value: string | null): ClaimTimeValue => ({ value, state: 'known' });
      const extractBase = {
        method: 'deterministic' as const,
        model: null,
        compiler_version: '0.6.3',
        prompt_hash: null,
        extracted_at: '2026-02-01T10:00:00.000Z',
      };
      const base: Claim = {
        id: '',
        subject_id: 'ent_cloudpeak',
        subject_name: 'Cloudpeak Realty',
        predicate: 'owns',
        object: { type: 'text', value: 'Project Aster' },
        scope,
        validity: { from: '2026-02-01T00:00:00.000Z', to: null },
        t_ingested: truth('2026-02-01T10:00:00.000Z'),
        t_invalidated: truth(null),
        t_valid_from: truth('2026-02-01T00:00:00.000Z'),
        t_valid_to: truth(null),
        source_event_id: 'obs_aster_owner',
        extraction_event_id: 'obs_aster_owner',
        supporting_evidence: ['obs_aster_owner'],
        extraction: extractBase,
        status: 'active',
        epistemic: 'observed',
        confidence: 0.9,
        sensitive: false,
        superseded_by: null,
        contested_by: [],
        operation_id: 'op_aster_owner',
        version_at: '2026-02-01T10:00:00.000Z',
      } as Claim;
      store.insertClaim({
        ...base,
        id: 'c_deliverable_aster',
      });
      store.insertClaim({
        ...base,
        id: 'c_aster_schedule',
        subject_id: 'ent_aster',
        subject_name: 'Project Aster',
        predicate: 'kickoff',
        object: { type: 'date', value: '2026-09-01' },
        t_ingested: truth('2026-08-18T11:30:00.000Z'),
        t_valid_from: truth('2026-08-18T00:00:00.000Z'),
        validity: { from: '2026-08-18T00:00:00.000Z', to: null },
        source_event_id: 'obs_aster_kickoff',
        extraction_event_id: 'obs_aster_kickoff',
        supporting_evidence: ['obs_aster_kickoff'],
        extraction: { ...extractBase, extracted_at: '2026-08-18T11:30:00.000Z' },
        operation_id: 'op_aster_kickoff',
        version_at: '2026-08-18T11:30:00.000Z',
      });
      store.close();

      // Sync Layer 3 claim-level FTS — the channel the hybrid lexical lane
      // must rank by (searchClaims), not the canonical entity-aggregated feed.
      const searchIndex = new SearchIndex(dbPath);
      syncSearchFromClaims(new ClaimStore(dbPath), searchIndex);
      searchIndex.close();

      const semanticStore = new SemanticRecordStore(
        path.join(dataDir, 'indices', 'semantic.db'),
      );
      // Deterministic 2-D adapter: the ownership claim is more similar to the
      // query than the schedule claim (mirrors the measured 0.8365 vs 0.7385).
      const adapter: EmbeddingAdapter = {
        provider: 'fixture',
        model: 'q03-v1',
        dimensions: 2,
        async embed(texts) {
          const vectors: Record<string, number[]> = {
            'Who owns Project Aster?': [1, 0],
            'Cloudpeak Realty\nowns: Project Aster': [0.84, 0.2],
            'Project Aster\nkickoff: 2026-09-01': [0.74, 0.3],
          };
          return texts.map(text => {
            const vector = vectors[text];
            if (!vector) throw new Error(`missing q03 fixture vector: ${JSON.stringify(text)}`);
            return vector;
          });
        },
      };
      const synced = await core.syncSemanticIndex(
        { actor: owner, scope },
        { adapter, store: semanticStore },
      );
      expect(synced.embedded).toBe(2);

      const result = await core.recallHybrid(
        { actor: owner, query: 'Who owns Project Aster?', scope, limit: 10 },
        { adapter, store: semanticStore, min_similarity: 0, limit: 10 },
      );
      expect(result.selected_channel).toBe('hybrid');
      expect(result.semantic_status).toBe('ok');

      // Exit condition for the D1+D2 fix: the q03-class query no longer
      // mis-ranks — the ownership claim is #1 in the hybrid ranking.
      expect(result.hybrid_results.map(hit => hit.claim_id)[0])
        .toBe('c_deliverable_aster');
      const byId = new Map(result.hybrid_results.map(hit => [hit.claim_id, hit]));
      // D1: the lexical channel is claim-level FTS order (deliverable #1).
      expect(byId.get('c_deliverable_aster')).toMatchObject({
        lexical_rank: 1,
        semantic_rank: 1,
      });
      expect(byId.get('c_aster_schedule')).toMatchObject({
        lexical_rank: 2,
        semantic_rank: 2,
      });
      // D2: when RRF ties, the higher semantic relevance wins.
      const deliverable = byId.get('c_deliverable_aster')!;
      const schedule = byId.get('c_aster_schedule')!;
      expect(deliverable.semantic_relevance ?? -1)
        .toBeGreaterThan(schedule.semantic_relevance ?? -1);
    } finally {
      core.close();
    }
  });
});
