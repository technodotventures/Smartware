#!/usr/bin/env node
// Smartware MCP executable — lifecycle only; protocol behavior lives in Core.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { getDataDir } from './config.js';
import { SmartwareCore } from './core.js';
import { createSmartwareMcpServer } from './mcp.js';

async function start(): Promise<void> {
  const core = await SmartwareCore.open({ dataDir: getDataDir() });
  const server = createSmartwareMcpServer(core);
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    await server.close();
    core.close();
  };
  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  await server.connect(transport);
  console.error('Smartware MCP server started');
}

start().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
