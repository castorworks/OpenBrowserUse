import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrowserSession } from './browser/session.js';
import { TOOLS, jsonSchema, parseInput } from './tools/index.js';
import { describeCall } from './agent.js';
import { authorize } from './permissions/policy.js';
import { PermissionStore } from './permissions/store.js';
import { DEFAULT_BLOCKED_SITES } from './permissions/rules.js';
import { dataURLParts } from './providers/base.js';

// ask_user needs the workbench; the calling agent talks to its user itself.
const MCP_TOOLS = TOOLS.filter(t => t.name !== 'ask_user');

export function sessionOptionsFromEnv(env = process.env) {
  return {
    // The workbench port stays unreachable; its /demo pages remain allowed.
    demoOrigin: env.OBU_WORKBENCH_ORIGIN || `http://127.0.0.1:${env.PORT || 4318}`,
    headless: env.BROWSER_HEADLESS === '1',
    mode: ['persistent', 'cdp'].includes(env.BROWSER_MODE) ? env.BROWSER_MODE : 'ephemeral',
    cdpURL: env.BROWSER_CDP_URL || 'http://127.0.0.1:9222',
    profileDir: env.BROWSER_PROFILE_DIR || undefined,
    policy: { allowLocalhost: env.BROWSER_ALLOW_LOCALHOST !== '0', allowPrivateNetwork: env.BROWSER_ALLOW_PRIVATE === '1' },
  };
}

/**
 * Browser tools over MCP for coding agents (Claude Code, Codex).
 * No human sits behind this server, so it runs in "skip" mode: the hard limits
 * (protected sites, denied sites, password/payment fields) still apply, and
 * javascript only runs when MCP_ALLOW_JAVASCRIPT=1.
 */
export function createMcpServer({ env = process.env, log = () => {} } = {}) {
  const server = new Server({ name: 'openbrowseruse', version: '0.2.0' }, { capabilities: { tools: {} } });
  const store = new PermissionStore(env.OBU_DATA_DIR ? { dir: env.OBU_DATA_DIR } : {});
  const options = sessionOptionsFromEnv(env);
  const allowJavascript = env.MCP_ALLOW_JAVASCRIPT === '1';
  let session = null, opening = null;

  async function browser() {
    if (session && session.pages().length) return session;
    if (!opening) {
      opening = (async () => {
        await session?.close();
        const s = new BrowserSession(options);
        await s.open();
        session = s;
        return s;
      })().finally(() => { opening = null; });
    }
    return opening;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t) })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const fail = text => ({ content: [{ type: 'text', text }], isError: true });
    const tool = MCP_TOOLS.find(t => t.name === params.name);
    if (!tool) return fail(`没有名为 ${params.name} 的工具。`);
    let input;
    try { input = parseInput(tool, params.arguments); } catch (error) { return fail(error.message); }
    try {
      const b = await browser();
      const summary = describeCall(tool.name, input);
      const verdict = await authorize({ mode: 'skip', tool, input, browser: b, store, taskSites: new Set(), blockedSites: DEFAULT_BLOCKED_SITES, review: async () => ({ decision: 'ask', reason: '' }), userMessages: [], summary });
      if (verdict.action === 'block') { log(`blocked ${summary}: ${verdict.reason}`); return fail(`已阻止：${verdict.reason}`); }
      if (verdict.action === 'ask' && !(tool.name === 'javascript' && allowJavascript)) return fail(tool.name === 'javascript' ? 'javascript 工具未启用。需要时用 MCP_ALLOW_JAVASCRIPT=1 启动服务器。' : `需要用户确认：${verdict.reason}`);
      const out = await tool.run(input, { browser: b });
      const image = dataURLParts(out.image);
      return { content: [{ type: 'text', text: out.text || '(empty)' }, ...(image ? [{ type: 'image', data: image.data, mimeType: image.mediaType }] : [])] };
    } catch (error) {
      return fail(error.message.split('\n')[0].slice(0, 1000));
    }
  });

  server.closeBrowser = async () => { const s = session; session = null; await s?.close(); };
  return server;
}
