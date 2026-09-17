// REFLECT without a scope compiles ALL scopes — pin (kanban t_27c73d58).
//
// `handleCompile` declares the contract in its own header: "Omitting scope
// compiles ALL scopes; only the owner may do that." Every downstream reader of
// the target already spells that absence as `undefined` (`CompileOptions.scope`,
// the L2 compiler's `if (options.scope && …)` gather guard,
// `reflectAutoCreateClaims`' scope filter, `syncSearchFromClaims`). Only the
// handler's own `const targetScope = params.scope ?? 'personal'` disagreed: it
// resolved the absence to one lane literal, which then (a) FILTERED claim
// production to a lane no Core-opened brain registers — measured on a fresh
// brain: a no-scope owner reflect produced 0 claims where a per-lane reflect
// produced 1 each — and (b) put that unregistered lane in the operations-log
// entry's `details.scope`, recording a scope the caller never named.
//
// This file pins the contract at the handler surface: an unscoped run compiles
// every registered lane (oracle: the union of the per-lane runs on identical
// fresh brains), and the operations log records such a run as unscoped (`null`,
// the same spelling its own `payload_hash` is computed over) rather than as a
// lane; a NAMED lane keeps filtering to that lane and being recorded by name;
// and the owner gate stays exactly as it was (a non-owner without a scope is
// still refused, a non-owner with a granted lane still compiles).
//
// A/B pair (this repo's mutation-check convention): at the pre-fix revision the
// unscoped cases fail — 0 claims, `details.scope: 'personal'` — while the named-
// lane and owner-gate controls pass unchanged; at the fix all pass. Nothing here
// imports what the fix introduces, so the byte-identical file runs on both arms.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ulid } from 'ulid';
import { afterEach, describe, test } from 'vitest';

import { createGrant } from '../../src/auth/grants.js';
import { SmartwareCore } from '../../src/core.js';

type Core = Awaited<ReturnType<typeof SmartwareCore.open>>;

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const STAFF = { type: 'agent' as const, id: 'agent:staff', display_name: 'Staff' };

/** One extractable body per registered lane (deterministic STATUS pattern). */
const BODIES: Record<string, string> = {
  self: 'Graphiti API is deployed.',
  workspace: 'Ledger API is deployed.',
  'project:default': 'Atlas API is deployed.',
};

const opened: Array<{ core: Core; dataDir: string }> = [];

async function openBrain(): Promise<{ core: Core; dataDir: string }> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-noscope-'));
  for (const sub of ['wiki', 'evidence', 'claims', 'operations']) {
    mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  opened.push({ core, dataDir });
  return { core, dataDir };
}

afterEach(() => {
  for (const { core, dataDir } of opened.splice(0)) {
    core.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/** One extractable observation in every lane the brain registers. */
async function seedEveryLane(core: Core): Promise<string[]> {
  const lanes = core.getConfig().scopes.map(scope => scope.id);
  for (const lane of lanes) {
    await core.observe({
      actor: OWNER,
      type: 'message',
      scope: lane,
      content: { format: 'text/plain', body: BODIES[lane] ?? 'Graphiti API is deployed.' },
      observed_at: '2026-11-02T10:00:00Z',
    });
  }
  return lanes;
}

/** Grant STAFF `compile` on one lane only. */
const grantStaff = (dataDir: string, lanes: string[]): void => {
  createGrant(dataDir, {
    actor_type: 'agent',
    actor_id: STAFF.id,
    trusted: true,
    quarantine: false,
    capabilities: { observe: lanes, query: lanes, compile: lanes, correct: [], forget: [], read: lanes },
  });
};

const claimScopes = (dataDir: string): Record<string, number> => {
  const dir = path.join(dataDir, 'claims');
  const counts: Record<string, number> = {};
  if (!existsSync(dir)) return counts;
  for (const file of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    const lines = readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const row = JSON.parse(line) as { scope: string };
      counts[row.scope] = (counts[row.scope] ?? 0) + 1;
    }
  }
  return counts;
};

interface ReflectEntry {
  operation_id: string;
  details: { payload_hash: string; scope: string | null; claims_created: number; pages_compiled: number };
}

const reflectEntries = (dataDir: string): ReflectEntry[] => {
  const dir = path.join(dataDir, 'operations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()
    .flatMap(file => readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean))
    .map(line => JSON.parse(line) as { op: string } & ReflectEntry)
    .filter(entry => entry.op === 'reflect.explicit')
    .map(entry => ({ operation_id: entry.operation_id, details: entry.details }));
};

describe('REFLECT with no scope compiles all scopes (t_27c73d58)', () => {
  test('an unscoped owner reflect equals the union of the per-lane reflects', async () => {
    const { core, dataDir } = await openBrain();
    const lanes = await seedEveryLane(core);
    const unscoped = await core.reflect({ actor: OWNER, use_llm: false, operation_id: `op_${ulid()}` });
    const fromUnscoped = claimScopes(dataDir);

    // Oracle: the same brain contents compiled one lane at a time, each on its
    // own fresh brain (claim production marks an observation processed, so the
    // lanes cannot share one).
    const union: Record<string, number> = {};
    let unionTotal = 0;
    for (const lane of lanes) {
      const arm = await openBrain();
      await seedEveryLane(arm.core);
      const result = await arm.core.reflect({ actor: OWNER, scope: lane, use_llm: false, operation_id: `op_${ulid()}` });
      unionTotal += result.claims_created;
      for (const [scope, count] of Object.entries(claimScopes(arm.dataDir))) {
        union[scope] = (union[scope] ?? 0) + count;
      }
    }

    // Non-vacuous: every registered lane produced at least one claim in the
    // oracle, so "the union" is not the empty set on both sides.
    assert.equal(Object.keys(union).sort().join(','), [...lanes].sort().join(','));
    for (const lane of lanes) assert.ok((union[lane] ?? 0) > 0, `oracle lane ${lane} produced no claims`);

    assert.deepEqual(fromUnscoped, union, 'an unscoped reflect must compile exactly the union of the lanes');
    assert.equal(unscoped.claims_created, unionTotal);
  }, 180_000);

  test('the operations log records an unscoped run as unscoped, never as a lane', async () => {
    const { core, dataDir } = await openBrain();
    const lanes = await seedEveryLane(core);
    const result = await core.reflect({ actor: OWNER, use_llm: false, operation_id: `op_${ulid()}` });

    const entries = reflectEntries(dataDir);
    assert.equal(entries.length, 1);
    const details = entries[0]!.details;
    assert.equal(details.scope, null, 'the entry must not name a lane the caller did not ask for');
    assert.equal(details.claims_created, result.claims_created);
    for (const lane of lanes) assert.notEqual(details.scope as unknown, lane);
    // `payload_hash` is computed over `scope: params.scope ?? null`; the entry
    // now agrees with the payload it is keyed on.
    const payload = await core.reflect({
      actor: OWNER, use_llm: false, operation_id: entries[0]!.operation_id,
    });
    assert.equal(payload.claims_created, result.claims_created, 'replay of the same id returns the recorded run');
    assert.equal(reflectEntries(dataDir).length, 1, 'no second entry on an idempotent replay');
  }, 120_000);

  test('a named lane still filters to that lane and is recorded by name', async () => {
    const { core, dataDir } = await openBrain();
    await seedEveryLane(core);
    const result = await core.reflect({
      actor: OWNER, scope: 'workspace', use_llm: false, operation_id: `op_${ulid()}`,
    });

    assert.deepEqual(claimScopes(dataDir), { workspace: 1 });
    assert.equal(result.claims_created, 1);
    assert.deepEqual(reflectEntries(dataDir).map(e => e.details.scope), ['workspace']);
  }, 120_000);

  test('a non-owner still cannot compile without naming a lane', async () => {
    const { core, dataDir } = await openBrain();
    await seedEveryLane(core);
    grantStaff(dataDir, ['workspace']);

    await assert.rejects(
      () => core.reflect({ actor: STAFF, use_llm: false, operation_id: `op_${ulid()}` }),
      (error: { code?: string }) => error.code === 'invalid_scope',
    );
    assert.deepEqual(claimScopes(dataDir), {});
    assert.deepEqual(reflectEntries(dataDir), []);
  }, 120_000);

  test('a non-owner still compiles the lane they are granted, and only it', async () => {
    const { core, dataDir } = await openBrain();
    await seedEveryLane(core);
    grantStaff(dataDir, ['workspace']);

    const result = await core.reflect({
      actor: STAFF, scope: 'workspace', use_llm: false, operation_id: `op_${ulid()}`,
    });
    assert.equal(result.claims_created, 1);
    assert.deepEqual(claimScopes(dataDir), { workspace: 1 });

    await assert.rejects(
      () => core.reflect({ actor: STAFF, scope: 'self', use_llm: false, operation_id: `op_${ulid()}` }),
      (error: { code?: string }) => error.code === 'insufficient_permission',
    );
  }, 120_000);

  test('deferred synthesis indexes every lane\'s claims, not one lane', async () => {
    const { core, dataDir } = await openBrain();
    const lanes = await seedEveryLane(core);
    const result = await core.compile({
      actor: OWNER, use_llm: false, defer_synthesis: true, operation_id: `op_${ulid()}`,
    });

    assert.equal(result.claims_created, lanes.length);
    assert.equal(result.telemetry.layer3_indexed_count, lanes.length);
    for (const lane of lanes) {
      const hits = await core.query({ actor: OWNER, query: 'API', scope: lane });
      assert.equal(hits.results.length, 1, `lane ${lane} is missing from the L3 index`);
    }
  }, 120_000);
});
