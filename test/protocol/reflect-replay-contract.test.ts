// REFLECT replay: a matched `operation_id` returns the RECORDED result and
// writes nothing — pin (kanban t_efa8d5a8, decision in
// `docs/adr/0018-reflect-replay-returns-the-recorded-result.md`).
//
// Protocol v0.5.0, "Idempotency and commit identity": "Same OperationId plus
// identical canonical payload returns the prior result." The committed
// `reflect.explicit` entry IS that prior result — it is appended only after the
// compile has finished, so its counts belong to the run that committed.
//
// Pre-fix the replay matched the entry, checked the payload, and then fell
// through into the whole compile: it re-ran claim production, L2 synthesis, L3
// indexing and `reflect.auto` receipts, and returned the entry's recorded
// `claims_created` next to a freshly measured `pages_compiled` — a result
// describing two different runs at once, from writes a retry did not ask for.
// It was measured (not asserted) on `t_27c73d58`'s branch tip: a fixed build
// replaying a pre-fix brain's id returned `claims_created: 0` (recorded) with
// `pages_compiled: 3` (fresh) while taking the brain from 0 claims / 1 page /
// 1 ops line to 3 claims / 5 pages / 7 ops lines.
//
// This file pins the decision at the handler surface:
//   1. a matched replay returns BOTH counts from the entry, marks the result
//      `telemetry.replayed`, and changes no canonical byte — even when there is
//      pending work a re-run would have compiled (the control proves the work
//      was there: a fresh id compiles it);
//   2. an id recorded by a pre-fix build replays to its recorded result (the
//      upgrade case: the pre-fix run left its observations unprocessed, and the
//      replay does not process them) — fresh behaviour needs a fresh id;
//   3. a deferred-synthesis replay carries the recorded 0 pages and the
//      deferred marker;
//   4. a different payload is still `conflict`, and an entry carrying no
//      recorded counts is refused rather than reported as a 0/0 run.
//
// Nothing here imports what the fix introduces, so the byte-identical file runs
// on both arms of the A/B: at `48cdc0b` (pre-fix) the replay cases fail — fresh
// `pages_compiled`, no `replayed` marker, an ops log that grew — and at the fix
// all pass.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ulid } from 'ulid';
import { afterEach, describe, test } from 'vitest';

import { SmartwareCore } from '../../src/core.js';
import { computePayloadHash } from '../../src/layer0/idempotency.js';
import { appendOpLogEntry } from '../../src/ops_log/index.js';

type Core = Awaited<ReturnType<typeof SmartwareCore.open>>;

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };

/** One extractable body per registered lane (deterministic STATUS pattern). */
const BODIES: Record<string, string> = {
  self: 'Graphiti API is deployed.',
  workspace: 'Ledger API is deployed.',
  'project:default': 'Atlas API is deployed.',
};

/** The canonical payload a REFLECT with these params is keyed on. */
const payloadHashFor = (params: { scope?: string; entity_id?: string; use_llm?: boolean } = {}): string =>
  computePayloadHash({
    actor_id: OWNER.id,
    scope: params.scope ?? null,
    entity_id: params.entity_id ?? null,
    use_llm: params.use_llm ?? false,
  });

const opened: Array<{ core: Core; dataDir: string }> = [];

async function openBrain(): Promise<{ core: Core; dataDir: string }> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-replay-'));
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

interface BrainState {
  claims: number;
  ops: number;
  evidence: number;
  /** `<layer>/<file>` → sha256, over the canonical surfaces. */
  files: Record<string, string>;
}

const digest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

function readBrain(dataDir: string): BrainState {
  const state: BrainState = { claims: 0, ops: 0, evidence: 0, files: {} };
  for (const layer of ['claims', 'operations', 'evidence', 'wiki']) {
    const dir = path.join(dataDir, layer);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (!statSync(full).isFile()) continue;
      state.files[`${layer}/${name}`] = digest(full);
      if (layer === 'claims') state.claims += readFileSync(full, 'utf8').split('\n').filter(Boolean).length;
      if (layer === 'operations') state.ops += readFileSync(full, 'utf8').split('\n').filter(Boolean).length;
      if (layer === 'evidence') state.evidence += readFileSync(full, 'utf8').split('\n').filter(Boolean).length;
    }
  }
  return state;
}

/** Only the canonical surfaces a REFLECT may write — `.db` files are derived. */
const canonical = (state: BrainState): Pick<BrainState, 'claims' | 'ops' | 'evidence' | 'files'> => ({
  claims: state.claims,
  ops: state.ops,
  evidence: state.evidence,
  files: state.files,
});

interface ReflectEntry {
  operation_id: string;
  op: string;
  details: { payload_hash: string; scope: string | null; claims_created: number; pages_compiled: number };
}

function reflectEntries(dataDir: string): ReflectEntry[] {
  const dir = path.join(dataDir, 'operations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()
    .flatMap(file => readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean))
    .map(line => JSON.parse(line) as { op: string } & ReflectEntry)
    .filter(entry => entry.op === 'reflect.explicit');
}

function opsOpCounts(dataDir: string): Record<string, number> {
  const dir = path.join(dataDir, 'operations');
  const counts: Record<string, number> = {};
  if (!existsSync(dir)) return counts;
  for (const line of readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()
    .flatMap(file => readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean))) {
    const op = (JSON.parse(line) as { op: string }).op;
    counts[op] = (counts[op] ?? 0) + 1;
  }
  return counts;
}

/**
 * The entry a pre-fix build recorded for an unscoped run that produced nothing:
 * the measured bytes from `t_27c73d58`'s reviewer evidence (`scope: 'personal'`,
 * 0 claims / 0 pages, payload hash over `scope: null`), written here through the
 * repo's own durable writer so the fixture cannot drift from the real shape.
 */
function writePreFixEntry(dataDir: string, operationId: string): void {
  appendOpLogEntry(path.join(dataDir, 'operations'), {
    operation_id: operationId,
    actor_id: OWNER.id,
    timestamp: '2026-11-02T10:00:00.000Z',
    op: 'reflect.explicit',
    details: {
      payload_hash: payloadHashFor({ scope: undefined, use_llm: false }),
      scope: 'personal',
      claims_created: 0,
      pages_compiled: 0,
    },
  });
}

describe('REFLECT replay returns the recorded result and writes nothing (t_efa8d5a8)', () => {
  test('a matched replay is a no-op even with pending work, and a fresh id compiles that work', async () => {
    const { core, dataDir } = await openBrain();
    await seedEveryLane(core);
    const id = `op_${ulid()}`;
    const first = await core.reflect({ actor: OWNER, use_llm: false, operation_id: id });

    // Non-vacuous: the recorded run did work, so "the same counts" is not 0/0
    // on both sides.
    assert.ok(first.claims_created > 0, `the recorded run created no claims (${first.claims_created})`);
    assert.ok(first.pages_compiled > 0, `the recorded run compiled no pages (${first.pages_compiled})`);
    const entry = reflectEntries(dataDir);
    assert.equal(entry.length, 1);
    assert.equal(entry[0]!.details.claims_created, first.claims_created);
    assert.equal(entry[0]!.details.pages_compiled, first.pages_compiled);

    // Pending work a re-run would pick up: one more extractable observation.
    await core.observe({
      actor: OWNER,
      type: 'message',
      scope: 'workspace',
      content: { format: 'text/plain', body: 'Zeta API is deployed.' },
      observed_at: '2026-11-02T11:00:00Z',
    });
    const before = readBrain(dataDir);
    const opsBefore = opsOpCounts(dataDir);

    const replayed = await core.reflect({ actor: OWNER, use_llm: false, operation_id: id });

    // Both counts are the recorded ones — never recorded + fresh in one result.
    assert.equal(replayed.claims_created, first.claims_created, 'claims_created must be the recorded count');
    assert.equal(replayed.pages_compiled, first.pages_compiled, 'pages_compiled must be the recorded count');
    assert.equal(
      replayed.telemetry.replayed, true,
      'a replayed result must say so: the counts above are historical, not measured by this call',
    );
    // Nothing was measured by this call, so nothing claims to have been.
    assert.equal(replayed.telemetry.layer3_indexed_count, 0);
    assert.equal(replayed.telemetry.observations_processed, 0);
    assert.deepEqual(replayed.audit, []);
    assert.equal(replayed.git_sha, undefined);
    assert.equal(replayed.telemetry.freshness, undefined, 'a recorded result must not carry a live reading');

    // No canonical byte moved: same claims, same pages, same ops lines, and no
    // new `reflect.auto` receipt for the pending observation.
    const after = readBrain(dataDir);
    assert.deepEqual(canonical(after), canonical(before), 'a replay must not write to claims/, wiki/, operations/ or evidence/');
    assert.deepEqual(opsOpCounts(dataDir), opsBefore, 'a replay must not append receipts');
    assert.equal(reflectEntries(dataDir).length, 1, 'a replay must not append a second reflect.explicit entry');

    // Control: the pending observation was genuinely uncompiled, so a re-run
    // would have produced work — a FRESH id compiles it.
    const fresh = await core.reflect({ actor: OWNER, use_llm: false, operation_id: `op_${ulid()}` });
    assert.equal(fresh.claims_created, 1, 'the pending observation must still be compilable under a fresh id');
    assert.equal(fresh.telemetry.replayed, undefined);
    const grown = readBrain(dataDir);
    assert.ok(grown.claims > after.claims, 'the fresh run is the positive control for the replay');
  }, 180_000);

  test('an id recorded by a pre-fix build replays to its recorded result; fresh behaviour needs a fresh id', async () => {
    const { core, dataDir } = await openBrain();
    await seedEveryLane(core);

    // The upgrade case, byte-shaped like the measured pre-fix entry: the run
    // recorded 0 claims / 0 pages and left its observations unprocessed (the
    // pre-fix `personal` filter `continue`d before the receipt).
    const id = `op_${ulid()}`;
    writePreFixEntry(dataDir, id);
    const before = readBrain(dataDir);
    assert.equal(before.claims, 0);
    assert.equal(before.ops, 1);

    const replayed = await core.reflect({ actor: OWNER, use_llm: false, operation_id: id });

    assert.equal(replayed.claims_created, 0, 'the recorded 0 must be reported as recorded, not repaired by a re-run');
    assert.equal(replayed.pages_compiled, 0);
    assert.equal(replayed.telemetry.replayed, true);
    assert.deepEqual(canonical(readBrain(dataDir)), canonical(before), 'the pre-fix brain must be left untouched');
    assert.equal(before.evidence, 3, 'the three seeded observations are the pending work');

    // The observations are still unprocessed — proven by compiling them under a
    // fresh id, which is what "fresh behaviour needs a fresh id" means.
    const fresh = await core.reflect({ actor: OWNER, use_llm: false, operation_id: `op_${ulid()}` });
    assert.equal(fresh.claims_created, 3, 'the unprocessed observations must still be compilable under a fresh id');
    assert.equal(fresh.telemetry.replayed, undefined);
    assert.equal(reflectEntries(dataDir).length, 2, 'the fresh run records its own entry');
  }, 180_000);

  test('a deferred-synthesis replay carries the recorded 0 pages and the deferred marker', async () => {
    const { core, dataDir } = await openBrain();
    await seedEveryLane(core);
    const id = `op_${ulid()}`;
    const first = await core.compile({ actor: OWNER, use_llm: false, defer_synthesis: true, operation_id: id });

    assert.ok(first.claims_created > 0);
    assert.equal(first.pages_compiled, 0);
    assert.equal(first.telemetry.synthesis_deferred, true);

    const before = readBrain(dataDir);
    const replayed = await core.reflect({ actor: OWNER, use_llm: false, defer_synthesis: true, operation_id: id });

    assert.equal(replayed.claims_created, first.claims_created);
    assert.equal(replayed.pages_compiled, 0);
    assert.equal(replayed.telemetry.replayed, true);
    assert.equal(replayed.telemetry.synthesis_deferred, true, 'the prior result carried the deferred marker');
    assert.deepEqual(canonical(readBrain(dataDir)), canonical(before));

    // Consequence, pinned deliberately (ADR-0018, *Consequences*): the deferred
    // L2 stage is a SEPARATE operation, so it is driven with a fresh id. A
    // same-id call with `defer_synthesis` absent is a replay of the deferred
    // operation (the payload hash never carried `defer_synthesis`), returns the
    // recorded 0 pages, and synthesises nothing — under the pre-fix fall-through
    // it silently completed the L2 step instead, which is what made the
    // deferred flow id-dependent.
    const sameId = await core.reflect({ actor: OWNER, use_llm: false, operation_id: id });
    assert.equal(sameId.telemetry.replayed, true);
    assert.equal(sameId.pages_compiled, 0, 'a same-id L2 completion is a replay, not a synthesis');
    assert.deepEqual(canonical(readBrain(dataDir)), canonical(before));

    // The sanctioned completion: the same stage under its own operation_id.
    const completed = await core.reflect({ actor: OWNER, use_llm: false, operation_id: `op_${ulid()}` });
    assert.ok(completed.pages_compiled > 0, 'a fresh id must still compile the pages');
    assert.equal(completed.telemetry.replayed, undefined);
  }, 180_000);

  test('a different payload on the same id is still a conflict', async () => {
    const { core, dataDir } = await openBrain();
    await seedEveryLane(core);
    const id = `op_${ulid()}`;
    await core.reflect({ actor: OWNER, use_llm: false, operation_id: id });
    const before = readBrain(dataDir);

    await assert.rejects(
      () => core.reflect({ actor: OWNER, scope: 'workspace', use_llm: false, operation_id: id }),
      (error: { code?: string }) => error.code === 'conflict',
    );
    assert.deepEqual(canonical(readBrain(dataDir)), canonical(before));
  }, 180_000);

  test('an entry with no recorded counts is refused, never reported as a 0/0 run', async () => {
    const { core, dataDir } = await openBrain();
    await seedEveryLane(core);
    const id = `op_${ulid()}`;
    appendOpLogEntry(path.join(dataDir, 'operations'), {
      operation_id: id,
      actor_id: OWNER.id,
      timestamp: '2026-11-02T10:00:00.000Z',
      op: 'reflect.explicit',
      details: { payload_hash: payloadHashFor({ use_llm: false }), scope: null, synthesis_deferred: true },
    });

    await assert.rejects(
      () => core.reflect({ actor: OWNER, use_llm: false, operation_id: id }),
      (error: { code?: string }) => error.code === 'conflict',
    );
    // Fail-closed, not silent: the pending observations are untouched and still
    // compilable under a fresh id.
    assert.equal(readBrain(dataDir).claims, 0);
    const fresh = await core.reflect({ actor: OWNER, use_llm: false, operation_id: `op_${ulid()}` });
    assert.equal(fresh.claims_created, 3);
  }, 180_000);
});
