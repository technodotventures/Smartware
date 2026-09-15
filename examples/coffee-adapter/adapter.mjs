// Coffee reference adapter — drop-in integration of Smartware as an additive
// company-brain memory layer for a multi-tenant, multi-replica host.
//
// Contract: docs/integration/coffee-adapter.md. Executable proof:
// scripts/coffee-adapter-smoke.mjs (`npm run verify:coffee-adapter`).
//
// Design rules this module follows, and the reasons:
//
//   1. PUBLIC SURFACE ONLY. Every Smartware import below is a published package
//      path (`smartware`, `smartware/layer1`, `smartware/layer1/*`,
//      `smartware/layer3`, `smartware/render`). A consumer cannot reach
//      `dist/...` internals through the `exports` map, so an adapter that did
//      would be unreproducible outside this repository.
//   2. PORTS, NOT A REDIS CLIENT. The host owns the app store and the ownership
//      arbiter (Coffee: Redis). They are injected as two ports, so the adapter
//      carries no dependency on a driver, is testable deterministically, and
//      can run in a single-process local mode.
//   3. OWNERSHIP IS SETTLED BEFORE EITHER STORE IS TOUCHED. A replica that is
//      not the lease holder refuses the request before writing anything: no
//      reconciliation work is created, and the caller gets a request that is
//      safe to retry against the holder (`retryable: true`).
//   4. THE APP STORE IS AUTHORITATIVE; THE BRAIN IS ADDITIVE. A write goes to
//      the app store first, then the brain. If the brain refuses or fails, the
//      divergence is recorded (a per-scope drift counter) and reported in the
//      response — never hidden.
//   5. THE BRAIN ENFORCES ITS OWN GRANTS. The adapter validates actor SHAPE
//      (fail closed) but does not re-derive authorization on the hot path: the
//      substrate's codes (`insufficient_permission`, `actor_unregistered`, …)
//      are returned verbatim. On a degraded read the brain is unavailable, so
//      the adapter applies a config-derived precheck (fail closed) and labels
//      it as such.
//   6. DENIALS ARE NOT FAILURES. A denied read is a 403 with no fallback. A
//      failed brain read is a degraded answer from the app store, explicitly
//      labelled `provenance: 'unavailable'` — provenance is never invented.
//   7. NO MODEL CREDENTIAL IS REQUIRED. Extraction is the host's (Coffee's
//      existing pipeline); the host's extracted claims are admitted through the
//      public conflict seam. `llm.provider` stays `'none'`.
//   8. THE BRAIN FENCE IS THE SECOND LINE. The lease guard covers the request
//      boundary; the brain's own monotonic epoch (ADR-0007) covers a writer
//      stalled between its guard and its first mutation. A stale writer is
//      refused before any canonical artifact and demotes itself.
//
// Honest limits (not claims this file makes):
//   - If the process dies between the app-store push and the brain write, the
//     drift counter records that a divergence was observed; it cannot count
//     divergences the process never observed. Reconcile from the app store.
//   - No cross-store transaction exists, by design. The brain is additive.
//   - The adapter does not prove single-writer safety by itself; that is the
//     arbiter port's contract plus the brain's fence.

import fs from 'node:fs';
import path from 'node:path';

import { SmartwareCore, createDefaultConfig, knownTime, nullTime } from 'smartware';
import { ClaimStore } from 'smartware/layer1';
import { admitClaim } from 'smartware/layer1/conflicts';
import { computeConfidence } from 'smartware/layer1/confidence';
import { SearchIndex, syncSearchFromClaims } from 'smartware/layer3';
import { showAttributionByDefault, attributionLine, whySentence } from 'smartware/render';

export const DEFAULT_NAMESPACE = 'coffee';
export const DEFAULT_LEASE_TTL_MS = 8000;

/** `client:<id>#<n>` — versioned, non-reusable. `#0` is never a valid incarnation; wildcards are never a client scope. */
export const SCOPE_PATTERN = /^client:[a-z0-9][a-z0-9._-]*#[1-9]\d*$/;

/** Codes the substrate uses to say "refused", as opposed to "unavailable". */
export const DENIAL_CODES = new Set([
  'actor_unregistered', 'insufficient_permission', 'owner_required', 'user_required', 'forbidden',
  'read_disabled', 'write_disabled', 'sensitive', 'sensitive_opt_in_required',
  'source_required', 'source_unregistered', 'source_inactive', 'secret_detected',
]);

const ACTOR_TYPES = new Set(['person', 'agent', 'system', 'sidecar', 'substrate']);
const ACTOR_ID_PATTERN = /^(user|agent|system|sidecar|substrate):\S+$/;
const OPERATION_ID_PATTERN = /^op_[0-9A-HJKMNP-TV-Z]{26}$/;
const CORRECTION_REASONS = new Set(['changed', 'wrong', 'extraction_error', 'duplicate']);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID-shaped id without adding a dependency (`ulid` is not a public export). */
export function newUlid(nowMs = Date.now()) {
  let remaining = nowMs;
  const time = new Array(10);
  for (let i = 9; i >= 0; i -= 1) {
    time[i] = CROCKFORD[remaining % 32];
    remaining = Math.floor(remaining / 32);
  }
  const random = new Uint8Array(16);
  globalThis.crypto.getRandomValues(random);
  let suffix = '';
  for (let i = 0; i < 16; i += 1) suffix += CROCKFORD[random[i] % 32];
  return time.join('') + suffix;
}

export function newOperationId(nowMs = Date.now()) {
  return `op_${newUlid(nowMs)}`;
}

function adapterError(code, message, status = 400) {
  const error = new Error(message);
  error.name = 'AdapterError';
  error.code = code;
  error.status = status;
  return error;
}

export function isProtocolError(error) {
  return Boolean(error) && typeof error === 'object'
    && (error.name === 'ProtocolError' || typeof error.code === 'string')
    && typeof error.code === 'string';
}

/** The non-reusable scope id for one client incarnation. */
export function scopeForClient(clientId, incarnation = 1) {
  const id = String(clientId ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw adapterError('invalid_scope', `Client id '${clientId}' cannot form a scope id`);
  }
  if (!Number.isInteger(incarnation) || incarnation < 1) {
    throw adapterError(
      'invalid_scope',
      `Client scope incarnation must be a positive integer (got ${JSON.stringify(incarnation)}). `
      + 'A client scope is versioned and never reused: a returning client gets a fresh incarnration.',
    );
  }
  return `client:${id}#${incarnation}`;
}

/** Explicit scopes must be a client scope or one of the two workspace scopes. */
export function assertScopeShape(scope) {
  if (scope === 'workspace' || scope === 'self') return scope;
  if (typeof scope === 'string' && SCOPE_PATTERN.test(scope)) return scope;
  throw adapterError(
    'invalid_scope',
    `'${scope}' is not a client scope (expected client:<id>#<n>) or a workspace scope. `
    + 'Wildcards are never issued to staff or agents.',
  );
}

function resolveScope({ client, scope, incarnation = 1 }) {
  if (scope !== undefined && scope !== null) return assertScopeShape(scope);
  if (client !== undefined && client !== null) return assertScopeShape(scopeForClient(client, incarnation));
  throw adapterError('invalid_scope', 'A client or an explicit scope is required');
}

function validateActor(actor) {
  if (!actor || typeof actor !== 'object') {
    throw adapterError('invalid_actor', 'A resolved actor is required (the host authenticates it)', 401);
  }
  const { id, type, display_name: displayName } = actor;
  if (typeof id !== 'string' || !ACTOR_ID_PATTERN.test(id)) {
    throw adapterError('invalid_actor', `Actor id '${String(id)}' is not an authenticated identity`, 401);
  }
  if (!ACTOR_TYPES.has(type)) {
    throw adapterError('invalid_actor', `Actor type '${String(type)}' is not a person, agent or system actor`, 401);
  }
  if (displayName !== undefined && typeof displayName !== 'string') {
    throw adapterError('invalid_actor', 'Actor display_name must be a string when present', 401);
  }
  return { type, id, ...(displayName ? { display_name: displayName } : {}) };
}

function validateOperationId(operationId) {
  if (operationId === undefined || operationId === null) return null;
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    throw adapterError(
      'invalid_operation_id',
      `operation_id must be 'op_' + 26 Crockford base32 characters (got '${String(operationId)}'). `
      + 'A UUID is rejected — use newOperationId() to mint one.',
    );
  }
  return operationId;
}

function validateText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw adapterError('invalid_text', 'Observation text must be a non-empty string');
  }
  return text;
}

function validateClaims(claims) {
  if (claims === undefined || claims === null) return [];
  if (!Array.isArray(claims)) throw adapterError('invalid_claims', 'claims must be an array');
  return claims.map((claim, index) => {
    if (!claim || typeof claim !== 'object') {
      throw adapterError('invalid_claims', `claims[${index}] must be an object`);
    }
    if (typeof claim.predicate !== 'string' || claim.predicate.length === 0) {
      throw adapterError('invalid_claims', `claims[${index}].predicate is required`);
    }
    if (!claim.object || typeof claim.object !== 'object' || 'value' in claim.object === false) {
      throw adapterError('invalid_claims', `claims[${index}].object must be a typed value ({ type, value })`);
    }
    if (typeof claim.validity_from !== 'string' || claim.validity_from.length === 0) {
      throw adapterError(
        'invalid_claims',
        `claims[${index}].validity_from is required and must be the FACT's validity start (a stable string), `
        + 'not the extraction time — identity includes it exactly, and a fresh timestamp silently disables corroboration.',
      );
    }
    const subject = claim.subject ?? {};
    if (typeof subject.name !== 'string' || subject.name.length === 0) {
      throw adapterError('invalid_claims', `claims[${index}].subject.name is required`);
    }
    return claim;
  });
}

// ── identity and key derivation ─────────────────────────────────────────────
//
// A brain's identity is read from its own provisioning surface (config.json —
// the file the host writes when it provisions the Pod): `workspace_id` (the
// business) and `instance_id` (the brain). NOT the filesystem path: replicas
// mount the same volume at different paths, and a copied provisioning file can
// repeat an instance_id, which the workspace part disambiguates. Deriving keys
// from scope alone would silently merge two businesses' data ("client:acme#1"
// exists in every business that has an Acme).

function token(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
}

function readProvisionedConfig(brainDir) {
  const configPath = path.join(brainDir, 'config.json');
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw adapterError(
      'brain_identity_unavailable',
      `config.json at '${brainDir}' is unreadable (${String(error?.message ?? error)}); `
      + 'refusing to fall back to another identity, because two replicas could then disagree about which brain they own',
    );
  }
}

export function brainIdentity({ brainDir = null, tenant = null }) {
  const source = (brainDir ? readProvisionedConfig(brainDir) : null) ?? tenant;
  if (!source) {
    throw adapterError(
      'brain_identity_unavailable',
      'no config.json and no provisioning object — refusing to derive a brain identity from the filesystem path',
    );
  }
  const instanceId = token(source.instance_id);
  if (!instanceId) {
    throw adapterError('brain_identity_unavailable', 'instance_id is missing from the provisioning surface');
  }
  const workspaceId = token(source.workspace_id ?? source.tenant_id) || instanceId;
  return `${workspaceId}.${instanceId}`;
}

export function leaseKeyFor(identity, namespace = DEFAULT_NAMESPACE) {
  return `${namespace}:brainlease:${identity}`;
}

export function fenceEpochKeyFor(identity, namespace = DEFAULT_NAMESPACE) {
  return `${namespace}:brainfence:${identity}`;
}

export function messagesKeyFor(identity, scope, namespace = DEFAULT_NAMESPACE) {
  return `${namespace}:${identity}:messages:${scope}`;
}

export function driftKeyFor(identity, scope, namespace = DEFAULT_NAMESPACE) {
  return `${namespace}:${identity}:drift:${scope}`;
}

// ── provisioning template ───────────────────────────────────────────────────

function grantFor(actorType, descriptor) {
  const scopes = (descriptor.scopes ?? []).map(entry => assertScopeShape(entry));
  return {
    id: `grant_${newUlid()}`,
    actor_type: actorType,
    actor_id: descriptor.actorId,
    capabilities: {
      observe: scopes,
      query: scopes,
      compile: (descriptor.compile ?? []).map(entry => assertScopeShape(entry)),
      correct: (descriptor.correct ?? []).map(entry => assertScopeShape(entry)),
      forget: (descriptor.forget ?? []).map(entry => assertScopeShape(entry)),
      read: scopes,
    },
    trusted: descriptor.trusted ?? false,
    quarantine: false,
    created_at: new Date().toISOString(),
    expires_at: null,
    status: 'active',
  };
}

/**
 * The tenant provisioning template: one business = one Pod; a client is a
 * versioned scope; staff and agents are exact-id grants. `llm.provider` is
 * `'none'` — extraction is the host's, so the memory layer needs no model key.
 */
export function coffeeTenantConfig({
  dataDir,
  ownerId,
  workspaceId,
  instanceId,
  clients = [],
  staff = [],
  agents = [],
  llm = { provider: 'none', model: '' },
}) {
  const config = createDefaultConfig(dataDir);
  config.owner_id = ownerId;
  config.instance_id = instanceId;
  config.workspace_id = workspaceId;
  config.data_dir = dataDir;
  config.llm = llm;
  config.scopes = [
    { id: 'self', parent: null, visibility_default: 'private' },
    { id: 'workspace', parent: null, visibility_default: 'workspace' },
    ...clients.map(client => ({
      id: scopeForClient(client.id, client.incarnation ?? 1),
      parent: 'workspace',
      visibility_default: 'scope',
    })),
  ];
  config.grants = [
    ...staff.map(person => grantFor('person', person)),
    ...agents.map(agent => grantFor('agent', agent)),
  ];
  return config;
}

// ── the adapter ─────────────────────────────────────────────────────────────

/**
 * One instance per replica. `ports.appStore` is the host's authoritative
 * application store (Redis in Coffee); `ports.arbiter` is the ownership arbiter.
 *
 * appStore port:
 *   appendOnce({ key, operationId, record }) -> { written, len }   // idempotent per operationId
 *   list({ key }) -> record[]                                      // degraded reads
 *   getDrift({ key }) -> number
 *   incrDrift({ key }) -> number
 *
 * arbiter port (Redis in Coffee):
 *   tryAcquire({ key, holder, ttlMs }) -> boolean            // SET key holder NX PX ttl
 *   renewIfHeld({ key, holder, ttlMs }) -> boolean           // compare-and-extend; NOT SET..XX
 *   releaseIfHeld({ key, holder }) -> boolean
 *   holder(key) -> string | null
 *   nextEpoch(key) -> number                                 // monotonic per acquisition (INCR)
 */
export class CoffeeBrainAdapter {
  constructor({
    tenant,
    brainDir,
    ports,
    instanceId,
    namespace = DEFAULT_NAMESPACE,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    now = () => new Date().toISOString(),
    hooks = {},
  }) {
    if (!tenant || typeof tenant !== 'object') throw adapterError('invalid_config', 'tenant provisioning object is required');
    if (!brainDir) throw adapterError('invalid_config', 'brainDir is required');
    if (!ports?.appStore || !ports?.arbiter) throw adapterError('invalid_config', 'ports.appStore and ports.arbiter are required');
    if (!instanceId) throw adapterError('invalid_config', 'instanceId is required (the lease holder identity)');

    this.tenant = tenant;
    this.brainDir = brainDir;
    this.appStore = ports.appStore;
    this.arbiter = ports.arbiter;
    this.instanceId = instanceId;
    this.namespace = namespace;
    this.leaseTtlMs = leaseTtlMs;
    this.now = now;
    /** Drill seam: awaited between the ownership guard and the brain mutation. */
    this.hooks = { afterGuard: null, ...hooks };

    this.role = 'standby';
    this.identity = null;
    this.leaseKey = null;
    this.epoch = null;
    this.brain = null;
    this.store = null;
    this.index = null;
    this.events = [];
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    this.#provision();
    this.identity = brainIdentity({ brainDir: this.brainDir, tenant: this.tenant });
    this.leaseKey = leaseKeyFor(this.identity, this.namespace);
    await this.refreshOwnership();
    return this;
  }

  async stop({ release = true } = {}) {
    let released = false;
    if (release && this.role === 'owner' && this.leaseKey) {
      released = await this.arbiter.releaseIfHeld({ key: this.leaseKey, holder: this.instanceId });
      this.#note('released', released ? 'lease released on shutdown' : 'lease not held at shutdown');
    }
    this.#closeBrain();
    this.role = 'standby';
    return { released, role: this.role };
  }

  #provision() {
    fs.mkdirSync(this.brainDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(this.brainDir, 'config.json');
    if (fs.existsSync(configPath)) return;
    const config = { ...this.tenant, data_dir: this.brainDir };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    this.#note('provisioned', `wrote ${configPath}`);
  }

  /**
   * Acquire, renew or lose the brain lease. Call on a timer (every ttl/3) and
   * before any leadership-sensitive work; writes and reads call the guard
   * themselves, so a host that never wires a timer still fails closed.
   *
   * A renewal that fails demotes this replica and then immediately attempts a
   * fresh acquire: if the lease simply lapsed while nobody else took it, the
   * replica recovers in the same poll (with a NEW epoch — the brain fence never
   * accepts the old one); if another replica took it, the acquire fails and
   * this replica stays a standby.
   */
  async refreshOwnership() {
    if (!this.leaseKey) throw adapterError('not_started', 'start() must run before refreshOwnership()');
    if (this.role === 'owner') {
      const renewed = await this.arbiter.renewIfHeld({
        key: this.leaseKey, holder: this.instanceId, ttlMs: this.leaseTtlMs,
      });
      if (renewed) return this.role;
      this.#note('lost-lease', 'demoted: the lease is no longer ours');
      this.#closeBrain();
      this.role = 'standby';
    }
    const acquired = await this.arbiter.tryAcquire({
      key: this.leaseKey, holder: this.instanceId, ttlMs: this.leaseTtlMs,
    });
    if (!acquired) return this.role;
    const epoch = await this.arbiter.nextEpoch(fenceEpochKeyFor(this.identity, this.namespace));
    this.role = 'owner';
    await this.#openBrain(epoch);
    this.#note('acquired', `epoch ${epoch}`);
    return this.role;
  }

  async #openBrain(epoch) {
    this.#closeBrain();
    this.brain = await SmartwareCore.open({
      dataDir: this.brainDir,
      ownerId: this.tenant.owner_id,
      fencingToken: epoch,
    });
    const dbPath = path.join(this.brainDir, 'smartware.db');
    this.store = new ClaimStore(dbPath);
    this.store.setDataDir(this.brainDir);   // ClaimStore takes it; SearchIndex does NOT
    this.index = new SearchIndex(dbPath);
    this.epoch = epoch;
  }

  #closeBrain() {
    try { this.store?.close(); } catch { /* already closed */ }
    try { this.index?.close(); } catch { /* already closed */ }
    try { this.brain?.close(); } catch { /* already closed */ }
    this.store = null;
    this.index = null;
    this.brain = null;
    this.epoch = null;
  }

  #note(event, detail) {
    this.events.push({ at: this.now(), instance: this.instanceId, event, detail });
    if (this.events.length > 40) this.events.shift();
  }

  #config() {
    return { ...this.tenant, ...(readProvisionedConfig(this.brainDir) ?? {}), data_dir: this.brainDir };
  }

  // ── authorization ─────────────────────────────────────────────────────────

  /**
   * A config-derived precheck used ONLY on the degraded read path, where the
   * brain is unavailable and nothing else can enforce grants. It is deliberately
   * conservative (exact ids and `prefix/*` only) and labelled in every response
   * it produces. On the brain path the substrate remains the authority.
   */
  #precheck(actor, capability, scope) {
    const config = this.#config();
    if (actor.id === config.owner_id) return { ok: true, reason: 'owner' };
    const grant = (config.grants ?? []).find(entry =>
      entry.status === 'active' && entry.actor_id === actor.id && entry.actor_type === actor.type);
    if (!grant) return { ok: false, code: 'actor_unregistered' };
    const allowed = grant.capabilities?.[capability] ?? [];
    const covered = allowed.some(entry =>
      entry === scope || (typeof entry === 'string' && entry.endsWith('/*') && scope.startsWith(entry.slice(0, -1))));
    return covered ? { ok: true, reason: 'grant' } : { ok: false, code: 'insufficient_permission' };
  }

  // ── write path ────────────────────────────────────────────────────────────

  async handleWrite({
    actor, text, client, scope, incarnation = 1, source_ref = null, claims, observed_at, operation_id,
  }) {
    let verifiedActor; let targetScope; let body; let operationId; let claimInputs;
    try {
      verifiedActor = validateActor(actor);
      targetScope = resolveScope({ client, scope, incarnation });
      body = validateText(text);
      operationId = validateOperationId(operation_id);
      claimInputs = validateClaims(claims);
    } catch (error) {
      return this.#refusal(error);
    }

    // (1) Ownership is settled BEFORE either store is touched.
    if (this.role !== 'owner') return this.#notHolder(targetScope);
    const held = await this.arbiter.renewIfHeld({
      key: this.leaseKey, holder: this.instanceId, ttlMs: this.leaseTtlMs,
    });
    if (!held) {
      this.#note('lost-lease', 'guard refused a write after ownership moved');
      this.#closeBrain();
      this.role = 'standby';
      return {
        ok: false, status: 503, code: 'lease_lost', retryable: true, partial_write: false,
        scope: targetScope, holder: await this.arbiter.holder(this.leaseKey),
        hint: 'ownership moved during the request; nothing was written — retry against the current holder',
      };
    }

    // (2) The app store is authoritative: the application record lands first.
    const appKey = messagesKeyFor(this.identity, targetScope, this.namespace);
    const record = {
      ts: this.now(), actor: verifiedActor, scope: targetScope, text: body,
      source_ref, operation_id: operationId,
    };
    const appResult = await this.appStore.appendOnce({ key: appKey, operationId, record });

    // (3) Drill/observability seam between the guard and the brain mutation.
    if (typeof this.hooks.afterGuard === 'function') await this.hooks.afterGuard();

    // (4) The brain is additive. `operation_id` makes this half idempotent.
    let observation;
    try {
      observation = await this.brain.observe({
        actor: verifiedActor,
        type: 'message',
        content: { format: 'text/markdown', body },
        scope: targetScope,
        visibility: 'scope',
        ...(source_ref ? { source_ref } : {}),
        ...(observed_at ? { observed_at } : {}),
        ...(operationId ? { operation_id: operationId } : {}),
      });
    } catch (error) {
      return this.#brainWriteFailed({ error, targetScope, appResult, appKey, record });
    }

    // (5) Host-extracted claims: admitted (not compiled), identity-guarded.
    const summary = { inserted: 0, corroborated: 0, contested: 0, superseded: 0, skipped: 0, claim_ids: [], outcomes: [] };
    if (observation.status !== 'duplicate' && claimInputs.length > 0) {
      for (const input of claimInputs) {
        const outcome = this.#admit(observation.id, targetScope, input, verifiedActor);
        summary.outcomes.push({ predicate: input.predicate, outcome: outcome.outcome, claim_id: outcome.claim_id });
        summary.claim_ids.push(outcome.claim_id);
        if (outcome.outcome in summary) summary[outcome.outcome] += 1;
      }
      summary.claim_ids = [...new Set(summary.claim_ids)];
      syncSearchFromClaims(this.store, this.index, targetScope);
    } else if (observation.status === 'duplicate' && claimInputs.length > 0) {
      summary.skipped = claimInputs.length;
    }

    return {
      ok: true,
      status: 201,
      replayed: appResult.written === false,
      scope: targetScope,
      client: client ?? null,
      observation: { id: observation.id, status: observation.status },
      claims: summary,
      app: { key: appKey, written: appResult.written, len: appResult.len, record },
      brain: { written: true },
      drift_total: await this.appStore.getDrift({ key: driftKeyFor(this.identity, targetScope, this.namespace) }),
    };
  }

  #admit(observationId, scope, input, actor) {
    const typedObject = { ...input.object };
    // Identity discipline: the canonical key is (subject_id, predicate, scope,
    // validity_from). A fresh entity id per observation would make every
    // restatement a new fact, so an unnamed subject resolves to the entity the
    // fact was already recorded against in this scope.
    let entityId = input.subject.id;
    if (!entityId) {
      const existing = this.store.findEntityByName(input.subject.name, scope);
      if (existing) {
        entityId = existing.id;
      } else {
        entityId = `entity_${newUlid()}`;
        this.store.insertEntity({
          id: entityId,
          canonical_name: input.subject.name,
          aliases: [],
          type: input.subject.type ?? 'organization',
          scope,
          created_at: this.now(),
        });
      }
    }
    const at = this.now();
    const claim = {
      id: `claim_${newUlid()}`,
      subject_id: entityId,
      subject_name: input.subject.name,
      predicate: input.predicate,
      object: typedObject,
      scope,
      validity: { from: input.validity_from, to: null },
      t_ingested: knownTime(at),
      t_invalidated: nullTime(),
      t_valid_from: knownTime(input.validity_from),
      t_valid_to: nullTime(),
      source_event_id: observationId,
      extraction_event_id: observationId,
      supporting_evidence: [observationId],
      extraction: {
        method: 'deterministic', model: null,
        compiler_version: this.#config().version ?? '0.7.0',
        prompt_hash: null, extracted_at: at,
      },
      status: 'active',
      epistemic: input.epistemic ?? 'observed',
      confidence: 0,
      sensitive: false,
      superseded_by: null,
      contested_by: [],
      actor_id: actor.id,
    };
    // Confidence is derived, not stored input — set it with the same formula
    // the corroboration path will recompute, so the two agree.
    claim.confidence = computeConfidence(claim);
    const admission = admitClaim(claim, this.store);
    return { outcome: admission.outcome, claim_id: admission.claim_id ?? claim.id, related: admission.related_claim_ids ?? [] };
  }

  #brainWriteFailed({ error, targetScope, appResult, appKey }) {
    const code = isProtocolError(error) ? error.code : 'brain_unavailable';
    const message = String(error?.message ?? error).slice(0, 300);
    const fence = (() => {
      try { return this.brain?.fencingState?.() ?? null; } catch { return null; }
    })();
    const fenced = code === 'fencing_token_stale' || code === 'fencing_token_missing';
    const denial = DENIAL_CODES.has(code);
    if (fenced) {
      this.#note(code, 'brain refused a stale epoch; demoting');
      this.#closeBrain();
      this.role = 'standby';
    }
    // Retry semantics: a refusal that wrote no canonical artifact can be
    // re-issued with the SAME operation_id (the app store dedupes it and the
    // brain replays or completes it). Denials and payload conflicts cannot.
    const retryable = !denial && code !== 'conflict';
    return this.appStore
      .incrDrift({ key: driftKeyFor(this.identity, targetScope, this.namespace) })
      .then(driftTotal => ({
        ok: false,
        status: fenced ? 503 : (denial ? 403 : (code === 'conflict' ? 409 : 502)),
        code,
        denied: denial,
        retryable,
        partial_write: true,
        replayed: false,
        scope: targetScope,
        app: { key: appKey, written: appResult.written, len: appResult.len },
        brain: {
          written: false,
          error: message,
          ...(fence ? { fencing_refusals: fence.refusals, fencing_high_water: fence.high_water } : {}),
        },
        drift_total: driftTotal,
        hint: fenced
          ? 'the brain refused a stale ownership epoch before any artifact; the app-store record stands — retry with the same operation_id against the new lease holder'
          : denial
            ? 'the brain refused this actor; the app-store record stands and the divergence is counted — fix the grant or the caller, then reconcile'
            : 'the brain write failed after the app-store record: replay it with the same operation_id once the brain is reachable; do not re-push the app-store record',
      }));
  }

  #notHolder(scope) {
    return this.arbiter.holder(this.leaseKey).then(holder => ({
      ok: false, status: 503, code: 'lease_not_holder', retryable: true, partial_write: false,
      scope, holder,
      hint: 'route this tenant to the lease holder, or retry once failover completes — nothing was written',
    }));
  }

  #refusal(error) {
    const code = error?.code ?? 'invalid_request';
    return {
      ok: false,
      status: error?.status ?? 400,
      code,
      retryable: false,
      partial_write: false,
      hint: error?.message,
    };
  }

  // ── read path ─────────────────────────────────────────────────────────────

  async handleRecall({ actor, query, client, scope, incarnation = 1, limit = 10 }) {
    let verifiedActor; let targetScope;
    try {
      verifiedActor = validateActor(actor);
      targetScope = resolveScope({ client, scope, incarnation });
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw adapterError('invalid_query', 'query must be a non-empty string');
      }
    } catch (error) {
      return this.#refusal(error);
    }

    if (this.role !== 'owner') {
      return this.#degradedRead({
        actor: verifiedActor, scope: targetScope, query, reason: `brain lease held by ${await this.arbiter.holder(this.leaseKey)}`,
      });
    }

    try {
      const result = await this.brain.recall({ actor: verifiedActor, query, scope: targetScope, limit });
      return {
        ok: true,
        status: 200,
        degraded: false,
        source: 'brain',
        provenance: 'brain',
        authorization: 'brain grants',
        scope: targetScope,
        query,
        total_found: result.total_found ?? result.results.length,
        results: result.results,
      };
    } catch (error) {
      if (isProtocolError(error) && DENIAL_CODES.has(error.code)) {
        // A denial is not a failure: answering it from the app store would hand
        // an unauthorized actor data and hide the denial.
        return {
          ok: false, status: 403, code: error.code, denied: true, retryable: false,
          degraded: false, scope: targetScope, query,
          hint: String(error.message).slice(0, 300),
        };
      }
      return this.#degradedRead({
        actor: verifiedActor, scope: targetScope, query,
        reason: `brain read failed: ${String(error?.message ?? error).slice(0, 200)}`,
      });
    }
  }

  async #degradedRead({ actor, scope, query, reason }) {
    const precheck = this.#precheck(actor, 'query', scope);
    if (!precheck.ok) {
      return {
        ok: false, status: 403, code: precheck.code, denied: true, retryable: false,
        degraded: true, scope, query,
        hint: 'refused on the degraded path by the config-derived precheck (fail closed); the brain is unavailable, so its grants were not evaluated',
      };
    }
    const appKey = messagesKeyFor(this.identity, scope, this.namespace);
    const rows = await this.appStore.list({ key: appKey });
    const needle = query.toLowerCase();
    const matches = rows.filter(row => String(row.text ?? '').toLowerCase().includes(needle));
    return {
      ok: true,
      status: 200,
      degraded: true,
      source: 'app-store-fallback',
      provenance: 'unavailable',
      authorization: 'config-derived precheck (host-side; the brain did not evaluate grants)',
      scope,
      query,
      reason,
      total_found: matches.length,
      results: matches,
      note: 'degraded read: the app store is authoritative for application data; provenance, claims, conflicts and lifecycle require the brain (lease holder)',
    };
  }

  // ── provenance and attribution ────────────────────────────────────────────

  /** Resolve an observation's authenticated actor + registered source. */
  async describeProvenance({ actor, observation_id }) {
    const verifiedActor = validateActor(actor);
    const evidence = this.brain.readObservationEvidence({ actor: verifiedActor, observation_id });
    if (!evidence) {
      return { ok: false, status: 404, code: 'evidence_not_found', scope: null };
    }
    return {
      ok: true,
      status: 200,
      id: evidence.id,
      scope: evidence.scope,
      actor: {
        id: evidence.actor_id,
        type: evidence.actor_type,
        display_name: evidence.actor_display_name ?? evidence.actor_id,
      },
      observed_at: evidence.observed_at,
      captured_at: evidence.captured_at,
      source: { app: evidence.source_app, source_id: evidence.source_id, source_ref: evidence.source_ref ?? null },
      render: {
        surface: 'staff',
        freshness: 'unverified',
        compileState: 'ok',
        actorKind: evidence.actor_type === 'agent' ? 'agent' : 'person',
        actorDisplay: evidence.actor_display_name ?? evidence.actor_id,
        sourceDate: new Date(evidence.observed_at ?? evidence.captured_at ?? Date.now()),
        claimType: 'finding',
        epistemicTag: 'fact',
        confidence: 'high',
        tags: [],
      },
    };
  }

  /** Staff-facing attribution goes through smartware/render — never re-implemented. */
  attribution(input) {
    return {
      show: showAttributionByDefault(input),
      line: attributionLine(input),
      why: whySentence(input),
    };
  }

  // ── owner operations (lease-routed) ───────────────────────────────────────

  async registerSource({ actor, source }) {
    const notHolder = this.role !== 'owner' ? await this.#notHolder('workspace') : null;
    if (notHolder) return notHolder;
    try {
      const entry = this.brain.registerSource({ actor: validateActor(actor), ...source });
      return { ok: true, status: 200, source: entry };
    } catch (error) {
      return this.#brainOpFailed(error);
    }
  }

  async addClient({ actor, clientId, incarnation, parent = 'workspace' }) {
    if (this.role !== 'owner') return this.#notHolder(scopeForClient(clientId, incarnation));
    try {
      const scope = scopeForClient(clientId, incarnation);
      this.brain.ensureScopes([{ id: scope, parent, visibility_default: 'scope' }]);
      return { ok: true, status: 200, scope };
    } catch (error) {
      return this.#brainOpFailed(error);
    }
  }

  async exportClientScope({ actor, client, scope, incarnation = 1, operation_id }) {
    let targetScope;
    try {
      validateActor(actor);
      targetScope = resolveScope({ client, scope, incarnation });
    } catch (error) {
      return this.#refusal(error);
    }
    if (this.role !== 'owner') return this.#notHolder(targetScope);
    try {
      const result = await this.brain.exportScope({ actor, scope: targetScope, ...(operation_id ? { operation_id } : {}) });
      return { ok: true, status: 200, export_id: result.export_id, path: result.path, manifest: result.manifest, counts: result.counts };
    } catch (error) {
      return this.#brainOpFailed(error);
    }
  }

  async forgetClientScope({ actor, client, scope, incarnation = 1, reason = 'offboarding', operation_id, owner_pointer }) {
    let targetScope;
    try {
      validateActor(actor);
      targetScope = resolveScope({ client, scope, incarnation });
    } catch (error) {
      return this.#refusal(error);
    }
    if (this.role !== 'owner') return this.#notHolder(targetScope);
    try {
      const result = await this.brain.forgetScope({
        actor, scope: targetScope, reason,
        ...(operation_id ? { operation_id } : {}),
        ...(owner_pointer ? { owner_pointer } : {}),
      });
      return { ok: true, status: 200, result };
    } catch (error) {
      return this.#brainOpFailed(error);
    }
  }

  #brainOpFailed(error) {
    const code = isProtocolError(error) ? error.code : 'brain_unavailable';
    if (code === 'fencing_token_stale' || code === 'fencing_token_missing') {
      this.#closeBrain();
      this.role = 'standby';
    }
    return {
      ok: false,
      status: DENIAL_CODES.has(code) ? 403 : 502,
      code,
      denied: DENIAL_CODES.has(code),
      retryable: !DENIAL_CODES.has(code),
      hint: String(error?.message ?? error).slice(0, 300),
    };
  }

  // ── lifecycle and correction operations (lease-routed, owner/staff as granted) ──

  /**
   * Retention expiry sweep for one scope (ADR-0001): tombstones elapsed
   * `duration`-policy observations and retracts claims whose only evidence they
   * were. Idempotent by nature and per `operation_id`; requires a `forget`
   * grant on the scope (or the owner). Refused on a standby.
   */
  async expireRetention({ actor, client, scope, incarnation = 1, as_of, operation_id }) {
    let verifiedActor; let targetScope;
    try {
      verifiedActor = validateActor(actor);
      targetScope = resolveScope({ client, scope, incarnation });
    } catch (error) {
      return this.#refusal(error);
    }
    if (this.role !== 'owner') return this.#notHolder(targetScope);
    try {
      const result = await this.brain.expireRetention({
        actor: verifiedActor,
        scope: targetScope,
        ...(as_of ? { as_of } : {}),
        ...(operation_id ? { operation_id } : {}),
      });
      return { ok: true, status: 200, scope: targetScope, result };
    } catch (error) {
      return this.#brainOpFailed(error);
    }
  }

  /**
   * Restore one EXPORT.SCOPE package into this brain — the return path after a
   * disaster (ADR-0006). Verifies the manifest checksums and refuses a package
   * that crosses its scope boundary, a non-empty target scope, or a tampered
   * package before writing anything. Owner-only; refused on a standby.
   */
  async restoreScope({ actor, package_dir, operation_id }) {
    let verifiedActor;
    try {
      verifiedActor = validateActor(actor);
      if (typeof package_dir !== 'string' || package_dir.trim().length === 0) {
        throw adapterError('invalid_package_dir', 'package_dir must be the directory of an EXPORT.SCOPE package');
      }
    } catch (error) {
      return this.#refusal(error);
    }
    if (this.role !== 'owner') return this.#notHolder('workspace');
    try {
      const result = await this.brain.restoreScope({
        actor: verifiedActor,
        package_dir,
        ...(operation_id ? { operation_id } : {}),
      });
      return { ok: true, status: 200, ...result };
    } catch (error) {
      return this.#brainOpFailed(error);
    }
  }

  /**
   * A warranted correction of one claim (spec verb CORRECT/REVISE). This is the
   * path that settles a disagreement by explicit human action instead of by
   * recency, and it is auditable: the brain appends a correction observation and
   * spawns a new claim version. Requires the `correct` capability on the claim's
   * scope (carried by the provisioning template) — the brain enforces it.
   *
   * One-shot by design: unlike `handleWrite` there is no `operation_id` on this
   * verb, so a blind retry after a timeout creates another correction version.
   * Settle ambiguity from the brain, not by retrying.
   */
  async correctClaim({
    actor, target_claim_id, corrected_predicate, corrected_object, corrected_validity, change_time, reason = 'changed',
  }) {
    let verifiedActor;
    try {
      verifiedActor = validateActor(actor);
      if (typeof target_claim_id !== 'string' || target_claim_id.length === 0) {
        throw adapterError('invalid_claim', 'target_claim_id is required');
      }
      if (!CORRECTION_REASONS.has(reason)) {
        throw adapterError('invalid_reason', `reason must be one of changed|wrong|extraction_error|duplicate (got '${String(reason)}')`);
      }
      if (corrected_object !== undefined
        && (!corrected_object || typeof corrected_object !== 'object' || !('value' in corrected_object))) {
        throw adapterError('invalid_claims', 'corrected_object must be a typed value ({ type, value })');
      }
    } catch (error) {
      return this.#refusal(error);
    }
    if (this.role !== 'owner') return this.#notHolder('workspace');
    try {
      const result = await this.brain.correct({
        actor: verifiedActor,
        target_claim_id,
        ...(corrected_predicate !== undefined ? { corrected_predicate } : {}),
        ...(corrected_object !== undefined ? { corrected_object } : {}),
        ...(corrected_validity !== undefined ? { corrected_validity } : {}),
        ...(change_time ? { change_time } : {}),
        reason,
      });
      return { ok: true, status: 200, ...result };
    } catch (error) {
      return this.#brainOpFailed(error);
    }
  }

  // ── operations surface ────────────────────────────────────────────────────

  async health({ actor, backup_dir } = {}) {
    const holder = this.leaseKey ? await this.arbiter.holder(this.leaseKey) : null;
    let brainHealth = null;
    if (this.brain && this.role === 'owner') {
      try {
        brainHealth = await this.brain.health({ actor, ...(backup_dir ? { backup_dir } : {}) });
      } catch (error) {
        brainHealth = { error: isProtocolError(error) ? error.code : String(error?.message ?? error) };
      }
    }
    return {
      ok: true,
      status: 200,
      instance_id: this.instanceId,
      role: this.role,
      degraded: this.role !== 'owner',
      identity: { brain: this.identity, lease_key: this.leaseKey },
      lease: {
        key: this.leaseKey,
        ttl_ms: this.leaseTtlMs,
        holder,
        epoch: this.epoch,
      },
      brain: brainHealth,
      events: this.events.slice(-6),
      note: this.role === 'owner'
        ? 'this replica owns the brain; provenance is available'
        : `brain owned by ${holder}; reads are degraded to the app store and writes are refused`,
    };
  }
}

export default CoffeeBrainAdapter;
