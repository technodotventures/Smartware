// Layer 1 — Entity Registry with fuzzy matching and merge guardrails

import { ulid } from 'ulid';
import type { Entity } from './types.js';
import type { ClaimStore } from './store.js';
import type { SmartwareConfig } from '../config.js';

/** Telemetry collector for entity merge events during replay */
export interface EntityMergeEvent {
  from_name: string;
  to_name: string;
  to_entity_id: string;
  jaro_winkler_score: number;
  /** How the merge decision was made */
  resolution: 'auto' | 'borderline_accepted' | 'borderline_rejected' | 'exact';
}

let _mergeLog: EntityMergeEvent[] = [];
let _newEntityLog: string[] = [];

export function resetEntityTelemetry(): void {
  _mergeLog = [];
  _newEntityLog = [];
}

export function getEntityMergeLog(): EntityMergeEvent[] { return _mergeLog; }
export function getNewEntityLog(): string[] { return _newEntityLog; }

export interface EntityResolution {
  id: string;
  isNew: boolean;
  matchConfidence: number;
  /** If a fuzzy merge occurred, the canonical name of the entity merged into */
  mergedIntoName?: string;
}

/** Jaro-Winkler similarity (0-1) */
function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  const s1l = s1.length, s2l = s2.length;
  if (s1l === 0 || s2l === 0) return 0.0;

  const matchDist = Math.floor(Math.max(s1l, s2l) / 2) - 1;
  const s1Matches: boolean[] = new Array(s1l).fill(false);
  const s2Matches: boolean[] = new Array(s2l).fill(false);

  let matches = 0, transpositions = 0;
  for (let i = 0; i < s1l; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, s2l);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < s1l; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro = (matches / s1l + matches / s2l + (matches - transpositions / 2) / matches) / 3;
  const prefix = Math.min(4, [...s1].findIndex((c, i) => c !== s2[i]) === -1 ? Math.min(s1l, s2l) : [...s1].findIndex((c, i) => c !== s2[i]));
  return jaro + prefix * 0.1 * (1 - jaro);
}

function normalise(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ');
}

/** Default thresholds when entity_resolution config is not set */
const DEFAULT_AUTO_MERGE_THRESHOLD = 0.92;
const DEFAULT_BORDERLINE_THRESHOLD = 0.85;

export function resolveEntity(
  name: string,
  type: string,
  scope: string,
  store: ClaimStore,
  config?: SmartwareConfig,
): EntityResolution {
  const erConfig = config?.entity_resolution;
  const autoMerge = erConfig?.auto_merge_threshold ?? DEFAULT_AUTO_MERGE_THRESHOLD;
  const borderline = erConfig?.borderline_threshold ?? DEFAULT_BORDERLINE_THRESHOLD;

  // 1. Exact match on canonical_name
  const exact = store.findEntityByName(name, scope);
  if (exact) {
    // Upgrade entity type if current is 'concept' and new type is more specific
    maybeUpgradeType(exact, type, store);
    return { id: exact.id, isNew: false, matchConfidence: 1.0 };
  }

  // 2. Normalised exact match check (cross-type: allow matching regardless of type)
  const normName = normalise(name);
  const allEntities = store.getAllEntities(scope);

  for (const entity of allEntities) {
    const candidates = [entity.canonical_name, ...entity.aliases];
    for (const candidate of candidates) {
      if (normalise(candidate) === normName) {
        maybeUpgradeType(entity, type, store);
        _mergeLog.push({
          from_name: name,
          to_name: entity.canonical_name,
          to_entity_id: entity.id,
          jaro_winkler_score: 1.0,
          resolution: 'exact',
        });
        return { id: entity.id, isNew: false, matchConfidence: 1.0, mergedIntoName: entity.canonical_name };
      }
    }
  }

  // 3. Fuzzy match with three-zone logic (prefer same-type, but allow cross-type)
  let bestMatch: Entity | null = null;
  let bestScore = 0;

  for (const entity of allEntities) {
    const candidates = [entity.canonical_name, ...entity.aliases];
    for (const candidate of candidates) {
      const normCandidate = normalise(candidate);
      const score = jaroWinkler(normName, normCandidate);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entity;
      }
    }
  }

  if (bestMatch && bestScore >= autoMerge) {
    // Zone 1: HIGH confidence — auto-merge
    _mergeLog.push({
      from_name: name,
      to_name: bestMatch.canonical_name,
      to_entity_id: bestMatch.id,
      jaro_winkler_score: bestScore,
      resolution: 'auto',
    });
    maybeUpgradeType(bestMatch, type, store);
    return { id: bestMatch.id, isNew: false, matchConfidence: bestScore, mergedIntoName: bestMatch.canonical_name };
  }

  if (bestMatch && bestScore >= borderline) {
    // Zone 2: BORDERLINE — log the rejection, create new entity
    // (LLM disambiguation handled separately by caller when needed)
    _mergeLog.push({
      from_name: name,
      to_name: bestMatch.canonical_name,
      to_entity_id: bestMatch.id,
      jaro_winkler_score: bestScore,
      resolution: 'borderline_rejected',
    });
    // Fall through to create new entity
  }

  // Zone 3: LOW confidence or borderline-rejected — create new entity
  const newEntity: Entity = {
    id: `entity_${ulid()}`,
    canonical_name: name,
    aliases: [],
    type,
    scope,
    created_at: new Date().toISOString(),
  };
  store.insertEntity(newEntity);
  _newEntityLog.push(newEntity.id);
  return { id: newEntity.id, isNew: true, matchConfidence: 1.0 };
}

/**
 * Upgrade an entity's type from 'concept' to a more specific type.
 * Only upgrades if the existing type is the generic default and the
 * new type is something more specific.
 */
function maybeUpgradeType(entity: Entity, newType: string, store: ClaimStore): void {
  if (entity.type === 'concept' && newType !== 'concept') {
    entity.type = newType;
    store.updateEntityType(entity.id, newType);
  }
}
