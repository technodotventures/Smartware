// Conformance — P0 sources, federated reads and the ingestion contract.
//
// Executable gate for the Coffee company-brain contract v1 (P1-2 shown here as
// the shared-workspace source operation):
//   * source registry inside one business brain (owner-provisioned provenance
//     origins: connector, meeting, note, agent, manual, system);
//   * fail-closed source context — an unregistered, inactive, or
//     actor-forbidden source is a denial, never a silently-unattributed write;
//   * idempotent ingestion — cursor checkpoints, per-item dedup, replayed
//     batches return their recorded receipt and write nothing again;
//   * sync status a host can render (cursor, last sync, counts per scope);
//   * federated reads constrained by actor grants (deny, never partially
//     answer an unauthorized scope);
//   * humans and agents writing one workspace without attribution loss.
//
// Black-box by construction: the fixture drives the embedded core's public
// surface exactly as a host does. Slices are added one behavior at a time
// (TDD): each `it` failed before the code that makes it pass existed.

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
import type { SmartwareConfig, Grant } from '../../src/config.js';
import { saveConfig } from '../../src/config.js';
import { ProtocolError } from '../../src/auth/middleware.js';
import type { Claim } from '../../src/layer1/types.js';
import { readAll } from '../../src/layer0/log.js';

const CLIENT_ACME = 'client:acme#1';
const CLIENT_BCAU = 'client:bcau#1';

const op = () => `op_${ulid()}`;

interface Tenant {
  id: string;
  dataDir: string;
  core: SmartwareCore;
  store: ClaimStore;
  index: SearchIndex;
  owner: Actor;
  /** Human staff, granted client:acme#1 only. */
  staff: Actor;
  /** Agent, granted client:bcau#1 only. */
  agent: Actor;
}

const opened: Tenant[] = [];
const directories: string[] = [];

function actor(prefix: 'user' | 'agent', name: string): Actor {
  return { type: prefix === 'agent' ? 'agent' : 'person', id: `${prefix}:${name}`, display_name: name };
}

function grantFor(id: string, actorId: string, actorType: 'person' | 'agent', scopes: string[]): Grant {
  return {
    id: `grant_${id}`,
    actor_type: actorType,
    actor_id: actorId,
    capabilities: {
      observe: scopes, query: scopes, compile: [], correct: scopes, forget: [], read: scopes,
    },
    trusted: false,
    quarantine: false,
    created_at: '2026-08-01T00:00:00.000Z',
    expires_at: null,
    status: 'active',
  };
}

function tenantConfig(dataDir: string, ownerId: string, grants: Grant[]): SmartwareConfig {
  return {
    instance_id: `smartware_${ulid()}`,
    owner_id: ownerId,
    writer_id: `writer_local_${ulid()}`,
    version: '0.7.0',
    data_dir: dataDir,
    scopes: [
      { id: 'self', parent: null, visibility_default: 'private' },
      { id: 'workspace', parent: null, visibility_default: 'workspace' },
      { id: CLIENT_ACME, parent: 'workspace', visibility_default: 'scope' },
      { id: CLIENT_BCAU, parent: 'workspace', visibility_default: 'scope' },
    ],
    grants,
    llm: { provider: 'none', model: '' },
    staleness: { default_half_life_days: 90, scope_overrides: {}, stale_threshold: 0.3 },
  };
}

/** One business with the Coffee actor shape: owner, human staff (Acme), agent (Bcau). */
async function newTenant(id: string): Promise<Tenant> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sw-src-${id}-`));
  directories.push(dataDir);
  const owner = actor('user', `owner${id}`);
  const staff = actor('user', `staff${id}`);
  const agent = actor('agent', `agent${id}`);
  const config = tenantConfig(dataDir, owner.id, [
    grantFor(`${id}_staff`, staff.id, 'person', [CLIENT_ACME]),
    grantFor(`${id}_agent`, agent.id, 'agent', [CLIENT_BCAU]),
  ]);
  saveConfig(dataDir, config);
  const core = await SmartwareCore.open({ dataDir, ownerId: owner.id });
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const index = new SearchIndex(dbPath);
  const tenant = { id, dataDir, core, store, index, owner, staff, agent };
  opened.push(tenant);
  return tenant;
}

/** Seed a claim + raw observation for one client scope, host-side (route b). */
async function seedFact(t: Tenant, scope: string, subject: string, predicate: string, value: string): Promise<void> {
  const observed = await t.core.observe({
    actor: t.owner,
    type: 'message',
    content: { format: 'text/plain', body: `${subject} ${predicate} ${value}` },
    scope,
    observed_at: '2026-08-01T00:00:00.000Z',
    operation_id: op(),
  });
  const subjectId = `entity_${ulid()}`;
  t.store.insertEntity({
    id: subjectId, canonical_name: subject, aliases: [], type: 'organization',
    scope, created_at: new Date().toISOString(),
  });
  const claim: Claim = {
    id: `claim_${ulid()}`,
    subject_id: subjectId,
    subject_name: subject,
    predicate,
    object: { type: 'text', value },
    scope,
    validity: { from: '2026-08-01T00:00:00.000Z', to: null },
    t_ingested: knownTime('2026-08-01T00:00:00.000Z'),
    t_invalidated: nullTime(),
    t_valid_from: knownTime('2026-08-01T00:00:00.000Z'),
    t_valid_to: nullTime(),
    source_event_id: observed.id,
    extraction_event_id: observed.id,
    supporting_evidence: [observed.id],
    extraction: {
      method: 'deterministic', model: null, compiler_version: '0.7.0',
      prompt_hash: null, extracted_at: '2026-08-01T00:00:00.000Z',
    },
    status: 'active',
    epistemic: 'observed',
    confidence: 0.85,
    sensitive: false,
    superseded_by: null,
    contested_by: [],
  };
  t.store.insertClaim(claim);
  syncSearchFromClaims(t.store, t.index, scope);
}

/** A denial must be an explicit, code-carrying ProtocolError — not a silent empty. */
async function expectDenied(run: () => unknown | Promise<unknown>, code?: string): Promise<ProtocolError> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'expected an explicit denial, got a result').toBeInstanceOf(ProtocolError);
  const denial = thrown as ProtocolError;
  if (code) expect(denial.code).toBe(code);
  return denial;
}

afterEach(() => {
  for (const tenant of opened.splice(0)) {
    tenant.store.close();
    tenant.index.close();
    tenant.core.close();
  }
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('P0 sources · registry', () => {
  it('owner registers a source and lists it back', async () => {
    const t = await newTenant('r1');

    const registered = t.core.registerSource({
      actor: t.owner,
      id: 'src_gmail_ava',
      kind: 'connector',
      display_name: 'Gmail — ava@harbor-lane',
      external_ref: 'acct_ava_primary',
    });
    expect(registered).toMatchObject({
      id: 'src_gmail_ava',
      kind: 'connector',
      display_name: 'Gmail — ava@harbor-lane',
      status: 'active',
      external_ref: 'acct_ava_primary',
    });
    expect(typeof registered.created_at).toBe('string');

    const listed = t.core.listSources({ actor: t.owner });
    expect(listed.map(entry => entry.id)).toEqual(['src_gmail_ava']);
  });

  it('registration is an upsert: re-registering the id updates state, never duplicates', async () => {
    const t = await newTenant('r2');
    t.core.registerSource({ actor: t.owner, id: 'src_notes', kind: 'note', display_name: 'Notes' });
    t.core.registerSource({ actor: t.owner, id: 'src_notes', kind: 'note', display_name: 'Notes (renamed)' });

    const listed = t.core.listSources({ actor: t.owner });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.display_name).toBe('Notes (renamed)');
  });

  it('the registry is owner-only — a granted staff actor can neither read nor write it', async () => {
    const t = await newTenant('r3');

    await expectDenied(() => t.core.registerSource({
      actor: t.staff, id: 'src_x', kind: 'note', display_name: 'X',
    }), 'owner_required');
    await expectDenied(() => t.core.listSources({ actor: t.staff }), 'owner_required');
  });

  it('a source is scoped to its own brain — a second business never sees it', async () => {
    const t1 = await newTenant('r4');
    const t2 = await newTenant('r5');
    t1.core.registerSource({ actor: t1.owner, id: 'src_only_b1', kind: 'note', display_name: 'Only B1' });

    expect(t2.core.listSources({ actor: t2.owner })).toEqual([]);
  });
});

describe('P0 sources · fail-closed source context on observes', () => {
  it('observing under an unregistered source is denied and writes nothing', async () => {
    const t = await newTenant('f1');

    await expectDenied(() => t.core.observe({
      actor: t.owner,
      type: 'message',
      content: { format: 'text/plain', body: 'note from nowhere' },
      scope: CLIENT_ACME,
      source_ref: 'src_does_not_exist',
    }), 'source_unregistered');

    const raw = t.core.searchObservations({ actor: t.owner, query: 'nowhere', scope: CLIENT_ACME });
    expect(raw).toEqual([]);
  });

  it('a paused or revoked source cannot write, but its recorded evidence is untouched', async () => {
    const t = await newTenant('f2');
    t.core.registerSource({ actor: t.owner, id: 'src_bot', kind: 'agent', display_name: 'Bot' });
    await t.core.observe({
      actor: t.owner,
      type: 'message',
      content: { format: 'text/plain', body: 'written while active' },
      scope: CLIENT_ACME,
      source_ref: 'src_bot',
    });

    t.core.registerSource({ actor: t.owner, id: 'src_bot', kind: 'agent', display_name: 'Bot', status: 'paused' });
    await expectDenied(() => t.core.observe({
      actor: t.owner,
      type: 'message',
      content: { format: 'text/plain', body: 'written while paused' },
      scope: CLIENT_ACME,
      source_ref: 'src_bot',
    }), 'source_inactive');

    // The earlier evidence still resolves, and carries its source attribution.
    const raw = t.core.searchObservations({ actor: t.owner, query: 'active', scope: CLIENT_ACME });
    expect(raw).toHaveLength(1);
    expect(raw[0]?.source_ref).toBe('src_bot');
  });

  it('an actor outside the source allow-list cannot claim that provenance', async () => {
    const t = await newTenant('f3');
    t.core.registerSource({
      actor: t.owner, id: 'src_connected', kind: 'connector', display_name: 'Connected',
      actor_ids: ['substrate:connector-runner'],
    });

    await expectDenied(() => t.core.observe({
      actor: t.staff,
      type: 'message',
      content: { format: 'text/plain', body: 'forged provenance attempt' },
      scope: CLIENT_ACME,
      source_ref: 'src_connected',
    }), 'insufficient_permission');
  });
});

// ── Ingestion contract: batches, cursors, replay and dedup.

function ingestItem(externalId: string, body: string) {
  return {
    external_id: externalId,
    type: 'message' as const,
    content: { format: 'text/plain' as const, body },
  };
}

/** A registered connector + the actor Coffee's scheduler runs as (the owner here). */
async function withConnector(id: string, actorId?: string) {
  const t = await newTenant(id);
  t.core.registerSource({
    actor: t.owner, id: 'src_gmail', kind: 'connector', display_name: 'Gmail — ava@harbor',
    ...(actorId ? { actor_ids: [actorId] } : {}),
  });
  return t;
}

const evidenceCount = (t: Tenant) => [...readAll(path.join(t.dataDir, 'evidence'))].length;

describe('P0 ingestion · batches, cursors and replay', () => {
  it('ingests a batch under a registered connector and returns a receipt with the new cursor', async () => {
    const t = await withConnector('i1');

    const receipt = await t.core.ingest({
      actor: t.owner,
      source_id: 'src_gmail',
      scope: CLIENT_ACME,
      cursor: 'history/100',
      operation_id: op(),
      items: [
        ingestItem('msg_1', 'Acme asked about quarterly invoicing.'),
        ingestItem('msg_2', 'Bcau preferred monthly billing.'),
        ingestItem('msg_3', 'Acme renewed the support contract.'),
      ],
    });

    expect(receipt).toMatchObject({
      status: 'ok',
      source_id: 'src_gmail',
      scope: CLIENT_ACME,
      cursor: 'history/100',
      cursor_before: null,
      accepted: 3,
      duplicated: 0,
      quarantined: 0,
      rejected: 0,
    });
    expect(receipt.items.map(item => item.status)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(receipt.items.every(item => (item.observation_id ?? '').startsWith('obs_'))).toBe(true);

    // The evidence lands with its provenance origin attached, searchable immediately.
    const raw = t.core.searchObservations({ actor: t.owner, query: 'invoicing', scope: CLIENT_ACME });
    expect(raw).toHaveLength(1);
    expect(raw[0]?.source_ref).toBe('src_gmail');
    expect(raw[0]?.id).toBe(receipt.items[0]?.observation_id);
  });

  it('replaying the same operation_id returns the recorded receipt and writes nothing again', async () => {
    const t = await withConnector('i2');
    const batch = {
      actor: t.owner,
      source_id: 'src_gmail',
      scope: CLIENT_ACME,
      cursor: 'history/200',
      operation_id: op(),
      items: [ingestItem('msg_1', 'First message.'), ingestItem('msg_2', 'Second message.')],
    };

    const first = await t.core.ingest(batch);
    const before = evidenceCount(t);

    const replay = await t.core.ingest(batch);
    expect(replay.status).toBe('replayed');
    expect(replay.accepted).toBe(first.accepted);
    expect(replay.cursor).toBe('history/200');
    expect(replay.items.map(item => item.observation_id)).toEqual(first.items.map(item => item.observation_id));
    expect(evidenceCount(t)).toBe(before);
  });

  it('re-sending the same items under a new operation_id dedups them instead of minting twin evidence', async () => {
    const t = await withConnector('i3');
    const items = [ingestItem('msg_1', 'Same message.'), ingestItem('msg_2', 'Another message.')];
    const first = await t.core.ingest({
      actor: t.owner, source_id: 'src_gmail', scope: CLIENT_ACME, cursor: 'history/10', operation_id: op(), items,
    });
    const before = evidenceCount(t);

    const resend = await t.core.ingest({
      actor: t.owner, source_id: 'src_gmail', scope: CLIENT_ACME, cursor: 'history/11', operation_id: op(), items,
    });

    expect(resend.status).toBe('ok');
    expect(resend.accepted).toBe(0);
    expect(resend.duplicated).toBe(2);
    expect(resend.items.map(item => item.status)).toEqual(['duplicate', 'duplicate']);
    expect(resend.items.map(item => item.observation_id)).toEqual(first.items.map(item => item.observation_id));
    expect(evidenceCount(t)).toBe(before);
  });

  it('a batch interrupted mid-write converges on retry: written items dedup, the rest complete', async () => {
    const t = await withConnector('i4');
    const batch = {
      actor: t.owner,
      source_id: 'src_gmail',
      scope: CLIENT_ACME,
      cursor: 'history/300',
      operation_id: op(),
      items: [
        ingestItem('msg_1', 'Message one.'),
        ingestItem('msg_2', 'Message two.'),
        ingestItem('msg_3', 'Message three.'),
      ],
    };

    // Fault injection: die after the second item, before the batch receipt.
    await expect(t.core.ingest(batch, {
      afterItem: (_item, index) => {
        if (index === 1) throw new Error('simulated crash');
      },
    })).rejects.toThrow('simulated crash');
    expect(evidenceCount(t)).toBe(2);

    // Retry with the same operation_id: the two written items dedup, the third lands once.
    const retried = await t.core.ingest(batch);
    expect(retried.status).toBe('ok');
    expect(retried.duplicated).toBe(2);
    expect(retried.accepted).toBe(1);
    expect(evidenceCount(t)).toBe(3);

    // The receipt is now durable: a further replay returns it verbatim.
    const replay = await t.core.ingest(batch);
    expect(replay.status).toBe('replayed');
    expect(evidenceCount(t)).toBe(3);
  });

  it('cursor checkpoints advance per source and scope, never globally', async () => {
    const t = await withConnector('i5');
    t.core.registerSource({ actor: t.owner, id: 'src_notes', kind: 'note', display_name: 'Notes' });
    const base = { actor: t.owner, cursor: 'c1', operation_id: '' };

    await t.core.ingest({
      ...base, operation_id: op(), source_id: 'src_gmail', scope: CLIENT_ACME,
      items: [ingestItem('m1', 'gmail acme')],
    });
    await t.core.ingest({
      ...base, operation_id: op(), source_id: 'src_gmail', scope: CLIENT_BCAU,
      items: [ingestItem('m1', 'gmail bcau')],
    });
    const third = await t.core.ingest({
      ...base, cursor: 'c2', operation_id: op(), source_id: 'src_notes', scope: CLIENT_ACME,
      items: [ingestItem('n1', 'note acme')],
    });
    const fourth = await t.core.ingest({
      ...base, cursor: 'c3', operation_id: op(), source_id: 'src_gmail', scope: CLIENT_ACME,
      items: [ingestItem('m2', 'gmail acme again')],
    });

    // Each (source, scope) stream checkpoints independently.
    expect(third.cursor_before).toBeNull();
    expect(fourth.cursor_before).toBe('c1');
    expect(fourth.cursor).toBe('c3');
  });

  it('invalid context fails closed and writes nothing at all', async () => {
    const t = await withConnector('i6');
    const before = evidenceCount(t);
    const batch = (overrides: Record<string, unknown>) => ({
      actor: t.owner,
      source_id: 'src_gmail',
      scope: CLIENT_ACME,
      cursor: 'c1',
      operation_id: op(),
      items: [ingestItem('m1', 'message')],
      ...overrides,
    });

    await expectDenied(() => t.core.ingest(batch({ source_id: 'src_ghost' })), 'source_unregistered');
    await expectDenied(() => t.core.ingest(batch({ source_id: '' })), 'source_required');
    // Staff hold Acme only: an ingestion into Bcau is denied even though the
    // source is registered — the actor's grants still bound the write.
    await expectDenied(() => t.core.ingest(batch({ actor: t.staff, scope: CLIENT_BCAU })), 'insufficient_permission');
    await expectDenied(() => t.core.ingest(batch({ operation_id: 'not-a-ulid' })), 'invalid_parameter');
    await expectDenied(() => t.core.ingest(batch({ cursor: '' })), 'invalid_parameter');

    expect(evidenceCount(t)).toBe(before);
  });

  it('item-level failures are recorded with a code; the batch still advances', async () => {
    const t = await withConnector('i7');

    const receipt = await t.core.ingest({
      actor: t.owner,
      source_id: 'src_gmail',
      scope: CLIENT_ACME,
      cursor: 'c1',
      operation_id: op(),
      items: [
        ingestItem('m1', 'A clean message.'),
        ingestItem('m2', 'Deploy key: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        ingestItem('m3', 'Another clean message.'),
      ],
    });

    expect(receipt.accepted).toBe(2);
    expect(receipt.rejected).toBe(1);
    const rejected = receipt.items.find(item => item.status === 'rejected');
    expect(rejected?.external_id).toBe('m2');
    expect(rejected?.code).toBe('secret_detected');
    expect(receipt.cursor).toBe('c1');

    // The rejected item left no evidence behind; the others are searchable.
    expect(t.core.searchObservations({ actor: t.owner, query: 'message', scope: CLIENT_ACME })).toHaveLength(2);
    expect(t.core.searchObservations({ actor: t.owner, query: 'Deploy', scope: CLIENT_ACME })).toHaveLength(0);
  });

  it('dedup is scope-aware: one source item in two scopes is two observations, never a cross-scope shadow', async () => {
    const t = await withConnector('i8');

    // A message that matters to two clients must land in both client memories.
    const acme = await t.core.ingest({
      actor: t.owner, source_id: 'src_gmail', scope: CLIENT_ACME, cursor: 'c1', operation_id: op(),
      items: [ingestItem('shared_1', 'The kickoff call mentioned both Acme and Bcau.')],
    });
    const bcau = await t.core.ingest({
      actor: t.owner, source_id: 'src_gmail', scope: CLIENT_BCAU, cursor: 'c1', operation_id: op(),
      items: [ingestItem('shared_1', 'The kickoff call mentioned both Acme and Bcau.')],
    });

    expect(acme.accepted).toBe(1);
    expect(bcau.accepted).toBe(1);
    expect(bcau.items[0]?.observation_id).not.toBe(acme.items[0]?.observation_id);

    // Each scope's raw window holds its own copy; nothing was silently dropped.
    expect(t.core.searchObservations({ actor: t.owner, query: 'kickoff', scope: CLIENT_ACME })).toHaveLength(1);
    expect(t.core.searchObservations({ actor: t.owner, query: 'kickoff', scope: CLIENT_BCAU })).toHaveLength(1);

    // The same rule holds on the plain OBSERVE path: scope is part of the item identity.
    const plainA = await t.core.observe({
      actor: t.owner, type: 'message', content: { format: 'text/plain', body: 'plain item' },
      scope: CLIENT_ACME, source_id: 'plain_1', app: 'coffee',
    });
    const plainB = await t.core.observe({
      actor: t.owner, type: 'message', content: { format: 'text/plain', body: 'plain item' },
      scope: CLIENT_BCAU, source_id: 'plain_1', app: 'coffee',
    });
    expect(plainA.status).toBe('accepted');
    expect(plainB.status).toBe('accepted');
    expect(plainB.id).not.toBe(plainA.id);
  });
});

describe('P0 ingestion · sync status', () => {
  it('reports per-source, per-scope cursors and counts a host can render', async () => {
    const t = await withConnector('s1');
    t.core.registerSource({ actor: t.owner, id: 'src_notes', kind: 'note', display_name: 'Notes' });

    await t.core.ingest({
      actor: t.owner, source_id: 'src_gmail', scope: CLIENT_ACME, cursor: 'c1', operation_id: op(),
      items: [ingestItem('m1', 'First.'), ingestItem('m2', 'Key ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')],
    });
    await t.core.ingest({
      actor: t.owner, source_id: 'src_gmail', scope: CLIENT_ACME, cursor: 'c2', operation_id: op(),
      items: [ingestItem('m3', 'Third.')],
    });
    await t.core.ingest({
      actor: t.owner, source_id: 'src_gmail', scope: CLIENT_BCAU, cursor: 'c1', operation_id: op(),
      items: [ingestItem('m1', 'Bcau mail.')],
    });

    const status = t.core.sourceSyncStatus({ actor: t.owner });
    expect(status.map(entry => entry.source_id).sort()).toEqual(['src_gmail', 'src_notes']);

    const gmail = status.find(entry => entry.source_id === 'src_gmail')!;
    expect(gmail).toMatchObject({ kind: 'connector', display_name: 'Gmail — ava@harbor', status: 'active' });
    expect(gmail.totals).toEqual({ batches: 3, accepted: 3, duplicated: 0, quarantined: 0, rejected: 1 });
    expect(gmail.last_sync).toMatchObject({ scope: CLIENT_BCAU, cursor: 'c1' });

    const acme = gmail.scopes.find(row => row.scope === CLIENT_ACME)!;
    expect(acme).toMatchObject({ cursor: 'c2', cursor_before: 'c1', batches: 2, accepted: 2, rejected: 1 });
    const bcau = gmail.scopes.find(row => row.scope === CLIENT_BCAU)!;
    expect(bcau).toMatchObject({ cursor: 'c1', cursor_before: null, batches: 1, accepted: 1 });

    // A registered source with no batches yet is still a row — "connected, never synced".
    const notes = status.find(entry => entry.source_id === 'src_notes')!;
    expect(notes.scopes).toEqual([]);
    expect(notes.last_sync).toBeNull();
    expect(notes.totals).toEqual({ batches: 0, accepted: 0, duplicated: 0, quarantined: 0, rejected: 0 });
  });

  it('is owner-only, and a named unknown source denies rather than answering empty', async () => {
    const t = await withConnector('s2');

    await expectDenied(() => t.core.sourceSyncStatus({ actor: t.staff }), 'owner_required');
    await expectDenied(() => t.core.sourceSyncStatus({ actor: t.owner, source_id: 'src_ghost' }), 'source_unregistered');
  });
});

// ── Federated reads: one query across scopes, always bounded by grants.

describe('P0 federated reads · constrained by actor grants', () => {
  it('the owner reads across the named client scopes in one call, scope-tagged', async () => {
    const t = await newTenant('fed1');
    await seedFact(t, CLIENT_ACME, 'Acme', 'billing_cycle', 'quarterly');
    await seedFact(t, CLIENT_BCAU, 'Bcau', 'billing_cycle', 'monthly');

    const federated = await t.core.recallFederated({
      actor: t.owner, query: 'billing', scopes: [CLIENT_ACME, CLIENT_BCAU],
    });

    expect(federated.scopes).toEqual([CLIENT_ACME, CLIENT_BCAU]);
    const scopes = new Set(federated.results.map(result => result.scope));
    expect(scopes).toEqual(new Set([CLIENT_ACME, CLIENT_BCAU]));
    expect(federated.results.map(result => result.claim?.object)).toEqual(
      expect.arrayContaining([{ type: 'text', value: 'quarterly' }, { type: 'text', value: 'monthly' }]),
    );
    expect(federated.per_scope).toEqual([
      { scope: CLIENT_ACME, total_found: 1, returned: 1 },
      { scope: CLIENT_BCAU, total_found: 1, returned: 1 },
    ]);
  });

  it('a named scope the actor cannot read denies the whole read — never a partial answer', async () => {
    const t = await newTenant('fed2');
    await seedFact(t, CLIENT_ACME, 'Acme', 'billing_cycle', 'quarterly');
    await seedFact(t, CLIENT_BCAU, 'Bcau', 'billing_cycle', 'monthly');

    // Staff hold Acme only: the whole request fails, Bcau included or not.
    await expectDenied(() => t.core.recallFederated({
      actor: t.staff, query: 'billing', scopes: [CLIENT_ACME, CLIENT_BCAU],
    }), 'insufficient_permission');
    // The unregistered stranger is named as such, not "forbidden".
    await expectDenied(() => t.core.recallFederated({
      actor: actor('user', 'stranger'), query: 'billing', scopes: [CLIENT_ACME],
    }), 'actor_unregistered');

    // The scope they do hold answers normally.
    const allowed = await t.core.recallFederated({ actor: t.staff, query: 'billing', scopes: [CLIENT_ACME] });
    expect(allowed.results.length).toBeGreaterThan(0);
    expect(new Set(allowed.results.map(result => result.scope))).toEqual(new Set([CLIENT_ACME]));
  });

  it('omitting scopes federates over exactly the actor\'s readable scopes', async () => {
    const t = await newTenant('fed3');
    await seedFact(t, CLIENT_ACME, 'Acme', 'billing_cycle', 'quarterly');
    await seedFact(t, CLIENT_BCAU, 'Bcau', 'billing_cycle', 'monthly');

    const staff = await t.core.recallFederated({ actor: t.staff, query: 'billing' });
    expect(new Set(staff.results.map(result => result.scope))).toEqual(new Set([CLIENT_ACME]));

    const agent = await t.core.recallFederated({ actor: t.agent, query: 'billing' });
    expect(new Set(agent.results.map(result => result.scope))).toEqual(new Set([CLIENT_BCAU]));

    const owner = await t.core.recallFederated({ actor: t.owner, query: 'billing' });
    expect(new Set(owner.results.map(result => result.scope))).toEqual(new Set([CLIENT_ACME, CLIENT_BCAU]));
  });

  it('federated results never carry evidence from another business', async () => {
    const t1 = await newTenant('fed4');
    const t2 = await newTenant('fed5');
    await seedFact(t1, CLIENT_ACME, 'Acme', 'billing_cycle', 'b1-acme-value');
    await seedFact(t2, CLIENT_ACME, 'Acme', 'billing_cycle', 'b2-acme-value');

    const federated = await t1.core.recallFederated({ actor: t1.owner, query: 'billing' });
    const text = JSON.stringify(federated);
    expect(text).toContain('b1-acme-value');
    expect(text).not.toContain('b2-acme-value');
  });
});

// ── Attribution: humans and agents writing one workspace, with no loss.

/** Append observe/read grants for an actor on a scope (provisioning, like Coffee). */
function grantScopes(
  t: Tenant,
  actorId: string,
  actorType: 'person' | 'agent',
  scopes: string[],
  options: { trusted?: boolean; quarantine?: boolean } = {},
): void {
  const config = t.core.getConfig();
  config.grants.push({
    id: `grant_${ulid()}`,
    actor_type: actorType,
    actor_id: actorId,
    capabilities: { observe: scopes, query: scopes, compile: [], correct: [], forget: [], read: scopes },
    trusted: options.trusted ?? true,
    quarantine: options.quarantine ?? false,
    created_at: new Date().toISOString(),
    expires_at: null,
    status: 'active',
  });
  saveConfig(t.dataDir, config);
}

describe('P0 attribution · humans and agents share one workspace', () => {
  it('each writer keeps its own actor and source through every read lane', async () => {
    const t = await newTenant('a1');
    grantScopes(t, t.staff.id, 'person', ['workspace']);
    grantScopes(t, t.agent.id, 'agent', ['workspace']);
    t.core.registerSource({ actor: t.owner, id: 'src_staff_notes', kind: 'note', display_name: 'Staff notes' });
    t.core.registerSource({ actor: t.owner, id: 'src_agent_runs', kind: 'agent', display_name: 'Coffee agent runs' });

    const human = await t.core.observe({
      actor: t.staff, type: 'note',
      content: { format: 'text/plain', body: 'Kickoff call with Acme moved to Tuesday.' },
      scope: 'workspace', source_ref: 'src_staff_notes',
    });
    const machine = await t.core.observe({
      actor: t.agent, type: 'agent_run_completed',
      content: { format: 'text/plain', body: 'Kickoff call follow-up drafted for Acme.' },
      scope: 'workspace', source_ref: 'src_agent_runs',
    });
    expect(human.status).toBe('accepted');
    expect(machine.status).toBe('accepted');

    // Raw window: both writers present, each carrying its own provenance.
    const raw = t.core.searchObservations({ actor: t.owner, query: 'Kickoff', scope: 'workspace' });
    const byId = new Map(raw.map(row => [row.id, row]));
    expect(byId.get(human.id)).toMatchObject({ actor_id: t.staff.id, source_ref: 'src_staff_notes' });
    expect(byId.get(machine.id)).toMatchObject({ actor_id: t.agent.id, source_ref: 'src_agent_runs' });

    // Activity feed: actor type is preserved, human vs agent.
    const activity = t.core.listActivity({ actor: t.owner, scope: 'workspace' });
    const activityHuman = activity.find(event => event.id === human.id);
    const activityAgent = activity.find(event => event.id === machine.id);
    expect(activityHuman).toMatchObject({ actor_type: 'person', source_ref: 'src_staff_notes' });
    expect(activityAgent).toMatchObject({ actor_type: 'agent', source_ref: 'src_agent_runs' });

    // Evidence reader: the full attribution chain survives.
    const evidence = t.core.readObservationEvidence({ actor: t.owner, observation_id: human.id });
    expect(evidence).toMatchObject({
      actor_id: t.staff.id,
      actor_type: 'person',
      actor_display_name: t.staff.display_name,
      source_ref: 'src_staff_notes',
    });
  });

  it('an untrusted writer\'s ingested items are quarantined, counted, and not silently treated as accepted', async () => {
    const t = await withConnector('a2');
    // The host vets the connector's writes: everything it sends is held for review.
    grantScopes(t, t.staff.id, 'person', [CLIENT_ACME], { trusted: false, quarantine: true });

    const receipt = await t.core.ingest({
      actor: t.staff, source_id: 'src_gmail', scope: CLIENT_ACME, cursor: 'c1', operation_id: op(),
      items: [ingestItem('q1', 'A message waiting on review.')],
    });

    expect(receipt.accepted).toBe(0);
    expect(receipt.quarantined).toBe(1);
    expect(receipt.items[0]?.status).toBe('quarantined');

    // The raw window (accepted evidence) does not show it; sync status reports it.
    expect(t.core.searchObservations({ actor: t.owner, query: 'review', scope: CLIENT_ACME })).toHaveLength(0);
    const status = t.core.sourceSyncStatus({ actor: t.owner, source_id: 'src_gmail' })[0]!;
    expect(status.totals.quarantined).toBe(1);
  });

  it('dedup never rewrites the original writer: a re-sync by another actor does not steal attribution', async () => {
    const t = await withConnector('a3');
    grantScopes(t, t.staff.id, 'person', [CLIENT_ACME]);
    grantScopes(t, t.agent.id, 'agent', [CLIENT_ACME]);

    const first = await t.core.ingest({
      actor: t.staff, source_id: 'src_gmail', scope: CLIENT_ACME, cursor: 'c1', operation_id: op(),
      items: [ingestItem('m1', 'The invoice was sent.')],
    });
    expect(first.accepted).toBe(1);

    const second = await t.core.ingest({
      actor: t.agent, source_id: 'src_gmail', scope: CLIENT_ACME, cursor: 'c2', operation_id: op(),
      items: [ingestItem('m1', 'The invoice was sent.')],
    });
    expect(second.duplicated).toBe(1);
    expect(second.items[0]?.observation_id).toBe(first.items[0]?.observation_id);

    const evidence = t.core.readObservationEvidence({ actor: t.owner, observation_id: first.items[0]!.observation_id! });
    expect(evidence?.actor_id).toBe(t.staff.id);
  });
});
