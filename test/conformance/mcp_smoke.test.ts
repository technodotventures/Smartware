// MCP transport conformance — exercise the real stdio server.

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
  });
});
