// Layer 2 — Full 6-stage compilation pipeline

import fs from 'fs';
import path from 'path';
import { ulid } from 'ulid';
import type { Observation } from '../layer0/types.js';
import type { Layer0Index } from '../layer0/index.js';
import { readAll } from '../layer0/log.js';
import { appendObservation } from '../layer0/log.js';
import { assignIntegrity } from '../layer0/integrity.js';
import type { ClaimStore } from '../layer1/store.js';
import type { Entity, Claim } from '../layer1/types.js';
import { confidenceToBucket, epistemicToTag, type EpistemicLabel } from '../layer1/types.js';
import { replayCatchUp } from '../layer1/replay.js';
import { resetEntityTelemetry, getEntityMergeLog, getNewEntityLog } from '../layer1/entities.js';
import { extractDeterministic } from '../extraction/deterministic.js';
import { extractClaimsLLM, compileMarkdownLLM } from '../extraction/llm.js';
import type { SmartwareConfig } from '../config.js';
import type { Frontmatter, CompiledPage, CompilationAudit, CompileTelemetry, EntityMerge, PageEnvelope, PageNotice } from './types.js';
import { PAGE_CATEGORY_DIRS } from './paths.js';
import { ensurePrivateDirectory, writePrivateFile } from '../storage/private-fs.js';
import { serialiseFrontmatter } from './frontmatter.js';
import {
  isoDate,
  pageCitedClaimIds,
  pageCreatedDate,
  readPageFile,
  renderEnvelopeBlock,
} from './envelope.js';
import {
  categoryDirForEntity,
  entityPagePath,
  entitySlug,
  pageCategoryForDir,
  pageIdForSlug,
} from './paths.js';
import { buildOneliner, buildParagraph, buildFullPage } from './resolutions.js';
import { commitWikiChanges, buildCommitMessage, ensureGitRepo } from './git.js';
import type { SearchIndex } from '../layer3/search.js';
import { syncSearchFromClaims } from '../layer3/search.js';
import { SMARTWARE_VERSION } from '../version.js';

const COMPILER_VERSION = SMARTWARE_VERSION;

function stripUserMetadataForExtraction(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUserMetadataForExtraction);
  }
  if (value && typeof value === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'tags') continue;
      cleaned[key] = stripUserMetadataForExtraction(nested);
    }
    return cleaned;
  }
  return value;
}

export interface CompileOptions {
  scope?: string;
  entityId?: string;
  useLLM?: boolean;
  /**
   * §11.2b re-scope: observations already parsed by the caller (reflect
   * production). Without it, compile() re-reads the whole evidence JSONL in
   * gather — measured ~2s of the 50k pipeline. Defaults to a fresh read.
   */
  observations?: Observation[];
}

export interface CompileResult {
  pages: CompiledPage[];
  audit: CompilationAudit[];
  telemetry: CompileTelemetry;
  gitSha?: string;
}

export function isContextOnlyObservation(obs: Observation, contextClaimIds: Set<string>): boolean {
  const informedBy = obs.provenance.informed_by ?? [];
  return informedBy.length > 0 && informedBy.every(claimId => contextClaimIds.has(claimId));
}

export async function compile(
  evidenceDir: string,
  wikiDir: string,
  layer0: Layer0Index,
  store: ClaimStore,
  config: SmartwareConfig,
  options: CompileOptions = {},
  searchIndex?: SearchIndex,
): Promise<CompileResult> {
  const compileStart = Date.now();
  const stageDurations: Record<string, number> = {};

  // ── Stage 1: GATHER ──────────────────────────────────────────────────────
  const stageGatherStart = Date.now();
  // Reload raw observations for the target scope — callers that already
  // parsed the log (reflect production) pass them to avoid a second full
  // JSONL parse (§11.2b re-scope). Iterate a source array and collect into a
  // separate output list (never mutate the array under iteration).
  const sourceObservations: Observation[] = options.observations ?? [...readAll(evidenceDir)];
  const observations: Observation[] = [];
  // §11.2b: one-query status snapshot replaces 50k per-obs SELECTs.
  const statusMap = layer0.getEffectiveStatusMap();
  let gatherCount = 0;
  for (const obs of sourceObservations) {
    if (options.scope && obs.scope !== options.scope) continue;
    const effectiveStatus = statusMap.get(obs.id) ?? obs.status;
    if (effectiveStatus !== 'accepted') continue;
    observations.push(obs);
    if (++gatherCount % 100 === 0) await new Promise(r => setImmediate(r));
  }
  stageDurations['gather'] = Date.now() - stageGatherStart;

  // ── Stage 2: EXTRACT ────────────────────────────────────────────────────
  const stageExtractStart = Date.now();
  const now = new Date().toISOString();
  const writerSeq = layer0.getLastSequence();
  let seq = writerSeq;
  let prevHash = layer0.getLatestHashForWriter(config.writer_id);
  const contextClaimIds = new Set(
    store.getActiveClaims(options.scope)
      .filter(claim => claim.status === 'active')
      .map(claim => claim.id),
  );

  // Telemetry: track per-observation extraction counts
  const claimsPerObs: Record<string, number> = {};
  const extractableTypes = new Set(['message', 'file', 'preference', 'decision']);
  // Pre-record all extractable observations so zero-claim ones are visible
  for (const obs of observations) {
    if (extractableTypes.has(obs.type)) {
      claimsPerObs[obs.id] = 0;
    }
  }

  // v1.6.16: extraction no longer writes claim_extracted events here.
  // Claim creation is reflect.auto's job (called before compile in the
  // REFLECT handler). The compiler now only synthesizes L2 pages from
  // existing L1 claims. The extraction stage is preserved for telemetry
  // counting only.
  for (const obs of observations) {
    if (!extractableTypes.has(obs.type)) continue;
    if (isContextOnlyObservation(obs, contextClaimIds)) continue;
    claimsPerObs[obs.id] = 0;
  }

  stageDurations['extract'] = Date.now() - stageExtractStart;

  // ── Stage 3 & 4: RECONCILE + TAG (via replay) ───────────────────────────
  const stageReconcileStart = Date.now();
  resetEntityTelemetry();
  await replayCatchUp(evidenceDir, store, layer0, config, sourceObservations, statusMap);
  stageDurations['reconcile'] = Date.now() - stageReconcileStart;

  // ── Stage 4.5: SEARCH INDEX (L3 from L1 — decoupled from L2) ──────────
  // Index claims into L3 immediately after replay. This ensures newly-
  // extracted claims are queryable even if Stage 5 (markdown synthesis)
  // fails or times out. L3 no longer depends on L2 completion.
  const stageIndexStart = Date.now();
  let layer3IndexedCount = 0;
  if (searchIndex) {
    layer3IndexedCount = syncSearchFromClaims(store, searchIndex, options.scope);
  }
  stageDurations['index'] = Date.now() - stageIndexStart;

  // ── Stage 5: COMPILE ────────────────────────────────────────────────────
  const stageCompileStart = Date.now();
  await ensureGitRepo(wikiDir);
  // PR-6 / A5: ensure the spec-shaped category directories exist before
  // writing pages. Safe to call every compile (idempotent).
  ensureCategoryDirs(wikiDir);

  const entities: Entity[] = options.entityId
    ? [store.getEntity(options.entityId)].filter(Boolean) as Entity[]
    : store.getAllEntities(options.scope);

  const pages: CompiledPage[] = [];
  const audit: CompilationAudit[] = [];
  const changedFiles: string[] = [];
  let llmSynthesisAttempted = 0;
  let llmSynthesisFailed = 0;
  let llmSynthesisSkippedSensitive = 0;

  for (const entity of entities) {
    const claims = store.getActiveClaims(entity.scope)
      .filter(c => c.subject_id === entity.id && c.status === 'active');
    if (claims.length === 0) continue;

    const sensitive = claims.some(c => c.sensitive);
    const confidence = claims.length > 0
      ? claims.reduce((sum, c) => sum + c.confidence, 0) / claims.length
      : 0;
    const epistemic = mostConfidentEpistemic(claims);

    // Generate resolutions
    let oneliner: string;
    let paragraph: string;
    let fullPage: string;

    const llmConfigured = options.useLLM === true && config.llm.provider !== 'none';
    if (llmConfigured && sensitive) llmSynthesisSkippedSensitive++;
    let usedLLM = false;
    if (llmConfigured && !sensitive) {
      llmSynthesisAttempted++;
      try {
        const llmResult = await compileMarkdownLLM(
          entity.canonical_name,
          entity.type,
          claims.map(c => ({ predicate: c.predicate, object: c.object, epistemic: c.epistemic, confidence: c.confidence })),
          null,
          config,
        );
        oneliner = llmResult.oneliner;
        paragraph = llmResult.paragraph;
        fullPage = llmResult.fullPage;
        usedLLM = true;
      } catch {
        llmSynthesisFailed++;
        oneliner = buildOneliner(entity, claims);
        paragraph = buildParagraph(entity, claims);
        fullPage = buildFullPage(entity, claims);
      }
    } else {
      oneliner = buildOneliner(entity, claims);
      paragraph = buildParagraph(entity, claims);
      fullPage = buildFullPage(entity, claims);
    }

    const categoryDir = categoryDirForEntity(entity);
    const category = pageCategoryForDir(categoryDir) ?? 'concept';
    const slug = entitySlug(entity.canonical_name);
    const claimIds = claims.map(c => c.id);
    const sourceObservationIds = [...new Set(claims.flatMap(c => c.supporting_evidence))];
    const pagePath = entityPagePath(wikiDir, entity);

    // Voice protection: on user-authored pages the Current Understanding prose, the cited
    // `sources`, the creation date, user tags/aliases and the notice slot survive a recompile;
    // only the derived cached region (Evidence Timeline + envelope), `updated` and
    // `supporting_claims` are agent-maintained (§9). `Read` the page in *either* shape so a
    // tree that predates ADR-0013 → D2 is upgraded in place.
    const existingPage = fs.existsSync(pagePath)
      ? readPageFile(fs.readFileSync(pagePath, 'utf-8'))
      : null;
    const isUserPage = existingPage?.frontmatter['author'] === 'user';
    const existingEnvelope = existingPage?.envelope ?? null;

    const frontmatter: Frontmatter = {
      title: entity.canonical_name,
      page_id: pageIdForSlug(slug),
      category,
      author: isUserPage ? 'user' : 'agent',
      // §9: `sources` is locked at endorsement on user-authored pages. On a legacy page the
      // published name still holds the observation list, so the cited claims are read through
      // the compatibility accessor.
      sources: isUserPage && existingPage ? pageCitedClaimIds(existingPage) : claimIds,
      supporting_claims: [],
      created: existingPage ? pageCreatedDate(existingPage.frontmatter, now) : isoDate(now),
      updated: isoDate(now),
      scope: entity.scope,
      confidence: confidenceToBucket(confidence),
      epistemic_tag: epistemicToTag(epistemic, 'active'),
      summary: '',
      tags: [],
      aliases: [],
      notices: [],
    };
    frontmatter.summary = oneliner.trim().split('\n')[0]?.slice(0, 240) ?? '';

    if (isUserPage && existingPage) {
      const existingFm = existingPage.frontmatter;
      frontmatter.supporting_claims = [
        ...new Set([
          ...toStringArray(existingFm['supporting_claims']),
          ...claimIds.filter(id => !frontmatter.sources.includes(id)),
        ]),
      ];
      frontmatter.notices = (Array.isArray(existingFm['notices']) ? existingFm['notices'] : []) as PageNotice[];
      frontmatter.tags = toStringArray(existingFm['tags']);
      frontmatter.aliases = toStringArray(existingFm['aliases']);
    }

    // The compile envelope is implementation mechanics, not page vocabulary: it renders into
    // the derived cached region below rather than into the published frontmatter
    // (ADR-0013 → D2).
    const envelope: PageEnvelope = {
      compiled_at: now,
      compiled_by: 'smartware-compiler',
      entity_id: entity.id,
      entity: entity.canonical_name,
      type: entity.type,
      sensitive,
      source_observation_ids: sourceObservationIds,
      supersedes: [],
      related: [],
    };
    if (usedLLM) envelope.model = config.llm.model;
    // Endorsement-recovery metadata is durable state about a warranted action, not a compile
    // artifact: a later recompile carries it forward instead of erasing it.
    if (existingEnvelope?.endorsement_operation_id) {
      envelope.endorsement_operation_id = existingEnvelope.endorsement_operation_id;
    }
    if (existingEnvelope?.endorsed_by) envelope.endorsed_by = existingEnvelope.endorsed_by;
    if (existingEnvelope?.endorsed_at) envelope.endorsed_at = existingEnvelope.endorsed_at;

    // ── Stage 6: VERIFY — two-region page + voice protection ────────────
    const evidenceTimeline = buildEvidenceTimeline(claims, envelope);

    let body: string;
    if (isUserPage && existingPage) {
      body = replaceEvidenceTimeline(existingPage.body, evidenceTimeline);
    } else {
      body = `\n## Current Understanding\n\n${oneliner}\n\n${paragraph}\n\n${fullPage}\n\n${evidenceTimeline}\n`;
    }

    const raw = serialiseFrontmatter(frontmatter, body);

    // Write page
    ensurePrivateDirectory(path.dirname(pagePath));
    writePrivateFile(pagePath, raw, 'utf-8');
    changedFiles.push(pagePath);

    const page: CompiledPage = { path: pagePath, frontmatter, envelope, oneliner, paragraph, fullPage, raw };
    pages.push(page);

    const contestedCount = claims.filter(c => c.status === 'contested').length;
    audit.push({
      entity_id: entity.id,
      entity_name: entity.canonical_name,
      claims_used: claims.length,
      claims_contested: contestedCount,
      observations_used: sourceObservationIds.length,
      compiled_at: now,
      model: usedLLM ? config.llm.model : null,
      path: pagePath,
    });
  }

  stageDurations['compile'] = Date.now() - stageCompileStart;

  // PR-6 / A5: regenerate _index.md per affected category dir so the
  // human-readable view stays current after every compile.
  const touchedCategories = new Set(pages.map((p) => path.basename(path.dirname(p.path))));
  for (const category of touchedCategories) {
    rebuildCategoryIndex(wikiDir, category);
    changedFiles.push(path.join(wikiDir, category, '_index.md'));
  }

  // Git commit
  const stageVerifyStart = Date.now();
  let gitSha: string | undefined;
  if (pages.length > 0) {
    const msg = buildCommitMessage('wiki', pages.length, audit.reduce((s, a) => s + a.claims_contested, 0));
    const commit = await commitWikiChanges(wikiDir, msg, changedFiles);
    gitSha = commit?.sha;
  }
  stageDurations['verify'] = Date.now() - stageVerifyStart;

  // ── Telemetry ───────────────────────────────────────────────────────────
  const zeroClaims = Object.entries(claimsPerObs)
    .filter(([, count]) => count === 0)
    .map(([id]) => id);

  const durationMs = Date.now() - compileStart;

  const telemetry: CompileTelemetry = {
    observations_processed: Object.keys(claimsPerObs).length,
    claims_extracted_per_observation: claimsPerObs,
    observations_with_zero_claims: zeroClaims,
    entity_merges: getEntityMergeLog(),
    entities_created_new: getNewEntityLog(),
    layer3_indexed_count: layer3IndexedCount,
    duration_ms: durationMs,
    timed_out: false,  // caller sets to true if handler timeout fires
    stage_durations_ms: stageDurations,
    llm_extraction_attempted: 0,
    llm_extraction_failed: 0,
    llm_extraction_skipped_sensitive: 0,
    llm_synthesis_attempted: llmSynthesisAttempted,
    llm_synthesis_failed: llmSynthesisFailed,
    llm_synthesis_skipped_sensitive: llmSynthesisSkippedSensitive,
  };

  return { pages, audit, telemetry, gitSha };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function mostConfidentEpistemic(claims: Claim[]): EpistemicLabel {
  const order: EpistemicLabel[] = ['user_confirmed', 'asserted', 'observed', 'inferred', 'system_generated'];
  for (const label of order) {
    if (claims.some(c => c.epistemic === label)) return label;
  }
  return 'inferred';
}

/** Ensure all six spec-shaped category directories exist. Idempotent. */
function ensureCategoryDirs(wikiDir: string): void {
  for (const cat of PAGE_CATEGORY_DIRS) {
    ensurePrivateDirectory(path.join(wikiDir, cat));
  }
}

/**
 * Rebuild `<wikiDir>/<category>/_index.md` from whatever .md files (other
 * than the index itself) are present in the directory. Each entry is a
 * markdown link with a one-line summary parsed from frontmatter.
 */
function rebuildCategoryIndex(wikiDir: string, category: string): void {
  const dir = path.join(wikiDir, category);
  if (!fs.existsSync(dir)) return;
  const entries = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== '_index.md')
    .sort();

  const lines: string[] = [];
  lines.push(`# ${category.charAt(0).toUpperCase() + category.slice(1)}`);
  lines.push('');
  lines.push('Auto-maintained by Smartware. Edits are overwritten on the next compile.');
  lines.push('');
  if (entries.length === 0) {
    lines.push('(empty)');
  } else {
    for (const entry of entries) {
      const slug = entry.replace(/\.md$/, '');
      const filePath = path.join(dir, entry);
      let summary = '';
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const sumLine = fmMatch[1].split('\n').find((l) => l.startsWith('summary:'));
          if (sumLine) {
            summary = sumLine.replace(/^summary:\s*"?/, '').replace(/"?$/, '').trim();
          }
        }
      } catch {
        // Best-effort; missing summaries are fine.
      }
      lines.push(`- [${slug}](./${entry})${summary ? ` — ${summary}` : ''}`);
    }
  }
  lines.push('');
  writePrivateFile(path.join(dir, '_index.md'), lines.join('\n'), 'utf-8');
}

function buildEvidenceTimeline(claims: Claim[], envelope: PageEnvelope): string {
  const lines: string[] = [];
  lines.push('## Evidence Timeline');
  lines.push('');
  lines.push(renderEnvelopeBlock(envelope));
  lines.push('');
  const sorted = [...claims].sort((a, b) =>
    (a.extraction.extracted_at ?? '').localeCompare(b.extraction.extracted_at ?? ''),
  );
  for (const claim of sorted) {
    const val = typeof claim.object.value === 'string' ? claim.object.value : JSON.stringify(claim.object.value);
    const sourceIds = claim.supporting_evidence.join(', ');
    lines.push(`- **${claim.predicate}**: ${val} _(${claim.epistemic}, confidence: ${claim.confidence.toFixed(2)})_`);
    lines.push(`  source_claim_id: ${claim.id} | source_observation_ids: ${sourceIds}`);
  }
  return lines.join('\n');
}

function replaceEvidenceTimeline(existingBody: string, newTimeline: string): string {
  const marker = '## Evidence Timeline';
  const idx = existingBody.indexOf(marker);
  if (idx === -1) {
    return existingBody + '\n\n' + newTimeline + '\n';
  }
  return existingBody.slice(0, idx) + newTimeline + '\n';
}
