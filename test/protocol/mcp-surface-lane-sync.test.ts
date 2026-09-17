// The MCP dispatcher surface (`src/index.ts`) and the claim-FTS lane —
// kanban t_dae50f51, the follow-up the t_a6bf30a8 decision carded.
//
// `src/index.ts` is a second dispatcher surface: its `server.tool(...)`
// callbacks call the protocol handlers DIRECTLY, not through the
// `SmartwareCore` wrappers. A lane repair that lives in a wrapper therefore
// never reaches it, and the class has now been found three times: CORRECT
// (PR #25, wrapper-level), REVISE (PR #29, wrapper-level) and this surface
// (measured on the MCP call shapes with `probes/mcp-surface-probe.mjs`). The
// decision taken here, following t_a6bf30a8: repairs live in the HANDLERS, the
// dispatcher that owns a lane passes it, and the invariant is pinned on each
// surface's own call shape.
//
// The invariant, the survey's (t_12c79071):
//
//     after a verb that moves claim rows, in-process recall == what a fresh
//     open of the same brain serves
//
// Behavioural pins below drive the exact call shapes `src/index.ts` uses:
//
//   smartware_correct -> handleCorrect(params, evidenceDir, layer0, store, config, searchIndex)
//   smartware_revise  -> handleRevise(params, dataDir, store, config, { opsDir },
//                                     undefined, undefined, searchIndex)
//   REVISE via SmartwareCore.revise — the shipped `smartware` binary's path
//   (`src/mcp.ts`) — must agree with the same invariant.
//
// Provenance (out of tree, `node probes/mcp-surface-probe.mjs <dist>`):
//   - REVISE pins: RED at 63b608f (in-process `[replacement]` vs fresh
//     `[replacement, revised]`), GREEN after the handler-level repair.
//   - CORRECT pin (reason `wrong`, the demotion-free shape): RED at fd55cc2
//     (in-process `[]` vs fresh `[replacement]`) — the t_a6bf30a8 catch-up
//     repair — GREEN at 63b608f. The `changed` shape is deliberately NOT pinned
//     for cross-leg equality: its remaining live-vs-fresh difference is the
//     demotion resurrection (`e5f093e`/`3ae8a6b`, not in this tree), not the
//     lane.
//
// The classification tripwire at the bottom keeps the NEXT verb loud: a tool
// added to `src/index.ts` fails this file until it is classified here, and a
// claim-row-moving tool must pass `searchIndex` at its call site.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, loadConfig, saveConfig, type SmartwareConfig } from '../../src/config.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { admitClaim } from '../../src/layer1/conflicts.js';
import { iterAllClaimVersions } from '../../src/layer1/jsonl.js';
import { Layer0Index } from '../../src/layer0/index.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import { handleCorrect } from '../../src/protocol/correct.js';
import { handleRevise } from '../../src/protocol/revise.js';
import { makeClaim } from '../helpers.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const SCOPE = 'client:acme#1';
const T1 = '2026-08-01T00:00:00.000Z';
const T2 = '2026-09-01T00:00:00.000Z';

interface Fixture {
  dataDir: string;
  core: SmartwareCore;
  layer0: Layer0Index;
  store: ClaimStore;
  searchIndex: SearchIndex;
}

const live: Fixture[] = [];

function scaffold(dataDir: string): SmartwareConfig {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = OWNER.id;
  cfg.llm = { provider: 'none', model: '' };
  cfg.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' as const },
    { id: 'workspace', parent: null, visibility_default: 'workspace' as const },
    { id: SCOPE, parent: 'workspace', visibility_default: 'scope' as const },
  ];
  saveConfig(dataDir, cfg);
  return cfg;
}

/**
 * The fixture mirrors the MCP server process: a live core (reads) plus the
 * layer instances `src/index.ts` holds and hands to the handlers.
 */
async function newFixture(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-mcp-lane-'));
  scaffold(dataDir);
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  const dbPath = path.join(dataDir, 'smartware.db');
  const layer0 = new Layer0Index(dbPath);
  layer0.catchUp(path.join(dataDir, 'evidence'));
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const searchIndex = new SearchIndex(dbPath);
  const fx = { dataDir, core, layer0, store, searchIndex };
  live.push(fx);
  return fx;
}

afterEach(async () => {
  for (const fx of live.splice(0)) {
    fx.store.close();
    fx.searchIndex.close();
    fx.layer0.close();
    fx.core.close();
    fs.rmSync(fx.dataDir, { recursive: true, force: true });
  }
});

const laneRows = (searchIndex: SearchIndex): string[] =>
  (searchIndex.getDB()
    .prepare('SELECT claim_id FROM claim_search_index WHERE scope = ?')
    .all(SCOPE) as Array<{ claim_id: string }>)
    .map(row => row.claim_id)
    .sort();

async function served(core: SmartwareCore, query: string): Promise<string[]> {
  const result = await core.recall({ actor: OWNER, query, scope: SCOPE });
  return result.results.flatMap(entry => (entry.claim ? [entry.claim.id] : [])).sort();
}

/** What a fresh open of the same brain serves — run LAST (it replaces the shared lane). */
async function freshServed(fx: Fixture, query: string): Promise<string[]> {
  const fresh = await SmartwareCore.open({ dataDir: fx.dataDir, ownerId: OWNER.id });
  try {
    return await served(fresh, query);
  } finally {
    fresh.close();
  }
}

const probeClaim = (fields: { id: string; entityId: string; subject: string; value: string; validFrom: string; ingestedAt: string }) =>
  makeClaim({
    id: fields.id,
    subject_id: fields.entityId,
    subject_name: fields.subject,
    predicate: 'probe_state',
    object: { type: 'text', value: fields.value },
    scope: SCOPE,
    validity: { from: fields.validFrom, to: null },
    t_ingested: knownTime(fields.ingestedAt),
    t_invalidated: nullTime(),
    t_valid_from: knownTime(fields.validFrom),
    t_valid_to: nullTime(),
    confidence: 0.7,
  });

describe('the MCP dispatcher surface keeps the claim-FTS lane equal to the durable surface', () => {
  it('CORRECT over the MCP call shape: the corrected fact is served exactly as a fresh open serves it', async () => {
    const fx = await newFixture();
    const subject = 'Mcp Surface Correct Co';
    const entityId = `entity_${ulid()}`;
    fx.store.insertEntity({ id: entityId, canonical_name: subject, aliases: [], type: 'concept', scope: SCOPE, created_at: T1 });
    const target = probeClaim({ id: `claim_${ulid()}`, entityId, subject, value: 'before', validFrom: T1, ingestedAt: T1 });
    fx.store.insertClaim(target);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);
    expect(laneRows(fx.searchIndex)).toEqual([target.id]);

    // Exactly as `src/index.ts`'s smartware_correct tool calls it. reason
    // 'wrong' retracts the target (its canonical record says `forgotten`), so
    // the fresh leg does not resurrect it: in-process == fresh is the honest
    // measurement of the lane here.
    const result = await handleCorrect(
      {
        actor: OWNER,
        target_claim_id: target.id,
        corrected_object: { type: 'text', value: 'after' },
        reason: 'wrong',
      },
      path.join(fx.dataDir, 'evidence'),
      fx.layer0,
      fx.store,
      loadConfig(fx.dataDir),
      fx.searchIndex,
    );
    expect(result.new_claim_id).toBeTruthy();
    const replacementId = result.new_claim_id!;

    // The lane is the store's indexable set again: the retracted target left
    // it and the replacement is in it.
    expect(laneRows(fx.searchIndex)).toEqual([replacementId]);
    const inProcess = await served(fx.core, subject);
    expect(inProcess).toEqual([replacementId]);
    expect(await freshServed(fx, subject)).toEqual(inProcess);
  });

  it('REVISE over the MCP call shape: the revised claim is served exactly as a fresh open serves it', async () => {
    const fx = await newFixture();
    const subject = 'Mcp Surface Revise Co';
    const entityId = `entity_${ulid()}`;
    fx.store.insertEntity({ id: entityId, canonical_name: subject, aliases: [], type: 'organization', scope: SCOPE, created_at: T1 });

    // The t_336ba0b9 composition: a claim that a later event-valid window
    // superseded — the lane was re-synced, so the superseded claim is out of it
    // while its canonical record still says active.
    const original = probeClaim({ id: `claim_${ulid()}`, entityId, subject, value: '2031-01-01', validFrom: T1, ingestedAt: T1 });
    fx.store.insertClaim(original);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);
    const replacement = probeClaim({ id: `claim_${ulid()}`, entityId, subject, value: '2031-02-02', validFrom: T2, ingestedAt: T2 });
    expect(admitClaim(replacement, fx.store).outcome).toBe('superseded');
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);
    expect(laneRows(fx.searchIndex)).toEqual([replacement.id]);

    // Exactly as `src/index.ts`'s smartware_revise tool calls it (no db, no
    // crash hooks, the server's lane). The warranted user revision.
    const result = await handleRevise(
      {
        actor: OWNER,
        target: original.id,
        expected_base_version: [...iterAllClaimVersions(fx.dataDir)]
          .filter(version => version.claim_id === original.id)
          .reduce((max, version) => Math.max(max, version.version), 0),
        set_confidence: 'high',
        reason: 'the earlier window was still in force',
        operation_id: `op_${ulid()}`,
      },
      fx.dataDir,
      fx.store,
      loadConfig(fx.dataDir),
      { opsDir: path.join(fx.dataDir, 'operations') },
      undefined,
      undefined,
      fx.searchIndex,
    );
    expect(result.claim_id).toBe(original.id);

    // The handler re-synced the revised claim's scope: both claims are
    // indexable again (the store's derivation of the revised canonical record),
    // and the live process no longer answers without the revised claim.
    const inProcess = await served(fx.core, subject);
    expect(inProcess).toContain(original.id);
    expect(laneRows(fx.searchIndex)).toEqual([original.id, replacement.id].sort());
    expect(await freshServed(fx, subject)).toEqual(inProcess);
  });

  it('REVISE through SmartwareCore.revise: the wrapper surface agrees with the MCP surface', async () => {
    const fx = await newFixture();
    const subject = 'Mcp Surface Wrapper Co';
    const entityId = `entity_${ulid()}`;
    fx.store.insertEntity({ id: entityId, canonical_name: subject, aliases: [], type: 'organization', scope: SCOPE, created_at: T1 });
    const original = probeClaim({ id: `claim_${ulid()}`, entityId, subject, value: '2031-03-03', validFrom: T1, ingestedAt: T1 });
    fx.store.insertClaim(original);
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);
    const replacement = probeClaim({ id: `claim_${ulid()}`, entityId, subject, value: '2031-04-04', validFrom: T2, ingestedAt: T2 });
    expect(admitClaim(replacement, fx.store).outcome).toBe('superseded');
    syncSearchFromClaims(fx.store, fx.searchIndex, SCOPE);

    await fx.core.revise({
      actor: OWNER,
      target: original.id,
      expected_base_version: [...iterAllClaimVersions(fx.dataDir)]
        .filter(version => version.claim_id === original.id)
        .reduce((max, version) => Math.max(max, version.version), 0),
      set_confidence: 'high',
      reason: 'verified with the client',
      operation_id: `op_${ulid()}`,
    });

    const inProcess = await served(fx.core, subject);
    expect(inProcess).toContain(original.id);
    expect(await freshServed(fx, subject)).toEqual(inProcess);
  });
});

// ── Classification tripwire ─────────────────────────────────────────────────
//
// Adding a tool to `src/index.ts` is the cheapest way to re-open this class on
// this surface. The two checks below make that loud rather than silent: every
// registered tool must be classified, and every tool whose path can move claim
// rows must hand the lane to its handler (the source slice check is a wiring
// tripwire, not a proof — it fails when the call site stops mentioning the
// lane, and a reviewer still owns the classification).

const REGISTRY: Array<{ name: string; lane: 'claim-rows' | 'none'; pin: string }> = [
  { name: 'smartware_context', lane: 'none', pin: '' },
  // Observe writes the raw observation and enqueues compile; claims reach the
  // lane through the compile pipeline (pinned below), not this call.
  { name: 'smartware_observe', lane: 'none', pin: '' },
  { name: 'smartware_recall', lane: 'none', pin: '' },
  { name: 'smartware_query', lane: 'none', pin: '' },
  { name: 'smartware_reflect', lane: 'claim-rows', pin: 'test/protocol/replay-catchup-lane-sync.test.ts (COMPILE case; the compiler re-syncs its own scopes)' },
  { name: 'smartware_compile', lane: 'claim-rows', pin: 'test/protocol/replay-catchup-lane-sync.test.ts (COMPILE case; the compiler re-syncs its own scopes)' },
  { name: 'smartware_read', lane: 'none', pin: '' },
  { name: 'smartware_explain', lane: 'none', pin: '' },
  { name: 'smartware_correct', lane: 'claim-rows', pin: 'this file (CORRECT over the MCP call shape)' },
  { name: 'smartware_revise', lane: 'claim-rows', pin: 'this file (REVISE over the MCP call shape)' },
  { name: 'smartware_forget', lane: 'claim-rows', pin: 'test/protocol/replay-catchup-lane-sync.test.ts (FORGET case)' },
  { name: 'smartware_forget_scope', lane: 'claim-rows', pin: 'test/protocol/forget-scope.test.ts + test/conformance/v050-rebuild-forget-provenance.test.ts (erasure: every lane zero)' },
  { name: 'smartware_export_scope', lane: 'none', pin: '' },
  { name: 'smartware_quarantine_review', lane: 'claim-rows', pin: 'test/protocol/replay-catchup-lane-sync.test.ts (quarantine-review case)' },
  { name: 'smartware_grant', lane: 'none', pin: '' },
  { name: 'smartware_revoke', lane: 'none', pin: '' },
  { name: 'smartware_session_start', lane: 'none', pin: '' },
  { name: 'smartware_session_describe', lane: 'none', pin: '' },
  { name: 'smartware_session_end', lane: 'none', pin: '' },
  { name: 'smartware_status', lane: 'none', pin: '' },
];

describe('the MCP tool registry is classified for the claim-FTS lane', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
  /** Each tool's registration text: from its `server.tool(` to the next one. */
  const registrations: string[] = [];
  const slices = new Map<string, string>();
  const starts = [...source.matchAll(/server\.tool\(/g)].map(match => match.index!);
  starts.forEach((start, index) => {
    const slice = source.slice(start, index + 1 < starts.length ? starts[index + 1] : source.length);
    const name = slice.match(/'([a-z_]+)'/)?.[1];
    if (!name) return;
    registrations.push(name);
    slices.set(name, slice);
  });

  it('every registered tool is classified here (a new tool fails this until it is)', () => {
    expect(registrations.slice().sort()).toEqual(REGISTRY.map(entry => entry.name).sort());
  });

  it('every claim-row-moving tool passes the lane at its call site', () => {
    for (const entry of REGISTRY.filter(item => item.lane === 'claim-rows')) {
      expect(slices.get(entry.name), `${entry.name} must pass searchIndex`).toContain('searchIndex');
    }
  });

  it('every claim-row-moving tool names where its lane behaviour is pinned', () => {
    for (const entry of REGISTRY.filter(item => item.lane === 'claim-rows')) {
      expect(entry.pin, `${entry.name} needs a named pin`).toBeTruthy();
    }
  });
});
