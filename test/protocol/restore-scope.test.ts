// Tests: Protocol — RESTORE.SCOPE (the return path for an EXPORT.SCOPE package).
//
// An export nobody can read back is a dead-end artifact, so the return path has to be
// executable: a package produced by handleExportScope must restore into a fresh brain and
// yield the same canonical records, the same provenance and the same recall answers.
//
// Oracle behaviors:
//   - owner-only; derived indexes are never part of the package and are rebuilt on restore;
//   - one scope = one boundary: a package for scope A never writes into scope B;
//   - integrity: a package whose content does not match its manifest checksums is refused;
//   - no merging: restoring into a scope that already holds content is a conflict, not a merge;
//   - idempotent per export: a second restore of the same package writes nothing;
//   - post-erasure package (deletion certificate, no content) restores as an empty package.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import { SmartwareCore } from '../../src/core.js';
import { ClaimStore } from '../../src/layer1/store.js';
import { SearchIndex, syncSearchFromClaims } from '../../src/layer3/search.js';
import { knownTime, nullTime } from '../../src/layer1/types.js';
import type { Actor } from '../../src/layer0/types.js';
import type { SmartwareConfig } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';
import type { Claim } from '../../src/layer1/types.js';
import { ProtocolError } from '../../src/auth/middleware.js';

const SCOPE = 'client:acme#1';
const OTHER_SCOPE = 'client:bcau#1';
const OWNER: Actor = { type: 'person', id: 'user:owner', display_name: 'Owner' };
const STAFF: Actor = { type: 'person', id: 'user:gigi', display_name: 'Gigi' };

const opened: SmartwareCore[] = [];
const dirs: string[] = [];

function tenantConfig(dataDir: string): SmartwareConfig {
  return {
    instance_id: `smartware_${ulid()}`,
    owner_id: OWNER.id,
    writer_id: `writer_${ulid()}`,
    version: '0.7.0',
    data_dir: dataDir,
    scopes: [
      { id: 'self', parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: SCOPE, parent: 'workspace', visibility_default: 'scope' },
      { id: OTHER_SCOPE, parent: 'workspace', visibility_default: 'scope' },
    ],
    grants: [
      {
        id: `grant_${ulid()}`,
        actor_type: 'person',
        actor_id: STAFF.id,
        capabilities: { observe: [SCOPE], query: [SCOPE], compile: [], correct: [], forget: [], read: [SCOPE] },
        trusted: false,
        quarantine: false,
        created_at: '2026-08-01T00:00:00.000Z',
        expires_at: null,
        status: 'active',
      },
    ],
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
}

async function newBrain(seed?: (core: SmartwareCore, store: ClaimStore, index: SearchIndex) => Promise<void>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-restore-'));
  dirs.push(dataDir);
  saveConfig(dataDir, tenantConfig(dataDir));
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  opened.push(core);
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const index = new SearchIndex(dbPath);
  if (seed) await seed(core, store, index);
  return { dataDir, core, store, index };
}

/** Route-b write path: observe the evidence, then persist the claim the host extracted. */
async function observeAndClaim(
  core: SmartwareCore,
  store: ClaimStore,
  index: SearchIndex,
  { scope, subject, predicate, value, body }: { scope: string; subject: string; predicate: string; value: string; body: string },
): Promise<{ observationId: string; claimId: string }> {
  const observed = await core.observe({
    actor: OWNER,
    type: 'message',
    content: { format: 'text/markdown', body },
    scope,
    visibility: 'scope',
    operation_id: `op_${ulid()}`,
  });
  const subjectId = `entity_${subject.toLowerCase()}`;
  if (!store.getEntity(subjectId)) {
    store.insertEntity({ id: subjectId, canonical_name: subject, aliases: [], type: 'organization', scope, created_at: new Date().toISOString() });
  }
  const claim: Claim = {
    id: `claim_${ulid()}`,
    subject_id: subjectId,
    subject_name: subject,
    predicate,
    object: { type: 'text', value },
    scope,
    validity: { from: '2026-09-01T00:00:00.000Z', to: null },
    t_ingested: knownTime('2026-09-01T00:00:00.000Z'),
    t_invalidated: nullTime(),
    t_valid_from: knownTime('2026-09-01T00:00:00.000Z'),
    t_valid_to: nullTime(),
    source_event_id: observed.id,
    extraction_event_id: observed.id,
    supporting_evidence: [observed.id],
    extraction: { method: 'deterministic', model: null, compiler_version: '0.7.0', prompt_hash: null, extracted_at: '2026-09-01T00:00:00.000Z' },
    status: 'active',
    epistemic: 'observed',
    confidence: 0.85,
    sensitive: false,
    superseded_by: null,
    contested_by: [],
  };
  store.insertClaim(claim);
  syncSearchFromClaims(store, index, scope);
  return { observationId: observed.id, claimId: claim.id };
}

async function guarded(run: () => Promise<unknown>): Promise<ProtocolError> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'expected a ProtocolError denial').toBeInstanceOf(ProtocolError);
  return thrown as ProtocolError;
}

afterEach(() => {
  while (opened.length) opened.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('RESTORE.SCOPE — an exported scope has a tested return path', () => {
  it('restores into a fresh brain with the same canonical records, provenance and recall answers', async () => {
    const source = await newBrain(async (core, store, index) => {
      await observeAndClaim(core, store, index, { scope: SCOPE, subject: 'Acme', predicate: 'prefers_billing', value: 'quarterly', body: 'Acme moved to quarterly billing.' });
      await observeAndClaim(core, store, index, { scope: SCOPE, subject: 'Acme', predicate: 'wants_run_on_day', value: '15', body: 'Acme wants the payroll run moved to the 15th.' });
      await observeAndClaim(core, store, index, { scope: OTHER_SCOPE, subject: 'Bcau', predicate: 'prefers_billing', value: 'monthly', body: 'Bcau moved to monthly billing.' });
    });
    const exported = await source.core.exportScope({ actor: OWNER, scope: SCOPE, operation_id: `op_${ulid()}` });
    expect(exported.counts.claims).toBeGreaterThan(0);

    const target = await newBrain();
    const restored = await target.core.restoreScope({ actor: OWNER, package_dir: exported.path, operation_id: `op_${ulid()}` });

    expect(restored.status).toBe('restored');
    expect(restored.export_id).toBe(exported.export_id);
    expect(restored.scope).toBe(SCOPE);
    expect(restored.counts.observations).toBe(exported.counts.observations);
    expect(restored.counts.claims).toBe(exported.counts.claims);

    // The same question gets the same answer, with the same provenance, in both brains.
    const ask = (core: SmartwareCore) => core.recall({ actor: OWNER, query: 'billing', scope: SCOPE, limit: 10 });
    const inSource = await ask(source.core);
    const inTarget = await ask(target.core);
    const shape = (result: Awaited<ReturnType<typeof ask>>) =>
      result.results.map((row) => ({
        claim_id: row.claim?.id ?? null,
        predicate: row.claim?.predicate ?? null,
        object: row.claim?.object ?? null,
        observation_ids: row.claim?.observation_ids ?? [],
      }));
    expect(shape(inTarget)).toEqual(shape(inSource));
    expect(shape(inTarget).length).toBeGreaterThan(0);
    expect(shape(inTarget).every((row) => row.observation_ids.length > 0)).toBe(true);

    // The other client's content did NOT travel (one scope = one boundary).
    const otherScope = await target.core.recall({ actor: OWNER, query: 'billing', scope: OTHER_SCOPE, limit: 10 });
    expect(otherScope.results).toHaveLength(0);
  });

  it('is idempotent: restoring the same package twice writes nothing the second time', async () => {
    const source = await newBrain(async (core, store, index) => {
      await observeAndClaim(core, store, index, { scope: SCOPE, subject: 'Acme', predicate: 'prefers_billing', value: 'quarterly', body: 'Acme moved to quarterly billing.' });
    });
    const exported = await source.core.exportScope({ actor: OWNER, scope: SCOPE, operation_id: `op_${ulid()}` });

    const target = await newBrain();
    const first = await target.core.restoreScope({ actor: OWNER, package_dir: exported.path, operation_id: `op_${ulid()}` });
    expect(first.status).toBe('restored');

    const before = await target.core.status(OWNER.id);
    const second = await target.core.restoreScope({ actor: OWNER, package_dir: exported.path, operation_id: `op_${ulid()}` });
    const after = await target.core.status(OWNER.id);
    expect(second.status).toBe('already_restored');
    expect(after.layer0.total).toBe(before.layer0.total);
  });

  it('refuses a tampered package: content that does not match the manifest is not imported', async () => {
    const source = await newBrain(async (core, store, index) => {
      await observeAndClaim(core, store, index, { scope: SCOPE, subject: 'Acme', predicate: 'prefers_billing', value: 'quarterly', body: 'Acme moved to quarterly billing.' });
    });
    const exported = await source.core.exportScope({ actor: OWNER, scope: SCOPE, operation_id: `op_${ulid()}` });

    const claimsFile = path.join(exported.path, 'claims.jsonl');
    const tampered = fs.readFileSync(claimsFile, 'utf8').replace('quarterly', 'annually');
    fs.writeFileSync(claimsFile, tampered);

    const target = await newBrain();
    const error = await guarded(() => target.core.restoreScope({ actor: OWNER, package_dir: exported.path, operation_id: `op_${ulid()}` }));
    expect(error.code).toBe('package_corrupt');
    expect((await target.core.status(OWNER.id)).layer0.total).toBe(0);
  });

  it('refuses to merge into a scope that already holds content', async () => {
    const source = await newBrain(async (core, store, index) => {
      await observeAndClaim(core, store, index, { scope: SCOPE, subject: 'Acme', predicate: 'prefers_billing', value: 'quarterly', body: 'Acme moved to quarterly billing.' });
    });
    const exported = await source.core.exportScope({ actor: OWNER, scope: SCOPE, operation_id: `op_${ulid()}` });

    const target = await newBrain(async (core, store, index) => {
      await observeAndClaim(core, store, index, { scope: SCOPE, subject: 'Acme', predicate: 'prefers_billing', value: 'monthly', body: 'Acme moved to monthly billing.' });
    });
    const error = await guarded(() => target.core.restoreScope({ actor: OWNER, package_dir: exported.path, operation_id: `op_${ulid()}` }));
    expect(error.code).toBe('scope_not_empty');
  });

  it('is owner-only', async () => {
    const source = await newBrain(async (core, store, index) => {
      await observeAndClaim(core, store, index, { scope: SCOPE, subject: 'Acme', predicate: 'prefers_billing', value: 'quarterly', body: 'Acme moved to quarterly billing.' });
    });
    const exported = await source.core.exportScope({ actor: OWNER, scope: SCOPE, operation_id: `op_${ulid()}` });

    const target = await newBrain();
    const error = await guarded(() => target.core.restoreScope({ actor: STAFF, package_dir: exported.path, operation_id: `op_${ulid()}` }));
    expect(error.code).toBe('owner_required');
  });
});
