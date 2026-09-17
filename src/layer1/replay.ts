// Layer 1 — Event Replay: materialise claim store from Layer 0

import { createHash } from 'node:crypto';

import type { Observation } from '../layer0/types.js';
import type { Layer0Index } from '../layer0/index.js';
import { readAll } from '../layer0/log.js';
import type { ClaimStore } from './store.js';
import type { Claim, ClaimTimeValue } from './types.js';
import { compatibilityValidity, inferredTime, knownTime, nullTime } from './types.js';
import type { SmartwareConfig } from '../config.js';
import { resolveEntity } from './entities.js';
import { computeConfidence } from './confidence.js';
import { admitClaim } from './conflicts.js';
import { removeEvidenceFromClaims } from './corroboration.js';

const COMPILER_VERSION = '0.6.1';
const YIELD_EVERY = 50;

function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function deterministicClaimId(extractionEventId: string, index: number): string {
  const digest = createHash('sha256').update(`${extractionEventId}:${index}`).digest('hex');
  return `claim_${digest.slice(0, 26)}`;
}

function normaliseTimeValue(raw: unknown, fallback: ClaimTimeValue): ClaimTimeValue {
  if (typeof raw === 'string') {
    return knownTime(raw);
  }
  if (raw && typeof raw === 'object') {
    const candidate = raw as Record<string, unknown>;
    const state = candidate['state'];
    if (state === 'known' || state === 'inferred' || state === 'null') {
      return {
        value: typeof candidate['value'] === 'string' ? candidate['value'] : null,
        state,
        basis: typeof candidate['basis'] === 'string' ? candidate['basis'] : undefined,
      };
    }
  }
  return fallback;
}

function normaliseCorrectionReason(reason: string | undefined): 'changed' | 'wrong' | 'extraction_error' | 'duplicate' {
  return reason === 'changed' || reason === 'wrong' || reason === 'extraction_error' || reason === 'duplicate'
    ? reason
    : 'changed';
}

export async function replayAll(evidenceDir: string, layer0: Layer0Index, store: ClaimStore, config?: SmartwareConfig): Promise<void> {
  store.deleteAllClaims();

  let lastSeq = 0;
  let processed = 0;
  for (const obs of readAll(evidenceDir)) {
    processEvent(obs, store, layer0, config);
    lastSeq = obs.integrity.sequence;
    if (++processed % YIELD_EVERY === 0) await yieldEventLoop();
  }
  store.setLastReplayedSequence(lastSeq);
}

export interface ReplayCatchUpResult {
  /** Events replayed by this call (0 when the log tail held nothing new). */
  processed: number;
  /**
   * Scopes whose claim rows this catch-up wrote, deduplicated.
   *
   * The catch-up is a *claim-row mutation*: `handleClaimExtracted`,
   * `handleCorrection` and `handleRetraction` write rows through the store and
   * touch no search lane. The claim-FTS lane is rebuilt only by
   * `syncSearchFromClaims`, so a caller that owns a lane must re-sync these
   * scopes or the live process answers without the claims this catch-up just
   * materialised while every restart serves them (measured, kanban t_a6bf30a8).
   * Layer 1 stays lane-free on purpose: it reports what it touched, the layer
   * that owns the lane decides what to do about it.
   */
  touchedScopes: string[];
}

export async function replayCatchUp(
  evidenceDir: string,
  store: ClaimStore,
  layer0?: Layer0Index,
  config?: SmartwareConfig,
  observations?: Observation[],
  /**
   * §11.2b: one-query status snapshot from the caller (compile gather builds
   * it) — replaces 50k per-obs getEffectiveStatus SELECTs in reconcile.
   */
  statusMap?: Map<string, import('../layer0/types.js').EffectiveStatus | null>,
): Promise<ReplayCatchUpResult> {
  const lastSeq = store.getLastReplayedSequence();
  let newLastSeq = lastSeq;
  let processed = 0;
  const touchedScopes = new Set<string>();

  // §11.2b re-scope: reusing the caller's parsed evidence list avoids a second
  // full JSONL read of a 48MB log (measured ~8% of the 50k pipeline).
  const allObservations = observations ?? [...readAll(evidenceDir)];
  for (const obs of allObservations) {
    if (obs.integrity.sequence <= lastSeq) continue;
    processEvent(obs, store, layer0, config, statusMap, touchedScopes);
    newLastSeq = Math.max(newLastSeq, obs.integrity.sequence);
    if (++processed % YIELD_EVERY === 0) await yieldEventLoop();
  }

  if (newLastSeq > lastSeq) {
    store.setLastReplayedSequence(newLastSeq);
  }

  return { processed, touchedScopes: [...touchedScopes] };
}

function processEvent(obs: Observation, store: ClaimStore, layer0?: Layer0Index, config?: SmartwareConfig, statusMap?: Map<string, import('../layer0/types.js').EffectiveStatus | null>, touchedScopes?: Set<string>): void {
  if (layer0) {
    const effective = statusMap
      ? (statusMap.get(obs.id) ?? obs.status)
      : layer0.getEffectiveStatus(obs.id);
    if (effective !== null && effective !== 'accepted') return;
  }

  switch (obs.type) {
    case 'claim_extracted':
      handleClaimExtracted(obs, store, config, touchedScopes);
      break;
    case 'correction':
      handleCorrection(obs, store, touchedScopes);
      break;
    case 'tombstone':
    case 'redaction':
      handleRetraction(obs, store, touchedScopes);
      break;
    default:
      break;
  }
}

function handleClaimExtracted(obs: Observation, store: ClaimStore, config?: SmartwareConfig, touchedScopes?: Set<string>): void {
  const body = obs.content.body as Record<string, unknown>;
  const rawClaims = (obs.claims ?? (Array.isArray(body['claims']) ? body['claims'] : [])) as Array<Record<string, unknown>>;
  const parentObsId = obs.provenance.parent_ids[0] ?? obs.id;
  const sourceObservedAt = typeof body['source_obs_observed_at'] === 'string' ? body['source_obs_observed_at'] : parentObsId === obs.id ? obs.source.observed_at : obs.source.observed_at;
  const sourceCapturedAt = typeof body['source_obs_captured_at'] === 'string' ? body['source_obs_captured_at'] : obs.source.captured_at;

  for (let index = 0; index < rawClaims.length; index += 1) {
    const raw = rawClaims[index]!;
    try {
      const subjectName = (raw['subject_name'] as string) || 'Unknown';
      const subjectType = (raw['subject_type'] as string) || inferTypeFromClaim(subjectName, raw);
      const claimScope = (raw['scope'] as string) || obs.scope;
      const persistedSubjectId = raw['subject_id'] as string | undefined;
      const subjectId = persistedSubjectId
        ?? resolveEntity(subjectName, subjectType, claimScope, store, config).id;

      const rawValidity = (raw['validity'] as { from?: string; to?: string | null } | undefined) ?? {};
      const tIngested = knownTime(sourceCapturedAt);
      const tValidFrom = normaliseTimeValue(
        raw['t_valid_from'],
        rawValidity.from ? inferredTime(rawValidity.from, 'legacy_validity_from') : nullTime(),
      );
      const tValidTo = normaliseTimeValue(
        raw['t_valid_to'],
        rawValidity.to ? inferredTime(rawValidity.to, 'legacy_validity_to') : nullTime(),
      );
      const validity = compatibilityValidity(
        tValidFrom.state === 'null' ? inferredTime(sourceObservedAt, 'source_observed_at') : tValidFrom,
        tValidTo,
        tIngested,
      );

      const extraction = raw['extraction'] as {
        method: 'deterministic' | 'llm' | 'user_input';
        model: string | null;
        compiler_version: string;
        prompt_hash: string | null;
      } | undefined;

      const draftClaim: Claim = {
        id: deterministicClaimId(obs.id, index),
        subject_id: subjectId,
        subject_name: subjectName,
        predicate: raw['predicate'] as string,
        object: raw['object'] as Claim['object'],
        scope: claimScope,
        validity,
        t_ingested: tIngested,
        t_invalidated: nullTime(),
        t_valid_from: tValidFrom,
        t_valid_to: tValidTo,
        source_event_id: parentObsId,
        extraction_event_id: obs.id,
        supporting_evidence: [parentObsId],
        extraction: {
          method: extraction?.method ?? 'llm',
          model: extraction?.model ?? null,
          compiler_version: extraction?.compiler_version ?? COMPILER_VERSION,
          prompt_hash: extraction?.prompt_hash ?? null,
          extracted_at: obs.source.captured_at,
        },
        status: 'active',
        epistemic: (raw['epistemic'] as Claim['epistemic']) ?? 'inferred',
        confidence: 0,
        sensitive: !!raw['sensitive'] || obs.policy.sensitive,
        superseded_by: null,
        contested_by: [],
      };

      // One policy for every write path. Extraction replay and host-side claim
      // persistence both go through admitClaim, so replay cannot drift from the
      // admission semantics hosts get (corroborate / contest / supersede).
      admitClaim(draftClaim, store);
      // The row is written; the scope now needs its claim-FTS lane re-synced.
      touchedScopes?.add(claimScope);
    } catch (error) {
      console.warn(`[replay] Skipped malformed claim in event ${obs.id}:`, error);
    }
  }
}

function buildCorrectedClaim(
  original: Claim,
  correctedData: Record<string, unknown> | undefined,
  obs: Observation,
  defaultValidFrom: ClaimTimeValue,
): Claim {
  const rawValidity = (correctedData?.['validity'] as { from?: string; to?: string | null } | undefined) ?? {};
  const tIngested = knownTime(obs.source.captured_at);
  const tValidFrom = normaliseTimeValue(
    correctedData?.['t_valid_from'],
    rawValidity.from ? inferredTime(rawValidity.from, 'legacy_validity_from') : defaultValidFrom,
  );
  const tValidTo = normaliseTimeValue(
    correctedData?.['t_valid_to'],
    rawValidity.to ? inferredTime(rawValidity.to, 'legacy_validity_to') : nullTime(),
  );

  return {
    ...original,
    id: deterministicClaimId(obs.id, 0),
    predicate: (correctedData?.['predicate'] as string) ?? original.predicate,
    object: (correctedData?.['object'] as Claim['object']) ?? original.object,
    validity: compatibilityValidity(tValidFrom, tValidTo, tIngested),
    t_ingested: tIngested,
    t_invalidated: nullTime(),
    t_valid_from: tValidFrom,
    t_valid_to: tValidTo,
    source_event_id: obs.id,
    extraction_event_id: obs.id,
    supporting_evidence: [...new Set([obs.id, ...original.supporting_evidence])],
    extraction: {
      method: 'user_input',
      model: null,
      compiler_version: COMPILER_VERSION,
      prompt_hash: null,
      extracted_at: obs.source.captured_at,
    },
    status: 'active',
    epistemic: 'user_confirmed',
    confidence: 1,
    superseded_by: null,
    contested_by: [],
  };
}

function handleCorrection(obs: Observation, store: ClaimStore, touchedScopes?: Set<string>): void {
  const body = obs.content.body as Record<string, unknown>;
  const targetClaimId = body['target_claim_id'] as string | undefined;
  const correctedData = body['corrected_claim'] as Record<string, unknown> | undefined;
  const reason = normaliseCorrectionReason(body['reason'] as string | undefined);

  if (!targetClaimId) return;

  const original = store.getClaim(targetClaimId);
  if (!original) return;
  // Every branch that writes below rewrites the target claim's row (and, except
  // `duplicate`, a replacement row in the same scope), so the scope is touched
  // either way; an invalid `duplicate` payload returns before any write and the
  // extra re-sync it causes is semantics-neutral (the lane is made equal to the
  // store's indexable set).
  touchedScopes?.add(original.scope);

  const now = knownTime(obs.source.captured_at);

  if (reason === 'duplicate') {
    const mergeIntoClaimId = body['merge_into_claim_id'] as string | undefined;
    if (!mergeIntoClaimId) return;
    const canonical = store.getClaim(mergeIntoClaimId);
    if (!canonical) return;
    touchedScopes?.add(canonical.scope);

    canonical.supporting_evidence = [...new Set([...canonical.supporting_evidence, ...original.supporting_evidence])];
    canonical.confidence = computeConfidence(canonical);
    store.insertClaim(canonical);

    original.status = 'superseded';
    original.superseded_by = canonical.id;
    original.t_invalidated = now;
    original.validity = compatibilityValidity(original.t_valid_from, original.t_valid_to, original.t_ingested);
    store.insertClaim(original);
    return;
  }

  if (reason === 'changed') {
    const changeTime = normaliseTimeValue(body['change_time'], now);
    const corrected = buildCorrectedClaim(original, correctedData, obs, changeTime);
    original.status = 'superseded';
    original.superseded_by = corrected.id;
    original.t_valid_to = changeTime;
    original.validity = compatibilityValidity(original.t_valid_from, original.t_valid_to, original.t_ingested);
    store.insertClaim(original);
    store.insertClaim(corrected);
    return;
  }

  if (reason === 'wrong') {
    original.status = 'retracted';
    original.t_invalidated = now;
    original.t_valid_to = original.t_valid_from.state === 'null' ? now : original.t_valid_from;
    original.validity = compatibilityValidity(original.t_valid_from, original.t_valid_to, original.t_ingested);
    store.insertClaim(original);

    if (correctedData) {
      const corrected = buildCorrectedClaim(original, correctedData, obs, now);
      store.insertClaim(corrected);
    }
    return;
  }

  // extraction_error
  original.status = 'retracted';
  original.t_invalidated = now;
  original.validity = compatibilityValidity(original.t_valid_from, original.t_valid_to, original.t_ingested);
  store.insertClaim(original);

  if (correctedData) {
    const corrected = buildCorrectedClaim(original, correctedData, obs, original.t_valid_from.state === 'null' ? now : original.t_valid_from);
    store.insertClaim(corrected);
  }
}

function handleRetraction(obs: Observation, store: ClaimStore, touchedScopes?: Set<string>): void {
  const body = obs.content.body as Record<string, unknown>;
  const targetId = body['target_id'] as string | undefined;
  const targetKind = (body['target_kind'] as string | undefined) ?? 'observation';
  if (!targetId) return;

  if (targetKind === 'claim') {
    if (obs.type === 'redaction') {
      const target = store.getClaim(targetId);
      store.redactClaim(targetId);
      if (target) touchedScopes?.add(target.scope);
      return;
    }
    if (store.getClaim(targetId)?.status === 'retracted') return;
    const scope = store.getClaim(targetId)?.scope;
    store.updateClaimStatus(targetId, 'retracted', undefined, knownTime(obs.source.captured_at));
    if (scope) touchedScopes?.add(scope);
    return;
  }

  removeEvidenceFromClaims(targetId, store, knownTime(obs.source.captured_at), touchedScopes);
}

function inferTypeFromClaim(subjectName: string, raw: Record<string, unknown>): string {
  const name = subjectName.toLowerCase();
  const predicate = (raw['predicate'] as string) ?? '';
  const obj = raw['object'] as { type?: string; value?: unknown } | undefined;
  const objValue = typeof obj?.value === 'string' ? obj.value.toLowerCase() : '';

  if (/\.(?:ai|io|dev|com|app)$/i.test(subjectName)) return 'tool';
  if (/\b(?:api|sdk|framework|server|runtime|engine|registry|bus|ledger)\b/i.test(name)) return 'tool';
  if (/\b(?:pricing|price|cost|fee|budget|cap)\b/i.test(name)) return 'concept';
  if (/\b(?:direction|decision|strategy|approach)\b/i.test(name)) return 'decision';
  if (/\b(?:orchestrator|pipeline|system|stack|extract)\b/i.test(name)) return 'tool';

  if (predicate === 'decided_on') return 'decision';
  if (predicate === 'status_is' && /\b(rejected|approved|viable|deployed|chosen)\b/.test(objValue)) return 'tool';

  return 'concept';
}
