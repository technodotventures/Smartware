// Protocol — ENDORSE handler (page endorsement cascade)
//
// REVISE on a PageId with author: user triggers the endorsement cascade.
// Two-phase: dry_run returns a preview, commit consumes the preview.

import { ulid } from 'ulid';

import type { Actor } from '../layer0/types.js';
import type { ClaimStore } from '../layer1/store.js';
import type { SmartwareConfig } from '../config.js';
import {
  appendClaimVersions,
  iterAllClaimVersions,
  readLatestVersion,
  type ActiveClaimVersion,
} from '../layer1/jsonl.js';
import { CascadePreviewStore, type CascadePreviewPayload } from '../preview_store/store.js';
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
  type EndorseOperationIntent,
} from '../ops_log/index.js';
import { parseFrontmatter, serialiseFrontmatter } from '../layer2/frontmatter.js';
import {
  endorsedEnvelope,
  endorsedPageFrontmatter,
  pageCitedClaimIds,
  readPageFile,
  writeEnvelopeIntoBody,
} from '../layer2/envelope.js';
import fs from 'fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function writeFileAtomic(filePath: string, content: string): void {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
}

function listMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listMarkdownFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(candidate);
  }
  return files;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface EndorseParams {
  actor: Actor;
  page_id: string;
  page_path: string;
  dry_run: boolean;
  cascade_preview_id?: string;
  reason: string;
  operation_id?: string;
}

export interface EndorsePreviewResult {
  cascade_preview_id: string;
  sources: string[];
  shared_claims: string[];
  status: 'preview';
}

export interface EndorseCommitResult {
  page_id: string;
  claims_endorsed: number;
  operation_id: string;
  commit_ts: string;
  status: 'endorsed';
}

export type EndorseResult = EndorsePreviewResult | EndorseCommitResult;

export interface EndorseCommitHooks {
  afterIntent?: (intent: EndorseOperationIntent) => void;
  afterClaimVersions?: (records: ActiveClaimVersion[]) => void;
  afterPage?: () => void;
  afterCommit?: () => void;
}

export async function handleEndorse(
  params: EndorseParams,
  dataDir: string,
  store: ClaimStore,
  previewStore: CascadePreviewStore,
  config: SmartwareConfig,
  commitCtx?: CommitContext,
  commitHooks?: EndorseCommitHooks,
): Promise<EndorseResult> {
  if (!params.actor.id.startsWith('user:')) {
    throw new ProtocolError('user_required', 'Endorsement is user-only');
  }
  requireRegisteredActor(params.actor.id, config);

  if (!fs.existsSync(params.page_path)) {
    throw new ProtocolError('page_not_found', `Page '${params.page_id}' not found at ${params.page_path}`);
  }

  const content = fs.readFileSync(params.page_path, 'utf-8');
  const page = readPageFile(content);
  if (!page) {
    throw new ProtocolError('invalid_page', 'Page has no valid frontmatter');
  }

  // The page's cited claims. `sources` is the published name (§9); a page written before
  // ADR-0013 → D2 is read through the compatibility accessor instead of mistaken for a
  // claim list it never carried.
  const sources = pageCitedClaimIds(page);
  const wikiRoot = fs.existsSync(path.join(dataDir, 'wiki'))
    ? path.join(dataDir, 'wiki')
    : path.dirname(path.dirname(params.page_path));
  const citedElsewhere = new Set<string>();
  for (const candidate of listMarkdownFiles(wikiRoot)) {
    if (path.resolve(candidate) === path.resolve(params.page_path)) continue;
    const other = readPageFile(fs.readFileSync(candidate, 'utf8'));
    if (!other) continue;
    for (const claimId of pageCitedClaimIds(other)) citedElsewhere.add(claimId);
  }
  const sharedClaims = sources.filter(claimId => citedElsewhere.has(claimId));

  if (params.dry_run) {
    const previewId = previewStore.put({
      page_id: params.page_id,
      sources_snapshot: sources,
      shared_claims_snapshot: sharedClaims,
      actor_id: params.actor.id,
      reason: params.reason,
    });

    return {
      cascade_preview_id: previewId,
      sources,
      shared_claims: sharedClaims,
      status: 'preview',
    };
  }

  if (!params.operation_id) {
    throw new ProtocolError('missing_operation_id', 'operation_id required for endorsement commit');
  }
  if (!OPERATION_ID_PATTERN.test(params.operation_id)) {
    throw new ProtocolError('invalid_parameter', `Invalid operation_id '${params.operation_id}'`);
  }

  const payloadHash = computePayloadHash({
    actor_id: params.actor.id,
    page_id: params.page_id,
    reason: params.reason,
    cascade_preview_id: params.cascade_preview_id ?? null,
  });
  const committedResult = (): EndorseCommitResult | null => {
    if (!commitCtx || !params.operation_id) return null;
    const entries = [...readAllOpLogEntries(commitCtx.opsDir)]
      .filter(entry => entry.operation_id === params.operation_id);
    if (entries.length === 0) return null;
    const exact = entries.find(entry =>
      entry.op === 'endorse'
      && entry.actor_id === params.actor.id
      && entry.details?.['payload_hash'] === payloadHash);
    if (!exact) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already used with a different payload`);
    }
    const pageId = exact.details?.['page_id'];
    const pageHash = exact.details?.['page_hash'];
    const claims = exact.details?.['claims'];
    if (typeof pageId !== 'string'
      || typeof pageHash !== 'string'
      || !Array.isArray(claims)) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' has no replayable ENDORSE result`);
    }
    const pageRaw = fs.readFileSync(params.page_path, 'utf8');
    if (pageId !== params.page_id || computePayloadHash(pageRaw) !== pageHash) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
    }
    const artifacts = [...iterAllClaimVersions(dataDir)]
      .filter(version => version.operation_id === params.operation_id);
    if (artifacts.length !== claims.length || claims.some(expected => {
      if (!expected || typeof expected !== 'object') return true;
      const record = expected as { claim_id?: unknown; version?: unknown; record_hash?: unknown };
      const artifact = artifacts.find(version =>
        version.claim_id === record.claim_id && version.version === record.version);
      return !artifact
        || typeof record.record_hash !== 'string'
        || computePayloadHash(artifact) !== record.record_hash;
    })) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
    }
    for (const artifact of artifacts) store.syncFromJsonlVersion(artifact);
    if (params.cascade_preview_id) previewStore.consume(params.cascade_preview_id);
    return {
      page_id: pageId,
      claims_endorsed: claims.length,
      operation_id: params.operation_id,
      commit_ts: exact.timestamp,
      status: 'endorsed',
    };
  };

  const priorCommit = committedResult();
  if (priorCommit) return priorCommit;

  let existingIntent: EndorseOperationIntent | null = null;
  if (commitCtx) {
    const prepared = readOperationIntent(commitCtx.opsDir, params.operation_id);
    if (prepared) {
      if (prepared.op !== 'endorse'
        || prepared.actor_id !== params.actor.id
        || prepared.payload_hash !== payloadHash) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' was already prepared with a different payload`);
      }
      existingIntent = prepared;
      const recovery = runRecovery({
        opsDir: commitCtx.opsDir,
        evidenceDir: '',
        claimsDir: dataDir,
        wikiDir: wikiRoot,
        quarantineDir: '',
      });
      const recovered = committedResult();
      if (recovered) return recovered;
      if (recovery.requiresManualReview.includes(params.operation_id)) {
        throw new ProtocolError('conflict', `operation_id '${params.operation_id}' requires manual recovery review`);
      }
    }
  }

  if (sharedClaims.length > 0 && !params.cascade_preview_id) {
    throw new ProtocolError('cascade_required_ack', 'Shared claims require an endorsement preview');
  }

  if (params.cascade_preview_id) {
    const lookup = previewStore.lookup(params.cascade_preview_id);
    if (lookup.kind === 'not_found') {
      throw new ProtocolError('preview_not_found', 'Preview not found');
    }
    if (lookup.kind === 'expired') {
      throw new ProtocolError('preview_expired', 'Preview has expired');
    }
    if (lookup.kind === 'consumed') {
      throw new ProtocolError('preview_not_found', 'Preview already consumed');
    }
    if (lookup.kind === 'hit') {
      if (
        lookup.payload.page_id !== params.page_id
        || lookup.payload.actor_id !== params.actor.id
        || !sameStringArray(sources, lookup.payload.sources_snapshot)
        || !sameStringArray(sharedClaims, lookup.payload.shared_claims_snapshot)
      ) {
        throw new ProtocolError('cascade_drift', 'Page sources have changed since preview');
      }
    }
  }

  const commitTs = existingIntent?.prepared_at ?? new Date().toISOString();
  const existingArtifacts = [...iterAllClaimVersions(dataDir)]
    .filter(version => version.operation_id === params.operation_id);
  const endorsedRecords: ActiveClaimVersion[] = [];
  const missingRecords: ActiveClaimVersion[] = [];
  for (const claimId of sources) {
    const preparedArtifact = existingArtifacts.find(version => version.claim_id === claimId);
    if (preparedArtifact) {
      if (preparedArtifact.state !== 'active') {
        throw new ProtocolError('conflict', `Prepared endorsement artifact for '${claimId}' is not active`);
      }
      endorsedRecords.push(preparedArtifact);
      continue;
    }
    const latest = readLatestVersion(dataDir, claimId);
    if (!latest) throw new ProtocolError('claim_not_found', `Claim '${claimId}' not found`);
    if (latest.state !== 'active') throw new ProtocolError('claim_forgotten', `Claim '${claimId}' is forgotten`);
    // The spread carries `superseded_by`/`superseded_at` with it: endorsing a claim adopts its body
    // as user voice, which does not decide that the claim is no longer a duplicate of the survivor
    // (`resolveFactMatches` makes that call — ADR-0003 → *Carry-forward across hand-built version
    // records*). Dropping the field here would release the demotion silently.
    const endorsed: ActiveClaimVersion = {
      ...latest,
      version: latest.version + 1,
      author: 'user',
      epistemic_owner: 'user',
      endorsement_source: params.page_id,
      supersedes: latest.version,
      version_at: commitTs,
      operation_id: params.operation_id,
      actor_id: params.actor.id,
    };
    endorsedRecords.push(endorsed);
    missingRecords.push(endorsed);
  }

  const stamp = {
    pageId: params.page_id,
    actorId: params.actor.id,
    operationId: params.operation_id,
    commitTs,
  };
  const pageContent = serialiseFrontmatter(
    endorsedPageFrontmatter(page, sources, stamp),
    // The evidence timeline is a derived render; the endorsement stamps its durable recovery
    // metadata into the same cached region instead of into the published frontmatter.
    writeEnvelopeIntoBody(page.body, endorsedEnvelope(page, stamp)),
  );
  const expectedClaims = endorsedRecords.map(record => ({
    claim_id: record.claim_id,
    version: record.version,
    record_hash: computePayloadHash(record),
  }));
  const pageHash = computePayloadHash(pageContent);
  let intent: EndorseOperationIntent | null = null;
  if (commitCtx) {
    intent = {
      version: 1,
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      op: 'endorse',
      payload_hash: payloadHash,
      prepared_at: commitTs,
      expected: {
        surface: 'endorse',
        page: { page_id: params.page_id, content_hash: pageHash },
        claims: expectedClaims,
      },
      result: {
        page_id: params.page_id,
        claims_endorsed: endorsedRecords.length,
        operation_id: params.operation_id,
        commit_ts: commitTs,
        status: 'endorsed',
      },
      details: { page_id: params.page_id },
    };
    if (existingIntent && JSON.stringify(existingIntent.expected) !== JSON.stringify(intent.expected)) {
      throw new ProtocolError('conflict', `operation_id '${params.operation_id}' no longer matches its prepared ENDORSE artifacts`);
    }
    persistOperationIntent(commitCtx.opsDir, intent, true);
    commitHooks?.afterIntent?.(intent);
  }

  if (missingRecords.length > 0) {
    appendClaimVersions(dataDir, missingRecords);
    for (const endorsed of missingRecords) store.syncFromJsonlVersion(endorsed);
    commitHooks?.afterClaimVersions?.(missingRecords);
  }
  const pageAlreadyWritten = fs.readFileSync(params.page_path, 'utf8') === pageContent;
  if (!pageAlreadyWritten) {
    writeFileAtomic(params.page_path, pageContent);
    commitHooks?.afterPage?.();
  }

  if (commitCtx && intent) {
    appendOpLogEntry(commitCtx.opsDir, {
      operation_id: params.operation_id,
      actor_id: params.actor.id,
      timestamp: commitTs,
      op: 'endorse',
      details: {
        payload_hash: payloadHash,
        page_id: params.page_id,
        page_hash: pageHash,
        claims: expectedClaims,
        claims_endorsed: endorsedRecords.length,
      },
    });
    commitHooks?.afterCommit?.();
    removeOperationIntent(commitCtx.opsDir, params.operation_id);
  }

  if (params.cascade_preview_id && !previewStore.consume(params.cascade_preview_id)) {
    throw new ProtocolError('preview_not_found', 'Preview could not be consumed');
  }

  return {
    page_id: params.page_id,
    claims_endorsed: endorsedRecords.length,
    operation_id: params.operation_id,
    commit_ts: commitTs,
    status: 'endorsed',
  };
}
