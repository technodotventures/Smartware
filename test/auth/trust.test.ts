// Tests: Auth — Trust determination

import { describe, it, expect } from 'vitest';
import { shouldQuarantine, quarantineForGrants } from '../../src/auth/trust.js';
import type { Actor } from '../../src/layer0/types.js';
import type { Grant } from '../../src/auth/grants.js';

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: 'grant_1',
    actor_type: 'agent',
    actor_id: 'agent_1',
    capabilities: { observe: [], query: [], compile: [], correct: [], forget: [], read: [] },
    trusted: false,
    quarantine: false,
    created_at: new Date().toISOString(),
    expires_at: null,
    status: 'active',
    ...overrides,
  };
}

describe('shouldQuarantine', () => {
  it('quarantines when no grant', () => {
    const actor: Actor = { type: 'agent', id: 'agent_x', display_name: 'X' };
    expect(shouldQuarantine(actor, null)).toBe(true);
  });

  it('quarantines when grant.quarantine = true', () => {
    const actor: Actor = { type: 'person', id: 'user_1', display_name: 'User' };
    const grant = makeGrant({ quarantine: true });
    expect(shouldQuarantine(actor, grant)).toBe(true);
  });

  it('does NOT quarantine when grant.trusted = true', () => {
    const actor: Actor = { type: 'agent', id: 'agent_1', display_name: 'Agent' };
    const grant = makeGrant({ trusted: true });
    expect(shouldQuarantine(actor, grant)).toBe(false);
  });

  it('quarantines by default when the GRANT records a system actor', () => {
    const actor: Actor = { type: 'system', id: 'sys_1', display_name: 'System' };
    const grant = makeGrant({ actor_type: 'system' });
    expect(shouldQuarantine(actor, grant)).toBe(true);
  });

  it('does NOT quarantine when the grant records a person/agent by default', () => {
    expect(shouldQuarantine({ type: 'person', id: 'u', display_name: 'P' }, makeGrant({ actor_type: 'person' }))).toBe(false);
    expect(shouldQuarantine({ type: 'agent', id: 'a', display_name: 'A' }, makeGrant({ actor_type: 'agent' }))).toBe(false);
  });

  it('cannot be bypassed by spoofing the client actor.type', () => {
    // Client claims to be an agent, but the grant was issued to a system actor.
    const spoofed: Actor = { type: 'agent', id: 'sys_1', display_name: 'Not really an agent' };
    expect(shouldQuarantine(spoofed, makeGrant({ actor_type: 'system' }))).toBe(true);
  });
});

describe('quarantineForGrants (scope-relevant set)', () => {
  it('holds when no authorising grant', () => {
    expect(quarantineForGrants([])).toBe(true);
  });
  it('any explicit quarantine flag forces a hold', () => {
    expect(quarantineForGrants([makeGrant({ trusted: true }), makeGrant({ quarantine: true })])).toBe(true);
  });
  it('a trusted scope-relevant grant accepts', () => {
    expect(quarantineForGrants([makeGrant({ actor_type: 'system' }), makeGrant({ trusted: true })])).toBe(false);
  });
  it('falls back to the recorded actor type', () => {
    expect(quarantineForGrants([makeGrant({ actor_type: 'system' })])).toBe(true);
    expect(quarantineForGrants([makeGrant({ actor_type: 'agent' })])).toBe(false);
  });
});
