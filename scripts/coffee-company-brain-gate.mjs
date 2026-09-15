#!/usr/bin/env node
// Coffee company-brain acceptance gate — the PACKAGED-ARTIFACT runner.
//
// What it does, in order:
//   1. `npm pack` the build that is on disk right now (dist/ from `npm run build`);
//   2. `npm install <tarball>` into a scratch app directory, so every import in
//      the fixture resolves through the installed package's own `exports` map —
//      never through this repository's source tree;
//   3. copy the Coffee reference adapter and the fixture next to that install;
//   4. run the fixture (scripts/coffee-company-brain-fixture.mjs): six
//      businesses, overlapping client names, staff and agents, shared/private
//      sources, duplicates, contradictions, corrections, offboarding, erasure,
//      retention expiry, export/restore, replica failover, degraded reads,
//      unauthorized fuzzing, restart-under-load and a soak with latency and
//      resource accounting;
//   5. collect `results.json` + the raw fixture log into the evidence directory
//      and print the verdict.
//
// Usage:  npm run verify:coffee-gate
// Env:    GATE_EVIDENCE_DIR=<dir>   (default /opt/data/workspaces/brain-pilot-evidence/coffee-gate-<UTC>)
//         GATE_KEEP_SCRATCH=0       (default: keep the scratch install for inspection)
//
// Exit code 0 only when every check in the fixture passes.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const evidenceDir = process.env.GATE_EVIDENCE_DIR
  ?? path.join('/opt/data/workspaces/brain-pilot-evidence', `coffee-gate-${stamp}`);
const keepScratch = process.env.GATE_KEEP_SCRATCH !== '0';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-coffee-gate-'));
const logsDir = path.join(evidenceDir, 'logs');
const artifactDir = path.join(evidenceDir, 'artifact');
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(artifactDir, { recursive: true });

const startedAt = new Date().toISOString();
const steps = [];
function step(name, fn) {
  process.stdout.write(`\n▸ ${name}\n`);
  const result = fn();
  steps.push({ name, ok: result.status === 0, status: result.status });
  return result;
}
function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', ...options });
}
function tail(text, lines = 6) {
  const parts = String(text ?? '').trimEnd().split('\n');
  return parts.slice(-lines).join('\n');
}

// ── 1. pack the artifact ────────────────────────────────────────────────────
const pack = step('npm pack', () => run('npm', ['pack', '--pack-destination', artifactDir]));
if (pack.status !== 0) {
  console.error(tail(pack.stderr ?? pack.stdout, 20));
  process.exit(1);
}
const tarballName = (pack.stdout ?? '').trim().split('\n').filter(Boolean).pop()
  ?.trim();
const tarball = path.join(artifactDir, tarballName);
if (!fs.existsSync(tarball)) {
  console.error(`pack did not produce ${tarball}`);
  process.exit(1);
}
const tarballSha = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');

// ── 2. install it into a scratch app ────────────────────────────────────────
const appDir = path.join(scratch, 'app');
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify({ name: 'coffee-gate-app', private: true, type: 'module' }, null, 2)}\n`);
const install = step(`npm install ${tarballName}`, () => run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', tarball], { cwd: appDir }));
if (install.status !== 0) {
  console.error(tail(install.stderr ?? install.stdout, 25));
  process.exit(1);
}
const installedPackage = JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', 'smartware', 'package.json'), 'utf8'));

// ── 3. copy the adapter + the fixture next to the install ───────────────────
fs.copyFileSync(path.join(REPO, 'examples', 'coffee-adapter', 'adapter.mjs'), path.join(appDir, 'coffee-adapter.mjs'));
fs.copyFileSync(path.join(REPO, 'scripts', 'coffee-company-brain-fixture.mjs'), path.join(appDir, 'fixture.mjs'));

// ── 4. run the fixture against the installed package ────────────────────────
const reportPath = path.join(evidenceDir, 'results.json');
const brainsDir = path.join(scratch, 'brains');
const fixture = step('coffee company-brain fixture', () => run('node', ['fixture.mjs', '--report', reportPath], {
  cwd: appDir,
  env: {
    ...process.env,
    GATE_ARTIFACT: tarball,
    GATE_ARTIFACT_SHA256: tarballSha,
    GATE_DATA_DIR: brainsDir,
  },
  timeout: 30 * 60 * 1000,
}));
const fixtureLog = `${fixture.stdout ?? ''}${fixture.stderr ?? ''}`;
fs.writeFileSync(path.join(logsDir, 'fixture.log'), fixtureLog);
process.stdout.write(fixtureLog);

// ── 5. collect the evidence ─────────────────────────────────────────────────
const results = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
const summary = {
  gate: 'coffee-company-brain-acceptance',
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  outcome: results ? results.outcome : 'no-results',
  artifact: {
    file: tarball,
    sha256: tarballSha,
    package_version: installedPackage.version,
    installed_at: path.join(appDir, 'node_modules', 'smartware'),
  },
  scratch_dir: scratch,
  evidence_dir: evidenceDir,
  brains_dir: brainsDir,
  steps,
  fixture: results ? {
    checks_total: results.total,
    checks_passed: results.passed,
    checks_failed: results.failed,
    mode: results.meta?.mode,
    latency: results.meta?.latency,
    resources: results.meta?.resources,
    counts: results.meta?.counts,
    slo_breaches: results.meta?.slo_breaches,
    findings: results.meta?.findings,
    failed_checks: results.checks.filter(check => !check.ok).map(check => check.name),
  } : null,
};
fs.writeFileSync(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const lines = [];
lines.push(`# Coffee company-brain gate — ${stamp}`);
lines.push('');
lines.push(`Artifact: \`${tarballName}\` sha256 \`${tarballSha}\` · package ${installedPackage.version} · Node ${process.version}`);
lines.push('');
lines.push(results
  ? `Outcome: **${summary.outcome}** — ${results.passed}/${results.total} checks passed, ${results.failed} failed.`
  : 'Outcome: **no results** — the fixture did not write a report; read `logs/fixture.log`.');
if (results) {
  lines.push('');
  lines.push('| phase | checks |');
  lines.push('|---|---|');
  for (const [name, group] of Object.entries(results.checks.reduce((acc, check) => {
    const key = check.section || 'other';
    acc[key] = acc[key] ?? { pass: 0, fail: 0 };
    if (check.ok) acc[key].pass += 1; else acc[key].fail += 1;
    return acc;
  }, {}))) {
    lines.push(`| ${name} | ${group.pass}/${group.pass + group.fail} |`);
  }
  lines.push('');
  lines.push('Latency (in-process, in-memory ports — excludes Redis/network):');
  lines.push('');
  lines.push('```');
  lines.push(JSON.stringify(results.meta.latency, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('Resource growth and claim/evidence counts: `summary.json` → `fixture.resources`, `fixture.counts`.');
  if ((results.meta.findings ?? []).length > 0) {
    lines.push('');
    lines.push('Findings (measured, contract-conformant unless stated — for the reviewer):');
    lines.push('');
    for (const finding of results.meta.findings) lines.push(`- **${finding.id}** (${finding.severity}): ${finding.statement}`);
  }
}
lines.push('');
lines.push('Raw fixture log: `logs/fixture.log`. Machine-readable: `results.json`, `summary.json`. Brain directories: see `summary.json.brains_dir`.');
fs.writeFileSync(path.join(evidenceDir, 'README.md'), `${lines.join('\n')}\n`);

if (!keepScratch) fs.rmSync(scratch, { recursive: true, force: true });

console.log('\n=== COFFEE COMPANY-BRAIN GATE RUNNER ===');
console.log(`artifact : ${tarball} (sha256 ${tarballSha})`);
console.log(`evidence : ${evidenceDir}`);
console.log(`scratch  : ${scratch}`);
console.log(results
  ? `checks   : ${results.passed}/${results.total} passed · ${results.failed} failed`
  : 'checks   : no report produced');
console.log(`GATE_RUNNER_OUTCOME=${summary.outcome}`);
process.exit(fixture.status === 0 && summary.outcome === 'pass' ? 0 : 1);
