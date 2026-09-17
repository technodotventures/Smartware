// MCP transport conformance — exercise the real stdio server.

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ulid } from 'ulid';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';

describe('MCP Server Smoke', () => {
  let tmpDir: string;
  let client: Client;
  let transport: StdioClientTransport;
  let ownerId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-mcp-'));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(process.cwd(), 'dist/cli.js')],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        SMARTWARE_DATA_DIR: tmpDir,
      },
      stderr: 'pipe',
    });
    client = new Client({ name: 'smartware-conformance', version: '1.0.0' });
    await client.connect(transport);
    ownerId = (JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'),
    ) as { owner_id: string }).owner_id;
  });

  afterEach(async () => {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers canonical protocol verbs over the real transport', async () => {
    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'smartware_observe',
      'smartware_recall',
      'smartware_reflect',
      'smartware_revise',
      'smartware_context',
      'smartware_forget',
      'smartware_read',
      'smartware_explain',
      'smartware_export_scope',
      'smartware_hold_release',
    ]));
    expect(names).toEqual(expect.arrayContaining([
      'smartware_query',
      'smartware_compile',
      'smartware_correct',
    ]));

    const context = listed.tools.find(tool => tool.name === 'smartware_context');
    expect(context?.inputSchema.required).toEqual(expect.arrayContaining([
      'actor_id',
      'query',
      'scope',
    ]));

    // The hold release is an audited act: operation_id is required at the MCP
    // boundary so a keyless release cannot exist (finding F1, card t_7a64ded2).
    const holdRelease = listed.tools.find(tool => tool.name === 'smartware_hold_release');
    expect(holdRelease?.inputSchema.required).toEqual(expect.arrayContaining([
      'actor_id',
      'scope',
      'operation_id',
    ]));
  });

  it('all handler imports resolve without errors', async () => {
    const handlers = await Promise.all([
      import('../../src/protocol/observe.js'),
      import('../../src/protocol/recall.js'),
      import('../../src/protocol/reflect.js'),
      import('../../src/protocol/revise.js'),
      import('../../src/protocol/forget.js'),
      import('../../src/protocol/read.js'),
      import('../../src/protocol/explain.js'),
      import('../../src/protocol/context.js'),
      import('../../src/protocol/endorse.js'),
      import('../../src/protocol/session.js'),
    ]);
    for (const h of handlers) {
      expect(h).toBeDefined();
    }
  });

  it('routes real tool calls through Core and marks protocol failures as errors', async () => {
    const observed = await client.callTool({
      name: 'smartware_observe',
      arguments: {
        actor_id: ownerId,
        actor_type: 'person',
        content_body: 'Deadline: 2026-09-01.',
        scope: 'self',
      },
    });
    expect(observed.isError).not.toBe(true);
    const observedBody = JSON.parse(
      (observed.content[0] as { type: 'text'; text: string }).text,
    ) as { id: string; status: string };
    expect(observedBody).toMatchObject({ status: 'accepted' });
    expect(observedBody.id).toMatch(/^obs_[a-f0-9]{64}$/);

    const denied = await client.callTool({
      name: 'smartware_recall',
      arguments: {
        query: 'deadline',
        scope: 'self',
      },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(
      (denied.content[0] as { type: 'text'; text: string }).text,
    )).toMatchObject({ error: 'invalid_parameter' });
  });

  it('SmartwareCore has all spec-named methods', async () => {
    const { SmartwareCore } = await import('../../src/core.js');
    const proto = SmartwareCore.prototype;
    expect(typeof proto.observe).toBe('function');
    expect(typeof proto.recall).toBe('function');
    expect(typeof proto.reflect).toBe('function');
    expect(typeof proto.context).toBe('function');
    expect(typeof proto.revise).toBe('function');
    expect(typeof proto.forget).toBe('function');
    expect(typeof proto.revive).toBe('function');
    expect(typeof proto.endorse).toBe('function');
    expect(typeof proto.read).toBe('function');
    expect(typeof proto.explain).toBe('function');
    // Shared-workspace contract: sources, ingestion, sync status, federation.
    expect(typeof proto.registerSource).toBe('function');
    expect(typeof proto.listSources).toBe('function');
    expect(typeof proto.ingest).toBe('function');
    expect(typeof proto.sourceSyncStatus).toBe('function');
    expect(typeof proto.recallFederated).toBe('function');
  });

  it('registers the source, ingestion and federation tools with their required inputs', async () => {
    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'smartware_register_source',
      'smartware_list_sources',
      'smartware_ingest',
      'smartware_sync_status',
      'smartware_recall_federated',
    ]));

    const ingest = listed.tools.find(tool => tool.name === 'smartware_ingest');
    expect(ingest?.inputSchema.required).toEqual(expect.arrayContaining([
      'actor_id', 'source_id', 'scope', 'cursor', 'operation_id', 'items',
    ]));

    const observe = listed.tools.find(tool => tool.name === 'smartware_observe');
    const observeProps = observe?.inputSchema.properties as Record<string, unknown>;
    expect(observeProps).toHaveProperty('source_ref');
  });

  it('registers the health tool and returns the host-facing contract over the real transport', async () => {
    const textOf = (result: unknown): string =>
      (result as { content: Array<{ type: string; text: string }> }).content[0]!.text;

    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);
    expect(names).toContain('smartware_health');

    const health = listed.tools.find(tool => tool.name === 'smartware_health');
    expect(health?.inputSchema.required).toEqual(expect.arrayContaining(['actor_id']));

    const result = await client.callTool({ name: 'smartware_health', arguments: { actor_id: ownerId } });
    expect(result.isError).not.toBe(true);
    const report = JSON.parse(textOf(result)) as Record<string, unknown>;
    // The contract survives the transport: ownership, lane counts, drift, the
    // SLO evaluation — and no owner-only block is omitted for the owner.
    expect(report.ownership).toMatchObject({ arbitration: 'external', ttl_owner: 'host' });
    expect(report.brain).toEqual({ open: true });
    expect(report.counts).toBeDefined();
    expect(report.drift).toBeDefined();
    expect(report.slo).toMatchObject({ trial: 'coffee-trial' });
  });

  it('drives a connector sync over the real transport: register, ingest, sync status, federated read', async () => {
    const textOf = (result: unknown): string =>
      (result as { content: Array<{ type: string; text: string }> }).content[0]!.text;

    const registered = await client.callTool({
      name: 'smartware_register_source',
      arguments: {
        actor_id: ownerId,
        source_id: 'src_gmail',
        kind: 'connector',
        display_name: 'Gmail — ava@harbor',
      },
    });
    expect(registered.isError).not.toBe(true);

    const listed = await client.callTool({ name: 'smartware_list_sources', arguments: { actor_id: ownerId } });
    const sources = JSON.parse(textOf(listed)) as Array<{ id: string }>;
    expect(sources.map(entry => entry.id)).toEqual(['src_gmail']);

    const receipt = await client.callTool({
      name: 'smartware_ingest',
      arguments: {
        actor_id: ownerId,
        actor_type: 'person',
        source_id: 'src_gmail',
        scope: 'self',
        cursor: 'c1',
        operation_id: `op_${ulid()}`,
        items: [
          { external_id: 'm1', content_body: 'A message ingested over MCP.' },
          { external_id: 'm2', content_body: 'A second message.' },
        ],
      },
    });
    expect(receipt.isError).not.toBe(true);
    const receiptBody = JSON.parse(textOf(receipt)) as {
      status: string; accepted: number; cursor: string; cursor_before: string | null;
    };
    expect(receiptBody).toMatchObject({ status: 'ok', accepted: 2, cursor: 'c1', cursor_before: null });

    const sync = await client.callTool({
      name: 'smartware_sync_status',
      arguments: { actor_id: ownerId, source_id: 'src_gmail' },
    });
    const syncBody = JSON.parse(textOf(sync)) as Array<{
      last_sync: { cursor: string } | null; totals: { accepted: number };
    }>;
    expect(syncBody[0]?.last_sync?.cursor).toBe('c1');
    expect(syncBody[0]?.totals.accepted).toBe(2);

    const federated = await client.callTool({
      name: 'smartware_recall_federated',
      arguments: { actor_id: ownerId, query: 'message', scopes: ['self'] },
    });
    expect(federated.isError).not.toBe(true);
    const federatedBody = JSON.parse(textOf(federated)) as { scopes: string[] };
    expect(federatedBody.scopes).toEqual(['self']);

    // Fail-closed context is visible over the transport too.
    const denied = await client.callTool({
      name: 'smartware_ingest',
      arguments: {
        actor_id: ownerId,
        source_id: 'src_ghost',
        scope: 'self',
        cursor: 'c1',
        operation_id: `op_${ulid()}`,
        items: [],
      },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(textOf(denied))).toMatchObject({ error: 'source_unregistered' });
  });
});
