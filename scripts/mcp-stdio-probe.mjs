// Real-transport MCP probe — kanban t_dae50f51.
//
// Spawns the actual `dist/index.js` MCP server over stdio (the surface the card
// is about), seeds a brain where a superseded claim is revised by the owner
// through the `smartware_revise` tool, then compares the server's own
// `smartware_recall` answer with a fresh open of the same brain after the server
// is stopped. Proves the wiring (`src/index.ts` passing the lane to the
// handler), not just the call shape.
//
// usage: node scripts/mcp-stdio-probe.mjs <dist-dir> [outfile]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DIST = process.argv[2];
const OUT = process.argv[3] ?? null;
if (!DIST) {
  console.error('usage: node probes/mcp-stdio-probe.mjs <dist-dir> [outfile]');
  process.exit(2);
}
const imp = (p) => import(pathToFileURL(path.join(DIST, p)).href);

const { SmartwareCore } = await imp('core.js');
const { createDefaultConfig, saveConfig } = await imp('config.js');
const { ClaimStore } = await imp('layer1/store.js');
const { SearchIndex, syncSearchFromClaims } = await imp('layer3/search.js');
const { knownTime, nullTime } = await imp('layer1/types.js');
const { admitClaim } = await imp('layer1/conflicts.js');
const { iterAllClaimVersions } = await imp('layer1/jsonl.js');

const OWNER = { type: 'person', id: 'user:owner', display_name: 'Owner' };
const SCOPE = 'client:acme#1';
const T1 = '2026-08-01T00:00:00.000Z';
const T2 = '2026-09-01T00:00:00.000Z';
const SUBJECT = 'Stdio Probe Co';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 26);
const opId = () => `op_${[...randomBytes(26)].map(b => CROCKFORD[b % 32]).join('')}`;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function makeProbeClaim({ id, entityId, value, validFrom, ingestedAt }) {
  return {
    id, subject_id: entityId, subject_name: SUBJECT,
    predicate: 'probe_state', object: { type: 'text', value }, scope: SCOPE,
    validity: { from: validFrom, to: null },
    t_ingested: knownTime(ingestedAt), t_invalidated: nullTime(),
    t_valid_from: knownTime(validFrom), t_valid_to: nullTime(),
    source_event_id: `obs_${hash(id + 'src')}`, extraction_event_id: `obs_${hash(id + 'ext')}`,
    supporting_evidence: [`obs_${hash(id + 'ev')}`],
    extraction: { method: 'deterministic', model: null, compiler_version: '0.7.0', prompt_hash: null, extracted_at: ingestedAt },
    status: 'active', epistemic: 'observed', confidence: 0.7, sensitive: false,
    superseded_by: null, contested_by: [],
  };
}

// ── Seed the brain: a superseded claim (canonical record still active) + lane ──
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-mcp-stdio-'));
for (const sub of ['wiki/personal', 'wiki/workspace', 'evidence', 'claims', 'operations']) {
  fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
}
const cfg = createDefaultConfig(dataDir);
cfg.owner_id = OWNER.id;
cfg.llm = { provider: 'none', model: '' };
cfg.scopes = [
  { id: 'self', parent: null, visibility_default: 'private' },
  { id: 'workspace', parent: null, visibility_default: 'workspace' },
  { id: SCOPE, parent: 'workspace', visibility_default: 'scope' },
];
saveConfig(dataDir, cfg);

const dbPath = path.join(dataDir, 'smartware.db');
const store = new ClaimStore(dbPath);
store.setDataDir(dataDir);
const searchIndex = new SearchIndex(dbPath);
const entityId = `entity_${hash('stdio-carrier')}`;
store.insertEntity({ id: entityId, canonical_name: SUBJECT, aliases: [], type: 'organization', scope: SCOPE, created_at: T1 });
const originalId = `claim_${hash('stdio-original')}`;
store.insertClaim(makeProbeClaim({ id: originalId, entityId, value: '2031-01-01', validFrom: T1, ingestedAt: T1 }));
syncSearchFromClaims(store, searchIndex, SCOPE);
const replacementId = `claim_${hash('stdio-replacement')}`;
const admission = admitClaim(makeProbeClaim({ id: replacementId, entityId, value: '2031-02-02', validFrom: T2, ingestedAt: T2 }), store);
syncSearchFromClaims(store, searchIndex, SCOPE);
const laneBefore = searchIndex.getDB().prepare('SELECT claim_id FROM claim_search_index WHERE scope = ?').all(SCOPE).map(r => r.claim_id).sort();
const baseVersion = [...iterAllClaimVersions(dataDir)].filter(v => v.claim_id === originalId).reduce((max, v) => Math.max(max, v.version), 0);
store.close();
searchIndex.close();

// ── Drive the real server over stdio ─────────────────────────────────────────
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(DIST, 'index.js')],
  cwd: path.dirname(DIST),
  env: { ...getDefaultEnvironment(), SMARTWARE_DATA_DIR: dataDir },
  stderr: 'pipe',
});
const client = new Client({ name: 'sw-stdio-probe', version: '1.0.0' });
await client.connect(transport);
const pid = transport.pid;
const textOf = (result) => result.content[0].text;

const revisedRaw = await client.callTool({
  name: 'smartware_revise',
  arguments: {
    actor_id: OWNER.id,
    target: originalId,
    expected_base_version: baseVersion,
    set_confidence: 'high',
    reason: 'the earlier window was still in force',
    operation_id: opId(),
  },
});
const recalledRaw = await client.callTool({
  name: 'smartware_recall',
  arguments: { actor_id: OWNER.id, query: 'Stdio Probe', scope: SCOPE },
});
const revised = JSON.parse(textOf(revisedRaw));
const recalled = JSON.parse(textOf(recalledRaw));
const inProcess = (recalled.results ?? []).flatMap(entry => (entry.claim ? [entry.claim.id] : [])).sort();

await client.close();
if (pid) {
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); await sleep(100); } catch { break; }
  }
}

// ── Fresh open of the same brain (server stopped: no write contention) ───────
// Read the lane BEFORE the fresh open — the open rebuilds the whole lane.
const laneIndex = new SearchIndex(dbPath);
const laneAfter = laneIndex.getDB().prepare('SELECT claim_id FROM claim_search_index WHERE scope = ?').all(SCOPE).map(r => r.claim_id).sort();
laneIndex.close();

const freshCore = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
const freshServed = (await freshCore.recall({ actor: OWNER, query: 'Stdio Probe', scope: SCOPE }))
  .results.flatMap(entry => (entry.claim ? [entry.claim.id] : [])).sort();
freshCore.close();

const record = {
  probe: 'mcp-stdio', dist: DIST, admission: admission.outcome,
  revised_claim_id: revised.claim_id ?? null, revise_error: revised.error ?? null,
  lane_before: laneBefore, lane_after: laneAfter,
  in_process: inProcess, fresh: freshServed,
  in_process_serves_revised: inProcess.includes(originalId),
  in_process_equals_fresh: JSON.stringify(inProcess) === JSON.stringify(freshServed),
};
console.log(JSON.stringify(record));
if (OUT) fs.appendFileSync(OUT, `${JSON.stringify(record)}\n`);
fs.rmSync(dataDir, { recursive: true, force: true });
