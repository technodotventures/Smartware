// Tombstone backfill for legacy `retracted` claims (PR-4 / A3).
//
// Per Spec v1.5.4.2 + Schemas v0.1.2, every claim in state=forgotten must
// have a corresponding `wiki/tombstones/<claim-ulid>.md` containing a full
// snapshot of the prior active version. The substrate's pre-A3 schema used
// `status=retracted` to indicate forgotten and did NOT emit a tombstone
// file. This module backfills tombstones for those rows on Pod open.
//
// The backfill is idempotent: tombstones that already exist are skipped.
// Runs to completion before the substrate accepts writes, so it's safe to
// invoke from core.ts open().

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { confidenceToBucket, epistemicToTag, type Claim } from './types.js';
import type { ClaimStore } from './store.js';
import { computeFingerprint } from './fingerprint.js';
import { ensurePrivateDirectory, writePrivateFile } from '../storage/private-fs.js';

// A pre-A3 row carries no `operation_id`/`actor_id` (the columns were added by
// `migrateSchema` with no backfill for existing rows). Both are required by
// `schemas/v0.5.0/tombstone-frontmatter.schema.json` with a Crockford-base32 `OperationId` /
// `ActorId` pattern, so the backfill stamps deterministic placeholders: synthetic by
// construction, and distinguishable from any real operation id (see the tombstone body note).
const LEGACY_OPERATION_ID = 'op_000000000000000000000000A3';
const LEGACY_ACTOR_ID = 'substrate:legacy-migration';

export interface TombstoneBackfillReport {
  retracted_found: number;
  tombstones_written: number;
  tombstones_skipped_existing: number;
}

function claimUlid(claimId: string): string {
  return claimId.replace(/^claim_/, '');
}

function frontmatter(value: unknown): string {
  const lines: string[] = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

function buildTombstoneFromLegacyClaim(claim: Claim): string {
  const tombstoneId = `tomb_${claimUlid(claim.id)}`;
  const content = typeof claim.object.value === 'string'
    ? claim.object.value
    : JSON.stringify(claim.object.value);
  const claimType = claim.claim_type ?? 'finding';
  const versionAt = claim.version_at ?? claim.extraction.extracted_at;
  const operationId = claim.operation_id ?? LEGACY_OPERATION_ID;
  const actorId = claim.actor_id ?? LEGACY_ACTOR_ID;

  // Snapshot of the claim's prior **active** L1 version — the shape
  // `schemas/v0.5.0/tombstone-frontmatter.schema.json` requires, so a lost L1 version is
  // reconstructible from the tombstone alone (Conformance Test LC-04).
  const snapshot = {
    claim_id: claim.id,
    version: 1,
    // The schema pins the snapshot's `state` to 'active': the tombstone records the prior active
    // version, and the row's current forgetting is carried by the top-level `forgotten_*` fields.
    // `statusToState()` is therefore deliberately not used here (for a retracted row it projects
    // 'forgotten', which is the state the tombstone announces, not the snapshot's).
    state: 'active' as const,
    content,
    derived_from: claim.supporting_evidence,
    author: claim.author ?? 'agent',
    // Defaults to `author` at insert time (Q8 rule; `store.ts` insertClaim / rowToClaim).
    epistemic_owner: claim.epistemic_owner ?? claim.author ?? 'agent',
    // A legacy row has no stored fingerprint to carry, so it is recomputed from normalised
    // content + scope + claim_type — the same rule as the Q8 read-time backfill
    // (`migration.ts` → `backfillClaimVersion`) and the schema's own description of the field
    // ("stable identity over normalized content, scope, and claim_type"). It is also the only
    // form derivable from the snapshot's own fields, so reconstruction can re-derive it.
    fingerprint: computeFingerprint(content, claim.scope, claimType),
    // Numeric → bucket through the library's one mapping (types.ts → `confidenceToBucket`).
    confidence: confidenceToBucket(claim.confidence),
    epistemic_tag: epistemicToTag(claim.epistemic, claim.status),
    claim_type: claimType,
    claim_role: claim.claim_role ?? 'memory',
    scope: claim.scope,
    created_at: claim.created_at ?? claim.extraction.extracted_at,
    version_at: versionAt,
    operation_id: operationId,
    actor_id: actorId,
    tags: [],
    relations: claim.relations ?? [],
    // A mechanical demotion is non-content metadata, and every flow preserves it (§11
    // carry-forward; ADR-0003 → *Carry-forward across hand-built version records*). Without the
    // pointer, reconstructing a demoted duplicate from this tombstone would return it to recall.
    ...(claim.superseded_by != null
      ? { superseded_by: claim.superseded_by, superseded_at: claim.t_invalidated.value ?? versionAt }
      : {}),
  };

  const data = {
    tombstone_id: tombstoneId,
    claim_id: claim.id,
    forgotten_at: claim.t_invalidated.value ?? claim.extraction.extracted_at,
    forgotten_by: actorId,
    operation_id: operationId,
    reason: 'Backfilled tombstone for legacy retracted claim (PR-4 / A3 migration).',
    snapshot,
    blast_radius_summary: {
      pages_affected: 0,
      agent_blocks_marked: 0,
      user_pages_notified: 0,
    },
    affected_pages: [],
  };

  const body = [
    `# Tombstone: ${claim.subject_name} (${claim.predicate})`,
    '',
    'This tombstone was generated by the PR-4 (A3) migration for a claim',
    "that was previously marked `status: retracted` before the spec's binary",
    '`state: forgotten` and full-snapshot tombstone semantics were adopted.',
    '',
    'Migration notes:',
    '',
    `- Original status: \`${claim.status}\``,
    `- Backfill operation_id is a placeholder; the original FORGET operation`,
    "  was performed under the pre-A3 schema which didn't carry one.",
    '',
    '## Snapshot content',
    '',
    '```',
    typeof claim.object.value === 'string'
      ? claim.object.value
      : JSON.stringify(claim.object.value, null, 2),
    '```',
  ].join('\n');

  return frontmatter(data) + body + '\n';
}

export function backfillTombstones(
  store: ClaimStore,
  wikiDir: string,
): TombstoneBackfillReport {
  const report: TombstoneBackfillReport = {
    retracted_found: 0,
    tombstones_written: 0,
    tombstones_skipped_existing: 0,
  };

  // Legacy `retracted` rows are the only ones that need backfill. New
  // forget paths (PR-5+) emit tombstones inline.
  const retracted = store.getAllClaims().filter((c) => c.status === 'retracted');
  report.retracted_found = retracted.length;
  if (retracted.length === 0) return report;

  const tombstonesDir = join(wikiDir, 'tombstones');
  ensurePrivateDirectory(tombstonesDir);

  for (const claim of retracted) {
    const filename = `${claimUlid(claim.id)}.md`;
    const path = join(tombstonesDir, filename);
    if (existsSync(path)) {
      report.tombstones_skipped_existing += 1;
      continue;
    }
    writePrivateFile(path, buildTombstoneFromLegacyClaim(claim), 'utf-8');
    report.tombstones_written += 1;
  }

  return report;
}
