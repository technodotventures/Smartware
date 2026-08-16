import type { ClaimRelation, RelationKind } from './types.js';
import type Database from 'better-sqlite3';

const SUPPRESSION_KINDS: ReadonlySet<RelationKind> = new Set(['supersedes', 'corrects']);
const evidenceSchemaCache = new WeakMap<object, boolean>();

function supportsEvidenceLifecycle(db: Database.Database): boolean {
  const cached = evidenceSchemaCache.get(db);
  if (cached !== undefined) return cached;
  try {
    const claimColumns = db.prepare('PRAGMA table_info(claims)').all() as Array<{ name: string }>;
    const observationColumns = db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    const supported = claimColumns.some(column => column.name === 'supporting_evidence')
      && observationColumns.some(column => column.name === 'effective_status');
    evidenceSchemaCache.set(db, supported);
    return supported;
  } catch {
    evidenceSchemaCache.set(db, false);
    return false;
  }
}

export function isEffectiveCurrent(claimId: string, db: Database.Database): boolean {
  const evidenceLifecycle = supportsEvidenceLifecycle(db);
  const claim = db.prepare(
    evidenceLifecycle
      ? 'SELECT state, supporting_evidence FROM claims WHERE id = ?'
      : 'SELECT state FROM claims WHERE id = ?',
  ).get(claimId) as { state?: string; supporting_evidence?: string } | undefined;
  if (!claim || claim.state === 'forgotten') return false;

  // A reflected claim remains effective only while at least one of its known
  // source observations is effective. Layer 0 tombstones/redactions are
  // canonical lifecycle events and must constrain every read interface, not
  // merely observation search.
  if (evidenceLifecycle) {
    let evidenceIds: string[] = [];
    try {
      const parsed = JSON.parse(claim.supporting_evidence ?? '[]') as unknown;
      if (Array.isArray(parsed)) {
        evidenceIds = parsed.filter((value): value is string => typeof value === 'string');
      }
    } catch {
      evidenceIds = [];
    }
    let matchedEvidence = 0;
    let acceptedEvidence = 0;
    const readEvidence = db.prepare('SELECT effective_status FROM observations WHERE id = ?');
    for (const evidenceId of evidenceIds) {
      const row = readEvidence.get(evidenceId) as { effective_status?: string } | undefined;
      if (!row) continue;
      matchedEvidence += 1;
      if (row.effective_status === 'accepted') acceptedEvidence += 1;
    }
    if (matchedEvidence > 0 && acceptedEvidence === 0) return false;
  }

  const suppressor = db.prepare(`
    SELECT r.source_claim_id FROM claim_relations r
    JOIN claims src ON src.id = r.source_claim_id
    WHERE r.target_claim_id = ?
      AND r.kind IN ('supersedes', 'corrects')
      AND r.invalid_at IS NULL
      AND src.state = 'active'
    LIMIT 1
  `).get(claimId) as { source_claim_id: string } | undefined;

  return !suppressor;
}

export function getEffectiveCurrentIds(db: Database.Database, scope?: string): string[] {
  const allActive = scope
    ? db.prepare("SELECT id FROM claims WHERE state = 'active' AND scope = ?").all(scope) as Array<{ id: string }>
    : db.prepare("SELECT id FROM claims WHERE state = 'active'").all() as Array<{ id: string }>;

  return allActive
    .map(row => row.id)
    .filter(id => isEffectiveCurrent(id, db));
}

export function checkAcyclicity(
  sourceId: string,
  targetId: string,
  kind: RelationKind,
  db: Database.Database,
): boolean {
  if (!SUPPRESSION_KINDS.has(kind)) return true;

  const visited = new Set<string>();
  const queue = [targetId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === sourceId) return false;
    if (visited.has(current)) continue;
    visited.add(current);

    const outbound = db.prepare(`
      SELECT target_claim_id FROM claim_relations
      WHERE source_claim_id = ?
        AND kind IN ('supersedes', 'corrects')
        AND invalid_at IS NULL
    `).all(current) as Array<{ target_claim_id: string }>;

    for (const row of outbound) {
      if (!visited.has(row.target_claim_id)) {
        queue.push(row.target_claim_id);
      }
    }
  }
  return true;
}

export function computeReleasedClaims(forgottenClaimId: string, db: Database.Database): string[] {
  const targets = db.prepare(`
    SELECT target_claim_id FROM claim_relations
    WHERE source_claim_id = ?
      AND kind IN ('supersedes', 'corrects')
      AND invalid_at IS NULL
  `).all(forgottenClaimId) as Array<{ target_claim_id: string }>;

  return targets
    .map(row => row.target_claim_id)
    .filter(id => isEffectiveCurrent(id, db));
}

export interface ReviveValidation {
  valid: string[];
  invalidated: string[];
}

export function revalidateOnRevive(
  claimId: string,
  db: Database.Database,
): ReviveValidation {
  const edges = db.prepare(`
    SELECT relation_id, target_claim_id, kind FROM claim_relations
    WHERE source_claim_id = ?
      AND kind IN ('supersedes', 'corrects')
      AND invalid_at IS NULL
  `).all(claimId) as Array<{ relation_id: string; target_claim_id: string; kind: string }>;

  const valid: string[] = [];
  const invalidated: string[] = [];

  for (const edge of edges) {
    if (checkAcyclicity(claimId, edge.target_claim_id, edge.kind as RelationKind, db)) {
      valid.push(edge.relation_id);
    } else {
      invalidated.push(edge.relation_id);
    }
  }

  return { valid, invalidated };
}
