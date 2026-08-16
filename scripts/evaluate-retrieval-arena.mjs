import fs from 'node:fs';
import path from 'node:path';

import { evaluateRetrievalArena } from '../dist/core.js';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf8'));
}

function usage() {
  return [
    'Usage: node scripts/evaluate-retrieval-arena.mjs <arena.json> <run.json> [--details]',
    '',
    'The arena defines cases and quality gates. The run contains channel',
    'observations captured from lexical, semantic, hybrid, or reranked retrieval.',
  ].join('\n');
}

function main() {
  const [arenaPath, runPath, ...flags] = process.argv.slice(2);
  if (!arenaPath || !runPath) {
    throw new Error(usage());
  }

  const arena = readJson(arenaPath);
  const run = readJson(runPath);
  const evaluation = evaluateRetrievalArena(
    arena.cases ?? [],
    run.observations ?? [],
    arena.gates ?? [],
  );
  const report = {
    arena: arena.name ?? path.basename(arenaPath),
    run: run.name ?? path.basename(runPath),
    metadata: run.metadata ?? {},
    ...evaluation,
    channels: flags.includes('--details')
      ? evaluation.channels
      : evaluation.channels.map(({ queries_detail: _details, ...summary }) => summary),
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!evaluation.passed) process.exitCode = 1;
}

main();
