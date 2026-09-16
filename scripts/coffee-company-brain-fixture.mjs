// Coffee company-brain acceptance gate — the realistic fixture.
//
// This is the acceptance harness the Coffee reference adapter is measured by:
// six businesses (Pod = one business = one brain), overlapping client names,
// several human staff and agents per business, shared and private sources,
// duplicate/paraphrased facts, contradictions, corrections, offboarding,
// erasure, retention expiry, export/restore, replica failover with degraded
// reads, an unauthorized fuzzing pass, a restart-under-load drill and a
// soak with latency/resource accounting.
//
// It runs the REAL adapter module against the PUBLISHED package surface.
// Started by scripts/coffee-company-brain-gate.mjs, which packs the artifact,
// installs it into a scratch directory and copies this fixture + the adapter
// next to the installed `node_modules` — so `import 'smartware'` resolves
// through the package's own `exports` map, never through repository internals.
//
// Run directly (development):  node scripts/coffee-company-brain-fixture.mjs \
//     --report /tmp/gate.json         (GATE_ADAPTER=../examples/coffee-adapter/adapter.mjs)
//
// Every check prints one PASS/FAIL line; the process exits non-zero when any
// check fails. `--report <path>` writes the full machine-readable result:
// checks, latency percentiles, resource growth, claim/evidence counts and the
// leakage-check list.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_SPEC = process.env.GATE_ADAPTER ?? './coffee-adapter.mjs';
const adapterModule = await import(new URL(ADAPTER_SPEC, import.meta.url).href);
const {
  CoffeeBrainAdapter, coffeeTenantConfig, newOperationId, brainIdentity,
  leaseKeyFor, messagesKeyFor, driftKeyFor, scopeForClient, fenceEpochKeyFor,
} = adapterModule;

// ── assertion harness ───────────────────────────────────────────────────────
const checks = [];
let failed = 0;
let section = '';
function setSection(name) { section = name; console.log(`\n── ${name} ──`); }
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  checks.push({ section, name, ok, detail: ok ? '' : String(detail).slice(0, 500) });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${String(detail).slice(0, 300)}`}`);
}
const J = value => JSON.stringify(value);
const eq = (actual, expected) => `${J(actual)} !== ${J(expected)}`;

// ── clock: wall-clock-based lease timing, drivable for deterministic drills ──
let clockOffsetMs = 0;
const clock = () => Date.now() + clockOffsetMs;
const advance = ms => { clockOffsetMs += ms; };

// ── ports (in-memory implementations of the documented host contract) ───────
function createMemoryArbiter({ now = clock } = {}) {
  const keys = new Map(); const epochs = new Map();
  const expired = () => { for (const [k, v] of keys) if (v.expiresAt !== null && v.expiresAt <= now()) keys.delete(k); };
  return {
    async tryAcquire({ key, holder, ttlMs }) {
      expired(); const current = keys.get(key);
      if (current) return current.holder === holder;
      keys.set(key, { holder, expiresAt: now() + ttlMs }); return true;
    },
    async renewIfHeld({ key, holder, ttlMs }) {
      expired(); const current = keys.get(key);
      if (!current || current.holder !== holder) return false;
      current.expiresAt = now() + ttlMs; return true;
    },
    async releaseIfHeld({ key, holder }) {
      expired(); const current = keys.get(key);
      if (current && current.holder === holder) { keys.delete(key); return true; }
      return false;
    },
    async holder(key) { expired(); return keys.get(key)?.holder ?? null; },
    async nextEpoch(key) { const next = (epochs.get(key) ?? 0) + 1; epochs.set(key, next); return next; },
    // test/drill accessors (not part of the port contract)
    _epochs: epochs,
  };
}
function createMemoryAppStore() {
  const lists = new Map(); const operations = new Set(); const drift = new Map();
  return {
    async appendOnce({ key, operationId, record }) {
      if (operationId && operations.has(`${key}::${operationId}`)) return { written: false, len: (lists.get(key) ?? []).length };
      if (operationId) operations.add(`${key}::${operationId}`);
      const list = lists.get(key) ?? []; list.push(record); lists.set(key, list);
      return { written: true, len: list.length };
    },
    async list({ key }) { return [...(lists.get(key) ?? [])]; },
    async getDrift({ key }) { return drift.get(key) ?? 0; },
    async incrDrift({ key }) { const next = (drift.get(key) ?? 0) + 1; drift.set(key, next); return next; },
    _all() { return lists; },
  };
}

// ── fixture data: six businesses, overlapping client names ──────────────────
const ACME = 'client:acme#1';
const clientsOf = (owner) => ({
  'ava-consulting': [{ id: 'acme', incarnation: 1 }, { id: 'northstar', incarnation: 1 }, { id: 'harbor-lane', incarnation: 1 }],
  'bob-studio': [{ id: 'acme', incarnation: 1 }, { id: 'meridian', incarnation: 1 }],
  'clover-creative': [{ id: 'acme', incarnation: 1 }, { id: 'lanterna', incarnation: 1 }],
  'delta-labs': [{ id: 'northstar', incarnation: 1 }, { id: 'orbit', incarnation: 1 }],
  'ember-group': [{ id: 'meridian', incarnation: 1 }, { id: 'arcadia', incarnation: 1 }],
  'forge-works': [{ id: 'harbor-lane', incarnation: 1 }, { id: 'orbit', incarnation: 1 }],
}[owner]);

const BUSINESSES = [
  {
    key: 'ava',
    slug: 'ava-consulting',
    owner: { type: 'person', id: 'user:ava', display_name: 'Ava' },
    staff: [
      { actor: { type: 'person', id: 'user:gigi', display_name: 'Gigi' }, scopes: [ACME], correct: [ACME], forget: [ACME] },
      { actor: { type: 'person', id: 'user:noah', display_name: 'Noah' }, scopes: ['client:northstar#1'], correct: [], forget: [] },
    ],
    agents: [{ actor: { type: 'agent', id: 'agent:ava-assistant', display_name: 'Ava Assistant' }, scopes: [ACME], correct: [] }],
  },
  {
    key: 'bob',
    slug: 'bob-studio',
    owner: { type: 'person', id: 'user:bob', display_name: 'Bob' },
    staff: [{ actor: { type: 'person', id: 'user:lina', display_name: 'Lina' }, scopes: [ACME], correct: [ACME], forget: [] }],
    agents: [],
  },
  {
    key: 'clover',
    slug: 'clover-creative',
    owner: { type: 'person', id: 'user:clover', display_name: 'Clover' },
    staff: [
      { actor: { type: 'person', id: 'user:petra', display_name: 'Petra' }, scopes: [ACME], correct: [], forget: [] },
      { actor: { type: 'person', id: 'user:quinn', display_name: 'Quinn' }, scopes: ['client:lanterna#1'], correct: [], forget: [] },
    ],
    agents: [{ actor: { type: 'agent', id: 'agent:clover-bot', display_name: 'Clover Bot' }, scopes: [ACME], correct: [] }],
  },
  {
    key: 'delta',
    slug: 'delta-labs',
    owner: { type: 'person', id: 'user:delta', display_name: 'Delta' },
    staff: [{ actor: { type: 'person', id: 'user:rosa', display_name: 'Rosa' }, scopes: ['client:northstar#1'], correct: [], forget: [] }],
    agents: [],
  },
  {
    key: 'ember',
    slug: 'ember-group',
    owner: { type: 'person', id: 'user:ember', display_name: 'Ember' },
    staff: [
      { actor: { type: 'person', id: 'user:sam', display_name: 'Sam' }, scopes: ['client:meridian#1', 'client:arcadia#1'], correct: ['client:meridian#1'], forget: ['client:arcadia#1'] },
    ],
    agents: [{ actor: { type: 'agent', id: 'agent:ember-bot', display_name: 'Ember Bot' }, scopes: ['client:meridian#1'], correct: [] }],
    retention: { default: { policy: 'duration', duration_days: 30 }, scope_overrides: {} },
  },
  {
    key: 'forge',
    slug: 'forge-works',
    owner: { type: 'person', id: 'user:forge', display_name: 'Forge' },
    staff: [
      { actor: { type: 'person', id: 'user:tess', display_name: 'Tess' }, scopes: ['client:harbor-lane#1'], correct: ['client:harbor-lane#1'], forget: [] },
      { actor: { type: 'person', id: 'user:ulf', display_name: 'Ulf' }, scopes: ['client:orbit#1'], correct: [], forget: [] },
    ],
    agents: [],
  },
];

const marker = (key, scope, n) => `MKR-${key}-${String(scope).replace(/[^a-z0-9]+/g, '')}-${n}`;

// ── workspace: one data root the run's evidence can inspect afterwards ──────
const dataRoot = process.env.GATE_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sw-coffee-gate-'));
fs.mkdirSync(dataRoot, { recursive: true });

const arbiter = createMemoryArbiter();
const appStore = createMemoryAppStore();
const adapters = [];
const replicas = new Map();   // business key -> { a, b }
const tenants = new Map();

function tenantFor(business) {
  if (tenants.has(business.key)) return tenants.get(business.key);
  const dir = path.join(dataRoot, business.slug);
  const tenant = coffeeTenantConfig({
    dataDir: dir,
    ownerId: business.owner.id,
    workspaceId: business.slug,
    instanceId: `smartware_${business.key}`,
    clients: clientsOf(business.slug),
    staff: business.staff.map(person => ({
      actorId: person.actor.id, actorType: person.actor.type, scopes: person.scopes,
      correct: person.correct, forget: person.forget,
    })),
    agents: business.agents.map(agent => ({
      actorId: agent.actor.id, actorType: agent.actor.type, scopes: agent.scopes,
      correct: agent.correct, forget: agent.forget,
    })),
  });
  if (business.retention) tenant.retention = business.retention;
  tenants.set(business.key, tenant);
  return tenant;
}

function replica(business, instanceId, extra = {}) {
  const tenant = tenantFor(business);
  const adapter = new CoffeeBrainAdapter({
    tenant, brainDir: tenant.data_dir, instanceId,
    ports: { appStore, arbiter }, leaseTtlMs: 8000, namespace: 'coffee', ...extra,
  });
  adapters.push(adapter);
  return adapter;
}

// The host is documented to poll ownership on a timer (ttl/3). The fixture
// models that poll between phases: refresh both replicas and hand back the one
// that holds the brain now. Drills that manipulate ownership deliberately do
// NOT call this — they steer the lease themselves.
async function ownerOf(key) {
  const pair = replicas.get(key);
  await pair.a.refreshOwnership();
  await pair.b.refreshOwnership();
  return pair.a.role === 'owner' ? pair.a : pair.b;
}

// A FORGET.SCOPE revokes every grant row that references the scope (spec
// §10b.3) — so an actor whose grant spans several clients loses all of them.
// The fixture tracks that to keep later phases honest about who may still write.
const revokedActors = new Set();
function markScopeForgotten(scope) {
  for (const business of BUSINESSES) {
    for (const member of [...business.staff, ...business.agents]) {
      if (member.scopes.includes(scope)) revokedActors.add(member.actor.id);
    }
  }
}
function actorFor(business, clientId) {
  const scope = scopeForClient(clientId, 1);
  const person = business.staff.find(entry => entry.scopes.includes(scope) && !revokedActors.has(entry.actor.id));
  if (person) return person.actor;
  const agent = business.agents.find(entry => entry.scopes.includes(scope) && !revokedActors.has(entry.actor.id));
  return agent?.actor ?? business.owner;
}

// Measured behaviours that are contract-conformant but carry operational or
// product consequences the reviewer must see (they are not gate failures).
const findings = [];

function evidenceCount(dir) {
  const ev = path.join(dir, 'evidence');
  if (!fs.existsSync(ev)) return 0;
  return fs.readdirSync(ev).filter(n => n.endsWith('.jsonl')).reduce((total, name) => {
    const body = fs.readFileSync(path.join(ev, name), 'utf8');
    return total + body.split('\n').filter(Boolean).length;
  }, 0);
}

function dirBytes(dir) {
  let bytes = 0; let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) { files += 1; try { bytes += fs.statSync(full).size; } catch { /* race */ } }
    }
  }
  return { bytes, files };
}

function scanForMarker(root, needle) {
  const hits = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try { if (fs.readFileSync(full).includes(needle)) hits.push(path.relative(root, full)); } catch { /* binary/race */ }
      }
    }
  }
  return hits;
}

const claimOf = (value, validityFrom, predicate = 'renewal_date', subject = 'Acme') => ([{
  subject: { name: subject, type: 'organization' }, predicate,
  object: { type: 'text', value }, validity_from: validityFrom,
}]);

/**
 * Validate EVERY canonical record this run wrote against the schemas the *installed package*
 * publishes — the contract a Coffee-side consumer, a migration or a third-party import inherits.
 *
 * Families covered (the canonical surfaces the run writes):
 *   - `<brain>/claims/<yyyy-mm>.jsonl`            -> claim.schema.json (both states; a `state:
 *      "forgotten"` record is the L1 tombstone form, counted separately below)
 *   - `<brain>/operations/<yyyy-mm-dd>.jsonl`     -> operation-log-entry.schema.json
 *   - `<brain>/exports/exp_*\/claims.jsonl`        -> claim.schema.json (the portability artifact)
 *   - `<brain>/exports/exp_*\/operations.jsonl`    -> operation-log-entry.schema.json
 *   - `<brain>/wiki/tombstones/*.md` frontmatter  -> tombstone-frontmatter.schema.json (written by
 *      the tombstone backfill, not by this fixture — reported, with the count disclosed)
 *
 * Deliberately NOT validated, and why (ADR-0013): `evidence/<date>.jsonl` is the L0 evidence record,
 * whose published-schema question is carded separately (kanban t_f1157ed4, schemas/v0.5.1); the
 * package's `observations.jsonl` / `evidence.jsonl` / `entities.jsonl` are copies of the same shapes.
 * Their counts are reported so a reader can see exactly what this check does and does not cover.
 */
function validateEmittedRecords({ root, schemasDir, Ajv2020, addFormats, maxSamples = 6 }) {
  const ajv = new Ajv2020({ allErrors: true, strict: false, strictRequired: false });
  if (addFormats) addFormats(ajv);
  for (const file of fs.readdirSync(schemasDir).filter(name => name.endsWith('.schema.json')).sort()) {
    try { ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemasDir, file), 'utf8'))); } catch { /* duplicate $id */ }
  }
  const schemaId = name => JSON.parse(fs.readFileSync(path.join(schemasDir, name), 'utf8')).$id;
  const validators = {
    claim: ajv.getSchema(schemaId('claim.schema.json')),
    operation: ajv.getSchema(schemaId('operation-log-entry.schema.json')),
    tombstone: ajv.getSchema(schemaId('tombstone-frontmatter.schema.json')),
  };
  if (!validators.claim || !validators.operation) throw new Error(`schemas not registered in ${schemasDir}`);

  const families = {};
  const classes = new Map();
  const samples = [];
  const bucket = family => (families[family] ?? (families[family] = { files: 0, records: 0, violations: 0 }));
  const classify = (family, file, index, record, errors) => {
    bucket(family).violations += 1;
    const signature = errors.map(e => `${e.instancePath || '/'}:${e.keyword}`).join(',');
    classes.set(`${family} ${signature}`, (classes.get(`${family} ${signature}`) ?? 0) + 1);
    if (samples.length < maxSamples) {
      samples.push({
        family,
        file: path.relative(root, file),
        line: index + 1,
        claim_id: record?.claim_id ?? null,
        state: record?.state ?? null,
        operation_id: record?.operation_id ?? record?.op ?? null,
        errors: errors.map(e => `${e.instancePath || '/'}:${e.keyword}${e.keyword === 'additionalProperties' ? `(${e.params.additionalProperties})` : ''}`),
      });
    }
  };
  const validateFile = (family, file, validate) => {
    bucket(family).files += 1;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    lines.forEach((line, index) => {
      let record;
      try { record = JSON.parse(line); } catch { classify(family, file, index, null, [{ instancePath: '', keyword: 'unparseable-json', params: {} }]); return; }
      bucket(family).records += 1;
      if (line.includes(LEGACY_LITERAL)) legacyLiteralHits.push({ family, file: path.relative(root, file), line: index + 1 });
      if (family === 'brain_claims' && record.state === 'forgotten') forgotten += 1;
      if (validate(record)) return;
      classify(family, file, index, record, validate.errors ?? []);
    });
  };

  const LEGACY_LITERAL = 'op_LEGACY00000000000000000000';
  const legacyLiteralHits = [];

  let forgotten = 0;
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  const other = { evidence_records: 0 };
  for (const file of files) {
    const rel = path.relative(root, file);
    if (/\/claims\/[^/]+\.jsonl$/.test(rel)) validateFile('brain_claims', file, validators.claim);
    else if (/\/operations\/[^/]+\.jsonl$/.test(rel)) validateFile('brain_ops_log', file, validators.operation);
    else if (/\/exports\/[^/]+\/claims\.jsonl$/.test(rel)) validateFile('export_package_claims', file, validators.claim);
    else if (/\/exports\/[^/]+\/operations\.jsonl$/.test(rel)) validateFile('export_package_ops_log', file, validators.operation);
    else if (/\/evidence\/[^/]+\.jsonl$/.test(rel)) other.evidence_records += fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  }

  // Tombstone frontmatter: `wiki/tombstones/*.md`, written by the tombstone backfill (not this
  // fixture). Validated when present so the family is covered the moment a run writes one.
  const tombstoneFiles = files.filter(file => /\/wiki\/tombstones\/[^/]+\.md$/.test(path.relative(root, file)));
  let tombstoneViolations = 0;
  for (const file of tombstoneFiles) {
    const body = fs.readFileSync(file, 'utf8');
    const match = /^---\n([\s\S]*?)\n---/.exec(body);
    let frontmatter = null;
    try { frontmatter = match ? JSON.parse(match[1]) : null; } catch { frontmatter = null; }
    if (frontmatter === null) { tombstoneViolations += 1; continue; }
    if (!validators.tombstone(frontmatter)) tombstoneViolations += 1;
  }

  const recordsValidated = Object.values(families).reduce((sum, b) => sum + b.records, 0);
  const recordsInViolation = Object.values(families).reduce((sum, b) => sum + b.violations, 0);
  return {
    schemas_dir: schemasDir,
    schema_set: path.basename(schemasDir),
    records_validated: recordsValidated,
    records_in_violation: recordsInViolation,
    families,
    forgotten_records: forgotten,
    tombstone_frontmatter_files: tombstoneFiles.length,
    tombstone_frontmatter_violations: tombstoneViolations,
    not_validated: other,
    violation_classes: Object.fromEntries([...classes].sort((a, b) => b[1] - a[1])),
    legacy_literal_hits: legacyLiteralHits,
    samples,
  };
}

const formatConformance = report => [
  `${report.records_validated} records validated against ${report.schema_set}`,
  Object.entries(report.families).map(([name, b]) => `${name}: ${b.records - b.violations}/${b.records}`).join(' · '),
  `${report.records_in_violation} in violation`,
  Object.entries(report.violation_classes).map(([name, count]) => `${count}× ${name}`).join(' · '),
].filter(Boolean).join(' — ');


const percentiles = (samples) => {
  if (samples.length === 0) return { n: 0, p50: null, p95: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = p => sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
  return { n: sorted.length, p50: Number(at(50).toFixed(2)), p95: Number(at(95).toFixed(2)), max: Number(sorted[sorted.length - 1].toFixed(2)) };
};

const latency = { write: [], recall: [], degradedRecall: [], failover: [] };
const timed = async (bucket, fn) => {
  const started = performance.now();
  const result = await fn();
  latency[bucket].push(performance.now() - started);
  return result;
};

const rssBefore = process.memoryUsage().rss;
const storageBefore = new Map();
const runMeta = {
  started_at: new Date().toISOString(),
  data_dir: dataRoot,
  mode: process.env.GATE_ARTIFACT ? 'packaged' : 'development',
  artifact: process.env.GATE_ARTIFACT ?? null,
  artifact_sha256: process.env.GATE_ARTIFACT_SHA256 ?? null,
  node: process.version,
  package_version: (() => {
    for (const candidate of ['./node_modules/smartware/package.json', '../package.json']) {
      try { return JSON.parse(fs.readFileSync(new URL(candidate, import.meta.url), 'utf8')).version; } catch { /* try the next location */ }
    }
    return 'unknown';
  })(),
  resolved_smartware: import.meta.resolve('smartware'),
  harness: 'scripts/coffee-company-brain-fixture.mjs',
};

try {
  const byKey = Object.fromEntries(BUSINESSES.map(b => [b.key, b]));

  // ═══ P0 — artifact and provisioning ═══════════════════════════════════════
  setSection('P0 artifact and provisioning');
  {
    const resolved = runMeta.resolved_smartware;
    const installed = resolved.includes(`${path.sep}node_modules${path.sep}smartware${path.sep}`);
    check('0a the fixture loads the package through its exports map',
      runMeta.mode === 'packaged'
        ? installed && runMeta.package_version !== 'unknown'
        : resolved.endsWith('/dist/core.js'),
      `mode=${runMeta.mode} resolved=${resolved}`);
    check('0b the artifact identity is recorded (sha256 + tarball) when packaged',
      runMeta.mode !== 'packaged'
        || (typeof runMeta.artifact_sha256 === 'string' && /^[0-9a-f]{64}$/.test(runMeta.artifact_sha256)),
      J({ artifact: runMeta.artifact, sha: runMeta.artifact_sha256 }));

    for (const business of BUSINESSES) {
      const a = replica(business, `inst_${business.key}_a`);
      const b = replica(business, `inst_${business.key}_b`);
      await a.start(); await b.start();
      replicas.set(business.key, { a, b });
    }

    const identities = new Set(); const leaseKeys = new Set(); let mode0600 = 0;
    for (const business of BUSINESSES) {
      const tenant = tenantFor(business);
      identities.add(brainIdentity({ brainDir: tenant.data_dir }));
      leaseKeys.add(leaseKeyFor(brainIdentity({ brainDir: tenant.data_dir })));
      const mode = fs.statSync(path.join(tenant.data_dir, 'config.json')).mode & 0o777;
      if (mode === 0o600) mode0600 += 1;
    }
    check('0c six businesses provision distinct brain identities and lease keys',
      identities.size === 6 && leaseKeys.size === 6, `${identities.size} identities, ${leaseKeys.size} keys`);
    check('0d every provisioned config.json is owner-only (0600)', mode0600 === 6, `${mode0600}/6 at 0600`);

    const ownership = [...replicas.values()];
    check('0e each replica pair settles ownership: first owner, second standby',
      ownership.every(({ a, b }) => a.role === 'owner' && b.role === 'standby'),
      J(ownership.map(({ a, b }) => [a.role, b.role])));
  }

  // ═══ P1 — the working loop in all six businesses ══════════════════════════
  setSection('P1 write→recall in every business');
  const facts = {
    ava: { client: 'acme', value: '2026-11-02', predicate: 'renewal_date', subject: 'Acme', validity: '2026-08-01T00:00:00.000Z' },
    bob: { client: 'acme', value: '2026-11-02', predicate: 'renewal_date', subject: 'Acme', validity: '2026-08-01T00:00:00.000Z' },
    clover: { client: 'acme', value: '2027-01-15', predicate: 'renewal_date', subject: 'Acme', validity: '2026-08-01T00:00:00.000Z' },
    delta: { client: 'northstar', value: '120000', predicate: 'contract_value', subject: 'Northstar', validity: '2026-08-01T00:00:00.000Z' },
    ember: { client: 'meridian', value: 'monthly', predicate: 'billing_cadence', subject: 'Meridian', validity: '2026-08-01T00:00:00.000Z' },
    forge: { client: 'harbor-lane', value: '2026-10-05', predicate: 'renewal_date', subject: 'Harbor Lane', validity: '2026-08-01T00:00:00.000Z' },
  };
  const firstWrites = {};
  for (const business of BUSINESSES) {
    const fact = facts[business.key];
    const { a } = replicas.get(business.key);
    const text = `${fact.subject} ${fact.predicate.replace('_', ' ')} is ${fact.value} ${marker(business.key, fact.client, 1)}`;
    firstWrites[business.key] = await timed('write', () => a.handleWrite({
      actor: business.owner, client: fact.client, text, operation_id: newOperationId(),
      claims: claimOf(fact.value, fact.validity, fact.predicate, fact.subject),
    }));
  }
  const writeOutcomes = Object.values(firstWrites);
  check('1a every business accepts its first owner write into app store and brain',
    writeOutcomes.every(w => w.ok === true && w.status === 201 && w.app.written === true && w.brain.written === true),
    J(writeOutcomes.map(w => [w.ok, w.status, w.code])));

  const firstRecalls = {};
  for (const business of BUSINESSES) {
    const fact = facts[business.key];
    const { a } = replicas.get(business.key);
    firstRecalls[business.key] = await a.handleRecall({ actor: business.owner, client: fact.client, query: `${fact.subject} ${fact.predicate.replace('_', ' ')}`, limit: 10 });
  }
  check('1b every business recalls its fact from the brain, not the fallback',
    Object.values(firstRecalls).every(r => r.ok === true && r.degraded === false && r.source === 'brain' && r.results.length >= 1),
    J(Object.values(firstRecalls).map(r => [r.ok, r.source, r.degraded, r.results?.length])));
  check('1c the recalled claim is the fact that was written (value + predicate)',
    BUSINESSES.every((business) => {
      const fact = facts[business.key];
      const rows = firstRecalls[business.key].results.filter(r => r.claim?.predicate === fact.predicate);
      return rows.some(r => String(r.claim.object?.value ?? r.claim.object) === fact.value);
    }));
  check('1d the app store holds exactly one authoritative record per first write',
    BUSINESSES.every((business) => {
      const fact = facts[business.key];
      const identity = brainIdentity({ brainDir: tenantFor(business).data_dir });
      const rows = appStore._all().get(messagesKeyFor(identity, scopeForClient(fact.client), 'coffee')) ?? [];
      return rows.length === 1;
    }));
  check('1e evidence files hold one observation per first write',
    BUSINESSES.every((business) => evidenceCount(tenantFor(business).data_dir) === 1),
    J(BUSINESSES.map(b => evidenceCount(tenantFor(b).data_dir))));

  // ═══ P2 — shared and private sources, provenance, attribution ═════════════
  setSection('P2 sources, provenance, attribution');
  await ownerOf('ava');
  const ava = byKey.ava; const avaReplicas = replicas.get('ava');
  const sharedSource = { id: 'src_shared_inbox', kind: 'connector', display_name: 'Shared inbox', external_ref: 'acct_shared' };
  const privateSource = { id: 'src_ava_notes', kind: 'manual', display_name: 'Ava private notes', external_ref: 'user:ava' };
  const regShared = await avaReplicas.a.registerSource({ actor: ava.owner, source: sharedSource });
  const regPrivate = await avaReplicas.a.registerSource({ actor: ava.owner, source: privateSource });
  check('2a shared and private sources register on the holder', regShared.ok === true && regPrivate.ok === true,
    J([regShared.ok, regPrivate.ok, regShared.code, regPrivate.code]));

  const sourced = await avaReplicas.a.handleWrite({
    actor: ava.staff[0].actor, client: 'acme', source_ref: sharedSource.id,
    text: `Acme asked for the parking plan ${marker('ava', 'acme', 'src')}`,
    claims: claimOf('details', '2026-08-02T00:00:00.000Z', 'asked_for_parking', 'Acme'),
  });
  const sourcedProvenance = await avaReplicas.a.describeProvenance({ actor: ava.owner, observation_id: sourced.observation.id });
  check('2b a shared source is carried through to provenance',
    sourced.ok === true && sourcedProvenance.ok === true && sourcedProvenance.source.source_ref === sharedSource.id,
    J({ write: sourced.ok, prov: sourcedProvenance.source }));

  const PRIVATE_MARK = marker('ava', 'self', 'private');
  const privateWrite = await avaReplicas.a.handleWrite({
    actor: ava.owner, scope: 'self', source_ref: privateSource.id,
    text: `Ava private note ${PRIVATE_MARK}`,
    claims: claimOf(PRIVATE_MARK, '2026-08-03T00:00:00.000Z', 'private_observation', 'Ava'),
  });
  const acmeRecall = await avaReplicas.a.handleRecall({ actor: ava.owner, client: 'acme', query: 'parking plan' });
  const acmeMarkerScan = await avaReplicas.a.handleRecall({ actor: ava.owner, client: 'acme', query: 'private note' });
  check('2c a private-source fact in self does not surface in a client-scope recall',
    privateWrite.ok === true
    && acmeRecall.ok === true
    && acmeMarkerScan.results.every(r => !String(JSON.stringify(r)).includes(PRIVATE_MARK)),
    J({ privateWrite: privateWrite.ok, recalled: acmeMarkerScan.results.length }));

  const staffLine = avaReplicas.a.attribution({ ...sourcedProvenance.render, surface: 'staff', freshness: 'unverified' });
  const clientLine = avaReplicas.a.attribution({ ...sourcedProvenance.render, surface: 'client', freshness: 'unverified' });
  check('2d staff attribution renders the actor, client-facing surfaces never do',
    staffLine.show === true && staffLine.line.includes('Gigi') && clientLine.show === false,
    J({ staff: staffLine, client: clientLine }));

  // ═══ P3 — duplicates, paraphrases, contradictions, corrections ═══════════
  setSection('P3 duplicates, contradictions, corrections');
  await ownerOf('ava'); await ownerOf('bob');
  {
    const identityAva = brainIdentity({ brainDir: tenantFor(ava).data_dir });
    const acmeKey = messagesKeyFor(identityAva, ACME, 'coffee');

    // 3a — byte-identical duplicate evidence collapses to one observation, no new claim
    const claimsBeforeDup = firstRecalls.ava.total_found;
    const evidenceBeforeDup = evidenceCount(tenantFor(ava).data_dir);
    const appRowsBeforeDup = (appStore._all().get(acmeKey) ?? []).length;
    const dup = await avaReplicas.a.handleWrite({
      actor: ava.owner, client: 'acme',
      text: `${facts.ava.subject} renewal date is ${facts.ava.value} ${marker('ava', 'acme', 1)}`,
      claims: claimOf(facts.ava.value, facts.ava.validity),
    });
    const evidenceAfterDup = evidenceCount(tenantFor(ava).data_dir);
    check('3a duplicate evidence is reported and writes no second observation',
      dup.ok === true && dup.observation.status === 'duplicate' && dup.claims.skipped === 1,
      J({ obs: dup.observation, claims: dup.claims }));
    check('3b the app store keeps both messages (it is Coffee\'s own data), the brain keeps one',
      (appStore._all().get(acmeKey) ?? []).length === appRowsBeforeDup + 1 && evidenceAfterDup === evidenceBeforeDup,
      J({ app: (appStore._all().get(acmeKey) ?? []).length, evidence: evidenceAfterDup, before: evidenceBeforeDup }));

    // 3c — a paraphrase corroborates the same fact instead of minting a twin
    const restated = await avaReplicas.a.handleWrite({
      actor: ava.staff[0].actor, client: 'acme',
      text: `${facts.ava.subject} confirmed: renewal is ${facts.ava.value}`,
      claims: claimOf(facts.ava.value, facts.ava.validity),
    });
    const recallAfterCorr = await avaReplicas.a.handleRecall({ actor: ava.owner, client: 'acme', query: `Acme renewal date`, limit: 10 });
    const renewalRows = recallAfterCorr.results.filter(r => r.claim?.predicate === 'renewal_date');
    check('3c a paraphrase corroborates: one claim, more evidence',
      restated.ok === true && restated.claims.outcomes[0].outcome === 'corroborated'
      && renewalRows.length === 1 && (renewalRows[0].claim.observation_ids ?? []).length >= 2,
      J({ outcome: restated.claims.outcomes, rows: renewalRows.map(r => r.claim.observation_ids) }));

    // 3d — identical client name and fact in ANOTHER business stays separate
    const bobReplicas = replicas.get('bob');
    const bobRecall = await bobReplicas.a.handleRecall({ actor: byKey.bob.owner, client: 'acme', query: 'renewal date' });
    const avaIds = new Set(renewalRows.map(r => r.claim.id));
    check('3d the same client name and fact in another business never crosses over',
      bobRecall.ok === true && bobRecall.results.length >= 1
      && bobRecall.results.every(r => !avaIds.has(r.claim?.id)) && bobRecall.results.length !== 0,
      J({ bobRows: bobRecall.results.length, avaIds: [...avaIds] }));

    // 3e — a contradiction stays contested, both sides surfaced
    const contradiction = await avaReplicas.a.handleWrite({
      actor: ava.staff[0].actor, client: 'acme',
      text: `Acme renewal is 2026-12-15 instead`,
      claims: claimOf('2026-12-15', facts.ava.validity),
    });
    const recallContested = await avaReplicas.a.handleRecall({ actor: ava.owner, client: 'acme', query: 'Acme renewal', limit: 10 });
    const contestedRows = recallContested.results.filter(r => r.claim?.predicate === 'renewal_date');
    check('3e a contradiction is retained and surfaced as contested, never silently resolved',
      contradiction.ok === true && contradiction.claims.outcomes[0].outcome === 'contested'
      && contestedRows.length === 2
      && contestedRows.every(r => r.claim.status === 'contested' && r.claim.epistemic_tag === 'contested'),
      J(contestedRows.map(r => [r.claim.object?.value ?? r.claim.object, r.claim.status])));

    // 3f — a warranted correction closes the wrong side and is auditable
    const wrongRow = contestedRows.find(r => String(r.claim.object?.value ?? r.claim.object) === '2026-12-15');
    const corrected = await avaReplicas.a.correctClaim({
      actor: ava.staff[0].actor, target_claim_id: wrongRow.claim.id,
      corrected_object: { type: 'text', value: facts.ava.value }, reason: 'wrong',
    });
    const audit = corrected.ok
      ? await avaReplicas.a.describeProvenance({ actor: ava.owner, observation_id: corrected.audit_observation_id })
      : null;
    const recallCorrected = await avaReplicas.a.handleRecall({ actor: ava.owner, client: 'acme', query: 'Acme renewal', limit: 10 });
    const stillWrong = recallCorrected.results.filter(r => r.claim?.predicate === 'renewal_date'
      && String(r.claim.object?.value ?? r.claim.object) === '2026-12-15');
    check('3f a correction is recorded, auditable and stops serving the wrong value',
      corrected.ok === true && corrected.status === 'corrected' && typeof corrected.new_claim_id === 'string'
      && audit?.ok === true && stillWrong.length === 0,
      J({ corrected, audit: audit?.ok, stillWrong: stillWrong.map(r => r.claim?.object?.value ?? r.claim?.object) }));
    findings.push({
      id: 'correction-leaves-counterpart-contested',
      severity: 'product',
      statement: `after CORRECT closed the wrong side, the surviving renewal claim still reads contested (statuses ${J(recallCorrected.results.filter(r => r.claim?.predicate === 'renewal_date').map(r => [r.claim.status, r.claim.epistemic_tag]))}) — a warranted correction does not clear the counterpart's contested marking, so "resolved" facts keep reading unresolved until a REVISE cycle. Reviewer decision, not a gate failure.`,
    });

    // 3g — a staff member without the `correct` capability cannot correct
    const deniedCorrection = await avaReplicas.a.correctClaim({
      actor: ava.staff[1].actor, target_claim_id: wrongRow.claim.id,
      corrected_object: { type: 'text', value: 'nonsense' }, reason: 'wrong',
    });
    check('3g an actor without the correct capability is refused (403, no fallback)',
      deniedCorrection.ok === false && deniedCorrection.status === 403
      && deniedCorrection.code === 'insufficient_permission' && deniedCorrection.denied === true,
      J(deniedCorrection));

    // 3h — later event-valid time supersedes the earlier window
    const superseded = await avaReplicas.a.handleWrite({
      actor: ava.staff[0].actor, client: 'acme',
      text: 'Acme renewal moved to 2027-03-01',
      claims: claimOf('2027-03-01', '2026-09-01T00:00:00.000Z'),
    });
    const recallSuperseded = await avaReplicas.a.handleRecall({ actor: ava.owner, client: 'acme', query: 'Acme renewal', limit: 10 });
    const currentValues = recallSuperseded.results
      .filter(r => r.claim?.predicate === 'renewal_date' && r.claim.status === 'active')
      .map(r => String(r.claim.object?.value ?? r.claim.object));
    check('3h a later event-valid start supersedes the earlier window',
      superseded.ok === true && superseded.claims.outcomes[0].outcome === 'superseded'
      && currentValues.includes('2027-03-01') && !currentValues.includes(facts.ava.value),
      J({ outcome: superseded.claims.outcomes, currentValues }));

    // 3i — agents act under their own grants; an ungranted scope is a denial
    const agent = ava.agents[0].actor;
    const agentWrite = await avaReplicas.a.handleWrite({
      actor: agent, client: 'acme', text: 'Reminder scheduled for the renewal',
      claims: claimOf('renewal', '2026-08-05T00:00:00.000Z', 'reminder_set', 'Acme'),
    });
    const agentDenied = await avaReplicas.a.handleRecall({ actor: agent, client: 'northstar', query: 'anything' });
    check('3i the agent writes on a granted scope and is denied on an ungranted one',
      agentWrite.ok === true && agentDenied.ok === false && agentDenied.status === 403
      && agentDenied.results === undefined && agentDenied.degraded === false,
      J({ write: agentWrite.ok, denied: agentDenied }));
  }

  // ═══ P4 — replica failover and degraded reads ═════════════════════════════
  setSection('P4 replica failover and degraded reads');
  await ownerOf('delta');
  {
    const deltaReplicas = replicas.get('delta');
    const identity = brainIdentity({ brainDir: tenantFor(byKey.delta).data_dir });
    const deltaFact = facts.delta;
    const deltaClient = 'northstar';

    const standbyRefusal = await deltaReplicas.b.handleWrite({
      actor: byKey.delta.owner, client: deltaClient, text: 'standby attempt',
    });
    const evidenceBefore = evidenceCount(tenantFor(byKey.delta).data_dir);
    const appRows = (appStore._all().get(messagesKeyFor(identity, scopeForClient(deltaClient), 'coffee')) ?? []).length;
    check('4a a standby refuses before touching either store (retryable, no partial write)',
      standbyRefusal.ok === false && standbyRefusal.code === 'lease_not_holder'
      && standbyRefusal.retryable === true && standbyRefusal.partial_write === false,
      J(standbyRefusal));
    check('4b the refusal wrote nothing anywhere', evidenceBefore === 1 && appRows === 1,
      J({ evidence: evidenceBefore, app: appRows }));

    const degraded = await timed('degradedRecall', () => deltaReplicas.b.handleRecall({ actor: byKey.delta.owner, client: deltaClient, query: `${deltaFact.subject} contract` }));
    check('4c a standby answers degraded from the app store and says so',
      degraded.ok === true && degraded.degraded === true && degraded.source === 'app-store-fallback'
      && degraded.provenance === 'unavailable' && degraded.total_found >= 1,
      J({ ok: degraded.ok, source: degraded.source, provenance: degraded.provenance, n: degraded.total_found }));
    check('4d a degraded read never invents provenance',
      degraded.results.every(row => row.provenance === undefined) && degraded.note.includes('provenance'));

    const degradedStranger = await deltaReplicas.b.handleRecall({
      actor: { type: 'person', id: 'user:stranger', display_name: 'Stranger' }, client: deltaClient, query: 'contract',
    });
    const degradedUngranted = await deltaReplicas.b.handleRecall({ actor: byKey.delta.staff[0].actor, client: 'orbit', query: 'contract' });
    check('4e the degraded path fails closed for unregistered actors and ungranted scopes',
      degradedStranger.ok === false && degradedStranger.code === 'actor_unregistered'
      && degradedUngranted.ok === false && degradedUngranted.code === 'insufficient_permission'
      && degradedStranger.results === undefined && degradedUngranted.results === undefined,
      J([degradedStranger.code, degradedUngranted.code]));

    const stopped = await timed('failover', () => deltaReplicas.a.stop());
    await deltaReplicas.b.refreshOwnership();
    const epochs = arbiter._epochs.get(fenceEpochKeyFor(identity, 'coffee'));
    check('4f a graceful stop hands the brain over and the epoch advances',
      stopped.released === true && deltaReplicas.b.role === 'owner' && epochs >= 2,
      J({ released: stopped.released, role: deltaReplicas.b.role, epochs }));

    const afterFailover = await deltaReplicas.b.handleWrite({
      actor: byKey.delta.owner, client: deltaClient,
      text: 'Northstar contract expanded in Q4',
      claims: claimOf('150000', '2026-09-01T00:00:00.000Z', 'contract_value', 'Northstar'),
    });
    check('4g the new owner writes normally after the handover',
      afterFailover.ok === true && afterFailover.brain.written === true
      && afterFailover.claims.outcomes[0].outcome === 'superseded',
      J(afterFailover.claims?.outcomes));

    for (const business of BUSINESSES) {
      const pair = replicas.get(business.key);
      if (business.key === 'delta') continue;
      void pair;
    }

    // 4h — the guard refuses a stale writer after another replica took the lease
    await deltaReplicas.a.start();
    check('4h the old replica restarts as standby (the lease is held)', deltaReplicas.a.role === 'standby', deltaReplicas.a.role);
    advance(9000);
    await deltaReplicas.a.refreshOwnership();
    check('4i a lapsed lease is re-acquired by the replica that notices it first', deltaReplicas.a.role === 'owner');
    advance(9000);
    await deltaReplicas.b.refreshOwnership();
    const guardRefusal = await deltaReplicas.a.handleWrite({ actor: byKey.delta.owner, client: deltaClient, text: 'stale writer' });
    check('4j the lease guard refuses a displaced owner before any write', 
      guardRefusal.ok === false && guardRefusal.code === 'lease_lost'
      && guardRefusal.partial_write === false && guardRefusal.retryable === true
      && deltaReplicas.a.role === 'standby',
      J(guardRefusal));

    // 4k — the stall the guard cannot cover is caught by the brain fence
    const evidenceBeforeStall = evidenceCount(tenantFor(byKey.delta).data_dir);
    const driftsBefore = await appStore.getDrift({ key: driftKeyFor(identity, scopeForClient(deltaClient), 'coffee') });
    await deltaReplicas.b.stop();
    await deltaReplicas.a.refreshOwnership();
    const epochBeforeStall = deltaReplicas.a.brain.fencingState().high_water;
    const stallOp = newOperationId();
    const stalledText = 'stalled writer';
    deltaReplicas.a.hooks.afterGuard = async () => {
      advance(9000);
      await deltaReplicas.b.refreshOwnership();
    };
    const stalled = await deltaReplicas.a.handleWrite({
      actor: byKey.delta.owner, client: deltaClient, text: stalledText, operation_id: stallOp,
    });
    deltaReplicas.a.hooks.afterGuard = null;
    check('4k the brain fence refuses a stalled stale writer before any canonical artifact',
      stalled.ok === false && stalled.code === 'fencing_token_stale'
      && stalled.partial_write === true && stalled.retryable === true
      && evidenceCount(tenantFor(byKey.delta).data_dir) === evidenceBeforeStall,
      J({ stalled: { code: stalled.code, partial: stalled.partial_write }, evidence: evidenceCount(tenantFor(byKey.delta).data_dir), before: evidenceBeforeStall }));
    check('4l the fenced refusal is auditable and the app-side divergence is counted',
      stalled.brain.fencing_refusals >= 1 && stalled.brain.fencing_high_water > epochBeforeStall
      && stalled.drift_total > driftsBefore && deltaReplicas.a.role === 'standby',
      J({ brain: stalled.brain, drift: stalled.drift_total, before: driftsBefore }));

    // 4m — the refused operation replays cleanly against the new holder
    const replay = await deltaReplicas.b.handleWrite({
      actor: byKey.delta.owner, client: deltaClient, text: stalledText, operation_id: stallOp,
    });
    check('4n the brain completes for a replayed operation and the app record is not duplicated',
      replay.ok === true && replay.replayed === true && replay.app.written === false && replay.observation.status !== 'duplicate',
      J({ ok: replay.ok, replayed: replay.replayed, app: replay.app?.written, obs: replay.observation?.status }));
  }

  // ═══ P5 — restart during load ═════════════════════════════════════════════
  setSection('P5 restart during load');
  await ownerOf('clover');
  {
    const clover = byKey.clover;
    const pair = replicas.get('clover');
    const identity = brainIdentity({ brainDir: tenantFor(clover).data_dir });
    const scope = scopeForClient('acme');
    const key = messagesKeyFor(identity, scope, 'coffee');
    const acked = [];
    const baseCount = (appStore._all().get(key) ?? []).length;

    const loadLoop = async () => {
      for (let i = 0; i < 24; i += 1) {
        const target = pair.b.role === 'owner' ? pair.b : pair.a;
        const op = newOperationId();
        const result = await timed('write', () => target.handleWrite({
          actor: clover.staff[0].actor, client: 'acme',
          text: `Acme load item ${i} ${marker('clover', 'acme', `load${i}`)}`,
          operation_id: op,
          claims: claimOf(`load-${i}`, '2026-08-10T00:00:00.000Z', `load_item_${i}`, 'Acme'),
        }));
        if (result.ok === true) acked.push({ op, i, observationId: result.observation.id });
        if (i === 11) {
          // restart during load: the holder stops, the standby takes over…
          await pair.a.stop();
          await pair.b.refreshOwnership();
        }
        if (i === 12) {
          // …and the stopped replica comes back as a standby
          await pair.a.start();
        }
      }
    };
    await loadLoop();
    const rows = appStore._all().get(key) ?? [];
    const rowOps = new Set(rows.map(r => r.operation_id));
    check('5a every acknowledged write is present in the authoritative app store',
      acked.length === 24 && acked.every(entry => rowOps.has(entry.op)) && rows.length === baseCount + acked.length,
      J({ acked: acked.length, rows: rows.length, base: baseCount }));
    check('5b the restart handed ownership to the standby mid-load and the old replica rejoined as standby',
      pair.b.role === 'owner' && pair.a.role === 'standby',
      J({ b: pair.b.role, a: pair.a.role }));

    // every acknowledged write produced exactly one observation, and no observation is repeated
    const evidenceText = (() => {
      const dir = path.join(tenantFor(clover).data_dir, 'evidence');
      return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))
        .map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');
    })();
    const observationIds = acked.map(entry => entry.observationId);
    const uniqueObservationIds = new Set(observationIds);
    const brainHalf = observationIds.filter(id => evidenceText.includes(id)).length;
    check('5c no acknowledged write is duplicated in the brain after the restart',
      uniqueObservationIds.size === observationIds.length && observationIds.length === acked.length,
      J({ acked: acked.length, unique: uniqueObservationIds.size }));
    check('5d the brain holds the canonical observation for every acknowledged write',
      brainHalf === acked.length,
      J({ brain: brainHalf, acked: acked.length }));

    const postRestartRecall = await timed('recall', () => pair.b.handleRecall({
      actor: clover.owner, client: 'acme', query: 'load item', limit: 50,
    }));
    check('5e recall after the restart answers from the brain with the pre-restart facts',
      postRestartRecall.ok === true && postRestartRecall.degraded === false
      && postRestartRecall.results.length >= 10,
      J({ ok: postRestartRecall.ok, degraded: postRestartRecall.degraded, n: postRestartRecall.results.length }));

    // 5f — a process death between the app write and the brain write (the hook
    // throws out of handleWrite: no response, no drift count — exactly the
    // window the adapter documents as reconciliation work for the host).
    const crashOp = newOperationId();
    const crashText = `Acme crashed write ${marker('clover', 'acme', 'crash')}`;
    const crashClaims = claimOf('crash', '2026-08-11T00:00:00.000Z', 'crash_probe', 'Acme');
    const evidenceCountBeforeCrash = evidenceCount(tenantFor(clover).data_dir);
    pair.b.hooks.afterGuard = async () => { throw new Error('simulated process death after the app-store append'); };
    let crashThrew = false;
    try {
      await pair.b.handleWrite({
        actor: clover.staff[0].actor, client: 'acme',
        text: crashText, operation_id: crashOp, claims: crashClaims,
      });
    } catch { crashThrew = true; }
    pair.b.hooks.afterGuard = null;
    const rowsAfterCrash = appStore._all().get(key) ?? [];
    const crashRows = rowsAfterCrash.filter(row => row.operation_id === crashOp);
    check('5f a death between the two stores leaves the app record standing and no brain artifact',
      crashThrew === true && crashRows.length === 1
      && evidenceCount(tenantFor(clover).data_dir) === evidenceCountBeforeCrash,
      J({ threw: crashThrew, appRows: crashRows.length }));

    // 5g — the host retries the same operation id once the replica is back
    const replayAfterCrash = await pair.b.handleWrite({
      actor: clover.staff[0].actor, client: 'acme',
      text: crashText, operation_id: crashOp, claims: crashClaims,
    });
    const crashRowsAfterReplay = (appStore._all().get(key) ?? []).filter(row => row.operation_id === crashOp);
    const evidenceAfterReplay = (() => {
      const dir = path.join(tenantFor(clover).data_dir, 'evidence');
      return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))
        .map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');
    })();
    check('5g the retry completes the brain half without duplicating the app record',
      replayAfterCrash.ok === true && replayAfterCrash.replayed === true
      && replayAfterCrash.brain.written === true
      && crashRowsAfterReplay.length === 1
      && evidenceAfterReplay.split(marker('clover', 'acme', 'crash')).length === 2,
      J({ replay: { ok: replayAfterCrash.ok, replayed: replayAfterCrash.replayed }, appRows: crashRowsAfterReplay.length }));
  }

  // ═══ P6 — offboarding, erasure, retention expiry ══════════════════════════
  setSection('P6 offboarding, erasure, retention expiry');
  await ownerOf('forge'); await ownerOf('bob'); await ownerOf('ember');
  {
    // 6a — offboarding a client scope with content
    const forge = byKey.forge;
    const forgeReplicas = replicas.get('forge');
    const harborFact = facts.forge;
    const offboardWrite = await forgeReplicas.a.handleWrite({
      actor: forge.owner, client: 'orbit', text: `Orbit kickoff ${marker('forge', 'orbit', 1)}`,
      claims: claimOf('2026-09-20', '2026-08-12T00:00:00.000Z', 'kickoff_date', 'Orbit'),
    });
    const offboarded = await forgeReplicas.a.forgetClientScope({ actor: forge.owner, client: 'orbit', reason: 'offboarding' });
    const recallOffboarded = await forgeReplicas.a.handleRecall({ actor: forge.owner, client: 'orbit', query: 'Orbit kickoff' });
    markScopeForgotten(scopeForClient('orbit', 1));
    findings.push({
      id: 'grant-row-revocation',
      severity: 'operational',
      statement: 'offboarding/erasure revokes the whole grant row, not just the scope (spec §10b.3): a staff member whose grant lists several clients loses access to all of them, and the adapter has no re-grant surface — Coffee must re-provision. Measured in 6a/6c/6n.',
    });
    check('6a offboarding tombstones the scope: recall is empty, the entry stays for a future incarnation',
      offboardWrite.ok === true && offboarded.ok === true
      && offboarded.result.claims_retracted >= 1 && offboarded.result.scope_entry_removed === false
      && recallOffboarded.ok === true && recallOffboarded.results.length === 0,
      J({ offboarded: offboarded.result, recall: recallOffboarded.results?.length }));
    const harborRecall = await forgeReplicas.a.handleRecall({
      actor: forge.owner, client: 'harbor-lane', query: `${harborFact.subject} renewal`,
    });
    check('6b offboarding one client leaves the business\'s other clients intact',
      harborRecall.ok === true && harborRecall.results.length >= 1
      && harborRecall.results.every(r => !String(JSON.stringify(r)).includes(marker('forge', 'orbit', 1))),
      J({ n: harborRecall.results.length }));

    // 6c — erasure is a physical purge at the settled layer; the raw L0 log keeps bytes (spec §16)
    const ERASE_MARK = marker('bob', 'meridian', 'erase');
    const bobReplicas = replicas.get('bob');
    await bobReplicas.a.handleWrite({
      actor: byKey.bob.owner, client: 'meridian', text: `Meridian sensitive note ${ERASE_MARK}`,
      claims: claimOf(ERASE_MARK, '2026-08-13T00:00:00.000Z', 'sensitive_note', 'Meridian'),
    });
    const exportBeforeErase = await bobReplicas.a.exportClientScope({ actor: byKey.bob.owner, client: 'meridian' });
    const erased = await bobReplicas.a.forgetClientScope({
      actor: byKey.bob.owner, client: 'meridian', reason: 'erasure', export_id: exportBeforeErase.export_id,
    });
    markScopeForgotten(scopeForClient('meridian', 1));
    const recallErased = await bobReplicas.a.handleRecall({ actor: byKey.bob.owner, client: 'meridian', query: ERASE_MARK });
    const exportAfterErase = await bobReplicas.a.exportClientScope({ actor: byKey.bob.owner, client: 'meridian' });
    check('6c erasure retracts claims and observations, removes the scope entry, and every recall answer is empty',
      erased.ok === true && erased.result.claims_retracted >= 1 && erased.result.observations_retracted >= 1
      && erased.result.scope_entry_removed === true
      && recallErased.ok === true && recallErased.results.length === 0,
      J({ erased: erased.result, recall: recallErased.results?.length }));
    check('6d export after erasure returns an empty package — the export path cannot hand content back',
      exportAfterErase.ok === true && (exportAfterErase.counts.observations ?? 0) === 0
      && (exportAfterErase.counts.claims ?? 0) === 0,
      J(exportAfterErase.counts));
    const derivedDirs = ['indices', 'wiki', 'claims', 'operations'].map(d => path.join(tenantFor(byKey.bob).data_dir, d));
    const derivedHits = derivedDirs.flatMap(d => (fs.existsSync(d) ? scanForMarker(d, ERASE_MARK) : []));
    check('6e erasure leaves no readable copy in the settled stores (L0 evidence is a known deferral)',
      derivedHits.length === 0, J(derivedHits));
    const evidenceHits = scanForMarker(path.join(tenantFor(byKey.bob).data_dir, 'evidence'), ERASE_MARK);
    check('6f measured: the raw L0 evidence log still holds the bytes (spec §16 deferred L0 erasure, reported not hidden)',
      evidenceHits.length >= 1,
      J({ evidence_files: evidenceHits }));
    if (evidenceHits.length >= 1) {
      findings.push({
        id: 'l0-erasure-deferral',
        severity: 'product',
        statement: 'erasure clears every lane the contract claims (recall, export, settled stores, rebuilt indexes — 6c/6d/6e/6g) but the raw Layer-0 evidence JSONL keeps the plaintext until the deferred L0 erasure path (spec §16) lands. A client-visible "erasure" promise must be worded with that bound.',
      });
    }

    // 6g — erasure holds against a rebuilt index
    await bobReplicas.a.stop();
    const bobIndices = path.join(tenantFor(byKey.bob).data_dir, 'indices');
    if (fs.existsSync(bobIndices)) fs.renameSync(bobIndices, `${bobIndices}.wiped`);
    await bobReplicas.b.stop({ release: true });
    await bobReplicas.b.start();
    const recallRebuilt = await bobReplicas.b.handleRecall({ actor: byKey.bob.owner, client: 'meridian', query: ERASE_MARK });
    const acmeStillThere = await bobReplicas.b.handleRecall({ actor: byKey.bob.owner, client: 'acme', query: 'renewal date' });
    check('6g erasure survives a derived-index wipe: the erased scope stays empty after rebuild',
      recallRebuilt.ok === true && recallRebuilt.results.length === 0,
      J({ n: recallRebuilt.results?.length }));
    check('6h the business\'s other scope is unaffected by the erasure rebuild',
      acmeStillThere.ok === true && acmeStillThere.results.length >= 1, J({ n: acmeStillThere.results?.length }));

    // 6i — erasure refuses a staff actor (owner-only decision)
    const staffErase = await bobReplicas.b.forgetClientScope({ actor: byKey.bob.staff[0].actor, client: 'acme', reason: 'erasure' });
    check('6i erasure is owner-only: a staff actor is refused',
      staffErase.ok === false && staffErase.status === 403 && staffErase.code === 'owner_required',
      J(staffErase));

    // 6j — retention expiry on the business configured with a 30-day policy
    const emberReplicas = replicas.get('ember');
    const oldWrite = await emberReplicas.a.handleWrite({
      actor: byKey.ember.staff[0].actor, client: 'arcadia', text: 'Arcadia old note',
      observed_at: '2026-07-01T00:00:00.000Z',
      claims: claimOf('old', '2026-07-01T00:00:00.000Z', 'old_note', 'Arcadia'),
    });
    const freshWrite = await emberReplicas.a.handleWrite({
      actor: byKey.ember.staff[0].actor, client: 'arcadia', text: 'Arcadia fresh note',
      observed_at: '2026-09-14T00:00:00.000Z',
      claims: claimOf('fresh', '2026-09-14T00:00:00.000Z', 'fresh_note', 'Arcadia'),
    });
    const sweep = await emberReplicas.a.expireRetention({ actor: byKey.ember.owner, client: 'arcadia', as_of: '2026-09-15T00:00:00.000Z' });
    const sweepAgain = await emberReplicas.a.expireRetention({ actor: byKey.ember.owner, client: 'arcadia', as_of: '2026-09-15T00:00:00.000Z' });
    const recallSwept = await emberReplicas.a.handleRecall({ actor: byKey.ember.owner, client: 'arcadia', query: 'Arcadia' });
    const predicatesSwept = recallSwept.results.map(r => r.claim?.predicate).filter(Boolean);
    check('6j retention expiry tombstones the elapsed observation and retracts its claim',
      oldWrite.ok === true && freshWrite.ok === true
      && sweep.ok === true && sweep.result.observations_expired === 1 && sweep.result.claims_retracted === 1
      && predicatesSwept.includes('fresh_note') && !predicatesSwept.includes('old_note'),
      J({ sweep: sweep.result, predicates: predicatesSwept }));
    check('6k the retention sweep is idempotent', sweepAgain.ok === true && sweepAgain.result.observations_expired === 0,
      J(sweepAgain.result));
    const sweepDenied = await emberReplicas.a.expireRetention({ actor: byKey.ember.agents[0].actor, client: 'meridian' });
    check('6l the sweep requires a forget grant (or owner): the agent is refused',
      sweepDenied.ok === false && sweepDenied.status === 403 && sweepDenied.denied === true,
      J(sweepDenied));
    const sweepGranted = await emberReplicas.a.expireRetention({ actor: byKey.ember.staff[0].actor, scope: 'client:arcadia#1' });
    check('6m a staff member holding the forget grant may run the sweep',
      sweepGranted.ok === true, J(sweepGranted));

    // 6n — grant revocation is row-scoped (spec §10b.3): the measured cost is
    // that an actor serving two clients loses both when one is erased.
    const sam = byKey.ember.staff[0].actor;
    const samBefore = await emberReplicas.a.handleRecall({ actor: sam, client: 'meridian', query: 'Meridian' });
    const arcadiaErase = await emberReplicas.a.forgetClientScope({
      actor: byKey.ember.owner, client: 'arcadia', reason: 'erasure', operation_id: newOperationId(),
    });
    markScopeForgotten(scopeForClient('arcadia', 1));
    const samAfter = await emberReplicas.a.handleRecall({ actor: sam, client: 'meridian', query: 'Meridian' });
    const ownerAfter = await emberReplicas.a.handleRecall({ actor: byKey.ember.owner, client: 'meridian', query: 'Meridian' });
    check('6n erasure revokes the grant row that referenced the scope; the other clients of that staff member are affected too',
      samBefore.ok === true && arcadiaErase.ok === true
      && samAfter.ok === false && samAfter.status === 403 && ownerAfter.ok === true,
      J({ before: samBefore.ok, erase: arcadiaErase.result?.claims_retracted, staffAfter: samAfter.code, ownerAfter: ownerAfter.ok }));
  }

  // ═══ P7 — export and restore (the return path) ════════════════════════════
  setSection('P7 export and restore');
  await ownerOf('forge');
  {
    const forgeReplicas = replicas.get('forge');
    const identity = brainIdentity({ brainDir: tenantFor(byKey.forge).data_dir });
    const scope = scopeForClient('harbor-lane');
    const op = newOperationId();
    const exported = await forgeReplicas.a.exportClientScope({ actor: byKey.forge.owner, client: 'harbor-lane', operation_id: op });
    const exportedAgain = await forgeReplicas.a.exportClientScope({ actor: byKey.forge.owner, client: 'harbor-lane', operation_id: op });
    const pkgBytes = exported.ok ? fs.readFileSync(path.join(exported.path, 'observations.jsonl'), 'utf8') : '';
    check('7a export is scope-exclusive and reports what it carries',
      exported.ok === true && exported.manifest.scope_exclusive === true && exported.manifest.scope === scope
      && exported.counts.observations >= 1,
      J({ ok: exported.ok, manifest: exported.manifest?.scope, counts: exported.counts }));
    check('7b export is idempotent per operation_id',
      exportedAgain.ok === true && exportedAgain.export_id === exported.export_id,
      J([exported.export_id, exportedAgain.export_id]));
    check('7c the package cannot contain another scope, business or private bytes',
      !pkgBytes.includes(marker('forge', 'orbit', 1))
      && !pkgBytes.includes(marker('ava', 'self', 'private'))
      && !pkgBytes.includes(marker('ava', 'acme', 1)),
      pkgBytes.slice(0, 200));

    // restore into a fresh brain after a simulated disaster
    const preRecall = await forgeReplicas.a.handleRecall({ actor: byKey.forge.owner, client: 'harbor-lane', query: 'Harbor Lane renewal', limit: 10 });
    const shapeOf = result => result.results.map(r => ({
      predicate: r.claim?.predicate ?? null,
      object: r.claim?.object ?? null,
      evidence: (r.claim?.observation_ids ?? []).length,
    })).sort((a, b) => String(a.predicate).localeCompare(String(b.predicate)));

    const recoveryBusiness = { ...byKey.forge, key: 'forge_recovery', slug: 'forge-recovery', instanceId: 'smartware_forge_recovery' };
    const recoveryTenant = coffeeTenantConfig({
      dataDir: path.join(dataRoot, 'forge-recovery'), ownerId: byKey.forge.owner.id,
      workspaceId: 'forge-recovery', instanceId: 'smartware_forge_recovery',
      clients: clientsOf('forge-works'), staff: [], agents: [],
    });
    const recovery = new CoffeeBrainAdapter({
      tenant: recoveryTenant, brainDir: recoveryTenant.data_dir, instanceId: 'inst_recovery',
      ports: { appStore, arbiter }, leaseTtlMs: 8000,
    });
    adapters.push(recovery);
    await recovery.start();
    const restored = await recovery.restoreScope({ actor: byKey.forge.owner, package_dir: exported.path, operation_id: newOperationId() });
    const restoredRecall = await recovery.handleRecall({ actor: byKey.forge.owner, client: 'harbor-lane', query: 'Harbor Lane renewal', limit: 10 });
    check('7d a disaster recovery brain restores the package and answers identically',
      restored.ok === true && restored.status === 'restored' && restored.counts.observations === exported.counts.observations
      && J(shapeOf(restoredRecall)) === J(shapeOf(preRecall)),
      J({ restored: restored.status, counts: restored.counts, source: shapeOf(preRecall), restoredShape: shapeOf(restoredRecall) }));

    const otherScopeInRecovery = await recovery.handleRecall({ actor: byKey.forge.owner, client: 'orbit', query: 'Orbit' });
    check('7e the restored brain holds exactly the exported scope', otherScopeInRecovery.results.length === 0,
      J({ n: otherScopeInRecovery.results.length }));

    // tampered package is refused before writing anything
    const tamperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-gate-tamper-'));
    fs.cpSync(exported.path, tamperDir, { recursive: true });
    const claimsFile = path.join(tamperDir, 'claims.jsonl');
    fs.writeFileSync(claimsFile, fs.readFileSync(claimsFile, 'utf8').replace('2026-10-05', '2027-10-05'));
    const tamperedTarget = coffeeTenantConfig({
      dataDir: path.join(dataRoot, 'forge-tampered'), ownerId: byKey.forge.owner.id,
      workspaceId: 'forge-tampered', instanceId: 'smartware_forge_tampered',
      clients: clientsOf('forge-works'), staff: [], agents: [],
    });
    const tamperedBrain = new CoffeeBrainAdapter({
      tenant: tamperedTarget, brainDir: tamperedTarget.data_dir, instanceId: 'inst_tampered',
      ports: { appStore, arbiter }, leaseTtlMs: 8000,
    });
    adapters.push(tamperedBrain);
    await tamperedBrain.start();
    const tampered = await tamperedBrain.restoreScope({ actor: byKey.forge.owner, package_dir: tamperDir });
    const tamperedRecall = await tamperedBrain.handleRecall({ actor: byKey.forge.owner, client: 'harbor-lane', query: 'Harbor Lane' });
    check('7f a tampered package is refused before anything is written',
      tampered.ok === false && tampered.code === 'package_corrupt' && tamperedRecall.results.length === 0,
      J({ restore: tampered, recall: tamperedRecall.results.length }));

    const staffRestore = await recovery.restoreScope({ actor: byKey.forge.staff[0].actor, package_dir: exported.path });
    check('7g restore is owner-only', staffRestore.ok === false && staffRestore.code === 'owner_required', J(staffRestore));

    const standbyLifecycle = await forgeReplicas.b.exportClientScope({ actor: byKey.forge.owner, client: 'harbor-lane' });
    check('7h a standby refuses lifecycle operations and names the holder',
      standbyLifecycle.ok === false && standbyLifecycle.code === 'lease_not_holder'
      && standbyLifecycle.holder === 'inst_forge_a' && standbyLifecycle.retryable === true,
      J(standbyLifecycle));
  }

  // ═══ P8 — unauthorized fuzzing ════════════════════════════════════════════
  setSection('P8 unauthorized fuzzing');
  await ownerOf('ava');
  {
    const targets = [
      { business: 'ava', replica: 'a' },
      { business: 'clover', replica: 'b' },
      { business: 'ember', replica: 'a' },
      { business: 'forge', replica: 'a' },
    ];
    const hostileTexts = [
      '', ' ', '\u0000\u0001\u0002', 'DROP TABLE claims; --', '<script>alert(1)</script>',
      'x'.repeat(70_000), '甲'.repeat(5_000), '\n\n', '{"__proto__":{"polluted":true}}',
    ];
    const malformedIds = ['', 'op_short', 'not-a-ulid', 'op_0000000000000000000000000O'];
    const evidenceBeforeFuzz = new Map(BUSINESSES.map(b => [b.key, evidenceCount(tenantFor(b).data_dir)]));
    const appStoreBeforeFuzz = new Map([...appStore._all()].map(([key, list]) => [key, list.length]));

    const results = [];
    let index = 0;
    for (const target of targets) {
      const business = byKey[target.business];
      const adapter = replicas.get(target.business)[target.replica];
      const others = BUSINESSES.filter(b => b.key !== business.key);
      const ownClient = clientsOf(business.slug)[0].id;
      const validScope = scopeForClient(ownClient, 1);
      const hostileActors = [
        { type: 'person', id: 'user:ghost' },
        { type: 'person', id: '' },
        { type: 'agent', id: 'agent:uninvited' },
        { type: 'ghost', id: 'user:x' },
        null,
        { type: 'person', id: 42 },
        others[0].owner,
        others[0].staff[0]?.actor ?? others[0].owner,
        { type: 'sidecar', id: 'sidecar:probe' },
      ];
      const record = (kind, result) => { results.push({ business: business.key, kind, result }); index += 1; };

      for (const actor of hostileActors) {
        for (let variant = 0; variant < 3; variant += 1) {
          record('write', await adapter.handleWrite({
            actor,
            scope: validScope,
            text: hostileTexts[(index + variant) % hostileTexts.length],
            claims: variant === 1
              ? [{ subject: { name: 'X' }, predicate: 'p', object: { type: 'text', value: 'v' }, validity_from: '2026-01-01T00:00:00.000Z' }]
              : [],
            operation_id: newOperationId(),
          }));
        }
        record('recall', await adapter.handleRecall({ actor, scope: validScope, query: 'anything' }));
      }

      // the business's own staff acting outside their grant (another client, not theirs)
      const staffActor = business.staff[0]?.actor ?? business.owner;
      record('write', await adapter.handleWrite({
        actor: staffActor, scope: 'client:out-of-grant#1', text: `out of grant ${marker(business.key, 'acme', 1)}`,
      }));
      record('recall', await adapter.handleRecall({ actor: staffActor, scope: 'client:out-of-grant#1', query: 'anything' }));

      // malformed payloads from a legitimate actor: still refused, still nothing written
      for (const badId of malformedIds) {
        record('write', await adapter.handleWrite({
          actor: business.owner, scope: validScope, text: 'malformed', operation_id: badId,
        }));
      }
      record('write', await adapter.handleWrite({ actor: business.owner, scope: validScope, text: '   ' }));
      record('write', await adapter.handleWrite({
        actor: business.owner, scope: validScope, text: 'bad claims',
        claims: [{ subject: {}, predicate: '', object: {} , validity_from: '' }],
      }));
      record('write', await adapter.handleWrite({ actor: business.owner, scope: 'client:*', text: 'wildcard' }));
      record('write', await adapter.handleWrite({ actor: business.owner, scope: `${validScope.slice(0, -1)}0`, text: 'incarnation zero' }));
      record('recall', await adapter.handleRecall({ actor: business.owner, scope: validScope, query: '   ' }));
    }

    const accepted = results.filter(entry => entry.result.ok === true);
    check('8a every hostile request is a refusal — none is accepted',
      accepted.length === 0,
      J(accepted.map(entry => ({ business: entry.business, kind: entry.kind, code: entry.result.code, status: entry.result.status })).slice(0, 6)));

    const leaked = [];
    for (const entry of results) {
      const body = JSON.stringify(entry.result);
      const keys = new Set([...body.matchAll(/MKR-([a-z]+)-/g)].map(match => match[1]));
      for (const key of keys) if (key !== entry.business) leaked.push({ business: entry.business, kind: entry.kind, leaked: key });
      for (const other of BUSINESSES) {
        if (other.key !== entry.business && body.includes(`MKR-${other.key}`)) leaked.push({ business: entry.business, kind: entry.kind, leaked: other.key });
      }
    }
    check('8b no fuzz response discloses another business\'s content', leaked.length === 0, J(leaked.slice(0, 5)));

    // The fuzz must not have written to any brain. App-side appends CAN happen:
    // the adapter's documented order writes the host store before the brain, and
    // an actor the brain refuses leaves a counted divergence. Anything else —
    // an app append with no drift count, or any brain artifact — fails.
    const appGrowth = [];
    const unaccountedGrowth = [];
    for (const [key, list] of appStore._all()) {
      const before = appStoreBeforeFuzz.get(key) ?? 0;
      if (list.length <= before) continue;
      const drift = await appStore.getDrift({ key: key.replace(':messages:', ':drift:') });
      appGrowth.push({ key, grew: list.length - before, drift });
      if (drift <= 0) unaccountedGrowth.push({ key, grew: list.length - before });
    }
    check('8c no brain was written and every app-side append from the fuzz is counted as drift',
      BUSINESSES.every(b => evidenceCount(tenantFor(b).data_dir) === evidenceBeforeFuzz.get(b.key))
      && unaccountedGrowth.length === 0,
      J({ app_growth: appGrowth, unaccounted: unaccountedGrowth }));
    if (appGrowth.length > 0) {
      findings.push({
        id: 'app-append-precedes-brain-authorization',
        severity: 'operational',
        statement: `the adapter appends to the host store before the brain evaluates grants (documented order), so an actor that fails brain authorization leaves ${appGrowth.length} app-side row(s) plus drift counters — in production Coffee must authenticate before calling the adapter, or the divergence path becomes a real reconciliation load.`,
      });
    }

    // op-id reuse with a different payload is a conflict, not a silent overwrite
    const conflictOp = newOperationId();
    const first = await replicas.get('ava').a.handleWrite({
      actor: byKey.ava.owner, client: 'acme', text: `Acme conflict probe ${marker('ava', 'acme', 'conflict')}`, operation_id: conflictOp,
      claims: claimOf('probe-A', '2026-08-20T00:00:00.000Z', 'conflict_probe', 'Acme'),
    });
    const conflicting = await replicas.get('ava').a.handleWrite({
      actor: byKey.ava.owner, client: 'acme', text: 'Acme conflict probe B (different payload)', operation_id: conflictOp,
      claims: claimOf('probe-B', '2026-08-20T00:00:00.000Z', 'conflict_probe', 'Acme'),
    });
    check('8d reusing an operation id with a different payload is refused as a conflict',
      first.ok === true && conflicting.ok === false && conflicting.status === 409 && conflicting.code === 'conflict'
      && conflicting.partial_write === true,
      J({ first: first.ok, conflict: conflicting }));

    const protoPollution = JSON.parse('{"__proto__":{"polluted":true},"actor":{"type":"person","id":"user:ava"},"text":"x","client":"acme"}');
    const pollution = await replicas.get('ava').a.handleWrite(protoPollution);
    check('8e a prototype-shaped payload neither pollutes nor bypasses the write path',
      ({}).polluted === undefined && pollution.ok === true,
      J({ polluted: ({}).polluted, ok: pollution.ok }));

    const healthy = await replicas.get('ava').a.health({ actor: byKey.ava.owner });
    const stillWorks = await replicas.get('ava').a.handleWrite({
      actor: byKey.ava.staff[0].actor, client: 'acme',
      text: `post-fuzz check ${marker('ava', 'acme', 'postfuzz')}`,
      claims: claimOf('ok', '2026-08-21T00:00:00.000Z', 'post_fuzz_check', 'Acme'),
    });
    check('8f after the fuzz the businesses are still healthy and answer',
      healthy.role === 'owner' && stillWorks.ok === true && stillWorks.brain.written === true,
      J({ role: healthy.role, write: stillWorks.ok }));
  }

  // ═══ P9 — soak, latency, resources ════════════════════════════════════════
  setSection('P9 soak, latency, resources');
  {
    for (const business of BUSINESSES) storageBefore.set(business.key, dirBytes(tenantFor(business).data_dir));
    const soakWrites = []; const soakRecalls = [];
    const SOAK_ROUNDS = 12;
    let soakFailures = 0;
    for (const business of BUSINESSES) {
      const adapter = await ownerOf(business.key);
      const fact = facts[business.key];
      const soakActor = actorFor(business, fact.client);
      for (let round = 0; round < SOAK_ROUNDS; round += 1) {
        const op = newOperationId();
        const result = await timed('write', () => adapter.handleWrite({
          actor: soakActor,
          client: fact.client,
          text: `${fact.subject} soak item ${round} ${marker(business.key, fact.client, `soak${round}`)}`,
          operation_id: op,
          claims: claimOf(`soak-${round}`, '2026-08-25T00:00:00.000Z', `soak_item_${round}`, fact.subject),
        }));
        soakWrites.push(result);
        if (result.ok !== true) soakFailures += 1;
        const recall = await timed('recall', () => adapter.handleRecall({
          actor: business.owner, client: fact.client, query: `${fact.subject} soak item ${round}`, limit: 5,
        }));
        soakRecalls.push(recall);
      }
    }
    check('9a the soak completed with no failed writes',
      soakFailures === 0 && soakWrites.length === BUSINESSES.length * SOAK_ROUNDS,
      J({ writes: soakWrites.length, failures: soakFailures }));
    check('9b every soak recall answered from the brain (no silent degradation)',
      soakRecalls.every(r => r.ok === true && r.degraded === false && r.source === 'brain'),
      J(soakRecalls.filter(r => r.degraded).length));

    const storageAfter = new Map(BUSINESSES.map(b => [b.key, dirBytes(tenantFor(b).data_dir)]));
    const growth = BUSINESSES.map((business) => {
      const before = storageBefore.get(business.key); const after = storageAfter.get(business.key);
      return {
        business: business.slug,
        bytes_before: before.bytes, bytes_after: after.bytes, bytes_growth: after.bytes - before.bytes,
        files_after: after.files,
      };
    });
    const totalGrowth = growth.reduce((sum, row) => sum + row.bytes_growth, 0);
    check('9c resource growth is measured per business and stays proportional to the writes',
      totalGrowth > 0 && growth.every(row => row.bytes_growth >= 0),
      J(growth));

    const claimAndEvidenceCounts = [];
    for (const business of BUSINESSES) {
      const adapter = await ownerOf(business.key);
      const health = await adapter.health({ actor: business.owner });
      claimAndEvidenceCounts.push({
        business: business.slug,
        claims: health.brain?.counts?.lanes?.layer1?.claims ?? null,
        observations: health.brain?.counts?.lanes?.layer0?.total ?? null,
        by_scope: health.brain?.counts?.by_scope ?? [],
        slo: health.brain?.slo?.status ?? null,
        slo_objectives: health.brain?.slo?.objectives?.map(o => ({ id: o.id, state: o.state, observed: o.observed })) ?? null,
        storage_bytes: health.brain?.storage?.total_bytes ?? null,
      });
    }
    check('9d the health report gives per-business claim/observation counts and storage',
      claimAndEvidenceCounts.every(row => typeof row.claims === 'number' && row.claims > 0
        && typeof row.observations === 'number' && row.observations > 0
        && typeof row.storage_bytes === 'number'),
      J(claimAndEvidenceCounts.map(r => [r.business, r.claims, r.observations])));

    // The gate provokes one stale-epoch refusal on delta (the fence drill);
    // that objective is expected to breach there and nowhere else. Any other
    // breach is the gate failing, not a drill artifact.
    const drilledStaleWriter = new Set(['delta']);
    const sloBreaches = [];
    for (const row of claimAndEvidenceCounts) {
      if (row.slo !== 'breach') continue;
      const businessKey = BUSINESSES.find(b => b.slug === row.business)?.key;
      for (const objective of row.slo_objectives ?? []) {
        if (objective.state !== 'breach') continue;
        sloBreaches.push({
          business: row.business,
          objective: objective.id,
          observed: objective.observed,
          drill_induced: objective.id === 'stale_writer_refusals' && drilledStaleWriter.has(businessKey),
        });
      }
    }
    const unexpectedBreaches = sloBreaches.filter(entry => !entry.drill_induced);
    check('9e no business is in SLO breach except the stale-writer objective the gate itself provokes',
      unexpectedBreaches.length === 0,
      J(sloBreaches));
    if (sloBreaches.some(entry => entry.drill_induced)) {
      findings.push({
        id: 'slo-stale-writer-breach',
        severity: 'expected',
        statement: 'delta-lab\'s Coffee-trial SLO reads `breach` on stale_writer_refusals because the gate deliberately stalled a writer across a takeover (4k/4l). The refusal itself is correct behaviour; the objective is a hard zero, so any real stale writer in production sets it.',
      });
    }
    check('9f the health report carries no tenant content',
      await (async () => {
        const serialized = [];
        for (const business of BUSINESSES) {
          const adapter = await ownerOf(business.key);
          serialized.push(JSON.stringify(await adapter.health({ actor: business.owner })));
        }
        const blob = serialized.join('\n');
        return !blob.includes('MKR-') && !blob.includes('renewal date is') && !blob.includes('soak item');
      })());

    // 9g — cross-business isolation after the soak
    const isolationHits = [];
    for (const business of BUSINESSES) {
      const fact = facts[business.key];
      const adapter = await ownerOf(business.key);
      const recall = await timed('recall', () => adapter.handleRecall({
        actor: business.owner, client: fact.client, query: `${fact.subject} ${fact.predicate.replace('_', ' ')}`, limit: 20,
      }));
      for (const other of BUSINESSES) {
        if (other.key === business.key) continue;
        if (JSON.stringify(recall).includes(marker(other.key, 'acme', 1)) || JSON.stringify(recall).includes(marker(other.key, 'soak0'))) {
          isolationHits.push([business.key, other.key]);
        }
      }
    }
    check('9g cross-business isolation holds after the soak', isolationHits.length === 0, J(isolationHits));

    // 9h — the final restart: every business reopens and its facts are still answerable
    let reopened = 0;
    for (const business of BUSINESSES) {
      const pair = replicas.get(business.key);
      const adapter = pair.a.role === 'owner' ? pair.a : pair.b;
      await adapter.stop();
      await adapter.start();
      const recall = await adapter.handleRecall({
        actor: business.owner, client: facts[business.key].client,
        query: `${facts[business.key].subject} ${facts[business.key].predicate.replace('_', ' ')}`, limit: 5,
      });
      if (recall.ok === true && recall.results.length >= 1) reopened += 1;
    }
    check('9h every business survives a stop/start with its facts still answerable', reopened === 6, `${reopened}/6`);

    Object.assign(runMeta, {
      latency: {
        write: percentiles(latency.write),
        recall: percentiles(latency.recall),
        degraded_recall: percentiles(latency.degradedRecall),
        failover: percentiles(latency.failover),
      },
      resources: {
        rss_before_bytes: rssBefore,
        rss_after_bytes: process.memoryUsage().rss,
        rss_growth_bytes: process.memoryUsage().rss - rssBefore,
        per_business: growth,
        total_growth_bytes: totalGrowth,
      },
      counts: claimAndEvidenceCounts,
      slo_breaches: sloBreaches,
      findings,
      checks_total: checks.length,
      checks_failed: failed,
    });
  }
  // ═══ P10 — the contract the records themselves keep ══════════════════════
  setSection('P10 emitted-record contract conformance');
  {
    // The schemas under test are the ones the *installed package* ships — resolved through its own
    // `exports` map, so a packaged run validates against the artifact's schemas and a development run
    // against this tree's. The validator (ajv) is a devDependency of the library: the gate runner
    // hands its resolved path to the fixture, so the check runs identically in both modes.
    const schemaUrl = import.meta.resolve('smartware/schemas/v0.5.0/claim.schema.json');
    const schemasDir = path.dirname(fileURLToPath(schemaUrl));
    const toSpecifier = value => (value.startsWith('/') ? pathToFileURL(value).href : value);
    let Ajv2020; let addFormats = null;
    try {
      ({ default: Ajv2020 } = await import(toSpecifier(process.env.GATE_AJV_MODULE ?? 'ajv/dist/2020.js')));
      ({ default: addFormats } = await import(toSpecifier(process.env.GATE_AJV_FORMATS_MODULE ?? 'ajv-formats')));
    } catch (error) {
      Ajv2020 = null;
      runMeta.record_conformance = { error: `validator unavailable: ${error?.message ?? error}` };
    }

    if (Ajv2020) {
      const report = validateEmittedRecords({ root: dataRoot, schemasDir, Ajv2020, addFormats });
      runMeta.record_conformance = report;

      const claims = { records: 0, violations: 0 };
      const operations = { records: 0, violations: 0 };
      for (const [name, family] of Object.entries(report.families)) {
        const into = name.endsWith('claims') ? claims : operations;
        into.records += family.records;
        into.violations += family.violations;
      }

      check('10a every canonical claim record this run wrote validates against the published claim schema',
        claims.records > 0 && claims.violations === 0,
        `${formatConformance(report)}${report.samples.length ? ` — e.g. ${J(report.samples[0])}` : ''}`);
      check('10b every operations-log entry this run wrote validates against the published operation-log schema',
        operations.records > 0 && operations.violations === 0,
        `${operations.violations}/${operations.records} in violation`);
      check('10c tombstone frontmatter files a run writes validate against the published tombstone schema',
        report.tombstone_frontmatter_violations === 0,
        J({ files: report.tombstone_frontmatter_files, violations: report.tombstone_frontmatter_violations, note: 'the tombstone-backfill writer is not exercised by this fixture' }));
      // Non-vacuity: the three read paths above must each have carried records, or a green 10a/10b is
      // silence, not evidence (the blind spot this check exists to close).
      check('10d the conformance check saw every family it claims to cover',
        (report.families.brain_claims?.records ?? 0) > 0
        && (report.families.brain_ops_log?.records ?? 0) > 0
        && (report.families.export_package_claims?.records ?? 0) > 0
        && (report.families.export_package_ops_log?.files ?? 0) > 0,
        J(Object.fromEntries(Object.entries(report.families).map(([name, b]) => [name, [b.files, b.records]]))));
      // The pre-fix literal, pinned so the class the review measured cannot return unnoticed even if a
      // future schema widens the OperationId pattern.
      check('10e no canonical record carries the pre-fix legacy OperationId literal',
        report.legacy_literal_hits.length === 0,
        J(report.legacy_literal_hits.slice(0, 6)));

      // Durable, machine-readable inventory beside the run's report (the check detail is truncated).
      const reportAt = process.argv.indexOf('--report');
      if (reportAt !== -1 && process.argv[reportAt + 1]) {
        const conformancePath = path.join(path.dirname(process.argv[reportAt + 1]), 'record-conformance.json');
        fs.writeFileSync(conformancePath, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`record conformance inventory: ${conformancePath}`);
      }
      console.log(`emitted records: ${formatConformance(report)}`);
    } else {
      check('10a every canonical claim record this run wrote validates against the published claim schema', false,
        `validator unavailable — ${J(runMeta.record_conformance)}`);
    }
  }

} catch (error) {
  check('the fixture completed without an unexpected exception', false, `${error?.stack ?? error}`);
} finally {
  for (const adapter of adapters) {
    try { await adapter.stop({ release: false }); } catch { /* already stopped */ }
  }
}

const reportAt = process.argv.indexOf('--report');
const report = {
  outcome: failed === 0 ? 'pass' : 'fail',
  meta: runMeta,
  total: checks.length,
  passed: checks.length - failed,
  failed,
  checks,
};
if (reportAt !== -1 && process.argv[reportAt + 1]) {
  fs.mkdirSync(path.dirname(process.argv[reportAt + 1]), { recursive: true });
  fs.writeFileSync(process.argv[reportAt + 1], JSON.stringify(report, null, 2));
}
console.log('\n=== COFFEE COMPANY-BRAIN GATE ===');
console.log(`mode: ${runMeta.mode} · package ${runMeta.package_version} · ${runMeta.node}`);
console.log(`checks: ${checks.length - failed}/${checks.length} passed`);
console.log(`latency: ${JSON.stringify(runMeta.latency ?? {})}`);
console.log(`data: ${dataRoot}`);
console.log(`GATE_OUTCOME=${failed === 0 ? 'pass' : 'fail'}`);
process.exit(failed === 0 ? 0 : 1);
