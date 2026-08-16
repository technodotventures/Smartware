import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateRetrievalActivation } from '../dist/core.js';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf8'));
}

function sha256(filePath) {
  return createHash('sha256')
    .update(fs.readFileSync(path.resolve(process.cwd(), filePath)))
    .digest('hex');
}

function usage() {
  return [
    'Usage: node scripts/evaluate-retrieval-activation.mjs',
    '  <arena.json> <run.json> <activation.json> [--expect-hold] [--details]',
    '',
    'By default a hold decision exits non-zero. --expect-hold is only for',
    'contract tests that prove development evidence cannot activate retrieval.',
  ].join('\n');
}

function compactChannel(channel, includeDetails) {
  if (includeDetails) return channel;
  const { queries_detail: _details, ...summary } = channel;
  return summary;
}

function main() {
  const [arenaPath, runPath, activationPath, ...flags] = process.argv.slice(2);
  if (!arenaPath || !runPath || !activationPath) throw new Error(usage());

  const arena = readJson(arenaPath);
  const run = readJson(runPath);
  const activation = readJson(activationPath);
  const arenaSha256 = sha256(arenaPath);
  const runSha256 = sha256(runPath);
  if (activation.evidence?.arena_sha256 !== arenaSha256) {
    throw new Error(
      `Activation arena_sha256 does not match ${arenaPath}: ${arenaSha256}`,
    );
  }
  if (activation.evidence?.run_sha256 !== runSha256) {
    throw new Error(
      `Activation run_sha256 does not match ${runPath}: ${runSha256}`,
    );
  }
  const evaluation = evaluateRetrievalActivation(
    arena.cases ?? [],
    run.observations ?? [],
    activation.evidence,
    activation.policy,
  );
  const includeDetails = flags.includes('--details');
  const report = {
    arena: arena.name ?? path.basename(arenaPath),
    run: run.name ?? path.basename(runPath),
    activation: activation.name ?? path.basename(activationPath),
    ...evaluation,
    baseline: compactChannel(evaluation.baseline, includeDetails),
    candidate: compactChannel(evaluation.candidate, includeDetails),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const expectHold = flags.includes('--expect-hold');
  if (expectHold ? evaluation.decision !== 'hold' : !evaluation.passed) {
    process.exitCode = 1;
  }
}

main();
