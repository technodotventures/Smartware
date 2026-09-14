// Protocol — RESTORE.SCOPE: the return path for an EXPORT.SCOPE package.
//
// An export nobody can read back is a dead end: the package is the portable record of one
// scope, so the substrate must be able to write it back. This handler restores exactly one
// scope into a brain whose scope is empty, from the canonical records alone (derived indexes
// are rebuilt from them at the next open).
//
// Binding semantics:
//   - Owner-only, like EXPORT.
//   - One scope = one boundary: only records whose `scope` equals the package's scope are
//     imported; anything else in the package is refused (package_corrupt), never silently
//     written into another client's memory.
//   - Integrity first: every content file is hashed and compared with the manifest — a
//     tampered package imports nothing.
//   - No merge: the target scope must be empty. A second restore of the SAME package is
//     idempotent (the receipt under `<data_dir>/imports/` is the marker), but restoring a
//     different package into a non-empty scope is a conflict.
//   - Post-erasure packages carry a deletion certificate and no content: they restore as an
//     empty package (the certificate travels with the manifest; nothing is resurrected).
//   - Entities are re-resolved by the receiving brain — the package marks them non-canonical
//     for exactly that reason.
//
// Receipt: `<data_dir>/imports/<export_id>.json` — operational state (like the ingestion
// ledger), not a canonical surface. Its loss means a retry re-imports into a now-non-empty
// scope and is refused as a conflict; it is never a lost write.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ProtocolError, requireOwner } from '../auth/middleware.js';
import type { SmartwareConfig } from '../config.js';
import { appendObservationAt, readAll } from '../layer0/log.js';
import type { Actor, Observation } from '../layer0/types.js';
import { appendClaimVersions, iterAllClaimVersions, type ClaimVersionRecord } from '../layer1/jsonl.js';
import type { ClaimStore } from '../layer1/store.js';
import { appendOpLogEntries } from '../ops_log/log.js';
import type { OpLogEntry } from '../ops_log/types.js';
import { OPERATION_ID_PATTERN } from '../ops_log/types.js';
import { ensurePrivateDirectory, writePrivateFile } from '../storage/private-fs.js';
import {
  EXPORT_ID_PATTERN,
  type ExportCounts,
  type ExportManifest,
} from './export_scope.js';

const CONTENT_FILES = ['observations', 'claims', 'evidence', 'operations', 'entities'] as const;
type ContentFileName = typeof CONTENT_FILES[number];

const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

export interface RestoreScopeParams {
  actor: Actor;
  /** Directory of an EXPORT.SCOPE package (must contain manifest.json). */
  package_dir: string;
  /** Idempotency key for the restore operation itself. */
  operation_id?: string;
}

export interface RestoreReceipt {
  export_id: string;
  scope: string;
  operation_id: string | null;
  restored_at: string;
  restored_by: string;
  counts: ExportCounts;
  package_aggregate: string;
}

export interface RestoreScopeResult {
  status: 'restored' | 'already_restored' | 'empty_package';
  export_id: string;
  scope: string;
  path: string;
  counts: ExportCounts;
  manifest: ExportManifest;
  receipt_path: string;
}

export interface RestoreScopeDeps {
  evidenceDir: string;
  dataDir: string;
  opsDir: string;
  store: ClaimStore;
  config: SmartwareConfig;
}

function parsePackageFile(packageDir: string, name: ContentFileName): { text: string; records: unknown[] } {
  const file = join(packageDir, `${name}.jsonl`);
  if (!existsSync(file)) {
    throw new ProtocolError('invalid_package', `Package is missing ${name}.jsonl`);
  }
  const text = readFileSync(file, 'utf8');
  const records: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new ProtocolError('package_corrupt', `${name}.jsonl contains a line that is not JSON`);
    }
  }
  return { text, records };
}

/** Restore one EXPORT.SCOPE package. See the module header for the binding semantics. */
export async function handleRestoreScope(
  params: RestoreScopeParams,
  deps: RestoreScopeDeps,
): Promise<RestoreScopeResult> {
  const { evidenceDir, dataDir, opsDir } = deps;

  if (!params.package_dir) {
    throw new ProtocolError('invalid_parameter', 'A package directory is required');
  }
  if (params.operation_id && !OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }
  requireOwner(params.actor.id, deps.config);

  const packageDir = resolve(params.package_dir);
  const manifestPath = join(packageDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new ProtocolError('invalid_package', `No manifest.json under '${packageDir}'`);
  }
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExportManifest;
  } catch {
    throw new ProtocolError('invalid_package', 'manifest.json is not valid JSON');
  }
  if (!EXPORT_ID_PATTERN.test(manifest.export_id ?? '')) {
    throw new ProtocolError('invalid_package', `manifest.export_id '${manifest.export_id}' is not a package id`);
  }
  if (!manifest.scope || typeof manifest.scope !== 'string') {
    throw new ProtocolError('invalid_package', 'manifest.scope is required');
  }
  if (manifest.scope_exclusive !== true) {
    throw new ProtocolError('invalid_package', 'manifest does not assert scope_exclusive: true');
  }

  // ── Integrity: content must match the manifest, or nothing is imported.
  const files = {} as Record<ContentFileName, { text: string; records: unknown[] }>;
  const digests: Record<string, string> = {};
  for (const name of CONTENT_FILES) {
    const parsed = parsePackageFile(packageDir, name);
    files[name] = parsed;
    digests[name] = sha256Hex(parsed.text);
  }
  const aggregate = sha256Hex(CONTENT_FILES.map((name) => digests[name]!).join(''));
  if (manifest.sha256?.aggregate !== aggregate) {
    throw new ProtocolError('package_corrupt', 'Package content does not match the manifest checksum');
  }
  if (CONTENT_FILES.some((name) => manifest.sha256?.[name] !== digests[name])) {
    throw new ProtocolError('package_corrupt', 'A package file does not match its manifest checksum');
  }

  // ── Counts must agree with the content (a manifest that lies about its own package is not
  //    a package this brain should trust).
  const counts: ExportCounts = {
    observations: files.observations.records.length,
    claims: files.claims.records.length,
    evidence: files.evidence.records.length,
    operations: files.operations.records.length,
    entities: files.entities.records.length,
  };
  for (const name of CONTENT_FILES) {
    const declared = manifest.counts?.[name];
    if (declared !== counts[name]) {
      throw new ProtocolError(
        'package_corrupt',
        `Manifest declares ${name}=${declared} but the package contains ${counts[name]}`,
      );
    }
  }

  // ── One scope = one boundary: every imported record carries the package's scope.
  const scope = manifest.scope;
  const observations = files.observations.records as Observation[];
  const claims = files.claims.records as ClaimVersionRecord[];
  const operations = files.operations.records as OpLogEntry[];
  const outOfScope = [
    ...observations.filter((record) => record?.scope !== scope).map((record) => `observation ${record?.id}`),
    ...claims.filter((record) => record?.scope !== scope).map((record) => `claim ${record?.claim_id}`),
  ];
  if (outOfScope.length > 0) {
    throw new ProtocolError(
      'package_corrupt',
      `Package crosses its scope boundary: ${outOfScope.slice(0, 3).join(', ')}`,
    );
  }

  // ── Idempotency: a receipt for this exact package means the restore already happened.
  const importsDir = join(dataDir, 'imports');
  const receiptPath = join(importsDir, `${manifest.export_id}.json`);
  if (existsSync(receiptPath)) {
    let receipt: RestoreReceipt;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as RestoreReceipt;
    } catch {
      throw new ProtocolError('conflict', `Restore receipt '${receiptPath}' is unreadable`);
    }
    if (receipt.package_aggregate !== aggregate || receipt.scope !== scope) {
      throw new ProtocolError('conflict', `Restore receipt for '${manifest.export_id}' does not match this package`);
    }
    return {
      status: 'already_restored',
      export_id: manifest.export_id,
      scope,
      path: packageDir,
      counts: receipt.counts,
      manifest,
      receipt_path: receiptPath,
    };
  }

  // ── No merge: the target scope must be empty.
  const existingObservation = [...readAll(evidenceDir)].find((record) => record.scope === scope);
  const existingClaim = [...iterAllClaimVersions(dataDir)].find((record) => record.scope === scope);
  if (existingObservation || existingClaim) {
    throw new ProtocolError(
      'scope_not_empty',
      `Scope '${scope}' already holds content in this brain — restore into an empty scope, or export/forget first`,
    );
  }

  const receipt: RestoreReceipt = {
    export_id: manifest.export_id,
    scope,
    operation_id: params.operation_id ?? null,
    restored_at: new Date().toISOString(),
    restored_by: params.actor.id,
    counts,
    package_aggregate: aggregate,
  };
  writePrivateFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  // An erased package has a deletion certificate and no content: record the restore, write
  // nothing (exporting an erased scope must never resurrect the data, and neither must this).
  if (manifest.deletion_certificate) {
    return {
      status: 'empty_package',
      export_id: manifest.export_id,
      scope,
      path: packageDir,
      counts,
      manifest,
      receipt_path: receiptPath,
    };
  }

  // ── Canonical writes, in the same order a live brain would produce them: evidence first,
  //    then claim versions, then the operations closure.
  ensurePrivateDirectory(dataDir);
  for (const observation of observations) {
    const stamp = observation.source?.observed_at ?? observation.source?.captured_at ?? new Date().toISOString();
    appendObservationAt(evidenceDir, stamp.slice(0, 10), observation);
  }
  appendClaimVersions(dataDir, claims);
  appendOpLogEntries(opsDir, operations);
  ensurePrivateDirectory(importsDir);

  return {
    status: 'restored',
    export_id: manifest.export_id,
    scope,
    path: packageDir,
    counts,
    manifest,
    receipt_path: receiptPath,
  };
}
