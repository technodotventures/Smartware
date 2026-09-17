// Protocol — REVISE handler (spec §9, v0.4.2 normative)
//
// The beta's only epistemic admission path. A user revision may:
//   - Admit epistemic relations (add_relations)
//   - Set confidence / epistemic_tag
//   - Incorporate corroboration (add_derived_from)
//   - Withdraw admitted edges (invalidate_relations)
//   - Adopt body as user voice (adopt_body)
//   - Re-pick which duplicate of one fact survives (repick_survivor)
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
  appendClaimVersions,
  carryDemotion,
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
  appendCommittedOpLogEntry,
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
  /**
   * User-only re-pick of which copy of one fact survives (ADR-0003 → *Releasing a
   * demotion*). `target` names the demoted duplicate; the operation atomically releases
   * it and demotes the current active copy (or copies) of the same fact, recording
   * `superseded_by_origin: 'user'` on that demotion. It is a claim-identity adjudication,
   * not a metadata edit, so in beta it is the operation's only action.
   */
  repick_survivor?: boolean;
  reason: string;
  operation_id: string;
}

export interface ReviseResult {
  claim_id: string;
  new_version: number;
  epistemic_owner: ClaimAuthor;
  operation_id: string;
  status: 'revised';
  /**
   * Set when the revised claim is still a mechanically demoted duplicate (ADR-0003 →
   * *Carry-forward across hand-built version records*): the surviving claim that supersedes it.
   * `REVISE` changes metadata, never the asserted fact, so it cannot release a duplicate
   * resolution — the caller is told that rather than left to discover it from a recall miss.
   * Never present on a `repick_survivor` result: the re-pick releases the target.
   */
  superseded_by?: string;
  /**
   * Present only on a `repick_survivor` result: the active copies this re-pick demoted, so the
   * released target is the fact's one recall-eligible claim. Oldest first; empty in rescue mode
   * (the previous survivor was already forgotten) and impossible when there was nothing to
   * re-pick (that is rejected, `not_demoted`).
   */
  demoted?: string[];
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
    // Included only when the caller names it, so the payload hash of every pre-existing
    // REVISE call is unchanged by the additive parameter.
    ...(params.repick_survivor !== undefined ? { repick_survivor: params.repick_survivor } : {}),
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
    const supersededBy = exact.details?.['superseded_by'];
    if (supersededBy !== undefined && typeof supersededBy !== 'string') {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' has no replayable REVISE result`);
    }
    // A re-pick records its demotions in the same entry: `repick_survivor: true`, the demoted
    // claim ids (mirrored from the operation's preparation) and each demotion artifact's
    // identity/hash, so the replay verifies the whole commit, not just the release.
    const repickFlag = exact.details?.['repick_survivor'];
    const demoted = exact.details?.['demoted'];
    const demotedRecords = exact.details?.['demoted_records'];
    let repickDemotions: Array<{ claim_id: string; version: number; record_hash: string }> | null = null;
    if (repickFlag !== undefined || demoted !== undefined || demotedRecords !== undefined) {
      const wellFormed = repickFlag === true
        && Array.isArray(demoted)
        && demoted.every(id => typeof id === 'string')
        && Array.isArray(demotedRecords)
        && demotedRecords.every(record =>
          !!record
          && typeof (record as Record<string, unknown>)['claim_id'] === 'string'
          && Number.isInteger((record as Record<string, unknown>)['version'])
          && typeof (record as Record<string, unknown>)['record_hash'] === 'string'
          && /^[a-f0-9]{64}$/.test((record as Record<string, unknown>)['record_hash'] as string))
        && demoted.length === demotedRecords.length
        && demoted.every((id, index) =>
          id === (demotedRecords[index] as { claim_id: string }).claim_id);
      if (!wellFormed || supersededBy !== undefined) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' has no replayable REVISE result`);
      }
      repickDemotions = demotedRecords as Array<{ claim_id: string; version: number; record_hash: string }>;
    }
    const expectedArtifacts = [
      { claim_id: claimId, version: newVersion, record_hash: recordHash },
      ...(repickDemotions ?? []),
    ];
    const artifacts = [...iterAllClaimVersions(dataDir)]
      .filter(version => version.operation_id === params.operation_id);
    const matched = expectedArtifacts.map(expected => artifacts.find(version =>
      version.claim_id === expected.claim_id
      && version.version === expected.version
      && computePayloadHash(version) === expected.record_hash));
    if (artifacts.length !== expectedArtifacts.length || matched.some(match => match === undefined)) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
    }
    for (const artifact of artifacts) store.syncFromJsonlVersion(artifact);
    return {
      claim_id: claimId,
      new_version: newVersion,
      epistemic_owner: epistemicOwner,
      operation_id: params.operation_id,
      status: 'revised',
      ...(repickDemotions
        ? { demoted: repickDemotions.map(record => record.claim_id) }
        : (supersededBy !== undefined ? { superseded_by: supersededBy } : {})),
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
        fence: commitCtx.fence ?? undefined,
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

  if (params.repick_survivor) {
    return repickSurvivor({
      params,
      dataDir,
      store,
      commitCtx,
      commitHooks,
      latest,
      existingIntent,
      payloadHash,
    });
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

  const record: ActiveClaimVersion = carryDemotion({
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
  }, latest);

  if (commitCtx) {
    const recordHash = computePayloadHash(record);
    const fenceStamp = commitCtx.fence?.stamp() ?? null;
    const intent: ReviseOperationIntent = {
      version: 1,
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      op: 'revise.claim',
      payload_hash: payloadHash,
      prepared_at: preparedAt,
      ...(fenceStamp ? { fence: fenceStamp } : {}),
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
        // The claim is still a demoted duplicate: the REVISE decided metadata, not fact identity.
        ...(record.superseded_by !== undefined ? { superseded_by: record.superseded_by } : {}),
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
    appendCommittedOpLogEntry(commitCtx.opsDir, {
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
        ...(record.superseded_by !== undefined ? { superseded_by: record.superseded_by } : {}),
      },
    }, commitCtx.fence);
    commitHooks?.afterCommit?.();
    removeOperationIntent(commitCtx.opsDir, params.operation_id);
  } else {
    appendClaimVersion(dataDir, record);
  }

  store.syncFromJsonlVersion(record);

  return {
    claim_id: record.claim_id,
    new_version: newVersion,
    epistemic_owner: newEpistemicOwner,
    operation_id: params.operation_id,
    status: 'revised',
    ...(record.superseded_by !== undefined ? { superseded_by: record.superseded_by } : {}),
  };
}

/**
 * `REVISE` with `repick_survivor` — the user-only release of a mechanical demotion
 * (ADR-0003 → *Releasing a demotion*, protocol v0.5.0).
 *
 * The target must be a demoted duplicate: its latest version carries `superseded_by`, so the
 * claim is out of the recall-eligible set and nothing in beta can bring it back. One commit then:
 *
 *   - **releases the target** — a new active version without `superseded_by`/`superseded_at`,
 *     `epistemic_owner: user` (the re-pick is an epistemic adjudication) and the audit-only
 *     `reinstated_by: 'user'`; and
 *   - **demotes the fact's current active copy** — a new version carrying
 *     `superseded_by: <released claim>` and `superseded_by_origin: 'user'`, so exactly one copy
 *     of the fact stays recall-eligible and the next §1e write touching the fact finds only the
 *     released claim (a bare release would leave two active copies and be re-demoted).
 *
 * The demotion uses the *mechanical* channel (`status: superseded`), deliberately not an admitted
 * `supersedes` edge: no effective-current cycle check, no `invalidate_relations` interaction. The
 * active copy (or copies — a store that predates §1e convergence can still hold more than one) is
 * resolved through `findActiveFactMatches` on the target's own fact, never from the target's
 * possibly-stale `superseded_by` pointer. If no active copy exists (the previous survivor was
 * already forgotten), the re-pick is a rescue: it releases the target and demotes nothing.
 *
 * Crash semantics: the whole mutation is one `appendClaimVersions` call — release first, then the
 * demotions, one monthly file, one write, one fsync — the same durability unit a single-record
 * commit gets, so a process crash cannot land between the records. The durable intent names every
 * artifact the commit will produce; a partially present set fails closed (manual review) in
 * recovery and on retry.
 */
async function repickSurvivor(args: {
  params: ReviseParams;
  dataDir: string;
  store: ClaimStore;
  commitCtx?: CommitContext;
  commitHooks?: ReviseCommitHooks;
  latest: ActiveClaimVersion;
  existingIntent: ReviseOperationIntent | null;
  payloadHash: string;
}): Promise<ReviseResult> {
  const { params, dataDir, store, commitCtx, commitHooks, latest, existingIntent, payloadHash } = args;

  // A re-pick adjudicates fact identity, not claim metadata. Riding it on the single-record
  // verbs (or vice versa) would commit two different kinds of mutation under one warrant whose
  // interaction is unspecified in beta — so it is the operation's only action.
  const combinedActions = !!(
    params.add_relations?.length
    || params.set_confidence
    || params.set_epistemic_tag
    || params.add_derived_from?.length
    || params.invalidate_relations?.length
    || params.adopt_body
  );
  if (combinedActions) {
    throw new ProtocolError(
      'invalid_parameter',
      'repick_survivor cannot be combined with other REVISE actions in beta',
    );
  }

  if (latest.superseded_by == null) {
    throw new ProtocolError(
      'not_demoted',
      `Claim '${params.target}' is not a demoted duplicate — nothing to re-pick`,
    );
  }

  const row = store.getClaim(params.target);
  if (!row) {
    throw new ProtocolError(
      'claim_not_found',
      `Claim '${params.target}' has no materialized row to resolve its fact from`,
    );
  }
  const factMatches = store.findActiveFactMatches(row.subject_id, {
    predicate: row.predicate,
    scope: row.scope,
    object: row.object,
  });
  const activeMatches = factMatches.filter(match => match.id !== params.target);
  if (activeMatches.length !== factMatches.length) {
    throw new ProtocolError(
      'conflict',
      `Claim '${params.target}' is demoted in canonical state but active in the store — sync the store before re-picking`,
    );
  }

  const preparedAt = existingIntent?.prepared_at ?? new Date().toISOString();
  const newVersion = latest.version + 1;

  const released: ActiveClaimVersion = {
    claim_id: latest.claim_id,
    version: newVersion,
    state: 'active',
    content: latest.content,
    claim_type: latest.claim_type,
    claim_role: latest.claim_role,
    author: latest.author,
    // The adjudication sets the protection; it does not adopt the body (`adopt_body` is not
    // combinable with a re-pick) and does not change confidence/tag values.
    epistemic_owner: 'user',
    fingerprint: latest.fingerprint,
    confidence: latest.confidence,
    epistemic_tag: latest.epistemic_tag,
    scope: latest.scope,
    derived_from: latest.derived_from,
    relations: latest.relations,
    created_at: latest.created_at,
    version_at: preparedAt,
    operation_id: params.operation_id,
    actor_id: params.actor.id,
    tags: latest.tags,
    supersedes: latest.version,
    reinstated_by: 'user',
    semantic: latest.semantic,
  };

  const demotedRecords: ActiveClaimVersion[] = [];
  for (const match of activeMatches) {
    const otherLatest = readLatestVersion(dataDir, match.id);
    if (!otherLatest || otherLatest.state !== 'active') {
      throw new ProtocolError(
        'conflict',
        `Active copy '${match.id}' has no active canonical version — resolve the store before re-picking`,
      );
    }
    demotedRecords.push({
      claim_id: otherLatest.claim_id,
      version: otherLatest.version + 1,
      state: 'active',
      content: otherLatest.content,
      claim_type: otherLatest.claim_type,
      claim_role: otherLatest.claim_role,
      author: otherLatest.author,
      epistemic_owner: otherLatest.epistemic_owner,
      fingerprint: otherLatest.fingerprint,
      confidence: otherLatest.confidence,
      epistemic_tag: otherLatest.epistemic_tag,
      scope: otherLatest.scope,
      derived_from: otherLatest.derived_from,
      relations: otherLatest.relations,
      created_at: otherLatest.created_at,
      version_at: preparedAt,
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      tags: otherLatest.tags,
      supersedes: otherLatest.version,
      superseded_by: released.claim_id,
      superseded_at: preparedAt,
      superseded_by_origin: 'user',
      semantic: otherLatest.semantic,
    });
  }

  if (commitCtx) {
    const recordHash = computePayloadHash(released);
    const demotedArtifacts = demotedRecords.map(record => ({
      claim_id: record.claim_id,
      version: record.version,
      record_hash: computePayloadHash(record),
    }));
    const demotedIds = demotedRecords.map(record => record.claim_id);
    const intent: ReviseOperationIntent = {
      version: 1,
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      op: 'revise.claim',
      payload_hash: payloadHash,
      prepared_at: preparedAt,
      expected: {
        surface: 'l1',
        claim_id: released.claim_id,
        version: released.version,
        record_hash: recordHash,
        relation_ids: [],
        repick: { demoted: demotedArtifacts },
      },
      result: {
        claim_id: released.claim_id,
        new_version: released.version,
        epistemic_owner: released.epistemic_owner,
        operation_id: params.operation_id,
        status: 'revised',
        demoted: demotedIds,
      },
      details: { claim_id: released.claim_id, new_version: released.version },
    };
    if (existingIntent) {
      const preparedDemoted = existingIntent.expected.repick?.demoted ?? [];
      const stillMatches = existingIntent.expected.repick !== undefined
        && existingIntent.expected.record_hash === recordHash
        && preparedDemoted.length === demotedArtifacts.length
        && preparedDemoted.every((artifact, index) =>
          artifact.claim_id === demotedArtifacts[index]!.claim_id
          && artifact.version === demotedArtifacts[index]!.version
          && artifact.record_hash === demotedArtifacts[index]!.record_hash);
      if (!stillMatches) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' no longer matches its prepared REVISE artifact`);
      }
    }
    persistOperationIntent(commitCtx.opsDir, intent, true);
    commitHooks?.afterIntent?.(intent);
    // One append for the whole mutation: the release first so a torn write can only degrade to
    // the pre-op state (two active copies converge on the next §1e write), never to a fact with
    // no recall-eligible copy. The hook fires once, after the unit is durable.
    appendClaimVersions(dataDir, [released, ...demotedRecords]);
    commitHooks?.afterClaimVersion?.(released);
    appendCommittedOpLogEntry(commitCtx.opsDir, {
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      timestamp: preparedAt,
      op: 'revise.claim',
      details: {
        payload_hash: payloadHash,
        claim_id: released.claim_id,
        new_version: released.version,
        epistemic_owner: released.epistemic_owner,
        record_hash: recordHash,
        repick_survivor: true,
        demoted: demotedIds,
        demoted_records: demotedArtifacts,
      },
    });
    commitHooks?.afterCommit?.();
    removeOperationIntent(commitCtx.opsDir, params.operation_id);
  } else {
    appendClaimVersions(dataDir, [released, ...demotedRecords]);
  }

  store.syncFromJsonlVersion(released);
  for (const record of demotedRecords) store.syncFromJsonlVersion(record);

  return {
    claim_id: released.claim_id,
    new_version: released.version,
    epistemic_owner: released.epistemic_owner,
    operation_id: params.operation_id,
    status: 'revised',
    demoted: demotedRecords.map(record => record.claim_id),
  };
}
