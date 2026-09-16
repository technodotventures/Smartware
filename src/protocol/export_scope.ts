// Protocol — EXPORT.SCOPE handler (spec §10c.4, G3.1).
//
// Owner-only MCP tool `smartware_export_scope { actor_id, scope, operation_id? }`
// → { export_id (exp_<ulid>), path, counts, manifest }.
//
// Binding semantics (spec §10c.4):
//   - ONE scope = exactly ONE boundary: every content record in the package
//     has scope === target. The only cross-scope records are (a) ops entries
//     in the operation closure and (b) forget.scope audit markers for the
//     target (they live in the POD scope by design and reference the scope id).
//   - Content = canonical records only. Derived indexes (FTS, vector, pages,
//     ops-index SQLite, compile queue) are regenerable and excluded.
//   - Post-erasure export of an erased scope: empty package + deletion
//     certificate reference (marker obs id + operation_id) — the erasure
//     proof is portable. (The raw evidence-log records of an erased scope
//     stay on disk for audit, but their effective status is `erased`; they
//     must NOT be exported — exporting them would resurrect deleted data.)
//   - Post-offboarding export: full history. Forgotten/tombstoned claim
//     versions are canonical records and MUST be included.
//   - Zero-touch: export NEVER writes to evidence/claims/operations logs,
//     config, or any derived index. The only writes are inside
//     <data_dir>/exports/<export_id>/ (its own artifact surface).
//   - Idempotency: an operation_id retry returns the same export_id (derived
//     deterministically from operation_id), the same package, and a stable
//     manifest. A reused operation_id with a different payload → conflict.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';

import { ProtocolError, requireOwner } from '../auth/middleware.js';
import type { SmartwareConfig } from '../config.js';
import type { Actor, Observation } from '../layer0/types.js';
import { readAll } from '../layer0/log.js';
import { iterAllClaimVersions } from '../layer1/jsonl.js';
import type { ClaimStore } from '../layer1/store.js';
import type { Entity } from '../layer1/types.js';
import { readAllOpLogEntries } from '../ops_log/log.js';
import { OPERATION_ID_PATTERN } from '../ops_log/types.js';
import { ensurePrivateDirectory, writePrivateFile } from '../storage/private-fs.js';

/** Canonical export id shape: exp_<ULID> (Crockford base32, 26 chars). */
export const EXPORT_ID_PATTERN = /^exp_[0-9A-HJKMNP-TV-Z]{26}$/;

export const EXPORT_PROTOCOL_VERSION = 'v0.5.0';

/**
 * The schema set that covers the bytes this package ships — the v0.5.0 wire
 * contract's records PLUS the L0 evidence record schema, which the v0.5.0 set
 * does not describe (`observation.schema.json` is the observation object on the
 * wire; it rejects the record envelope by construction — ADR-0013). The v0.5.1
 * set is the v0.5.0 set plus `observation-record.schema.json`, additively: no
 * v0.5.0 schema byte moves, and this manifest names the set that actually
 * covers `observations.jsonl` / `evidence.jsonl` (kanban t_f1157ed4).
 */
export const EXPORT_SCHEMA_VERSION = 'v0.5.1';

/**
 * The `$id` of the L0 evidence record schema — the validator for the record
 * bytes in `observations.jsonl` and `evidence.jsonl`. Named explicitly in the
 * manifest so a consumer does not have to infer it from the set version.
 */
export const EXPORT_RECORD_SCHEMA =
  'https://smartware.dev/schemas/v0.5.1/observation-record.schema.json';

const CONTENT_FILES = [
  'observations',
  'claims',
  'evidence',
  'operations',
  'entities',
] as const;

export type ExportContentFile = typeof CONTENT_FILES[number];

export interface ExportScopeParams {
  actor: Actor;
  /** The scope id, e.g. `client:acme#1`. */
  scope: string;
  /** Idempotency key. Retry returns the same export_id. */
  operation_id?: string;
}

export interface ExportCounts {
  observations: number;
  claims: number;
  evidence: number;
  operations: number;
  entities: number;
}

export interface DeletionCertificate {
  /** forget.scope erasure operation_id (null only if erasure ran without one). */
  operation_id: string | null;
  /** The L0 audit marker observation — this is the deletion proof record. */
  audit_observation_id: string;
}

export interface ExportManifest {
  protocol: string;
  schemas: string;
  /**
   * `$id` of the schema that validates `observations.jsonl` / `evidence.jsonl`.
   * Named explicitly because those files carry the L0 record, which the wire
   * schema set does not describe (ADR-0013).
   */
  record_schema: string;
  export_id: string;
  scope: string;
  exported_at: string;
  actor_id: string;
  /** Assertion per spec §10c.4 — content records never leave the boundary. */
  scope_exclusive: boolean;
  counts: ExportCounts;
  /** sha256 hex per package file + `aggregate` (concat of file digests). */
  sha256: Record<string, string>;
  /** Present only for a scope that was erased (deletion certificate). */
  deletion_certificate: DeletionCertificate | null;
}

export interface ExportScopeResult {
  export_id: string;
  /** Absolute path to the package directory. */
  path: string;
  counts: ExportCounts;
  manifest: ExportManifest;
}

export interface ExportScopeDeps {
  evidenceDir: string;
  dataDir: string;
  opsDir: string;
  store: ClaimStore;
  config: SmartwareConfig;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Deterministic export id for an operation_id retry: exp_ + 26 characters
 * of the operation id's SHA-256 in the ULID/Crockford base32 alphabet.
 * Same operation_id ⇒ same export_id ⇒ same package path ⇒ stable manifest.
 */
export function exportIdForOperationId(operationId: string): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const digest = createHash('sha256').update(operationId, 'utf8').digest();
  let id = '';
  for (let i = 0; i < 26; i += 1) id += ALPHABET[digest[i]! & 31];
  return `exp_${id}`;
}

/**
 * Export one scope (spec §10c.4). Owner-only; read-only to pod data.
 *
 * Scans are full scans by construction (readAll / iterAllClaimVersions /
 * readAllOpLogEntries have no scope filter) but nothing below ever mutates
 * the pod: records are filtered in code and written only under exports/.
 */
export async function handleExportScope(
  params: ExportScopeParams,
  deps: ExportScopeDeps,
): Promise<ExportScopeResult> {
  const { evidenceDir, dataDir, opsDir, store, config } = deps;

  if (!params.scope || params.scope.length === 0) {
    throw new ProtocolError('invalid_parameter', 'A scope is required');
  }
  if (params.operation_id && !OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }
  requireOwner(params.actor.id, config);

  // ── Idempotent replay: same operation_id ⇒ same export_id. If the package
  //    already exists, return it untouched (stable manifest); if it is
  //    missing (crash mid-export), regenerate into the same path.
  const exportId = params.operation_id
    ? exportIdForOperationId(params.operation_id)
    : `exp_${ulid()}`;
  const exportsRoot = join(dataDir, 'exports');
  const packageDir = join(exportsRoot, exportId);
  const manifestPath = join(packageDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExportManifest;
    if (manifest.scope !== params.scope || manifest.actor_id !== params.actor.id) {
      throw new ProtocolError(
        'conflict',
        `operation_id '${params.operation_id}' was already used for a different export`,
      );
    }
    return { export_id: exportId, path: packageDir, counts: manifest.counts, manifest };
  }

  // ── One pass over the evidence log: observations, evidence closure,
  //    and scope-level mutation markers (forget.scope audit markers).
  const allObservations = [...readAll(evidenceDir)];
  const byId = new Map<string, Observation>();
  const eraseMarkers = new Map<string, Observation>();
  for (const obs of allObservations) {
    byId.set(obs.id, obs);
    if (obs.type !== 'erasure') continue;
    const body = (typeof obs.content.body === 'object' && obs.content.body) as Record<string, unknown> | null;
    if (body?.target_kind !== 'scope' || body.scope !== params.scope) continue;
    const reason = body.reason === 'offboarding' ? 'offboarding' : 'erasure';
    if (reason === 'erasure') {
      const existing = eraseMarkers.get(params.scope);
      if (!existing || obs.integrity.sequence > existing.integrity.sequence) {
        eraseMarkers.set(params.scope, obs);
      }
    }
  }
  const eraseMarker = eraseMarkers.get(params.scope) ?? null;

  // ── Deletion certificate (post-erasure reference): marker obs id + the
  //    forget.scope operation that wrote it (ops entry or marker field).
  let deletionCertificate: DeletionCertificate | null = null;
  if (eraseMarker) {
    let operationId: string | null = eraseMarker.operation_id ?? null;
    if (!operationId) {
      for (const entry of readAllOpLogEntries(opsDir)) {
        if (entry.op === 'forget.scope'
          && entry.details?.['audit_observation_id'] === eraseMarker.id) {
          operationId = entry.operation_id;
          break;
        }
      }
    }
    deletionCertificate = {
      operation_id: operationId,
      audit_observation_id: eraseMarker.id,
    };
  }

  // ── Content collections (canonical records; filters in code).
  //    Erased scope ⇒ empty package: raw records still exist in the evidence
  //    log, but their effective status is 'erased' and they must not be
  //    exported (exporting them would resurrect a DSR-erased dataset).
  const observationRecords = eraseMarker
    ? []
    : allObservations.filter(obs => obs.scope === params.scope);

  const claimRecords = [
    ...iterAllClaimVersions(dataDir),
  ].filter(record => record.scope === params.scope);

  // Evidence closure: every observation referenced by the exported claims
  // (ClaimVersionRecord.derived_from == supporting_evidence id list). The
  // ONE-boundary rule applies: an out-of-scope reference belongs to the other
  // scope's export and is never pulled in.
  const closureIds = new Set<string>();
  for (const record of claimRecords) {
    for (const id of record.derived_from) closureIds.add(id);
  }
  const evidenceRecords = eraseMarker
    ? []
    : allObservations.filter(obs => closureIds.has(obs.id) && obs.scope === params.scope);

  // Entity rows (derived projection — see G2 finding): included for
  // portability but explicitly marked non-canonical; an importer MUST
  // re-resolve entity identity.
  const entityRecords: Array<Entity & { non_canonical: true }> = eraseMarker
    ? []
    : store.getAllEntities(params.scope).map(entity => ({ ...entity, non_canonical: true }));

  // Operation closure: every ops entry referenced by the exported records +
  // every forget.scope audit entry for the target (cross-scope by design).
  const referencedOpIds = new Set<string>();
  for (const obs of observationRecords) if (obs.operation_id) referencedOpIds.add(obs.operation_id);
  for (const record of claimRecords) referencedOpIds.add(record.operation_id);
  for (const obs of evidenceRecords) if (obs.operation_id) referencedOpIds.add(obs.operation_id);
  const operationRecords = [...readAllOpLogEntries(opsDir)].filter(entry =>
    referencedOpIds.has(entry.operation_id)
    || (entry.op === 'forget.scope' && entry.details?.['scope'] === params.scope));

  // ── Package writing: observations/claims/evidence/operations/entities
  //    then manifest.json LAST (the manifest is the package's completion
  //    proof — a dir without a manifest is an incomplete export).
  ensurePrivateDirectory(exportsRoot);
  ensurePrivateDirectory(packageDir);

  const fileRecords: Record<ExportContentFile, unknown[]> = {
    observations: observationRecords,
    claims: claimRecords,
    evidence: evidenceRecords,
    operations: operationRecords,
    entities: entityRecords,
  };

  const digests: Record<string, string> = {};
  const counts: ExportCounts = {
    observations: observationRecords.length,
    claims: claimRecords.length,
    evidence: evidenceRecords.length,
    operations: operationRecords.length,
    entities: entityRecords.length,
  };
  for (const name of CONTENT_FILES) {
    const content = fileRecords[name].map(record => JSON.stringify(record)).join('\n');
    writePrivateFile(join(packageDir, `${name}.jsonl`), content.length > 0 ? `${content}\n` : '');
    digests[name] = sha256Hex(content.length > 0 ? `${content}\n` : '');
  }
  const aggregate = sha256Hex(CONTENT_FILES.map(name => digests[name]!).join(''));

  const manifest: ExportManifest = {
    protocol: EXPORT_PROTOCOL_VERSION,
    schemas: EXPORT_SCHEMA_VERSION,
    record_schema: EXPORT_RECORD_SCHEMA,
    export_id: exportId,
    scope: params.scope,
    exported_at: new Date().toISOString(),
    actor_id: params.actor.id,
    scope_exclusive: true,
    counts,
    sha256: { ...digests, aggregate },
    deletion_certificate: deletionCertificate,
  };
  writePrivateFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { export_id: exportId, path: packageDir, counts, manifest };
}
