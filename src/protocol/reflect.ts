// Protocol — REFLECT handler (spec verb; formerly COMPILE)
//
// Two modes per spec §9:
//   - reflect.auto: autonomous background compilation. Creates bounded
//     L1 claims (author:agent, epistemic_owner:agent, confidence:low,
//     epistemic_tag:inference). Compiles L2 pages. Proposes candidates.
//     Does NOT admit epistemic relations or elevate confidence/tag.
//   - Explicit review/commit: rides REVISE in beta (§9).

import { ulid } from 'ulid';

import type { Layer0Index } from '../layer0/index.js';
import type { ClaimStore } from '../layer1/store.js';
import type { SearchIndex } from '../layer3/search.js';
import type { SmartwareConfig } from '../config.js';
import type { Actor, PreExtractedClaim } from '../layer0/types.js';
import type { ClaimRole, ClaimType, EpistemicLabel } from '../layer1/types.js';
import { compile, isContextOnlyObservation, type CompileResult, type CompileOptions } from '../layer2/compiler.js';
import type { CompileTelemetry } from '../layer2/types.js';
import { writeManifest, countWikiPages } from '../layer2/manifest.js';
import { requireGrant, ProtocolError } from '../auth/middleware.js';
import { isOwner } from '../auth/grants.js';
import {
  appendClaimVersion,
  readLatestVersion,
  iterAllClaimVersions,
  type ActiveClaimVersion,
} from '../layer1/jsonl.js';
import { computeStructuredClaimFingerprint } from '../layer1/fingerprint.js';
import { readAll } from '../layer0/log.js';
import { extractDeterministic } from '../extraction/deterministic.js';
import { extractClaimsLLM } from '../extraction/llm.js';
import { computePayloadHash } from '../layer0/idempotency.js';
import {
  appendOpLogEntry,
  OPERATION_ID_PATTERN,
  persistOperationIntent,
  readAllOpLogEntries,
  removeOperationIntent,
  type CommitContext,
  type OpLogEntry,
  type ReflectClaimOperationIntent,
} from '../ops_log/index.js';
import {
  isSessionCheckpointContent,
  renderSessionCheckpoint,
  validateSessionCheckpoint,
} from '../session/checkpoint.js';

export interface CompileParams {
  actor: Actor;
  scope?: string;
  entity_id?: string;
  use_llm?: boolean;
  operation_id?: string;
}

export interface CompileHandlerResult {
  pages_compiled: number;
  claims_created: number;
  git_sha?: string;
  audit: CompileResult['audit'];
  telemetry: CompileTelemetry;
}

export interface ReflectCommitHooks {
  afterIntent?: (intent: ReflectClaimOperationIntent) => void;
  afterClaimVersion?: (record: ActiveClaimVersion) => void;
  afterCommit?: () => void;
}

interface ReflectAutoStats {
  claimsCreated: number;
  llmAttempted: number;
  llmFailed: number;
  llmSkippedSensitive: number;
}

interface ReflectionCandidate extends PreExtractedClaim {
  claim_type?: ClaimType;
  claim_role?: ClaimRole;
  rendered_content?: string;
}

export type ReflectAutoTerminalOutcome =
  | 'ignored_context_only'
  | 'ignored_short_content'
  | 'no_claims'
  | 'claims_processed';

function extractedEpistemic(value: string): EpistemicLabel {
  if (value === 'observed'
    || value === 'asserted'
    || value === 'inferred'
    || value === 'user_confirmed'
    || value === 'system_generated') {
    return value;
  }
  return 'inferred';
}

function materializeSemantic(
  claim: PreExtractedClaim,
  subjectType: string,
  extractedAt: string,
  sensitive: boolean,
): NonNullable<ActiveClaimVersion['semantic']> {
  const tValidFrom = claim.t_valid_from ?? {
    value: claim.validity?.from ?? extractedAt,
    state: claim.validity?.from ? 'known' as const : 'inferred' as const,
    ...(claim.validity?.from ? {} : { basis: 'reflection_time' }),
  };
  const tValidTo = claim.t_valid_to ?? (
    claim.validity?.to
      ? { value: claim.validity.to, state: 'known' as const }
      : { value: null, state: 'null' as const }
  );
  return {
    subject_name: claim.subject_name,
    subject_type: subjectType,
    predicate: claim.predicate,
    object: claim.object,
    t_valid_from: tValidFrom,
    t_valid_to: tValidTo,
    extracted_epistemic: extractedEpistemic(claim.epistemic),
    extracted_confidence: Math.max(0, Math.min(1, claim.confidence)),
    sensitive,
    extraction: {
      ...claim.extraction,
      extracted_at: extractedAt,
    },
  };
}

/** Content-free replay checkpoint for one observation considered by REFLECT. */
export interface ReflectAutoTerminalReceipt extends Record<string, unknown> {
  observation_id: string;
  scope: string;
  reflection_complete: true;
  outcome: ReflectAutoTerminalOutcome;
  candidates_found?: number;
  claim_versions_written?: number;
}

export function isReflectAutoTerminalReceipt(
  entry: OpLogEntry,
): entry is OpLogEntry & { details: ReflectAutoTerminalReceipt } {
  const details = entry.details;
  return entry.op === 'reflect.auto'
    && details?.['reflection_complete'] === true
    && typeof details['observation_id'] === 'string'
    && typeof details['scope'] === 'string'
    && (
      details['outcome'] === 'ignored_context_only'
      || details['outcome'] === 'ignored_short_content'
      || details['outcome'] === 'no_claims'
      || details['outcome'] === 'claims_processed'
    );
}

function commitReflectClaim(
  dataDir: string,
  record: ActiveClaimVersion,
  commitCtx: CommitContext,
  hooks?: ReflectCommitHooks,
): void {
  const recordHash = computePayloadHash(record);
  const payloadHash = computePayloadHash({
    claim_id: record.claim_id,
    version: record.version,
    fingerprint: record.fingerprint,
    derived_from: record.derived_from,
  });
  const intent: ReflectClaimOperationIntent = {
    version: 1,
    operation_id: record.operation_id,
    actor_id: record.actor_id,
    op: 'reflect.auto',
    payload_hash: payloadHash,
    prepared_at: record.version_at,
    expected: {
      surface: 'l1',
      claim_id: record.claim_id,
      version: record.version,
      record_hash: recordHash,
    },
    result: { claim_id: record.claim_id, version: record.version, status: 'reflected' },
    details: { claim_id: record.claim_id, fingerprint: record.fingerprint },
  };
  persistOperationIntent(commitCtx.opsDir, intent);
  hooks?.afterIntent?.(intent);
  appendClaimVersion(dataDir, record);
  hooks?.afterClaimVersion?.(record);
  appendOpLogEntry(commitCtx.opsDir, {
    operation_id: record.operation_id,
    actor_id: record.actor_id,
    timestamp: record.version_at,
    op: 'reflect.auto',
    details: {
      payload_hash: payloadHash,
      claim_id: record.claim_id,
      version: record.version,
      fingerprint: record.fingerprint,
      record_hash: recordHash,
    },
  });
  hooks?.afterCommit?.();
  removeOperationIntent(commitCtx.opsDir, record.operation_id);
}

export async function handleCompile(
  params: CompileParams,
  evidenceDir: string,
  wikiDir: string,
  layer0: Layer0Index,
  store: ClaimStore,
  searchIndex: SearchIndex,
  config: SmartwareConfig,
  dataDir?: string,
  commitCtx?: CommitContext,
  commitHooks?: ReflectCommitHooks,
): Promise<CompileHandlerResult> {
  // Omitting scope compiles ALL scopes; only the owner may do that. A non-owner
  // must name a scope they're granted, else the 'personal' grant check would
  // authorise a compile across every scope.
  if (!params.scope && !isOwner(params.actor.id, config)) {
    throw new ProtocolError('invalid_scope', 'A scope is required to compile; only the owner may compile all scopes.');
  }
  const targetScope = params.scope ?? 'personal';
  requireGrant(params.actor.id, 'compile', targetScope, config);

  if (params.operation_id && !OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }
  if (params.operation_id && !commitCtx) {
    throw new ProtocolError('invalid_parameter', 'operation_id requires an operations directory');
  }
  const parentPayloadHash = computePayloadHash({
    actor_id: params.actor.id,
    scope: params.scope ?? null,
    entity_id: params.entity_id ?? null,
    use_llm: params.use_llm ?? false,
  });
  const parentEntry = params.operation_id && commitCtx
    ? [...readAllOpLogEntries(commitCtx.opsDir)]
      .find(entry => entry.operation_id === params.operation_id)
    : undefined;
  if (parentEntry && (parentEntry.op !== 'reflect.explicit'
    || parentEntry.actor_id !== params.actor.id
    || parentEntry.details?.['payload_hash'] !== parentPayloadHash)) {
    throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already used with a different payload`);
  }

  let reflectionStats: ReflectAutoStats = {
    claimsCreated: 0,
    llmAttempted: 0,
    llmFailed: 0,
    llmSkippedSensitive: 0,
  };
  const entityHints = new Map<string, { name: string; type: string; predicate?: string; sensitive?: boolean }>();

  if (dataDir) {
    reflectionStats = await reflectAutoCreateClaims(
      evidenceDir,
      dataDir,
      layer0,
      store,
      targetScope,
      config,
      params.use_llm === true,
      commitCtx,
      entityHints,
      commitHooks,
    );
    for (const v of iterAllClaimVersions(dataDir)) {
      store.syncFromJsonlVersion(v, entityHints.get(v.claim_id));
    }
  }

  const options: CompileOptions = {
    scope: params.scope,
    entityId: params.entity_id,
    useLLM: params.use_llm ?? false,
  };

  const compiled = await compile(evidenceDir, wikiDir, layer0, store, config, options, searchIndex);

  for (const page of compiled.pages) {
    searchIndex.indexPage(page);
  }

  const statusCounts = layer0.countByStatus();
  writeManifest(wikiDir, config, {
    layer0: {
      total: layer0.totalCount(),
      accepted: statusCounts['accepted'] ?? 0,
      quarantined: statusCounts['quarantined'] ?? 0,
      tombstoned: statusCounts['tombstoned'] ?? 0,
    },
    layer1: { claims: store.claimCount(), entities: store.entityCount() },
    layer2: { pages: countWikiPages(wikiDir) },
  });

  const handlerResult: CompileHandlerResult = {
    pages_compiled: compiled.pages.length,
    claims_created: typeof parentEntry?.details?.['claims_created'] === 'number'
      ? parentEntry.details['claims_created']
      : reflectionStats.claimsCreated,
    git_sha: compiled.gitSha,
    audit: compiled.audit,
    telemetry: {
      ...compiled.telemetry,
      llm_extraction_attempted: reflectionStats.llmAttempted,
      llm_extraction_failed: reflectionStats.llmFailed,
      llm_extraction_skipped_sensitive: reflectionStats.llmSkippedSensitive,
    },
  };
  if (params.operation_id && commitCtx && !parentEntry) {
    appendOpLogEntry(commitCtx.opsDir, {
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      timestamp: new Date().toISOString(),
      op: 'reflect.explicit',
      details: {
        payload_hash: parentPayloadHash,
        scope: targetScope,
        claims_created: reflectionStats.claimsCreated,
        pages_compiled: compiled.pages.length,
      },
    });
  }
  return handlerResult;
}

async function reflectAutoCreateClaims(
  evidenceDir: string,
  dataDir: string,
  layer0: Layer0Index,
  store: ClaimStore,
  scope: string,
  config: SmartwareConfig,
  useLLM: boolean,
  commitCtx?: CommitContext,
  entityHints?: Map<string, { name: string; type: string; predicate?: string; sensitive?: boolean }>,
  commitHooks?: ReflectCommitHooks,
): Promise<ReflectAutoStats> {
  const podActorId = `substrate:${config.instance_id.replace('smartware_', '')}`;
  let created = 0;
  let llmAttempted = 0;
  let llmFailed = 0;
  let llmSkippedSensitive = 0;

  const processedObsIds = new Set<string>();
  if (commitCtx) {
    for (const entry of readAllOpLogEntries(commitCtx.opsDir)) {
      if (isReflectAutoTerminalReceipt(entry)) {
        processedObsIds.add(entry.details['observation_id']);
      }
    }
  } else {
    for (const v of iterAllClaimVersions(dataDir)) {
      for (const obsId of v.derived_from) processedObsIds.add(obsId);
    }
  }
  const contextClaimIds = new Set(
    store.getActiveClaims(scope)
      .filter((claim) => claim.status === 'active')
      .map((claim) => claim.id),
  );

  const markComplete = (
    observationId: string,
    observationScope: string,
    outcome: ReflectAutoTerminalOutcome,
    details: Record<string, unknown> = {},
  ): void => {
    if (commitCtx) {
      const receipt: ReflectAutoTerminalReceipt = {
        ...details,
        observation_id: observationId,
        scope: observationScope,
        reflection_complete: true,
        outcome,
      };
      appendOpLogEntry(commitCtx.opsDir, {
        operation_id: `op_${ulid()}`,
        actor_id: podActorId,
        timestamp: new Date().toISOString(),
        op: 'reflect.auto',
        details: receipt,
      });
    }
    processedObsIds.add(observationId);
  };

  for (const obs of readAll(evidenceDir)) {
    if (obs.status !== 'accepted') continue;
    if (obs.type === 'claim_extracted' || obs.type === 'correction' || obs.type === 'tombstone') continue;
    if (scope && obs.scope !== scope && !obs.scope.endsWith('/' + scope) && !obs.scope.startsWith(scope + '/')) continue;
    if (processedObsIds.has(obs.id)) continue;
    if (isContextOnlyObservation(obs, contextClaimIds)) {
      markComplete(obs.id, obs.scope, 'ignored_context_only');
      continue;
    }

    let bodyText: string;
    if (typeof obs.content.body === 'string') {
      bodyText = obs.content.body;
    } else if (obs.content.body && typeof obs.content.body === 'object' && 'body' in obs.content.body) {
      const inner = (obs.content.body as { body: unknown }).body;
      bodyText = typeof inner === 'string' ? inner : JSON.stringify(inner);
    } else {
      bodyText = JSON.stringify(obs.content.body);
    }

    if (!bodyText || bodyText.length < 10) {
      markComplete(obs.id, obs.scope, 'ignored_short_content');
      continue;
    }

    const subjectName = obs.scope.split('/').pop() ?? obs.scope;
    let detClaims: ReflectionCandidate[];
    let extractedEntities: Array<{ name: string; type: string }>;
    if (isSessionCheckpointContent(obs.content.body)) {
      try {
        const checkpoint = validateSessionCheckpoint(obs.content.body);
        if (checkpoint.scope !== obs.scope) {
          throw new Error('checkpoint scope does not match observation scope');
        }
        detClaims = [{
          subject_name: checkpoint.session_id,
          subject_type: 'session',
          predicate: `checkpoint:${checkpoint.trigger}`,
          object: { type: 'any', value: checkpoint },
          scope: checkpoint.scope,
          t_valid_from: { value: obs.source.observed_at, state: 'known' },
          t_valid_to: { value: null, state: 'null' },
          epistemic: 'system_generated',
          confidence: 0.5,
          sensitive: obs.policy.sensitive,
          extraction: {
            method: 'deterministic',
            model: null,
            compiler_version: 'session-checkpoint-v1',
            prompt_hash: null,
          },
          claim_type: 'checkpoint',
          claim_role: 'checkpoint',
          rendered_content: renderSessionCheckpoint(checkpoint),
        }];
        extractedEntities = [{ name: checkpoint.session_id, type: 'session' }];
      } catch {
        markComplete(obs.id, obs.scope, 'no_claims');
        continue;
      }
    } else {
      const extracted = extractDeterministic(
        bodyText, obs.scope, subjectName, obs.source.observed_at,
      );
      detClaims = extracted.claims;
      extractedEntities = extracted.entities;
    }

    let llmClaims: ReflectionCandidate[] = [];
    if (!isSessionCheckpointContent(obs.content.body) && useLLM && config.llm.provider !== 'none') {
      if (obs.policy.sensitive) {
        llmSkippedSensitive++;
      } else {
        llmAttempted++;
        try {
          const llmResult = await extractClaimsLLM(
            bodyText, obs.scope, obs.source.observed_at,
            store.getAllEntities(obs.scope), config,
          );
          llmClaims = llmResult.claims;
        } catch {
          llmFailed++;
          // Deterministic extraction remains available and telemetry records the degradation.
        }
      }
    }

    const allClaims = [...detClaims, ...llmClaims];
    let claimVersionsWritten = 0;

    for (const claim of allClaims) {
      const content = claim.rendered_content ?? (typeof claim.object.value === 'string'
        ? claim.object.value
        : JSON.stringify(claim.object.value));
      const claimType = claim.claim_type ?? 'hypothesis';
      const claimRole = claim.claim_role ?? 'memory';
      const fp = computeStructuredClaimFingerprint(
        claim.subject_name,
        claim.predicate,
        claim.object,
        obs.scope,
        claimType,
      );
      const extractedEntity = extractedEntities.find(e => e.name === claim.subject_name);
      const entityInfo = {
        name: claim.subject_name,
        type: claim.subject_type ?? extractedEntity?.type ?? 'concept',
      };
      const sensitive = obs.policy.sensitive || claim.sensitive;

      const existingByFp = findByFingerprint(dataDir, fp)
        ?? findSemanticMatch(dataDir, store, fp);
      if (existingByFp) {
        if (existingByFp.epistemic_owner === 'user') continue;
        const existingClaim = store.getClaim(existingByFp.claim_id);
        const existingEntity = existingClaim ? store.getEntity(existingClaim.subject_id) : undefined;
        const existingHint = entityHints?.get(existingByFp.claim_id);
        entityHints?.set(existingByFp.claim_id, {
          name: existingClaim?.subject_name ?? existingHint?.name ?? entityInfo.name,
          type: existingEntity?.type ?? existingHint?.type ?? entityInfo.type,
          predicate: existingClaim?.predicate ?? existingHint?.predicate ?? claim.predicate,
          sensitive: sensitive || existingClaim?.sensitive === true || existingHint?.sensitive === true,
        });
        if (!existingByFp.derived_from.includes(obs.id)) {
          const extended: ActiveClaimVersion = {
            ...existingByFp,
            version: existingByFp.version + 1,
            derived_from: [...existingByFp.derived_from, obs.id],
            version_at: new Date().toISOString(),
            operation_id: `op_${ulid()}`,
            actor_id: podActorId,
            supersedes: existingByFp.version,
          };
          if (commitCtx) commitReflectClaim(dataDir, extended, commitCtx, commitHooks);
          else appendClaimVersion(dataDir, extended);
          claimVersionsWritten++;
        }
        continue;
      }

      const opId = `op_${ulid()}`;
      const commitTs = new Date().toISOString();
      const record: ActiveClaimVersion = {
        claim_id: `claim_${ulid()}`,
        version: 1,
        state: 'active',
        content,
        claim_type: claimType,
        claim_role: claimRole,
        author: 'agent',
        epistemic_owner: 'agent',
        fingerprint: fp,
        confidence: 'low',
        epistemic_tag: 'inference',
        scope: obs.scope,
        derived_from: [obs.id],
        relations: [],
        created_at: commitTs,
        version_at: commitTs,
        operation_id: opId,
        actor_id: podActorId,
        tags: [],
        semantic: materializeSemantic(claim, entityInfo.type, commitTs, sensitive),
      };

      if (commitCtx) commitReflectClaim(dataDir, record, commitCtx, commitHooks);
      else appendClaimVersion(dataDir, record);
      claimVersionsWritten++;
      entityHints?.set(record.claim_id, {
        name: entityInfo.name,
        type: entityInfo.type,
        predicate: claim.predicate,
        sensitive,
      });
      created++;
    }

    markComplete(
      obs.id,
      obs.scope,
      allClaims.length === 0 ? 'no_claims' : 'claims_processed',
      {
        candidates_found: allClaims.length,
        claim_versions_written: claimVersionsWritten,
      },
    );
  }

  return {
    claimsCreated: created,
    llmAttempted,
    llmFailed,
    llmSkippedSensitive,
  };
}

function findByFingerprint(dataDir: string, fp: string): ActiveClaimVersion | null {
  const latest = new Map<string, { version: number; active: ActiveClaimVersion | null }>();
  for (const v of iterAllClaimVersions(dataDir)) {
    if (v.fingerprint !== fp) continue;
    const existing = latest.get(v.claim_id);
    if (existing && existing.version >= v.version) continue;
    latest.set(v.claim_id, {
      version: v.version,
      active: v.state === 'active' ? v as ActiveClaimVersion : null,
    });
  }
  for (const entry of latest.values()) {
    if (entry.active) return entry.active;
  }
  return null;
}

function findSemanticMatch(
  dataDir: string,
  store: ClaimStore,
  structuredFingerprint: string,
): ActiveClaimVersion | null {
  for (const claim of store.getActiveClaims()) {
    const candidate = computeStructuredClaimFingerprint(
      claim.subject_name,
      claim.predicate,
      claim.object,
      claim.scope,
      (claim.claim_type ?? 'hypothesis'),
    );
    if (candidate !== structuredFingerprint) continue;
    const latest = readLatestVersion(dataDir, claim.id);
    if (latest?.state === 'active') return latest;
  }
  return null;
}

export { handleCompile as handleReflect };
export type { CompileParams as ReflectParams, CompileHandlerResult as ReflectResult };
