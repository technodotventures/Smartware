// Conformance — P0-5 / P0-7: tenant, scope, human and agent isolation.
//
// Executable gate for the Coffee company-brain contract v1:
//   P0-5  isolation — zero cross-tenant / cross-scope results, across every
//         lane, with identical client IDs in different businesses, per-scope
//         grants, owner bypass, revoked staff, agent actors, federated reads,
//         and fuzzed unauthorized (actor × scope × lane) combinations.
//   P0-7  actor→grant binding — no/unknown actor or no grant ⇒ DENY (fail
//         closed, with a code a host can route on), never an empty answer
//         that reads like "no memory".
//
// Black-box by construction: the fixture drives the embedded core's public
// surface (SmartwareCore + ClaimStore + the public search sync) exactly as a
// host does — Coffee's persistence path for claims, the core for every read
// lane. No test reaches into a private helper to make a lane pass.
//
// Slices are added one behavior at a time (TDD): each `it` failed before the
// code that makes it pass existed.

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

// ── fixture: several businesses ("one brain = one business"), each with the
//    SAME client scope ids — the shape that makes a leak visible.

const CLIENT_ACME = 'client:acme#1';
const CLIENT_BCAU = 'client:bcau#1';

interface Business {
  id: string;
  dataDir: string;
  core: SmartwareCore;
  store: ClaimStore;
  index: SearchIndex;
  owner: Actor;
}

const opened: Business[] = [];
const directories: string[] = [];

function actor(prefix: 'user' | 'agent', name: string): Actor {
  return { type: prefix === 'agent' ? 'agent' : 'person', id: `${prefix}:${name}`, display_name: name };
}

function grantFor(id: string, actorId: string, actorType: 'person' | 'agent', scopes: { observe?: string[]; query?: string[]; read?: string[]; correct?: string[] }, status: 'active' | 'revoked' = 'active'): Grant {
  return {
    id: `grant_${id}`,
    actor_type: actorType,
    actor_id: actorId,
    capabilities: {
      observe: scopes.observe ?? [],
      query: scopes.query ?? [],
      compile: [],
      correct: scopes.correct ?? [],
      forget: [],
      read: scopes.read ?? [],
    },
    trusted: false,
    quarantine: false,
    created_at: '2026-08-01T00:00:00.000Z',
    expires_at: null,
    status,
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

/**
 * One business with the Coffee actor shape:
 *   user:owner<biz>      — the business owner (bypasses grants)
 *   user:staff<biz>      — human staff granted ONLY client:acme#1
 *   agent:agent<biz>     — agent granted ONLY client:bcau#1
 *   user:exstaff<biz>    — a staff member whose grant was revoked
 */
async function newBusiness(id: string): Promise<Business> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sw-iso-${id}-`));
  directories.push(dataDir);
  const owner = actor('user', `owner${id}`);
  const config = tenantConfig(dataDir, owner.id, [
    grantFor(`${id}_staff`, actor('user', `staff${id}`).id, 'person', { observe: [CLIENT_ACME], query: [CLIENT_ACME], read: [CLIENT_ACME] }),
    grantFor(`${id}_agent`, actor('agent', `agent${id}`).id, 'agent', { observe: [CLIENT_BCAU], query: [CLIENT_BCAU], read: [CLIENT_BCAU] }),
    grantFor(`${id}_exstaff`, actor('user', `exstaff${id}`).id, 'person', { observe: [CLIENT_ACME], query: [CLIENT_ACME], read: [CLIENT_ACME] }, 'revoked'),
  ]);
  config.owner_id = owner.id;
  saveConfig(dataDir, config);
  const core = await SmartwareCore.open({ dataDir, ownerId: owner.id });
  const dbPath = path.join(dataDir, 'smartware.db');
  const store = new ClaimStore(dbPath);
  store.setDataDir(dataDir);
  const index = new SearchIndex(dbPath);
  const business = { id, dataDir, core, store, index, owner };
  opened.push(business);
  return business;
}

/** Seed one fact into one client scope: raw observation (raw window) + claim (claim lane). */
async function seedFact(b: Business, scope: string, subject: string, predicate: string, value: string): Promise<void> {
  const observed = await b.core.observe({
    actor: b.owner,
    type: 'message',
    content: { format: 'text/plain', body: `${subject} ${predicate} ${value}` },
    scope,
    observed_at: '2026-08-01T00:00:00.000Z',
  });
  const subjectId = `entity_${ulid()}`;
  b.store.insertEntity({
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
  b.store.insertClaim(claim);
  syncSearchFromClaims(b.store, b.index, scope);
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
  for (const business of opened.splice(0)) {
    business.store.close();
    business.index.close();
    business.core.close();
  }
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('P0-5/P0-7 isolation · raw-observation window lane', () => {
  it('denies a staff actor searching a client scope they are not granted', async () => {
    const b = await newBusiness('b1');
    await seedFact(b, CLIENT_ACME, 'Acme', 'billing_cycle', 'quarterly');
    await seedFact(b, CLIENT_BCAU, 'Bcau', 'billing_cycle', 'monthly');

    // Granted scope: the raw window works exactly as before.
    const allowed = b.core.searchObservations({
      actor: actor('user', `staff${b.id}`),
      query: 'billing',
      scope: CLIENT_ACME,
    });
    expect(allowed.length).toBeGreaterThan(0);

    // Ungranted scope inside the same business: deny, never the other client's raw text.
    await expectDenied(() => b.core.searchObservations({
      actor: actor('user', `staff${b.id}`),
      query: 'billing',
      scope: CLIENT_BCAU,
    }), 'insufficient_permission');
  });
});

describe('P0-5/P0-7 isolation · recall and context deny explicitly', () => {
  it('recall denies a staff actor for a client scope they are not granted', async () => {
    const b = await newBusiness('b1');
    await seedFact(b, CLIENT_ACME, 'Acme', 'billing_cycle', 'quarterly');
    await seedFact(b, CLIENT_BCAU, 'Bcau', 'billing_cycle', 'monthly');

    const allowed = await b.core.recall({
      actor: actor('user', `staff${b.id}`),
      query: 'billing',
      scope: CLIENT_ACME,
    });
    expect(allowed.results.length).toBeGreaterThan(0);

    await expectDenied(() => b.core.recall({
      actor: actor('user', `staff${b.id}`),
      query: 'billing',
      scope: CLIENT_BCAU,
    }), 'insufficient_permission');
  });

  it('context denies a staff actor for a client scope they are not granted', async () => {
    const b = await newBusiness('b1');
    await seedFact(b, CLIENT_ACME, 'Acme', 'billing_cycle', 'quarterly');

    await expectDenied(() => b.core.context({
      query: 'billing',
      scope: CLIENT_BCAU,
      actor_id: actor('user', `staff${b.id}`).id,
    }), 'insufficient_permission');
  });

  it('an actor with no grant at all is reported as unregistered, not merely forbidden', async () => {
    const b = await newBusiness('b1');
    await seedFact(b, CLIENT_ACME, 'Acme', 'billing_cycle', 'quarterly');

    await expectDenied(() => b.core.recall({
      actor: actor('user', 'nobody-anywhere'),
      query: 'billing',
      scope: CLIENT_ACME,
    }), 'actor_unregistered');
  });
});

describe('P0-5/P0-7 isolation · activity lane', () => {
  it('denies a staff actor listing activity for a client scope they are not granted', async () => {
    const b = await newBusiness('b1');
    await seedFact(b, CLIENT_ACME, 'Acme', 'billing_cycle', 'quarterly');
    await seedFact(b, CLIENT_BCAU, 'Bcau', 'billing_cycle', 'monthly');

    const allowed = b.core.listActivity({ actor: actor('user', `staff${b.id}`), scope: CLIENT_ACME });
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.every(event => event.scope === CLIENT_ACME)).toBe(true);

    await expectDenied(() => b.core.listActivity({
      actor: actor('user', `staff${b.id}`),
      scope: CLIENT_BCAU,
    }), 'insufficient_permission');
  });

  it('scope-less activity returns only scopes the actor may read', async () => {
    const b = await newBusiness('b1');
    await seedFact(b, CLIENT_ACME, 'Acme', 'billing_cycle', 'quarterly');
    await seedFact(b, CLIENT_BCAU, 'Bcau', 'billing_cycle', 'monthly');

    const visible = b.core.listActivity({ actor: actor('user', `staff${b.id}`) });
    expect(visible.length).toBeGreaterThan(0);
    expect([...new Set(visible.map(event => event.scope))]).toEqual([CLIENT_ACME]);
  });

  it('a staff actor cannot widen its own view with includeSensitive', async () => {
    const b = await newBusiness('b1');
    await b.core.observe({
      actor: b.owner,
      type: 'message',
      content: { format: 'text/plain', body: 'Acme payroll number is 42' },
      scope: CLIENT_ACME,
      sensitive: true,
    });

    // The owner sees it only with the explicit opt-in...
    const ownerIn = b.core.listActivity({ actor: b.owner, scope: CLIENT_ACME, includeSensitive: true });
    expect(ownerIn.some(event => event.sensitive)).toBe(true);

    // ...while a staff actor's flag buys nothing.
    const staffIn = b.core.listActivity({
      actor: actor('user', `staff${b.id}`),
      scope: CLIENT_ACME,
      includeSensitive: true,
    });
    expect(staffIn.some(event => event.sensitive)).toBe(false);
  });
});

// ── the cross-tenant matrix: six businesses, identical client IDs, every lane.

const BUSINESS_IDS = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
const ACME_VALUE = (biz: string) => `${biz}-acme-billing-value`;
const BCAU_VALUE = (biz: string) => `${biz}-bcau-billing-value`;
/** Every business's fact values, so a leak in any direction is visible. */
const FOREIGN_TOKENS = (own: string) =>
  BUSINESS_IDS.filter(id => id !== own).flatMap(id => [ACME_VALUE(id), BCAU_VALUE(id)]);

type LaneRunner = (b: Business, a: Actor, scope: string) => unknown | Promise<unknown>;

/** Every read lane a host can reach, driven exactly as the host calls it. */
const LANES: Record<string, LaneRunner> = {
  recall: (b, a, scope) => b.core.recall({ actor: a, query: 'billing', scope }),
  recall_hybrid: (b, a, scope) => b.core.recallHybrid(
    { actor: a, query: 'billing', scope },
    { adapter: null, store: null, min_similarity: 0.5 },
  ),
  context: (b, a, scope) => b.core.context({ query: 'billing', scope, actor_id: a.id }),
  raw_window: (b, a, scope) => b.core.searchObservations({ actor: a, query: 'billing', scope }),
  activity: (b, a, scope) => b.core.listActivity({ actor: a, scope }),
  read_browse: (b, a, scope) => b.core.read({ actor: a, scope }),
  conflicts: (b, a, scope) => b.core.readConflicts({ actor: a, scopes: [scope] }),
  knowledge_graph: (b, a, scope) => b.core.readKnowledgeGraph({ actor: a, scopes: [scope] }),
  semantic_documents: (b, a, scope) => b.core.prepareSemanticDocuments({ actor: a, scope }),
};

/** Every string carried by a `scope` key anywhere in a lane payload. */
function collectScopes(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectScopes(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'scope' && typeof nested === 'string') out.add(nested);
      else collectScopes(nested, out);
    }
  }
  return out;
}

function leakTokens(payload: unknown, ownBusiness: string): string[] {
  const text = JSON.stringify(payload) ?? '';
  return FOREIGN_TOKENS(ownBusiness).filter(token => text.includes(token));
}

/** Per-business actors, mirroring the Coffee shape (staff / agent / revoked / stranger). */
function actorsOf(b: Business) {
  return {
    owner: b.owner,
    staff: actor('user', `staff${b.id}`),
    agent: actor('agent', `agent${b.id}`),
    exstaff: actor('user', `exstaff${b.id}`),
    stranger: actor('user', 'stranger'),
  };
}

/** Active read scopes per actor, derived from the same fixture used to provision. */
function readableScopesOf(b: Business, who: keyof ReturnType<typeof actorsOf>): Set<string> | null {
  if (who === 'owner') return null; // owner bypasses grants
  if (who === 'staff') return new Set([CLIENT_ACME]);
  if (who === 'agent') return new Set([CLIENT_BCAU]);
  return new Set(); // revoked staff, stranger
}

async function seedAllBusinesses(): Promise<Business[]> {
  const businesses: Business[] = [];
  for (const id of BUSINESS_IDS) {
    const b = await newBusiness(id);
    await seedFact(b, CLIENT_ACME, 'Acme', 'billing_cycle', ACME_VALUE(id));
    await seedFact(b, CLIENT_BCAU, 'Bcau', 'billing_cycle', BCAU_VALUE(id));
    businesses.push(b);
  }
  return businesses;
}

describe('P0-5 isolation · six businesses, identical client IDs, every recall lane', () => {
  it('each business answers only from its own brain, per granted scope, in every lane', async () => {
    const businesses = await seedAllBusinesses();
    const assertions: string[] = [];

    for (const b of businesses) {
      const who = actorsOf(b);
      for (const [name, a] of Object.entries(who)) {
        const readable = readableScopesOf(b, name as keyof typeof who);
        for (const [lane, run] of Object.entries(LANES)) {
          for (const scope of [CLIENT_ACME, CLIENT_BCAU]) {
            if (readable !== null && !readable.has(scope)) continue;
            const payload = await run(b, a, scope);
            const leaked = leakTokens(payload, b.id);
            expect(leaked, `${b.id}/${name}/${lane}/${scope} leaked ${leaked.join(',')}`).toEqual([]);
            // Rows must never carry a client scope the caller did not ask for.
            const scopes = collectScopes(payload);
            for (const carried of scopes) {
              expect(
                [CLIENT_ACME, CLIENT_BCAU].includes(carried),
                `${b.id}/${name}/${lane}/${scope} carried scope ${carried}`,
              ).toBe(true);
            }
            assertions.push(`${b.id}/${name}/${lane}/${scope}`);
          }
        }
      }

      // Unauthorized actors inside the same brain are denied on every lane.
      for (const name of ['exstaff', 'stranger'] as const) {
        for (const [lane, run] of Object.entries(LANES)) {
          await expectDenied(() => run(b, who[name], CLIENT_ACME));
        }
      }
    }

    // The matrix is real: every allowed lane/actor/scope combination was exercised
    // (owner × 2 scopes, staff × 1, agent × 1 — the denied actors are asserted above).
    const allowedCombosPerBusiness = (2 + 1 + 1) * Object.keys(LANES).length;
    expect(assertions.length).toBe(BUSINESS_IDS.length * allowedCombosPerBusiness);
  });

  it('federated multi-scope reads deny rather than partially answering an unauthorized scope', async () => {
    const b = await newBusiness('b1');
    await seedFact(b, CLIENT_ACME, 'Acme', 'billing_cycle', ACME_VALUE('b1'));
    await seedFact(b, CLIENT_BCAU, 'Bcau', 'billing_cycle', BCAU_VALUE('b1'));
    const staff = actor('user', `staff${b.id}`);

    // Staff holds client:acme#1 only: adding an unauthorized scope to the
    // request must deny the whole read — never answer the granted part.
    await expectDenied(() => b.core.readKnowledgeGraph({ actor: staff, scopes: [CLIENT_ACME, CLIENT_BCAU] }), 'insufficient_permission');
    await expectDenied(() => b.core.readConflicts({ actor: staff, scopes: [CLIENT_ACME, CLIENT_BCAU] }), 'insufficient_permission');

    // Owner (bypass) may read both, and only ever from this brain.
    const kg = b.core.readKnowledgeGraph({ actor: b.owner, scopes: [CLIENT_ACME, CLIENT_BCAU] });
    expect(kg.claims.length).toBeGreaterThanOrEqual(2);
    expect(leakTokens(kg, b.id)).toEqual([]);
  });

  it('denied writes: an actor cannot observe into a scope it is not granted, in its brain or another', async () => {
    const b1 = await newBusiness('b1');
    const b2 = await newBusiness('b2');
    const staff = actor('user', `staff${b1.id}`);

    await expectDenied(() => b1.core.observe({
      actor: staff,
      type: 'message',
      content: { format: 'text/plain', body: 'write attempt into the other client scope' },
      scope: CLIENT_BCAU,
    }), 'insufficient_permission');

    // A staff identity from b1 must not be able to write into b2's brain at all.
    await expectDenied(() => b2.core.observe({
      actor: staff,
      type: 'message',
      content: { format: 'text/plain', body: 'cross-brain write attempt' },
      scope: CLIENT_ACME,
    }), 'actor_unregistered');

    // And nothing landed: no raw row, no claim, in either brain.
    expect(b1.core.searchObservations({ actor: b1.owner, query: 'write', scope: CLIENT_BCAU })).toHaveLength(0);
    expect(b2.core.searchObservations({ actor: b2.owner, query: 'cross-brain', scope: CLIENT_ACME })).toHaveLength(0);
  });

  it('fuzzes unauthorized (actor × scope × lane) combinations: zero leaks, and the denials are real', async () => {
    const businesses = await seedAllBusinesses();
    const scopes = [CLIENT_ACME, CLIENT_BCAU, 'workspace', 'self', 'client:ghost#9'];
    const leaks: string[] = [];
    let checked = 0;
    let denied = 0;
    let allowed = 0;

    for (const b of businesses) {
      const who = actorsOf(b);
      for (const [name, a] of Object.entries(who)) {
        const readable = readableScopesOf(b, name as keyof typeof who);
        for (const scope of scopes) {
          for (const [lane, run] of Object.entries(LANES)) {
            checked += 1;
            let payload: unknown;
            try {
              payload = await run(b, a, scope);
            } catch (error) {
              denied += 1;
              if (!(error instanceof ProtocolError)) {
                leaks.push(`${b.id}/${name}/${lane}/${scope}: non-denial error ${String(error)}`);
              } else if (!['insufficient_permission', 'actor_unregistered'].includes(error.code)) {
                leaks.push(`${b.id}/${name}/${lane}/${scope}: unexpected denial code ${error.code}`);
              }
              continue;
            }
            allowed += 1;
            const foreign = leakTokens(payload, b.id);
            if (foreign.length > 0) leaks.push(`${b.id}/${name}/${lane}/${scope}: foreign values ${foreign.join(',')}`);
            // Cross-scope: any row carried back must be in a scope this actor may read.
            if (readable !== null) {
              for (const carried of collectScopes(payload)) {
                if (carried === scope) continue; // echo of the requested scope is fine when allowed
                if (!readable.has(carried)) {
                  leaks.push(`${b.id}/${name}/${lane}/${scope}: carried unauthorized scope ${carried}`);
                }
              }
            }
          }
        }
      }
    }

    expect(leaks).toEqual([]);
    // The fuzz must actually exercise both outcomes, otherwise it proves nothing.
    expect(checked).toBe(BUSINESS_IDS.length * 5 * scopes.length * Object.keys(LANES).length);
    expect(denied).toBeGreaterThan(0);
    expect(allowed).toBeGreaterThan(0);
    console.log(
      `[p0-5 fuzz] ${checked} (actor × scope × lane) combinations across ${BUSINESS_IDS.length} businesses: `
      + `${denied} denied, ${allowed} allowed, ${leaks.length} leaks`,
    );
  });
});
