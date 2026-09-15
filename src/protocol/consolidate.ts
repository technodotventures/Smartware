// Protocol — CONSOLIDATE handler (ADR-0002).
//
// Collapses a cluster of related active claims into ONE reviewed "current
// understanding" claim. Binding invariant: the consolidated claim's
// `derived_from` is a superset of the inputs' evidence lineage, and the inputs
// are tombstoned (never deleted) — so the full correction + provenance trail
// survives the compaction.

import { ulid } from 'ulid';

import type { Actor } from '../layer0/types.js';
import type {
  ClaimAuthor,
  ConfidenceBucket,
  EpistemicTag,
  ClaimType,
  ClaimRole,
} from '../layer1/types.js';
import {
  appendClaimVersion,
  readLatestVersion,
  type ActiveClaimVersion,
  type ForgottenClaimVersion,
} from '../layer1/jsonl.js';
import { computeFingerprint } from '../layer1/fingerprint.js';
import type { ClaimStore } from '../layer1/store.js';
import type { SmartwareConfig } from '../config.js';
import { requireRegisteredActor, ProtocolError } from '../auth/middleware.js';
import {
  appendCommittedOpLogEntry,
  OPERATION_ID_PATTERN,
  readAllOpLogEntries,
  type CommitContext,
} from '../ops_log/index.js';

export interface ConsolidateParams {
  actor: Actor;
  /** 2+ active claim ids, same scope. */
  claim_ids: string[];
  /** Human/LLM-authored, human-reviewed consolidated text. */
  summary: string;
  subject_name: string;
  predicate: string;
  scope: string;
  reason?: string;
  operation_id: string;
  confidence?: ConfidenceBucket;
  epistemic_tag?: EpistemicTag;
  claim_type?: ClaimType;
  claim_role?: ClaimRole;
}

export interface ConsolidateResult {
  claim_id: string;
  inputs_consolidated: number;
  derived_from: string[];
  operation_id: string;
  status: 'consolidated';
}

export async function handleConsolidate(
  params: ConsolidateParams,
  dataDir: string,
  store: ClaimStore,
  config: SmartwareConfig,
  commitCtx?: CommitContext,
): Promise<ConsolidateResult> {
  const isUser = params.actor.id.startsWith('user:') || params.actor.id.startsWith('person_');
  if (!isUser) {
    throw new ProtocolError('user_required', 'CONSOLIDATE is user-only in beta');
  }
  requireRegisteredActor(params.actor.id, config);
  if (!OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }
  if (params.claim_ids.length < 2) {
    throw new ProtocolError('invalid_parameter', 'CONSOLIDATE requires at least two claim ids');
  }
  if (!params.summary.trim()) {
    throw new ProtocolError('invalid_parameter', 'CONSOLIDATE summary is required');
  }

  // Idempotency: a prior consolidate with this operation_id is already recorded.
  if (commitCtx) {
    const prior = [...readAllOpLogEntries(commitCtx.opsDir)]
      .find(entry => entry.operation_id === params.operation_id && entry.op === 'consolidate');
    if (prior) {
      const claimId = prior.details?.['claim_id'];
      if (typeof claimId === 'string') {
        return {
          claim_id: claimId,
          inputs_consolidated: Number(prior.details?.['inputs_consolidated'] ?? 0),
          derived_from: (prior.details?.['derived_from'] as string[]) ?? [],
          operation_id: params.operation_id,
          status: 'consolidated',
        };
      }
    }
  }

  // Load inputs; all must be active and share the consolidated scope.
  const inputs: ActiveClaimVersion[] = [];
  for (const id of params.claim_ids) {
    const latest = readLatestVersion(dataDir, id);
    if (!latest || latest.state !== 'active') {
      throw new ProtocolError('not_found', `Claim '${id}' is not an active claim`);
    }
    if (latest.scope !== params.scope) {
      throw new ProtocolError('invalid_scope', `Claim '${id}' is not in scope '${params.scope}'`);
    }
    inputs.push(latest as ActiveClaimVersion);
  }

  // Evidence lineage: union of inputs' derived_from + the input ids themselves.
  const derivedFrom: string[] = [];
  const seen = new Set<string>();
  for (const id of params.claim_ids) {
    if (!seen.has(id)) { seen.add(id); derivedFrom.push(id); }
  }
  for (const input of inputs) {
    for (const d of input.derived_from) {
      if (!seen.has(d)) { seen.add(d); derivedFrom.push(d); }
    }
  }

  const now = new Date().toISOString();
  const claimType = params.claim_type ?? 'finding';
  const claimRole = params.claim_role ?? 'summary';
  const confidence = params.confidence ?? 'medium';
  const epistemicTag = params.epistemic_tag ?? 'fact';
  const author: ClaimAuthor = 'user';

  const consolidated: ActiveClaimVersion = {
    claim_id: `claim_${ulid()}`,
    version: 1,
    state: 'active',
    content: params.summary,
    claim_type: claimType,
    claim_role: claimRole,
    author,
    epistemic_owner: author,
    fingerprint: computeFingerprint(params.summary, params.scope, claimType),
    confidence,
    epistemic_tag: epistemicTag,
    scope: params.scope,
    derived_from: derivedFrom,
    relations: [],
    created_at: now,
    version_at: now,
    operation_id: params.operation_id,
    actor_id: params.actor.id,
    tags: [],
  };

  appendClaimVersion(dataDir, consolidated);
  store.syncFromJsonlVersion(consolidated, { name: params.subject_name, type: 'concept', predicate: params.predicate });

  // Tombstone each input (forgotten version supersedes its latest active).
  for (const input of inputs) {
    const forgotten: ForgottenClaimVersion = {
      claim_id: input.claim_id,
      version: input.version + 1,
      state: 'forgotten',
      tombstone_id: `tomb_${input.claim_id.slice(6)}`,
      forgotten_at: now,
      forgotten_by: params.actor.id,
      claim_type: input.claim_type,
      claim_role: input.claim_role,
      author: input.author,
      epistemic_owner: input.epistemic_owner,
      fingerprint: input.fingerprint,
      confidence: input.confidence,
      epistemic_tag: input.epistemic_tag,
      scope: input.scope,
      derived_from: input.derived_from,
      relations: input.relations,
      created_at: input.created_at,
      version_at: now,
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      tags: input.tags,
      supersedes: input.version,
      endorsement_source: input.endorsement_source,
    };
    appendClaimVersion(dataDir, forgotten);
    store.syncFromJsonlVersion(forgotten);
  }

  if (commitCtx) {
    appendCommittedOpLogEntry(commitCtx.opsDir, {
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      timestamp: now,
      op: 'consolidate',
      details: {
        claim_id: consolidated.claim_id,
        inputs_consolidated: inputs.length,
        inputs: params.claim_ids,
        derived_from: derivedFrom,
        scope: params.scope,
        reason: params.reason ?? '',
      },
    }, commitCtx.fence);
  }

  return {
    claim_id: consolidated.claim_id,
    inputs_consolidated: inputs.length,
    derived_from: derivedFrom,
    operation_id: params.operation_id,
    status: 'consolidated',
  };
}
