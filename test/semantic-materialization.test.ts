import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import Ajv2020, { type AnySchema } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { SmartwareCore } from '../src/core.js';
import { iterAllClaimVersions } from '../src/layer1/jsonl.js';

const opened: SmartwareCore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const core of opened.splice(0)) core.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('reflect.auto semantic materialization', () => {
  it('preserves typed extraction and valid time without elevating autonomous authority', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartware-semantic-materialization-'));
    directories.push(dataDir);
    const core = await SmartwareCore.open({ dataDir });
    opened.push(core);
    const profile = core.createPodProfile('semantic-test');
    core.ensureTrustedClientGrant('person-local', 'person', [profile.scopes.workspace]);
    const observedAt = '2026-11-01T10:30:00Z';

    await core.observe({
      actor: { type: 'person', id: 'person-local', display_name: 'Owner' },
      type: 'message',
      scope: profile.scopes.workspace,
      observed_at: observedAt,
      content: {
        format: 'text/plain',
        body: 'Graphiti API is deployed. Deadline: 2027-01-15.',
      },
    });
    await core.reflect({
      actor: { type: 'person', id: 'person-local', display_name: 'Owner' },
      scope: profile.scopes.workspace,
      use_llm: false,
    });

    const versions = [...iterAllClaimVersions(dataDir)]
      .filter(version => version.state === 'active');
    const statusVersion = versions.find(version =>
      version.semantic?.subject_name === 'Graphiti API'
      && version.semantic.predicate === 'status_is');
    expect(statusVersion?.semantic).toMatchObject({
      subject_type: 'tool',
      object: { type: 'enum', value: 'deployed' },
      t_valid_from: {
        value: observedAt,
        state: 'inferred',
        basis: 'source_observed_at',
      },
      extracted_epistemic: 'observed',
      extracted_confidence: 0.85,
      extraction: { method: 'deterministic' },
    });
    expect(statusVersion?.confidence).toBe('low');
    expect(statusVersion?.epistemic_tag).toBe('inference');
    expect(statusVersion?.relations).toEqual([]);

    const snapshot = core.readKnowledgeGraph({
      actor: { type: 'person', id: 'person-local', display_name: 'Owner' },
      scopes: [profile.scopes.workspace],
    });
    const statusClaim = snapshot.claims.find(claim =>
      claim.subject_name === 'Graphiti API' && claim.predicate === 'status_is');
    expect(snapshot.entities.find(entity => entity.entity_id === statusClaim?.subject_id)?.type).toBe('tool');
    expect(statusClaim?.object).toEqual({ type: 'enum', value: 'deployed' });
    expect(statusClaim?.valid_at).toBe(observedAt);
    expect(statusClaim?.provenance.origin).toBe('deterministic');

    core.close();
    opened.splice(opened.indexOf(core), 1);
    const reopened = await SmartwareCore.open({ dataDir });
    opened.push(reopened);
    const replayed = reopened.readKnowledgeGraph({
      actor: { type: 'person', id: 'person-local', display_name: 'Owner' },
      scopes: [profile.scopes.workspace],
    });
    const replayedStatus = replayed.claims.find(claim =>
      claim.subject_name === 'Graphiti API' && claim.predicate === 'status_is');
    expect(replayedStatus?.object).toEqual({ type: 'enum', value: 'deployed' });
    expect(replayed.entities.find(entity => entity.entity_id === replayedStatus?.subject_id)?.type).toBe('tool');
  });

  it('the records reflect.auto appends are accepted by the published claim schema', async () => {
    // The block this suite exists for is also what the L1 record looks like on disk, so the record
    // has to be one the published contract accepts — the other writer of the same block
    // (`insertClaim`) is pinned by test/layer1/legacy-operation-id.test.ts. Read the raw JSONL bytes:
    // the library's reader applies a migration backfill, and the contract applies to what was written.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartware-semantic-schema-'));
    directories.push(dataDir);
    const core = await SmartwareCore.open({ dataDir });
    opened.push(core);
    const profile = core.createPodProfile('semantic-schema-test');
    core.ensureTrustedClientGrant('person-local', 'person', [profile.scopes.workspace]);

    await core.observe({
      actor: { type: 'person', id: 'person-local', display_name: 'Owner' },
      type: 'message',
      scope: profile.scopes.workspace,
      observed_at: '2026-11-01T10:30:00Z',
      content: { format: 'text/plain', body: 'Graphiti API is deployed. Deadline: 2027-01-15.' },
    });
    await core.reflect({
      actor: { type: 'person', id: 'person-local', display_name: 'Owner' },
      scope: profile.scopes.workspace,
      use_llm: false,
    });
    core.close();
    opened.splice(opened.indexOf(core), 1);

    const claimsDir = path.join(dataDir, 'claims');
    const records = fs.readdirSync(claimsDir).filter(f => f.endsWith('.jsonl')).sort()
      .flatMap(file => fs.readFileSync(path.join(claimsDir, file), 'utf8')
        .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>));
    const active = records.filter(record => record.state === 'active');
    expect(active.length).toBeGreaterThan(0);

    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    addFormats(ajv);
    const schemaDir = path.join(process.cwd(), 'schemas', 'v0.5.0');
    for (const file of fs.readdirSync(schemaDir).filter(f => f.endsWith('.schema.json')).sort()) {
      ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemaDir, file), 'utf8')) as AnySchema);
    }
    const validate = ajv.getSchema('https://smartware.dev/schemas/v0.5.0/claim.schema.json');
    expect(validate).toBeDefined();

    for (const record of active) {
      // The scope substitution is the one remaining, disclosed divergence: a pod-profile host lane
      // is not a v0.5.0 Scope value (ADR-0015, schemas/v0.5.0/README.md). The actor id is no longer
      // substituted — the writers mint one canonical lowercase `substrate:<slug>`, pinned in
      // test/layer1/pod-profile-conformance.test.ts together with this record-level pin.
      const conformant = { ...record, scope: 'workspace' };
      expect(validate!(conformant)).toBe(true);
      expect(validate!.errors ?? []).toEqual([]);
      // The block is optional (records written before v0.6 omit it), and it is what carries the
      // typed assertion the row is rebuilt from.
      const { semantic, ...withoutBlock } = conformant;
      expect(semantic).toBeDefined();
      expect(validate!(withoutBlock)).toBe(true);
    }
  });
});
