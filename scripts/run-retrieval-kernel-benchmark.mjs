import fs from 'node:fs';
import path from 'node:path';

import {
  rankHybridDocuments,
  rankSemanticDocuments,
  syncSemanticRecords,
} from '../dist/core.js';

function readFixture(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function withoutVector(document) {
  const { vector: _vector, ...semanticDocument } = document;
  return semanticDocument;
}

async function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    throw new Error('Usage: node scripts/run-retrieval-kernel-benchmark.mjs <fixture.json>');
  }

  const fixture = readFixture(path.resolve(process.cwd(), fixturePath));
  const documents = fixture.documents.map(withoutVector);
  const vectors = new Map([
    ...fixture.documents.map(document => [document.text, document.vector]),
    ...fixture.queries.map(query => [query.text, query.vector]),
  ]);
  const adapter = {
    provider: 'fixture',
    model: fixture.name,
    dimensions: fixture.documents[0]?.vector.length,
    async embed(texts) {
      return texts.map(text => {
        const vector = vectors.get(text);
        if (!vector) throw new Error(`Fixture has no vector for: ${text}`);
        return vector;
      });
    },
  };

  const synced = await syncSemanticRecords(documents, [], adapter);
  const results = [];
  for (const query of fixture.queries) {
    const eligible = documents.filter(document => query.eligible_ids.includes(document.id));
    const hybrid = query.lexical_ids
      ? await rankHybridDocuments(
          query.text,
          query.lexical_ids,
          eligible,
          synced.records,
          adapter,
          {
            min_similarity: query.min_similarity ?? 0.5,
            limit: query.limit ?? 5,
            temporal: query.temporal,
          },
        )
      : null;
    const matches = hybrid?.matches ?? await rankSemanticDocuments(
      query.text,
      eligible,
      synced.records,
      adapter,
      {
        min_similarity: query.min_similarity ?? 0.5,
        limit: query.limit ?? 5,
        temporal: query.temporal,
      },
    );
    const rank = query.expected_id === null
      ? null
      : matches.findIndex(match => match.id === query.expected_id) + 1 || null;
    const forbiddenHits = matches
      .filter(match => query.forbidden_ids.includes(match.id))
      .map(match => match.id);
    const passed = query.expected_id === null
      ? matches.length === 0 && forbiddenHits.length === 0
      : rank === 1 && forbiddenHits.length === 0;
    results.push({
      id: query.id,
      channel: hybrid ? 'hybrid' : 'semantic',
      ...(hybrid ? { semantic_status: hybrid.semantic_status } : {}),
      passed,
      expected_id: query.expected_id,
      expected_rank: rank,
      forbidden_hits: forbiddenHits,
      result_ids: matches.map(match => match.id),
    });
  }

  const scored = results.filter(result => result.expected_id !== null);
  const summary = {
    fixture: fixture.name,
    scenarios: results.length,
    passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length,
    hit_at_1: scored.length === 0
      ? 0
      : scored.filter(result => result.expected_rank === 1).length / scored.length,
    mean_reciprocal_rank: scored.length === 0
      ? 0
      : scored.reduce(
          (sum, result) => sum + (result.expected_rank ? 1 / result.expected_rank : 0),
          0,
        ) / scored.length,
    forbidden_hits: results.reduce(
      (sum, result) => sum + result.forbidden_hits.length,
      0,
    ),
    results,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failed > 0) process.exitCode = 1;
}

await main();
