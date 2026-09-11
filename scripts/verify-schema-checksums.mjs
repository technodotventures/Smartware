import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemasRoot = join(repositoryRoot, 'schemas');
// Verify every versioned schema set that ships a checksum manifest
// (v0.4.2 retained for five-verb claims; v0.5.0 is the current set).
const schemaDirs = readdirSync(schemasRoot)
  .filter(name => statSync(join(schemasRoot, name)).isDirectory())
  .sort();

let failures = 0;
let checked = 0;
for (const schemaDirName of schemaDirs) {
  const schemaDir = join(schemasRoot, schemaDirName);
  const checksumPath = join(schemaDir, 'SHA256SUMS');
  const lines = readFileSync(checksumPath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = /^([a-f0-9]{64})\s{2}(.+)$/u.exec(line);
    if (!match) {
      console.error(`[${schemaDirName}] Invalid checksum entry: ${line}`);
      failures += 1;
      continue;
    }
    const [, expected, filename] = match;
    const actual = createHash('sha256')
      .update(readFileSync(join(schemaDir, filename)))
      .digest('hex');
    if (actual !== expected) {
      console.error(`[${schemaDirName}] ${filename}: FAILED`);
      failures += 1;
    } else {
      console.log(`[${schemaDirName}] ${filename}: OK`);
      checked += 1;
    }
  }
}

console.log(`Verified ${checked} schema files across ${schemaDirs.join(', ')}`);
if (failures > 0) {
  process.exitCode = 1;
}
