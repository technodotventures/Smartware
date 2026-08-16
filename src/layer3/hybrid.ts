import {
  rankSemanticDocuments,
  type EmbeddingAdapter,
  type SemanticDocument,
  type SemanticEmbeddingRecord,
  type SemanticMatch,
} from './semantic.js';
import {
  matchesTemporalConstraint,
  type TemporalConstraint,
} from './temporal.js';

export type SemanticChannelStatus = 'ok' | 'fallback' | 'unavailable' | 'skipped';

export interface HybridFusionOptions {
  limit: number;
  rrf_k?: number;
  lexical_weight?: number;
  semantic_weight?: number;
}

export interface HybridRankOptions extends HybridFusionOptions {
  min_similarity: number;
  candidate_limit?: number;
  temporal?: TemporalConstraint;
  semantic_timeout_ms?: number;
}

export interface HybridMatch extends SemanticDocument {
  /**
   * Query-local reciprocal-rank score. It is not a probability and must not be
   * compared across queries.
   */
  rrf_score: number;
  lexical_rank: number | null;
  semantic_rank: number | null;
  semantic_relevance: number | null;
}

export interface HybridRankResult {
  matches: HybridMatch[];
  semantic_status: SemanticChannelStatus;
  semantic_error?: string;
}

function positiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
}

function validateOptions(
  options: HybridRankOptions,
): Required<Pick<
  HybridRankOptions,
  'rrf_k' | 'lexical_weight' | 'semantic_weight'
>> {
  if (!Number.isFinite(options.min_similarity)
    || options.min_similarity < -1
    || options.min_similarity > 1) {
    throw new Error('Hybrid semantic minimum similarity must be between -1 and 1');
  }
  if (options.candidate_limit !== undefined
    && (!Number.isInteger(options.candidate_limit) || options.candidate_limit < 1)) {
    throw new Error('Hybrid candidate limit must be a positive integer');
  }
  if (options.semantic_timeout_ms !== undefined
    && (!Number.isFinite(options.semantic_timeout_ms) || options.semantic_timeout_ms <= 0)) {
    throw new Error('Hybrid semantic timeout must be a positive number');
  }

  return validateFusionOptions(options);
}

function validateFusionOptions(
  options: HybridFusionOptions,
): Required<Pick<
  HybridFusionOptions,
  'rrf_k' | 'lexical_weight' | 'semantic_weight'
>> {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error('Hybrid result limit must be a positive integer');
  }
  const rrfK = options.rrf_k ?? 60;
  if (!Number.isInteger(rrfK) || rrfK < 1) {
    throw new Error('Hybrid RRF k must be a positive integer');
  }
  const lexicalWeight = options.lexical_weight ?? 1;
  const semanticWeight = options.semantic_weight ?? 1;
  positiveNumber(lexicalWeight, 'Hybrid lexical weight');
  positiveNumber(semanticWeight, 'Hybrid semantic weight');
  return {
    rrf_k: rrfK,
    lexical_weight: lexicalWeight,
    semantic_weight: semanticWeight,
  };
}

function validateDocuments(documents: SemanticDocument[]): void {
  const ids = new Set<string>();
  for (const document of documents) {
    if (!document.id) throw new Error('Hybrid document id is required');
    if (ids.has(document.id)) {
      throw new Error(`Duplicate hybrid document id: ${document.id}`);
    }
    ids.add(document.id);
  }
}

function deduplicateEligibleIds(
  ids: string[],
  eligibleIds: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  return ids.filter(id => {
    if (!eligibleIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fuse already-ranked, already-eligible lexical and semantic candidates.
 *
 * This pure boundary lets evaluation sweep semantic thresholds without
 * repeating provider requests. It still refuses to expand beyond `documents`.
 */
export function fuseHybridRankings(
  lexicalResultIds: string[],
  semanticMatches: SemanticMatch[],
  documents: SemanticDocument[],
  options: HybridFusionOptions,
): HybridMatch[] {
  validateDocuments(documents);
  const controls = validateFusionOptions(options);
  const documentsById = new Map(documents.map(document => [document.id, document]));
  const eligibleIds = new Set(documentsById.keys());
  const lexicalIds = deduplicateEligibleIds(lexicalResultIds, eligibleIds);
  const eligibleSemanticMatches = semanticMatches.filter(match => eligibleIds.has(match.id));
  const lexicalRanks = new Map(lexicalIds.map((id, index) => [id, index + 1]));
  const semanticRanks = new Map(
    eligibleSemanticMatches.map((match, index) => [match.id, index + 1]),
  );
  const semanticById = new Map(eligibleSemanticMatches.map(match => [match.id, match]));
  const candidateIds = new Set([
    ...lexicalIds,
    ...eligibleSemanticMatches.map(match => match.id),
  ]);

  return [...candidateIds].map(id => {
    const document = documentsById.get(id)!;
    const lexicalRank = lexicalRanks.get(id) ?? null;
    const semanticRank = semanticRanks.get(id) ?? null;
    const rrfScore = (lexicalRank === null
      ? 0
      : controls.lexical_weight / (controls.rrf_k + lexicalRank))
      + (semanticRank === null
        ? 0
        : controls.semantic_weight / (controls.rrf_k + semanticRank));
    return {
      ...document,
      rrf_score: rrfScore,
      lexical_rank: lexicalRank,
      semantic_rank: semanticRank,
      semantic_relevance: semanticById.get(id)?.semantic_relevance ?? null,
    };
  }).sort((left, right) => {
    const leftChannels = Number(left.lexical_rank !== null) + Number(left.semantic_rank !== null);
    const rightChannels = Number(right.lexical_rank !== null) + Number(right.semantic_rank !== null);
    const leftBestRank = Math.min(left.lexical_rank ?? Infinity, left.semantic_rank ?? Infinity);
    const rightBestRank = Math.min(right.lexical_rank ?? Infinity, right.semantic_rank ?? Infinity);
    return right.rrf_score - left.rrf_score
      || rightChannels - leftChannels
      || leftBestRank - rightBestRank
      || left.id.localeCompare(right.id);
  }).slice(0, options.limit);
}

/**
 * Fuse lexical and semantic rankings without blending their incomparable raw
 * scores.
 *
 * `documents` is the caller-authorized boundary. Lexical ids outside it are
 * ignored, and an explicit temporal constraint is applied to both channels
 * before semantic provider access. A semantic provider or vector failure
 * returns the lexical ranking instead of turning recall into an outage.
 */
export async function rankHybridDocuments(
  query: string,
  lexicalResultIds: string[],
  documents: SemanticDocument[],
  records: SemanticEmbeddingRecord[],
  adapter: EmbeddingAdapter | null,
  options: HybridRankOptions,
): Promise<HybridRankResult> {
  validateDocuments(documents);
  validateOptions(options);
  if (!query.trim()) {
    return { matches: [], semantic_status: 'skipped' };
  }

  const eligible = options.temporal
    ? documents.filter(document => matchesTemporalConstraint(document, options.temporal!))
    : documents;
  if (eligible.length === 0) {
    return { matches: [], semantic_status: 'skipped' };
  }

  const eligibleIds = new Set(eligible.map(document => document.id));

  let semanticMatches: SemanticMatch[] = [];
  const hasModelRecords = adapter !== null && records.some(
    record => eligibleIds.has(record.id)
      && record.model_key === `${adapter.provider}/${adapter.model}`,
  );
  let semanticStatus: SemanticChannelStatus = hasModelRecords ? 'ok' : 'unavailable';
  let semanticError: string | undefined;
  if (adapter && hasModelRecords) {
    try {
      semanticMatches = await rankSemanticDocuments(
        query,
        eligible,
        records,
        adapter,
        {
          min_similarity: options.min_similarity,
          limit: options.candidate_limit
            ?? Math.max(options.limit, Math.min(50, eligible.length)),
          timeout_ms: options.semantic_timeout_ms,
        },
      );
    } catch (error) {
      semanticStatus = 'fallback';
      semanticError = errorMessage(error);
    }
  }

  const matches = fuseHybridRankings(
    lexicalResultIds,
    semanticMatches,
    eligible,
    options,
  );

  return {
    matches,
    semantic_status: semanticStatus,
    ...(semanticError === undefined ? {} : { semantic_error: semanticError }),
  };
}
