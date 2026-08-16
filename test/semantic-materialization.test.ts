import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
});
