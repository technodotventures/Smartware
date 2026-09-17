// Session summariser lane pin (kanban t_574be8cd).
//
// `handleSessionEnd` hands a host's `onSummarize` callback the lane the durable
// summary is to be persisted into: `session.requested_scopes[0]`, with a `??`
// fallback for a session that declared no scopes. Pre-fix that fallback was the
// literal `personal` — a lane no revision ever registered and the published
// `$defs/Scope` vocabulary rejects — so a host that trusted the argument wrote
// its summary into a lane the brain does not name (the class ADR-0015 /
// `t_e6fce49a` fixed at the writers).
//
// Driven, not read: a real session is started with `requested_scopes: []` and
// ended with a callback that records what it was handed. The same file runs
// against the pre-fix revision (the RED arm: the callback receives `personal`).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { SmartwareCore } from '../../src/core.js';
import { handleSessionEnd, handleSessionStart } from '../../src/protocol/session.js';
import { SessionStore } from '../../src/session/store.js';

/** The pod's own lane — `POD_SELF_SCOPE` in `src/config.ts`. Spelled here so the
 *  identical file can run against the pre-fix revision. */
const POD_LANE = 'self';
/** The pre-fix fallback: not in `$defs/Scope`, not registered by any revision. */
const PRE_FIX_LANE = 'personal';

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };
const CAPABILITIES = {
  can_tag_sensitivity: false,
  can_provide_intent: true,
  can_request_user_confirmation: true,
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function openBrain(): Promise<{ core: SmartwareCore; sessionStore: SessionStore }> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sw-summariser-lane-'));
  tempDirs.push(dataDir);
  const core = await SmartwareCore.open({ dataDir, ownerId: OWNER.id });
  // A second connection to the same brain (WAL + busy_timeout), so the session
  // row this test drives is the one the protocol handlers read back.
  const sessionStore = new SessionStore(path.join(dataDir, 'smartware.db'));
  return { core, sessionStore };
}

/** Start a session and return the session id, asserting the summariser path is reachable. */
async function startSession(
  core: SmartwareCore,
  sessionStore: SessionStore,
  requestedScopes: string[],
  clientId: string,
) {
  const started = await handleSessionStart(
    {
      actor: OWNER,
      client_id: clientId,
      client_version: '1.0.0',
      declared_trust_level: 'user_facing',
      declared_capabilities: CAPABILITIES,
      requested_scopes: requestedScopes,
    },
    sessionStore,
    core.getConfig(),
  );
  assert.ok(
    started.effective_policy.write_mode === 'durable_summary' || started.effective_policy.write_mode === 'auto',
    `the summariser path needs a persisting write mode; got ${started.effective_policy.write_mode}`,
  );
  return started.session_id;
}

describe('the lane a durable session summary is handed', () => {
  test('a session that declared no scopes is handed the pod lane, and it is registered', async () => {
    const { core, sessionStore } = await openBrain();
    try {
      const sessionId = await startSession(core, sessionStore, [], 'pin-summariser-empty');

      let handed: { scope: string; actorId: string } | null = null;
      const ended = await handleSessionEnd(
        {
          session_id: sessionId,
          actor_id: OWNER.id,
          onSummarize: async (scope, actorId) => {
            handed = { scope, actorId };
            return 2;
          },
        },
        sessionStore,
        core.getConfig(),
      );

      // Non-vacuity: the callback actually ran (the fallback is the path under test).
      assert.equal(ended.summary?.durability, 'persisted', 'the summariser must have run');
      assert.equal(ended.summary?.claims_persisted, 2, 'the callback result is reported');
      assert.ok(handed, 'the host callback received the lane');
      const received = handed as unknown as { scope: string; actorId: string };

      assert.equal(
        received.scope,
        POD_LANE,
        `a session with no declared scopes must be handed the pod lane '${POD_LANE}' `
        + `(pre-fix it was handed '${PRE_FIX_LANE}')`,
      );
      assert.equal(received.actorId, OWNER.id, 'the session actor is handed alongside the lane');
      assert.ok(
        core.getConfig().scopes.some(entry => entry.id === received.scope),
        `the lane handed to a host must be registered; got '${received.scope}' from `
        + `[${core.getConfig().scopes.map(entry => entry.id).join(', ')}]`,
      );
    } finally {
      sessionStore.close();
      core.close();
    }
  }, 120_000);

  test('the pre-fix literal is not a lane this brain registers', async () => {
    const { core, sessionStore } = await openBrain();
    try {
      const registered = core.getConfig().scopes.map(entry => entry.id);
      assert.ok(registered.includes(POD_LANE), `a Core-opened brain registers '${POD_LANE}'`);
      assert.equal(
        registered.includes(PRE_FIX_LANE),
        false,
        `the pre-fix literal '${PRE_FIX_LANE}' is not registered — a host cannot persist into it `
        + `(registered: [${registered.join(', ')}])`,
      );
    } finally {
      sessionStore.close();
      core.close();
    }
  }, 120_000);

  test('A/B control: a session that declared scopes still hands its own lane', async () => {
    const { core, sessionStore } = await openBrain();
    try {
      const sessionId = await startSession(core, sessionStore, ['project:foo'], 'pin-summariser-declared');

      let handed: string | null = null;
      await handleSessionEnd(
        { session_id: sessionId, actor_id: OWNER.id, onSummarize: async scope => { handed = scope; return 1; } },
        sessionStore,
        core.getConfig(),
      );

      // The fix is a fallback change only: the primary path is untouched, so this
      // control passes on both arms of the pair.
      assert.equal(handed, 'project:foo', "a session's own declared lane wins over the fallback");
    } finally {
      sessionStore.close();
      core.close();
    }
  }, 120_000);
});
