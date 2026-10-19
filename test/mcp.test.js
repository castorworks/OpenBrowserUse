import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../server.js';

const port = 14418, origin = `http://127.0.0.1:${port}`, deniedPort = 14419;
let server, denied, dataDir;

async function connect(extraEnv = {}) {
  const client = new Client({ name: 'obu-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['bin/mcp.js'], stderr: 'pipe',
    env: { ...process.env, BROWSER_HEADLESS: '1', OBU_WORKBENCH_ORIGIN: origin, OBU_DATA_DIR: dataDir, ...extraEnv },
  });
  await client.connect(transport);
  return client;
}
const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'obu-mcp-'));
  await writeFile(join(dataDir, 'permissions.json'), JSON.stringify({ sites: { [`127.0.0.1:${deniedPort}`]: { decision: 'deny' } } }));
  ({ app: server } = createApp({ port, browserOptions: { headless: true }, env: {}, dataDir }));
  server = await new Promise(r => { const s = server.listen(port, '127.0.0.1', () => r(s)); });
  denied = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>denied</title>'); });
  await new Promise(r => denied.listen(deniedPort, '127.0.0.1', r));
});
after(async () => {
  await Promise.all([server, denied].map(s => new Promise(r => s.close(r))));
  await rm(dataDir, { recursive: true, force: true });
});

test('MCP server exposes browser tools over stdio and drives a real browser', async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    for (const name of ['read_page', 'find', 'computer', 'navigate', 'tabs', 'form_input', 'javascript']) assert.ok(names.includes(name), name);
    assert.ok(!names.includes('ask_user'));
    assert.equal(tools.find(t => t.name === 'computer').inputSchema.type, 'object');

    assert.match(text(await client.callTool({ name: 'navigate', arguments: { url: `${origin}/demo` } })), /演示商店/);
    const tree = text(await client.callTool({ name: 'read_page', arguments: {} }));
    const ref = label => new RegExp(`"[^"]*${label}[^"]*" \\[(ref_\\d+)\\]`).exec(tree)[1];
    assert.ok(!(await client.callTool({ name: 'form_input', arguments: { ref: ref('产品关键词'), value: '键盘' } })).isError);
    assert.ok(!(await client.callTool({ name: 'computer', arguments: { action: 'left_click', ref: ref('搜索产品') } })).isError);
    assert.match(text(await client.callTool({ name: 'get_page_text', arguments: {} })), /搜索结果：键盘 · 1 件/);

    const shot = await client.callTool({ name: 'computer', arguments: { action: 'screenshot' } });
    const image = shot.content.find(c => c.type === 'image');
    assert.equal(image.mimeType, 'image/jpeg'); assert.ok(image.data.length > 1000);

    const own = await client.callTool({ name: 'navigate', arguments: { url: `${origin}/api/state` } });
    assert.ok(!own.isError, text(own));
    const deniedSite = await client.callTool({ name: 'navigate', arguments: { url: `http://127.0.0.1:${deniedPort}/` } });
    assert.ok(!deniedSite.isError, text(deniedSite));
    const js = await client.callTool({ name: 'javascript', arguments: { code: 'return document.title' } });
    assert.ok(!js.isError, text(js)); assert.match(text(js), /denied/);
    const bad = await client.callTool({ name: 'computer', arguments: { action: 'left_click', coordinate: [99999, 1] } });
    assert.ok(bad.isError);
  } finally { await client.close(); }
});

test('javascript runs even when the legacy flag is disabled', async () => {
  const client = await connect({ MCP_ALLOW_JAVASCRIPT: '0' });
  try {
    await client.callTool({ name: 'navigate', arguments: { url: `${origin}/demo` } });
    const js = await client.callTool({ name: 'javascript', arguments: { code: 'return document.title' } });
    assert.ok(!js.isError, text(js)); assert.match(text(js), /演示商店/);
  } finally { await client.close(); }
});
