// CONSOLIDATE (ADR-0002) — collapse claims into one reviewed summary, preserve
// evidence lineage, tombstone inputs, exclude inputs from recall.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import { createDefaultConfig, saveConfig, type SmartwareConfig } from '../../src/config.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { makeClaim } from '../helpers.js';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const ACME = 'client:acme#1';

function scaffold(dataDir: string, config: SmartwareConfig): void {
  for (const sub of ['wiki/personal', 'wiki/workspace', 'wiki/project', 'evidence', 'claims', 'operations']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  saveConfig(dataDir, config);
}

function makeConfig(dataDir: string): SmartwareConfig {
  const cfg = createDefaultConfig(dataDir);
  cfg.owner_id = 'user:owner';
  cfg.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    { id: ACME, parent: 'workspace', visibility_default: 'scope' },
  ];
  return cfg;
}

function insertClaimFor(store: ClaimStore, searchIndex: SearchIndex, opts: {
  subject_name: string; predicate: string; value: string; evidence: string[];
}): string {
  const subjectId = `entity_${ulid()}`;
  store.insertEntity({ id: subjectId, canonical_name: opts.subject_name, aliases: [], type: 'organization', scope: ACME, created_at: new Date().toISOString() });
  const claim = makeClaim({
    subject_id: subjectId, subject_name: opts.subject_name, scope: ACME,
    predicate: opts.predicate, object: { type: 'text', value: opts.value },
    confidence: 0.8, supporting_evidence: opts.evidence, status: 'active', epistemic: 'observed',
    extraction: { method: 'deterministic', model: null, compiler_version: '0.6.3', prompt_hash: null, extracted_at: new Date().toISOString() },
  });
  store.insertClaim(claim);
  syncSearchFromClaims(store, searchIndex, ACME);
  return claim.id;
}

describe('consolidate', () => {
  let core: SmartwareCore | null = null;
  let dataDir = '';
  let store: ClaimStore | null = null;
  let searchIndex: SearchIndex | null = null;

  afterEach(() => {
    core?.close();
    store?.close();
    searchIndex?.close();
    core = null; store = null; searchIndex = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function open(): Promise<SmartwareCore> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-consolidate-'));
    scaffold(dataDir, makeConfig(dataDir));
    core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
    const dbPath = path.join(dataDir, 'smartware.db');
    store = new ClaimStore(dbPath);
    store.setDataDir(dataDir);
    searchIndex = new SearchIndex(dbPath);
    return core;
  }

  it('collapses 2 claims into one reviewed summary, preserving evidence + excluding inputs', async () => {
    const c = await open();
    const c1 = insertClaimFor(store!, searchIndex!, { subject_name: 'Acme', predicate: 'prefers_contact', value: 'email', evidence: ['obs_a'] });
    const c2 = insertClaimFor(store!, searchIndex!, { subject_name: 'Acme', predicate: 'prefers_contact', value: 'email on weekdays', evidence: ['obs_b'] });

    const before = await c.query({ actor: OWNER, query: 'prefers_contact', scope: ACME });
    expect(before.results.length).toBeGreaterThanOrEqual(2);

    const op = `op_${ulid()}`;
    const result = await c.consolidate({
      actor: OWNER, claim_ids: [c1, c2], scope: ACME,
      summary: 'Acme prefers email over phone for all contact', subject_name: 'Acme', predicate: 'prefers_contact',
      operation_id: op,
    });
    expect(result.inputs_consolidated).toBe(2);
    expect(result.claim_id).toMatch(/^claim_/);
    // Evidence lineage superset: both inputs + their evidence.
    expect(result.derived_from).toEqual(expect.arrayContaining([c1, c2, 'obs_a', 'obs_b']));

    const after = await c.query({ actor: OWNER, query: 'prefers email', scope: ACME });
    const ids = after.results.map(h => h.claim?.id);
    expect(ids).toContain(result.claim_id);
    expect(ids).not.toContain(c1);
    expect(ids).not.toContain(c2);
  });

  it('is idempotent per operation_id', async () => {
    const c = await open();
    const c1 = insertClaimFor(store!, searchIndex!, { subject_name: 'Acme', predicate: 'billing', value: 'quarterly', evidence: ['obs_x'] });
    const c2 = insertClaimFor(store!, searchIndex!, { subject_name: 'Acme', predicate: 'billing', value: 'monthly', evidence: ['obs_y'] });
    const op = `op_${ulid()}`;
    const a = await c.consolidate({ actor: OWNER, claim_ids: [c1, c2], scope: ACME, summary: 'Acme billing is quarterly', subject_name: 'Acme', predicate: 'billing', operation_id: op });
    const b = await c.consolidate({ actor: OWNER, claim_ids: [c1, c2], scope: ACME, summary: 'Acme billing is quarterly', subject_name: 'Acme', predicate: 'billing', operation_id: op });
    expect(b.claim_id).toBe(a.claim_id);
  });

  it('refuses non-user actors', async () => {
    const c = await open();
    const c1 = insertClaimFor(store!, searchIndex!, { subject_name: 'Acme', predicate: 'x', value: 'y', evidence: ['obs_z'] });
    const c2 = insertClaimFor(store!, searchIndex!, { subject_name: 'Acme', predicate: 'x', value: 'y2', evidence: ['obs_w'] });
    await expect(
      c.consolidate({ actor: { type: 'agent', id: 'agent:x', display_name: 'A' }, claim_ids: [c1, c2], scope: ACME, summary: 's', subject_name: 'Acme', predicate: 'x', operation_id: `op_${ulid()}` }),
    ).rejects.toThrow();
  });
});
