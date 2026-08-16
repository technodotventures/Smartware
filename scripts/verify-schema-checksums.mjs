import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(repositoryRoot, 'schemas', 'v0.4.2');
const checksumPath = join(schemaDir, 'SHA256SUMS');
const lines = readFileSync(checksumPath, 'utf8')
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);

let failures = 0;
for (const line of lines) {
  const match = /^([a-f0-9]{64})\s{2}(.+)$/u.exec(line);
  if (!match) {
    console.error(`Invalid checksum entry: ${line}`);
    failures += 1;
    continue;
  }
  const [, expected, filename] = match;
  const actual = createHash('sha256')
    .update(readFileSync(join(schemaDir, filename)))
    .digest('hex');
  if (actual !== expected) {
    console.error(`${filename}: FAILED`);
    failures += 1;
  } else {
    console.log(`${filename}: OK`);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
