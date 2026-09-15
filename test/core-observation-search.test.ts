// Integration: SmartwareCore raw-observation search window (spec §10a)
//
// Verifies the end-to-end contract the MCP/Pod surface exposes:
//  - an observation is raw-searchable IMMEDIATELY after observe (sync-raw),
//    before any compile job runs — this is the freshness promise;
//  - results carry the state-based freshness label (unverified by default),
//    never a timestamp-derived age;
//  - a tombstone (FORGET on the observation) drops it from the raw window
//    immediately, and a wipe-and-rebuild from JSONL agrees (rebuild-equivalence);
//  - sensitive observations stay default-deny;
//  - a blank query without a temporal range returns nothing (legacy contract).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SmartwareCore } from '../src/core.js';

const opened: SmartwareCore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const core of opened.splice(0)) core.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function openCore(): Promise<SmartwareCore> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-obs-search-'));
  directories.push(dataDir);
  const core = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
  opened.push(core);
  return core;
}

const OWNER = { type: 'person' as const, id: 'user:owner', display_name: 'Owner' };

describe('SmartwareCore observation raw-search window', () => {
  it('is raw-searchable immediately after observe, before any compile', async () => {
    const core = await openCore();
    await core.observe({
      actor: OWNER,
      type: 'message',
      content: { format: 'text/plain', body: 'The Atlas release is on hold until Friday.' },
      scope: 'personal',
    });

    const hits = core.searchObservations({ actor: OWNER, query: 'atlas', scope: 'personal' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toMatch(/^obs_/);
    // State-based freshness: never time-derived. A brand new observation is
    // still 'unverified' until a compile job RESOLVES — not until "old".
    expect(hits[0]!.freshness).toBe('unverified');
    expect(hits[0]!.status).toBe('accepted');
    // Snippet is centred on the matched term.
    expect(hits[0]!.snippet).toContain('Atlas');
    expect(hits[0]!.snippet).toContain('Friday');
  });

  it('honours includeSensitive default-deny in the raw window', async () => {
    const core = await openCore();
    await core.observe({
      actor: OWNER,
      type: 'message',
      content: { format: 'text/plain', body: 'Payroll number for Atlas is 42' },
      scope: 'personal',
      sensitive: true,
    });

    expect(core.searchObservations({ actor: OWNER, query: 'atlas', scope: 'personal' })).toHaveLength(0);
    const hits = core.searchObservations({ actor: OWNER, query: 'atlas', scope: 'personal', includeSensitive: true });
    expect(hits).toHaveLength(1);
  });

  it('applies temporal range filtering', async () => {
    const core = await openCore();
    await core.observe({
      actor: OWNER,
      type: 'message',
      content: { format: 'text/plain', body: 'Atlas briefing notes' },
      scope: 'personal',
      observed_at: '2026-08-10T10:00:00Z',
    });
    await core.observe({
      actor: OWNER,
      type: 'message',
      content: { format: 'text/plain', body: 'Atlas follow-up notes' },
      scope: 'personal',
      observed_at: '2026-09-01T10:00:00Z',
    });

    const inRange = core.searchObservations({
      actor: OWNER,
      query: 'atlas',
      scope: 'personal',
      temporalRange: { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' },
    });
    expect(inRange).toHaveLength(1);
    expect(inRange[0]!.snippet).toContain('briefing');

    // Blank query + no range → legacy contract: nothing.
    expect(core.searchObservations({ actor: OWNER, query: '', scope: 'personal' })).toHaveLength(0);
  });

  it('drops a tombstoned observation from the raw window immediately', async () => {
    const core = await openCore();
    const observed = await core.observe({
      actor: OWNER,
      type: 'message',
      content: { format: 'text/plain', body: 'Confidential Atlas budget of 100k' },
      scope: 'personal',
    });
    expect(observed.status).toBe('accepted');
    expect(core.searchObservations({ actor: OWNER, query: 'atlas', scope: 'personal' })).toHaveLength(1);

    await core.forget({
      actor: OWNER,
      target: { type: 'observation', id: observed.id },
      mode: 'tombstone',
      reason: 'client dispute',
    });
    expect(core.searchObservations({ actor: OWNER, query: 'atlas', scope: 'personal' })).toHaveLength(0);

    // Rebuild-equivalence: re-open the same data dir → derived index rebuilt
    // from JSONL must agree (no ghost in the raw window).
    const dataDir = core.getConfig().data_dir;
    core.close();
    opened.pop();
    const reopened = await SmartwareCore.open({ dataDir, ownerId: 'user:owner' });
    opened.push(reopened);
    expect(reopened.searchObservations({ actor: OWNER, query: 'atlas', scope: 'personal' })).toHaveLength(0);
  });

  it('applies structure-body stringification to JSON content', async () => {
    const core = await openCore();
    await core.observe({
      actor: OWNER,
      type: 'tool_output',
      content: { format: 'application/json', body: { status: 'blocked', owner: 'Atlas team' } },
      scope: 'personal',
    });

    const hits = core.searchObservations({ actor: OWNER, query: 'blocked', scope: 'personal' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain('blocked');
  });
});
