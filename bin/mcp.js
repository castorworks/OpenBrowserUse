#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../lib/mcp.js';

// stdout carries the protocol; diagnostics go to stderr.
const server = createMcpServer({ log: message => console.error(`[openbrowseruse] ${message}`) });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await server.closeBrowser().catch(() => {});
  process.exit(0);
}
server.onclose = shutdown;
process.stdin.on('end', shutdown);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
await server.connect(new StdioServerTransport());
