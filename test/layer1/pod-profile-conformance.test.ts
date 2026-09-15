// The pod-profile surface vs the published v0.5.0 Scope/ActorId patterns (ADR-0012).
//
// Two halves, measured on `wip/tech-head/claim-record-semantic` and decided on kanban
// `t_9a700aed`:
//
//   1. One instance, one substrate ActorId. Every autonomous writer (reflect.auto, the compile
//      queue, dream) mints one canonical lowercase `substrate:<slug>` (spec §5; the published
//      `ActorId` pattern is `^(user|agent|sidecar|substrate):[a-z0-9-]+$`, so the Crockford
//      uppercase ULID slugs the two writers used to mint were rejected — and dream minted a
//      second, different spelling).
//   2. Host-registered lanes are not v0.5.0 scopes. `createPodProfile` registers
//      `pod/<pod>/<lane>` ids; the published Scope vocabulary (`self`, `workspace`,
//      `project:<slug>`, `agent:<slug>`, `client:<id>[#n]`) does not admit a host-lane form, so a
//      pod-profile record's ONLY Ajv error is `/scope:pattern` — disclosed in
//      `schemas/v0.5.0/README.md`, not hidden. A protocol-native-lane record carries a complete,
//      empty error list. If a future protocol revision admits host lanes, both this file and the
//      schema fixture in `test/schemas-v0.5.0.test.ts` change in that revision's change.
//
// Raw-bytes discipline: the records are read off disk as JSONL (no library reader in the path)
// and validated with Ajv against `schemas/v0.5.0/` — the same instrument as the lane's probe
// (`probe/pod-profile-record.probe.test.ts` in the kanban workspace).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';

import { ACTOR_ID_PATTERN, SmartwareCore, substrateActorId } from '../../src/core.js';

const schemaDir = path.join(process.cwd(), 'schemas', 'v0.5.0');

const opened: SmartwareCore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const core of opened.splice(0)) core.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  for (const file of fs.readdirSync(schemaDir).filter(f => f.endsWith('.schema.json')).sort()) {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemaDir, file), 'utf8')) as AnySchema);
  }
  return ajv;
}

function claimValidator(ajv: Ajv2020): ValidateFunction {
  const validate = ajv.getSchema('https://smartware.dev/schemas/v0.5.0/claim.schema.json');
  expect(validate).toBeDefined();
  return validate as ValidateFunction;
}

/** Every active record on the canonical L1 JSONL surface, as bytes (no library reader). */
function rawActiveRecords(dataDir: string): Array<Record<string, unknown>> {
  const dir = path.join(dataDir, 'claims');
  const out: Array<Record<string, unknown>> = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.state === 'active') out.push(record);
    }
  }
  return out;
}

/** Every operations-log entry, as bytes. */
function rawOpsEntries(dataDir: string): Array<Record<string, unknown>> {
  const dir = path.join(dataDir, 'operations');
  const out: Array<Record<string, unknown>> = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean)) {
      out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

/** The complete Ajv error list, as `instancePath:keyword` strings. */
function errorList(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map(error => `${error.instancePath}:${error.keyword}`);
}

async function openCore(prefix: string): Promise<SmartwareCore> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `smartware-${prefix}-`));
  directories.push(dataDir);
  const core = await SmartwareCore.open({ dataDir });
  opened.push(core);
  return core;
}

/** One observation + one reflect.auto pass over `scope`, as a pod-profile host runs it. */
async function observeAndReflect(core: SmartwareCore, scope: string): Promise<void> {
  const actor = { type: 'person' as const, id: 'user:local', display_name: 'Owner' };
  core.ensureTrustedClientGrant('user:local', 'person', [scope]);
  await core.observe({
    actor,
    type: 'message',
    scope,
    observed_at: '2026-11-01T10:30:00Z',
    content: { format: 'text/plain', body: 'Graphiti API is deployed. Deadline: 2027-01-15.' },
  });
  await core.reflect({ actor, scope, use_llm: false });
}

describe('pod-profile records and the published v0.5.0 Scope/ActorId patterns (ADR-0012)', () => {
  it('mints one lowercase substrate ActorId; the only pattern error left is the host-lane scope', async () => {
    const core = await openCore('pod-profile-conformance');
    const profile = core.createPodProfile('conformance-pod');
    const expectedActorId = substrateActorId(core.getConfig());

    await observeAndReflect(core, profile.scopes.workspace);

    const records = rawActiveRecords(core.dataDir);
    expect(records.length).toBeGreaterThan(0);

    const validate = claimValidator(createAjv());
    for (const record of records) {
      // Half 1, fixed: the writer's own identity is the published pattern, one id per instance.
      expect(String(record.actor_id)).toBe(expectedActorId);
      expect(ACTOR_ID_PATTERN.test(String(record.actor_id))).toBe(true);

      // Half 2, disclosed: the host lane is not a v0.5.0 Scope value — and it is the ONLY error.
      expect(record.scope).toBe('pod/conformance-pod/workspace');
      const valid = validate(record) as boolean;
      expect(valid).toBe(false);
      expect(errorList(validate)).toEqual(['/scope:pattern']);
    }

    // The same identity is on the autonomous operations-log entries (reflect.auto).
    const reflectAuto = rawOpsEntries(core.dataDir).filter(entry => entry.op === 'reflect.auto');
    expect(reflectAuto.length).toBeGreaterThan(0);
    for (const entry of reflectAuto) {
      expect(entry.actor_id).toBe(expectedActorId);
    }
  });

  it('records written in protocol-native lanes carry a complete, empty Ajv error list', async () => {
    const core = await openCore('protocol-native-conformance');
    await observeAndReflect(core, 'workspace');

    const records = rawActiveRecords(core.dataDir);
    expect(records.length).toBeGreaterThan(0);

    const validate = claimValidator(createAjv());
    for (const record of records) {
      expect(record.scope).toBe('workspace');
      const valid = validate(record) as boolean;
      expect(errorList(validate)).toEqual([]);
      expect(valid).toBe(true);
    }
  });

  it('dream writes the same substrate ActorId as reflect.auto (one instance, one identity)', async () => {
    const core = await openCore('substrate-identity');
    const profile = core.createPodProfile('identity-pod');
    const expectedActorId = substrateActorId(core.getConfig());
    expect(ACTOR_ID_PATTERN.test(expectedActorId)).toBe(true);

    await observeAndReflect(core, profile.scopes.workspace);
    core.dream({
      actor: { type: 'person', id: core.getConfig().owner_id, display_name: 'Owner' },
      scope: profile.scopes.workspace,
    });

    const entries = rawOpsEntries(core.dataDir);
    const dreamEntries = entries.filter(entry => String(entry.op).startsWith('dream.'));
    expect(dreamEntries.length).toBeGreaterThan(0);
    const actorIds = new Set(entries.map(entry => entry.actor_id));
    // One substrate identity per instance: reflect.auto and dream agree with each other and with
    // the canonical helper. (Before ADR-0012, `substrate:<ULID>` and `substrate:smartware-<ulid>`
    // were two different spellings — the first rejected by the published pattern.)
    expect(actorIds).toEqual(new Set([expectedActorId]));
  });

  it('the slug is the pod/instance: named instances get the spec example form, not the prefix', () => {
    expect(substrateActorId({ instance_id: 'smartware_coffee' })).toBe('substrate:coffee');
    expect(substrateActorId({ instance_id: 'smartware_01M2JC3MZ9AZ070HZJSFZ8DYF5' }))
      .toBe('substrate:01m2jc3mz9az070hzjsfz8dyf5');
    for (const instanceId of ['smartware_coffee', 'smartware_01M2JC3MZ9AZ070HZJSFZ8DYF5', 'smartware_']) {
      expect(ACTOR_ID_PATTERN.test(substrateActorId({ instance_id: instanceId }))).toBe(true);
    }
  });
});
