// Protocol — REVISE handler (spec §9, v0.4.2 normative)
//
// The beta's only epistemic admission path. A user revision may:
//   - Admit epistemic relations (add_relations)
//   - Set confidence / epistemic_tag
//   - Incorporate corroboration (add_derived_from)
//   - Withdraw admitted edges (invalidate_relations)
//   - Adopt body as user voice (adopt_body)
//
// All epistemic adjudication sets epistemic_owner: user on the target.

import { ulid } from 'ulid';

import type { Actor } from '../layer0/types.js';
import type {
  ClaimRelation,
  ClaimAuthor,
  ConfidenceBucket,
  EpistemicTag,
  RelationKind,
} from '../layer1/types.js';
import { isCanonicalRelationValid } from '../layer1/types.js';
import {
  appendClaimVersion,
  iterAllClaimVersions,
  readLatestVersion,
  type ClaimVersionRecord,
  type ActiveClaimVersion,
} from '../layer1/jsonl.js';
import { computeFingerprint } from '../layer1/fingerprint.js';
import { checkAcyclicity } from '../layer1/effective_current.js';
import type { ClaimStore } from '../layer1/store.js';
import type { SmartwareConfig } from '../config.js';
import { requireRegisteredActor, ProtocolError } from '../auth/middleware.js';
import { computePayloadHash } from '../layer0/idempotency.js';
import {
  appendOpLogEntry,
  OPERATION_ID_PATTERN,
  persistOperationIntent,
  readAllOpLogEntries,
  readOperationIntent,
  removeOperationIntent,
  runRecovery,
  type CommitContext,
  type ReviseOperationIntent,
} from '../ops_log/index.js';
import type Database from 'better-sqlite3';
import { syncSearchFromClaims, type SearchIndex } from '../layer3/search.js';

export interface ReviseParams {
  actor: Actor;
  target: string;
  expected_base_version: number;
  add_relations?: Array<{
    kind: RelationKind;
    target: string;
    valid_at: string;
    provenance: { origin: 'user'; target_claim_version: number };
  }>;
  set_confidence?: ConfidenceBucket;
  set_epistemic_tag?: EpistemicTag;
  add_derived_from?: string[];
  invalidate_relations?: string[];
  adopt_body?: boolean;
  reason: string;
  operation_id: string;
}

export interface ReviseResult {
  claim_id: string;
  new_version: number;
  epistemic_owner: ClaimAuthor;
  operation_id: string;
  status: 'revised';
}

/** Synchronous fault hooks used by crash-boundary conformance tests. */
export interface ReviseCommitHooks {
  afterIntent?: (intent: ReviseOperationIntent) => void;
  afterClaimVersion?: (record: ActiveClaimVersion) => void;
  afterCommit?: () => void;
}

function revisePayload(params: ReviseParams): Record<string, unknown> {
  return {
    actor_id: params.actor.id,
    target: params.target,
    expected_base_version: params.expected_base_version,
    add_relations: params.add_relations ?? [],
    set_confidence: params.set_confidence ?? null,
    set_epistemic_tag: params.set_epistemic_tag ?? null,
    add_derived_from: params.add_derived_from ?? [],
    invalidate_relations: params.invalidate_relations ?? [],
    adopt_body: params.adopt_body ?? false,
    reason: params.reason,
  };
}

export async function handleRevise(
  params: ReviseParams,
  dataDir: string,
  store: ClaimStore,
  config: SmartwareConfig,
  commitCtx?: CommitContext,
  db?: Database.Database,
  commitHooks?: ReviseCommitHooks,
  /**
   * The caller's claim-FTS lane, when it owns one. REVISE appends a claim
   * version through the store (`store.syncFromJsonlVersion`) and writes no
   * index, so the process that performed the revision answers without the
   * revised claim while every restart — which re-derives the derived rows and
   * re-syncs the lane — serves it. Every path below that syncs a claim row
   * from the canonical surface re-syncs that claim's scope; the repair lives
   * in the handler, not in a wrapper, so every dispatcher that passes its lane
   * inherits it (`SmartwareCore.revise`, `src/index.ts`'s MCP tool) — and a
   * dispatcher that passes none behaves exactly as before (kanban t_dae50f51).
   */
  searchIndex?: SearchIndex,
): Promise<ReviseResult> {
  const isUser = params.actor.id.startsWith('user:') || params.actor.id.startsWith('person_');
  if (!isUser) {
    throw new ProtocolError('user_required', 'REVISE is user-only in beta');
  }
  requireRegisteredActor(params.actor.id, config);
  if (!OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }

  const payloadHash = computePayloadHash(revisePayload(params));

  /**
   * The lane repair, in one place: re-sync the revised claim's scope after a
   * claim row was synced from the canonical surface (`syncFromJsonlVersion`).
   * No-op without a lane, so protocol callers without one keep their shape.
   */
  const resyncRevisedScope = (claimId: string): void => {
    if (!searchIndex) return;
    const scope = store.getClaim(claimId)?.scope;
    if (scope) syncSearchFromClaims(store, searchIndex, scope);
  };

  const committedResult = (): ReviseResult | null => {
    if (!commitCtx) return null;
    const entries = [...readAllOpLogEntries(commitCtx.opsDir)]
      .filter(entry => entry.operation_id === params.operation_id);
    if (entries.length === 0) return null;
    const exact = entries.find(entry =>
      entry.op === 'revise.claim'
      && entry.actor_id === params.actor.id
      && entry.details?.['payload_hash'] === payloadHash);
    if (!exact) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already used with a different payload`);
    }
    const claimId = exact.details?.['claim_id'];
    const newVersion = exact.details?.['new_version'];
    const epistemicOwner = exact.details?.['epistemic_owner'];
    const recordHash = exact.details?.['record_hash'];
    if (typeof claimId !== 'string'
      || typeof newVersion !== 'number'
      || (epistemicOwner !== 'agent' && epistemicOwner !== 'user')
      || typeof recordHash !== 'string') {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' has no replayable REVISE result`);
    }
    const artifacts = [...iterAllClaimVersions(dataDir)]
      .filter(version => version.operation_id === params.operation_id);
    if (artifacts.length !== 1
      || artifacts[0]!.claim_id !== claimId
      || artifacts[0]!.version !== newVersion
      || computePayloadHash(artifacts[0]) !== recordHash) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
    }
    store.syncFromJsonlVersion(artifacts[0]!);
    resyncRevisedScope(claimId);
    return {
      claim_id: claimId,
      new_version: newVersion,
      epistemic_owner: epistemicOwner,
      operation_id: params.operation_id,
      status: 'revised',
    };
  };

  const priorCommit = committedResult();
  if (priorCommit) return priorCommit;

  let existingIntent: ReviseOperationIntent | null = null;
  if (commitCtx) {
    const prepared = readOperationIntent(commitCtx.opsDir, params.operation_id);
    if (prepared) {
      if (prepared.op !== 'revise.claim'
        || prepared.actor_id !== params.actor.id
        || prepared.payload_hash !== payloadHash) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already prepared with a different payload`);
      }
      existingIntent = prepared;
      runRecovery({
        opsDir: commitCtx.opsDir,
        evidenceDir: '',
        claimsDir: dataDir,
        quarantineDir: '',
      });
      const recovered = committedResult();
      if (recovered) return recovered;
      const artifacts = [...iterAllClaimVersions(dataDir)]
        .filter(version => version.operation_id === params.operation_id);
      if (artifacts.length > 0) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
      }
    }
  }

  const latest = readLatestVersion(dataDir, params.target);
  if (!latest) {
    throw new ProtocolError('claim_not_found', `Claim '${params.target}' not found`);
  }
  if (latest.state !== 'active') {
    throw new ProtocolError('claim_forgotten', `Claim '${params.target}' is forgotten`);
  }
  if (latest.version !== params.expected_base_version) {
    throw new ProtocolError('conflict', `Expected version ${params.expected_base_version} but latest is ${latest.version}`);
  }

  const isAdjudicating = !!(
    params.add_relations?.length ||
    params.set_confidence ||
    params.set_epistemic_tag ||
    params.invalidate_relations?.length ||
    params.adopt_body
  );

  if (params.add_derived_from?.length) {
    const targetIsProtected = latest.epistemic_owner === 'user';
    if (!targetIsProtected && !isAdjudicating) {
      throw new ProtocolError(
        'invalid_add_derived_from',
        'add_derived_from requires epistemic_owner: user or a same-op adjudicating action',
      );
    }
  }

  const newVersion = latest.version + 1;
  const preparedAt = existingIntent?.prepared_at ?? new Date().toISOString();
  const relationIds = existingIntent?.expected.relation_ids
    ?? (params.add_relations ?? []).map(() => `rel_${ulid()}`);
  let newRelations = [...latest.relations];

  if (params.add_relations) {
    for (const [relationIndex, rel] of params.add_relations.entries()) {
      if (!isCanonicalRelationValid(rel.kind, 'user')) {
        throw new ProtocolError('invalid_relation', `Cannot admit ${rel.kind} with origin user`);
      }
      if (db && (rel.kind === 'supersedes' || rel.kind === 'corrects')) {
        if (!checkAcyclicity(params.target, rel.target, rel.kind, db)) {
          throw new ProtocolError('effective_current_cycle', `Admitting ${rel.kind} from ${params.target} to ${rel.target} would create a cycle`);
        }
      }
      const newRel: ClaimRelation = {
        relation_id: relationIds[relationIndex]!,
        kind: rel.kind,
        target: rel.target,
        valid_at: rel.valid_at,
        invalid_at: null,
        provenance: {
          origin: 'user',
          asserted_in_source_version: newVersion,
          target_claim_version: rel.provenance.target_claim_version,
          observation_ids: [],
        },
      };
      newRelations.push(newRel);
    }
  }

  if (params.invalidate_relations) {
    for (const relId of params.invalidate_relations) {
      const idx = newRelations.findIndex(r => r.relation_id === relId);
      if (idx === -1) {
        throw new ProtocolError('relation_not_found', `Relation '${relId}' not found on claim`);
      }
      newRelations[idx] = { ...newRelations[idx]!, invalid_at: preparedAt };
    }
  }

  const newAuthor: ClaimAuthor = params.adopt_body ? 'user' : latest.author;
  const newEpistemicOwner: ClaimAuthor = isAdjudicating || params.adopt_body ? 'user' : latest.epistemic_owner;
  const newConfidence = params.set_confidence ?? latest.confidence;
  const newEpistemicTag = params.set_epistemic_tag ?? latest.epistemic_tag;
  const newDerivedFrom = params.add_derived_from
    ? [...new Set([...latest.derived_from, ...params.add_derived_from])]
    : latest.derived_from;

  const record: ActiveClaimVersion = {
    claim_id: latest.claim_id,
    version: newVersion,
    state: 'active',
    content: latest.content,
    claim_type: latest.claim_type,
    claim_role: latest.claim_role,
    author: newAuthor,
    epistemic_owner: newEpistemicOwner,
    fingerprint: latest.fingerprint,
    confidence: newConfidence,
    epistemic_tag: newEpistemicTag,
    scope: latest.scope,
    derived_from: newDerivedFrom,
    relations: newRelations,
    created_at: latest.created_at,
    version_at: preparedAt,
    operation_id: params.operation_id,
    actor_id: params.actor.id,
    tags: latest.tags,
    supersedes: latest.version,
    semantic: latest.semantic,
  };

  if (commitCtx) {
    const recordHash = computePayloadHash(record);
    const intent: ReviseOperationIntent = {
      version: 1,
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      op: 'revise.claim',
      payload_hash: payloadHash,
      prepared_at: preparedAt,
      expected: {
        surface: 'l1',
        claim_id: record.claim_id,
        version: record.version,
        record_hash: recordHash,
        relation_ids: relationIds,
      },
      result: {
        claim_id: record.claim_id,
        new_version: record.version,
        epistemic_owner: record.epistemic_owner,
        operation_id: params.operation_id,
        status: 'revised',
      },
      details: { claim_id: record.claim_id, new_version: record.version },
    };
    if (existingIntent && existingIntent.expected.record_hash !== recordHash) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' no longer matches its prepared REVISE artifact`);
    }
    persistOperationIntent(commitCtx.opsDir, intent, true);
    commitHooks?.afterIntent?.(intent);
    appendClaimVersion(dataDir, record);
    commitHooks?.afterClaimVersion?.(record);
    appendOpLogEntry(commitCtx.opsDir, {
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      timestamp: preparedAt,
      op: 'revise.claim',
      details: {
        payload_hash: payloadHash,
        claim_id: record.claim_id,
        new_version: record.version,
        epistemic_owner: record.epistemic_owner,
        record_hash: recordHash,
      },
    });
    commitHooks?.afterCommit?.();
    removeOperationIntent(commitCtx.opsDir, params.operation_id);
  } else {
    appendClaimVersion(dataDir, record);
  }

  store.syncFromJsonlVersion(record);
  resyncRevisedScope(record.claim_id);

  return {
    claim_id: record.claim_id,
    new_version: newVersion,
    epistemic_owner: newEpistemicOwner,
    operation_id: params.operation_id,
    status: 'revised',
  };
}
