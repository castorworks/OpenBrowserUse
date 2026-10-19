import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { Agent } from '../lib/agent.js';
import { apiEndpoint, OpenAIProvider } from '../lib/providers/openai.js';
import { AnthropicProvider } from '../lib/providers/anthropic.js';
import { allowedURL, localCDPURL } from '../lib/browser/url.js';
import { detectChannel, launchChannel } from '../lib/browser/channel.js';
import { BrowserSession } from '../lib/browser/session.js';
import { TOOLS, getTool, jsonSchema, parseInput } from '../lib/tools/index.js';
import { normalizeKey } from '../lib/tools/computer.js';
import { authorize } from '../lib/permissions/policy.js';
import { PermissionStore, siteOf } from '../lib/permissions/store.js';
import { isBlockedSite } from '../lib/permissions/rules.js';
import { parseVerdict } from '../lib/permissions/reviewer.js';

const port = 14318, origin = `http://127.0.0.1:${port}`, openaiPort = 14319, anthropicPort = 14320, sitePort = 14321;
const dataDir = mkdtempSync(join(tmpdir(), 'obu-data-'));
const { app, agent } = createApp({ port, browserOptions: { headless: true }, env: {}, dataDir });
let server, openaiServer, anthropicServer, siteServer, browser, mockMode = 'normal', reviewerVerdict = 'safe', reviewerCalls = 0, requests = 0, requestAuth, lastOpenAIBody, anthropicRequests = [];
const headers = { 'Content-Type': 'application/json', 'X-Browser-Agent': '1' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 25000) { const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error(`Timed out. State: ${agent.task?.status}, ${agent.task?.result}, ${JSON.stringify(agent.task?.events.slice(-3))}`); await sleep(60); } }
async function post(path, body) { const response = await fetch(origin + '/api/' + path, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
async function configureOpenAI() { return post('config', { provider: 'openai', baseURL: `http://127.0.0.1:${openaiPort}/v1`, model: 'test-model', apiKey: 'test-secret', vision: false }); }
async function start(extra = {}) { return post('tasks', { goal: '搜索键盘并读取价格', startURL: origin + '/demo', maxSteps: 20, permissionMode: 'ask', ...extra }); }
async function settle() { if (agent.busy) { try { agent.control('stop'); } catch {} } await agent.promise; if (agent.browser) { agent.control('stop'); await until(() => !agent.browser); } }

// Scripted OpenAI-compatible model: read_page → form_input → click → get_page_text → answer.
function openaiReply(body) {
  const msgs = body.messages;
  const called = msgs.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(c => c.function.name);
  const toolText = msgs.filter(m => m.role === 'tool').map(m => m.content).join('\n');
  const last = msgs.at(-1);
  const ref = label => new RegExp(`"[^"]*${label}[^"]*" \\[(ref_\\d+)\\]`).exec(toolText)?.[1];
  const call = (name, args) => ({ tool_calls: [{ id: `call_${msgs.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (last.role === 'user' && JSON.stringify(last.content).includes('再确认')) return { content: '确认：价格仍是 ¥ 399。' };
  if (mockMode === 'nav') return called.includes('navigate') ? { content: `导航结果：${msgs.at(-1).content}` } : call('navigate', { url: `http://127.0.0.1:${sitePort}/` });
  const answered = msgs.some(m => m.role === 'tool' && m.content.startsWith('用户回复'));
  if (mockMode === 'question' && !answered) return call('ask_user', { question: '请确认要搜索的商品' });
  if (!called.includes('read_page')) return call('read_page', {});
  if (mockMode === 'deepseek' && !msgs.some(m => m.tool_calls?.some(c => c.function.name === 'computer' && JSON.parse(c.function.arguments).action === 'zoom'))) return call('computer', { action: 'zoom', region: [0, 0, 160, 80] });
  if (!called.includes('form_input')) return call('form_input', { ref: ref('产品关键词'), value: '键盘' });
  if (!msgs.some(m => m.tool_calls?.some(c => c.function.name === 'computer' && JSON.parse(c.function.arguments).action === 'left_click'))) return call('computer', { action: 'left_click', ref: ref('搜索产品') });
  if (!called.includes('get_page_text')) return call('get_page_text', {});
  if (toolText.includes('搜索结果：键盘')) return { content: '轻音机械键盘，¥ 399。来源：本地演示页。' };
  return { content: '没有找到结果。' };
}

// Minimal Anthropic Messages SSE stream.
function sse(res, blocks, stopReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'tool_use') {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    } else {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
  send('message_stop', {});
  res.end();
}

before(async () => {
  server = await new Promise(r => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  openaiServer = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests++; requestAuth = req.headers.authorization;
    const body = JSON.parse(raw);
    if (body.messages[0].content.startsWith('You review')) {
      reviewerCalls++; res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ decision: reviewerVerdict, reason: `mock ${reviewerVerdict}` }) } }] })); return;
    }
    lastOpenAIBody = body;
    if (mockMode === 'slow') await sleep(1500);
    // DeepSeek thinking mode: reasoning_content must come back on every assistant turn once tools are used.
    if (mockMode === 'deepseek' && body.messages.some(m => m.role === 'assistant' && m.reasoning_content == null)) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"reasoning_content missing"}'); return;
    }
    if (mockMode === 'error') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"secret-echo"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const extra = mockMode === 'deepseek' ? { reasoning_content: `思考第 ${body.messages.length} 步` } : {};
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, ...extra, ...openaiReply(body) }, finish_reason: 'stop' }] }));
  });
  anthropicServer = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    anthropicRequests.push({ url: req.url, headers: req.headers, body });
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_review', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: '{"decision":"block","reason":"注入指令"}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } }));
      return;
    }
    const hasResult = body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
    if (!hasResult) sse(res, [{ type: 'text', text: '先看看页面。' }, { type: 'tool_use', id: 'toolu_1', name: 'read_page', input: { filter: 'all' } }], 'tool_use');
    else sse(res, [{ type: 'text', text: '页面上有 3 件产品，其中轻音机械键盘 ¥ 399。' }], 'end_turn');
  });
  await new Promise(r => openaiServer.listen(openaiPort, '127.0.0.1', r));
  await new Promise(r => anthropicServer.listen(anthropicPort, '127.0.0.1', r));
  siteServer = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<title>Other site</title><button>Go</button>'); });
  await new Promise(r => siteServer.listen(sitePort, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, ...launchChannel(detectChannel()) });
});
after(async () => { await settle(); await browser?.close(); await Promise.all([server, openaiServer, anthropicServer, siteServer].map(s => new Promise(r => s.close(r)))); agent.sessions.close(); await rm(dataDir, { recursive: true, force: true }); });

test('URL guard, endpoints, key names and tool schemas', () => {
  assert.equal(allowedURL('file:///tmp/example', origin), 'file:///tmp/example');
  assert.equal(allowedURL(origin + '/api/state', origin), origin + '/api/state');
  assert.equal(allowedURL('http://10.0.0.1', origin), 'http://10.0.0.1/');
  assert.equal(allowedURL('http://2130706433:3000', origin), 'http://127.0.0.1:3000/', 'localhost dev servers allowed by default');
  assert.equal(allowedURL('http://localhost:3000', origin, { allowLocalhost: false }), 'http://localhost:3000/');
  for (const own of [`http://localhost:${port}/api/state`, `http://0.0.0.0:${port}/api/state`, `http://[::1]:${port}/`, `http://127.0.0.2:${port}/demo`]) assert.equal(allowedURL(own, origin), new URL(own).href);
  assert.equal(allowedURL('http://192.168.1.5/', origin, { allowLocalhost: true, allowPrivateNetwork: true }), 'http://192.168.1.5/');
  assert.equal(localCDPURL('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222');
  assert.equal(localCDPURL('http://example.com:9222'), 'http://example.com:9222');
  assert.equal(localCDPURL('https://example.com'), 'https://example.com');
  assert.equal(allowedURL(origin + '/demo', origin), origin + '/demo');
  assert.equal(apiEndpoint('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
  assert.throws(() => apiEndpoint('http://example.com/v1'));
  assert.equal(normalizeKey('ctrl+a'), 'Control+a'); assert.equal(normalizeKey('cmd+shift+T'), 'Meta+Shift+T'); assert.equal(normalizeKey('enter'), 'Enter');
  for (const tool of TOOLS) { const schema = jsonSchema(tool); assert.equal(schema.type, 'object', tool.name); assert.ok(!('$schema' in schema)); }
  assert.throws(() => parseInput(getTool('computer'), { action: 'left_click', coordinate: [5000, 1] }));
  assert.throws(() => parseInput(getTool('form_input'), { ref: '#query', value: 'x' }));
  assert.equal(detectChannel({ BROWSER_CHANNEL: 'chromium' }), 'chromium');
});

test('Anthropic request: adaptive thinking, effort, caching, and fallbacks only on the first-party API', () => {
  const tools = [{ name: 'read_page', description: 'd', input_schema: { type: 'object' } }];
  const direct = new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', effort: 'high' }, { system: 's', tools }).request();
  assert.deepEqual(direct.params.thinking, { type: 'adaptive', display: 'updates' });
  assert.equal(direct.params.output_config.effort, 'high');
  assert.deepEqual(direct.params.cache_control, { type: 'ephemeral' });
  assert.equal(direct.params.fallbacks, 'default');
  assert.deepEqual(direct.betas, ['thinking-display-updates-2026-08-18', 'server-side-fallback-2026-07-01']);
  const proxied = new AnthropicProvider({ apiKey: 'k', baseURL: 'https://proxy.example', model: 'claude-opus-5-5' }, { system: 's', tools }).request();
  assert.equal(proxied.params.fallbacks, undefined);
  const old = new AnthropicProvider({ apiKey: 'k', model: 'claude-3-haiku-x' }, { system: 's', tools }).request();
  assert.equal(old.params.thinking, undefined); assert.equal(old.params.output_config, undefined);
});

test('OpenAI provider keeps only the latest screenshots', () => {
  const p = new OpenAIProvider({ baseURL: 'https://example.com/v1', model: 'm', vision: true }, { system: 's', tools: [] });
  for (let i = 0; i < 4; i++) { p.addToolResults([{ id: `c${i}`, text: 'shot', image: 'data:image/jpeg;base64,AAAA' }]); p.flush(); }
  const count = msgs => (JSON.stringify(msgs).match(/"type":"image_url"/g) || []).length;
  assert.equal(count(p.outgoing()), 2);
  assert.equal(count(p.messages), 4, 'stored history is not edited');
});

test('DeepSeek vision defaults on, supports opt-out, and does not enable generic providers', () => {
  for (const [provider, vision, expected] of [['deepseek', undefined, true], ['deepseek', false, false], ['openai', undefined, false]]) {
    const p = new OpenAIProvider({ provider, vision, baseURL: 'https://example.com', model: 'm' }, { system: 's', tools: [] });
    p.addToolResults([{ id: 'shot', text: 'screenshot', image: 'data:image/png;base64,AAAA' }]); p.flush();
    assert.equal(p.outgoing().some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url')), expected);
  }
});

test('read_page reaches iframes and shadow DOM; refs stay stable and act across frames', async () => {
  const session = new BrowserSession({ demoOrigin: origin, headless: true });
  await session.open();
  try {
    await session.current().setContent(`
      <h1>Fixture</h1><button id="b" onclick="this.textContent='Clicked'">Main button</button>
      <x-card></x-card>
      <iframe srcdoc="<button onclick=&quot;this.textContent='Frame clicked'&quot;>Frame button</button>"></iframe>
      <script>customElements.define('x-card', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow button</button>'; } });</script>`);
    await session.current().waitForFunction(() => document.querySelector('iframe').contentDocument?.querySelector('button'));
    const text = (await getTool('read_page').run({ filter: 'interactive', max_chars: 20000 }, { browser: session })).text;
    for (const label of ['Main button', 'Shadow button', 'Frame button']) assert.match(text, new RegExp(`"${label}" \\[ref_\\d+\\]`));
    const refOf = label => new RegExp(`"${label}" \\[(ref_\\d+)\\]`).exec(text)[1];
    const again = (await getTool('read_page').run({ filter: 'all', max_chars: 20000 }, { browser: session })).text;
    assert.ok(again.includes(`[${refOf('Main button')}]`), 'refs are stable across reads');
    assert.match(again, /heading "Fixture"/);
    await getTool('computer').run({ action: 'left_click', ref: refOf('Frame button') }, { browser: session });
    assert.equal(await session.current().frames()[1].locator('button').textContent(), 'Frame clicked');
    const found = (await getTool('find').run({ query: 'main button' }, { browser: session })).text;
    assert.match(found, new RegExp(refOf('Main button')));
    const box = await session.current().locator('#b').boundingBox();
    await getTool('computer').run({ action: 'left_click', coordinate: [box.x + 5, box.y + 5] }, { browser: session });
    assert.equal(await session.current().locator('#b').textContent(), 'Clicked');
    const shot = await getTool('computer').run({ action: 'screenshot' }, { browser: session });
    assert.match(shot.image, /^data:image\/jpeg;base64,/);
    await session.current().setContent('<input type="password" id="p">');
    const pw = /ref_\d+/.exec((await getTool('read_page').run({ filter: 'interactive', max_chars: 2000 }, { browser: session })).text)[0];
    await getTool('form_input').run({ ref: pw, value: 'x' }, { browser: session });
    await getTool('computer').run({ action: 'left_click', ref: pw }, { browser: session });
    await getTool('computer').run({ action: 'type', text: 'y' }, { browser: session });
    await getTool('computer').run({ action: 'type', ref: pw, text: 'z' }, { browser: session });
    assert.equal(await session.current().locator('#p').inputValue(), 'xyz');
    await session.current().setContent('<input type="file" id="upload">');
    const uploadRef = /ref_\d+/.exec((await getTool('read_page').run({ filter: 'interactive', max_chars: 2000 }, { browser: session })).text)[0];
    await getTool('form_input').run({ ref: uploadRef, value: new URL('../package.json', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1') }, { browser: session });
    assert.equal(await session.current().locator('#upload').evaluate(el => el.files[0].name), 'package.json');
  } finally { await session.close(); }
});

test('permission policy: modes, site approval, rules, blocklist and reviewer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-perm-'));
  const store = new PermissionStore({ dir });
  let target = { label: 'Search', tag: 'button' }, reviews = 0, verdict = 'safe';
  let pageURL = 'https://shop.example/item';
  const browser = { current: () => ({ url: () => pageURL }), describeTarget: async () => ({ url: pageURL, ...target }) };
  const run = (mode, name, input, extra = {}) => authorize({ mode, tool: getTool(name), input, browser, store, taskSites: new Set(['shop.example']), review: async () => { reviews++; return { decision: verdict, reason: verdict }; }, userMessages: ['买个键盘'], summary: name, ...extra });
  const click = { action: 'left_click', ref: 'ref_1' };
  try {
    assert.equal((await run('ask', 'read_page', { filter: 'all', max_chars: 1000 })).action, 'run');
    assert.equal((await run('ask', 'computer', { action: 'screenshot' })).action, 'run');
    const nav = await run('ask', 'navigate', { url: 'https://www.other.example/x' });
    assert.equal(nav.action, 'ask'); assert.equal(nav.site, 'other.example'); assert.ok(nav.needsSite);
    assert.equal((await run('skip', 'navigate', { url: 'https://other.example/' })).action, 'run');
    assert.equal((await run('ask', 'navigate', { url: 'back' })).action, 'run');
    assert.equal((await run('ask', 'computer', click)).action, 'ask');
    assert.equal((await run('skip', 'computer', click)).action, 'run');
    assert.equal((await run('skip', 'javascript', { code: 'return 1' })).action, 'run', 'javascript runs directly');
    // auto: reviewer decides plain actions on allowed sites
    assert.equal((await run('auto', 'computer', click)).action, 'run'); assert.equal(reviews, 1);
    verdict = 'block'; assert.equal((await run('auto', 'computer', click)).action, 'block');
    verdict = 'ask'; assert.equal((await run('auto', 'computer', click)).source, 'reviewer');
    // rules run before the reviewer
    target = { label: '立即购买', tag: 'button', submit: true, inForm: true };
    const buy = await run('auto', 'computer', click); assert.equal(buy.action, 'ask'); assert.equal(buy.source, 'rule'); assert.equal(reviews, 3);
    assert.equal((await run('skip', 'computer', click)).action, 'run', 'skip ignores soft rules');
    target = { label: 'Continue', tag: 'button', submit: true, inForm: true, crossOriginForm: true, formOrigin: 'https://evil.example' };
    assert.match((await run('auto', 'computer', click)).reason, /evil\.example/);
    target = { label: '密码', type: 'password', password: true };
    assert.equal((await run('skip', 'form_input', { ref: 'ref_1', value: 'x' })).action, 'run');
    target = { label: 'Card', name: 'cardnumber', autocomplete: 'cc-number' };
    assert.equal((await run('skip', 'form_input', { ref: 'ref_1', value: '4111' })).action, 'run');
    // new site in auto asks for the site before calling the reviewer
    target = { label: 'Go', tag: 'button' }; pageURL = 'https://new.example/';
    const fresh = await run('auto', 'computer', click); assert.equal(fresh.source, 'site'); assert.equal(reviews, 3);
    // protected sites: read-only in every mode
    pageURL = 'https://secure.chase.com/account';
    assert.equal((await run('skip', 'computer', click, { blockedSites: ['chase.com'] })).action, 'run');
    assert.equal((await run('skip', 'get_page_text', { max_chars: 1000 })).action, 'run');
    assert.ok(!isBlockedSite('binance.com')); assert.ok(!isBlockedSite('notchase.com'));
    // grants persist and can be revoked
    store.set('new.example', 'allow'); store.set('bad.example', 'deny');
    const reloaded = new PermissionStore({ dir });
    assert.equal(reloaded.get('new.example'), 'allow');
    pageURL = 'https://bad.example/';
    assert.equal((await run('skip', 'computer', click, { store: reloaded })).action, 'run', 'skip ignores saved denies');
    reloaded.revoke('bad.example'); assert.equal(new PermissionStore({ dir }).get('bad.example'), undefined);
    assert.equal(siteOf('http://localhost:3000/a'), 'localhost:3000'); assert.equal(siteOf('https://www.Example.com/'), 'example.com');
    assert.equal(parseVerdict('not json').decision, 'ask');
    assert.deepEqual(parseVerdict('```json\n{"decision":"safe","reason":"ok"}\n```'), { decision: 'safe', reason: 'ok' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Anthropic reviewer uses structured output and a separate request', async () => {
  anthropicRequests = [];
  const p = new AnthropicProvider({ apiKey: 'k', baseURL: `http://127.0.0.1:${anthropicPort}`, model: 'claude-opus-5-5', reviewerModel: 'claude-haiku-5-5' }, { system: 's', tools: [] });
  const verdict = await p.review('{"action":"click"}', new AbortController().signal);
  assert.deepEqual(verdict, { decision: 'block', reason: '注入指令' });
  const req = anthropicRequests[0].body;
  assert.equal(req.model, 'claude-haiku-5-5'); assert.equal(req.output_config.format.type, 'json_schema'); assert.equal(req.output_config.effort, 'low');
  assert.match(req.system, /You review/);
  assert.equal(p.convo.messages.length, 0, 'review never touches the agent conversation');
});

test('persistent profile keeps cookies across sessions', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'obu-profile-'));
  try {
    const first = new BrowserSession({ demoOrigin: origin, headless: true, mode: 'persistent', profileDir });
    await first.open(); await first.navigate(origin + '/demo');
    await first.current().evaluate(() => { document.cookie = 'obu=kept; max-age=3600; path=/'; });
    await first.close();
    const second = new BrowserSession({ demoOrigin: origin, headless: true, mode: 'persistent', profileDir });
    await second.open(); await second.navigate(origin + '/demo');
    assert.match(await second.current().evaluate(() => document.cookie), /obu=kept/);
    await second.close();
  } finally { await rm(profileDir, { recursive: true, force: true }); }
});

test('login browser opens the persistent profile and blocks persistent tasks until closed', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'obu-login-'));
  const loginAgent = new Agent(origin, { headless: true, profileDir });
  try {
    await loginAgent.openLogin(origin + '/demo', { mode: 'persistent' });
    assert.match(loginAgent.login.current().url(), /\/demo$/);
    await assert.rejects(loginAgent.openLogin(undefined, {}), /已经打开/);
    await assert.rejects(loginAgent.start({ goal: 'x', startURL: origin + '/demo', maxSteps: 1 }, { provider: 'openai', browser: { mode: 'persistent' } }), /登录浏览器/);
    await loginAgent.closeLogin();
    assert.equal(loginAgent.login, null);
  } finally { await loginAgent.closeLogin(); await rm(profileDir, { recursive: true, force: true }); }
});

test('CDP attach uses only its own tabs and leaves the external browser running', async () => {
  const cdpPort = 14330;
  const external = await chromium.launch({ headless: true, ...launchChannel(detectChannel()), args: [`--remote-debugging-port=${cdpPort}`] });
  try {
    const userPage = await external.newPage(); await userPage.setContent('<title>user tab</title><p>mine</p>');
    const session = new BrowserSession({ demoOrigin: origin, headless: true, mode: 'cdp', cdpURL: `http://127.0.0.1:${cdpPort}` });
    await session.open(); await session.navigate(origin + '/demo');
    assert.equal(session.pages().length, 1);
    assert.ok(!session.tabs().some(t => t.url === userPage.url() && t.url !== session.current().url()));
    assert.match(await getTool('read_page').run({ filter: 'interactive', max_chars: 20000 }, { browser: session }).then(r => r.text), /搜索产品/);
    await session.navigate(`http://localhost:${port}/api/state`);
    assert.equal(session.current().url(), `http://localhost:${port}/api/state`);
    await session.close();
    assert.ok(external.isConnected(), 'external browser still running');
    assert.equal(userPage.isClosed(), false);
    assert.equal(await userPage.title(), 'user tab');
  } finally { await external.close(); }
});

test('API blocks foreign origins, validates input and never returns a configured key', async () => {
  const foreign = await fetch(origin + '/api/config', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
  assert.equal((await post('tasks', { goal: '' })).status, 400);
  await configureOpenAI();
  assert.ok(!(await (await fetch(origin + '/api/state')).text()).includes('test-secret'));
  const changed = await post('config', { provider: 'openai', baseURL: `http://127.0.0.1:${openaiPort}/other`, model: 'test', apiKey: '' });
  assert.equal(changed.body.hasKey, false);
  await configureOpenAI();
  assert.equal((await post('browser', { mode: 'cdp', cdpURL: 'http://example.com:9222', allowLocalhost: true, allowPrivateNetwork: false })).status, 200);
  const browserCfg = await post('browser', { mode: 'ephemeral', cdpURL: '', allowLocalhost: false, allowPrivateNetwork: false });
  assert.equal(browserCfg.body.browser.allowLocalhost, false);
  const unrestricted = await start({ startURL: origin + '/demo', permissionMode: undefined });
  assert.equal(unrestricted.status, 202);
  await until(() => !agent.busy);
  assert.equal(agent.task.permissionMode, 'skip');
  assert.match(agent.task.result, /399/);
  await settle();
  await post('browser', { mode: 'ephemeral', cdpURL: '', allowLocalhost: true, allowPrivateNetwork: false });
  const switched = await post('config', { provider: 'anthropic', model: 'claude-opus-5-5' });
  assert.equal(switched.body.hasKey, false, 'switching provider drops the key');
  await configureOpenAI();
});

test('OpenAI tool loop: mutating tools wait for approval, answer arrives, follow-up reuses the browser', async () => {
  mockMode = 'normal'; await configureOpenAI(); await start();
  await until(() => agent.task.status === 'approval');
  assert.equal(agent.task.pending.tool, 'form_input');
  assert.match(agent.task.pending.target, /产品关键词/);
  assert.equal(await agent.browser.current().locator('#query').inputValue(), '');
  assert.equal((await start()).status, 409);
  assert.equal((await configureOpenAI()).status, 409);
  await post('control', { command: 'approve' });
  await until(() => agent.task.status === 'approval' && agent.task.pending.tool === 'computer');
  assert.equal(await agent.browser.current().locator('#query').inputValue(), '键盘');
  await post('control', { command: 'approve' });
  await until(() => !agent.busy);
  assert.equal(agent.task.status, 'done'); assert.match(agent.task.result, /399/);
  assert.equal(requestAuth, 'Bearer test-secret');
  assert.ok(lastOpenAIBody.tools.some(t => t.function.name === 'computer'));
  assert.ok(agent.state().sessionOpen);
  assert.equal((await post('messages', { text: '再确认一次价格' })).status, 202);
  await until(() => !agent.busy);
  assert.match(agent.task.result, /确认/);
  await post('control', { command: 'stop' }); await until(() => agent.task.status === 'stopped');
  assert.equal(agent.browser, null);
});

test('auto mode runs reviewer-approved actions without prompts and records an audit trail', async () => {
  mockMode = 'normal'; reviewerVerdict = 'safe'; reviewerCalls = 0; await configureOpenAI();
  await start({ permissionMode: 'auto' }); await until(() => !agent.busy);
  assert.equal(agent.task.status, 'done'); assert.match(agent.task.result, /399/);
  assert.equal(reviewerCalls, 2);
  assert.deepEqual(agent.task.audit.map(a => [a.tool, a.decision, a.source]), [['form_input', 'run', 'reviewer'], ['computer', 'run', 'reviewer']]);
  await settle();
  reviewerVerdict = 'block';
  await start({ permissionMode: 'auto' }); await until(() => !agent.busy);
  assert.ok(agent.task.audit.every(a => a.decision === 'blocked' && a.source === 'reviewer'));
  assert.equal(await agent.browser.current().locator('#query').inputValue(), '');
  reviewerVerdict = 'safe'; await settle();
});

test('site approval: always-allow persists, revoke clears it, deny blocks later tasks', async () => {
  mockMode = 'nav'; await configureOpenAI();
  const other = `127.0.0.1:${sitePort}`;
  await start(); await until(() => agent.task.status === 'approval');
  assert.equal(agent.task.pending.site, other); assert.ok(agent.task.pending.needsSite);
  await post('control', { command: 'approve_site' }); await until(() => !agent.busy);
  assert.match(agent.task.result, /Other site/);
  assert.ok((await (await fetch(origin + '/api/state')).json()).permissions.some(p => p.site === other && p.decision === 'allow'));
  await settle();
  await start(); await until(() => !agent.busy);
  assert.equal(agent.task.events.filter(e => e.kind === 'approval').length, 0, 'granted site needs no prompt');
  await settle();
  assert.deepEqual((await post('permissions', { action: 'revoke', site: other })).body.permissions, []);
  await start(); await until(() => agent.task.status === 'approval');
  await post('control', { command: 'deny_site' }); await until(() => !agent.busy);
  await settle();
  await start(); await until(() => !agent.busy);
  assert.ok(agent.task.audit.some(a => a.decision === 'blocked' && a.source === 'site'));
  await post('permissions', { action: 'revoke', site: other });
  mockMode = 'normal'; await settle();
});

// Reads server-sent events until `want` returns true for the collected events (or times out).
async function readEvents(want, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const res = await fetch(origin + '/api/events', { signal: controller.signal });
  const reader = res.body.getReader(); const decoder = new TextDecoder();
  const events = []; let buffer = '';
  try {
    while (!want(events)) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        const type = /^event: (.+)$/m.exec(chunk)?.[1]; const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (type) events.push({ type, data });
      }
    }
  } finally { clearTimeout(timer); controller.abort(); }
  return events;
}

test('live updates: SSE pushes state changes and screencast frames; messages steer a running task', async () => {
  mockMode = 'slow'; await configureOpenAI();
  const streamed = readEvents(events => events.some(e => e.type === 'frame') && events.some(e => e.type === 'state' && JSON.parse(e.data).task?.events.some(x => x.kind === 'user' && x.message === '顺便看看价格')));
  await start();
  await until(() => agent.task?.status === 'running' && agent.browser);
  assert.equal((await post('messages', { text: '顺便看看价格' })).status, 202);
  const events = await streamed;
  const frame = events.find(e => e.type === 'frame').data;
  assert.ok(Buffer.from(frame, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'frame is a JPEG');
  await until(() => agent.task.status === 'approval');
  assert.ok(JSON.stringify(lastOpenAIBody.messages).includes('[用户在执行过程中补充] 顺便看看价格'), 'steering message reaches the model');
  await settle(); mockMode = 'normal';
});

test('sessions are saved with tool cards and can be listed, replayed and deleted', async () => {
  mockMode = 'normal'; await configureOpenAI();
  await start({ permissionMode: 'skip' }); await until(() => !agent.busy);
  const id = agent.task.id;
  await settle();
  const { sessions } = await (await fetch(origin + '/api/sessions')).json();
  assert.equal(sessions[0].id, id); assert.equal(sessions[0].status, 'stopped');
  const saved = await (await fetch(`${origin}/api/sessions/${id}`)).json();
  const card = saved.events.find(e => e.kind === 'action' && e.tool === 'get_page_text');
  assert.equal(card.state, 'ok'); assert.match(card.output, /搜索结果：键盘/);
  assert.match(saved.result, /399/);
  assert.equal(saved.snapshot.screenshot, undefined, 'screenshots are not stored');
  assert.equal((await fetch(`${origin}/api/sessions/00000000-0000-4000-8000-000000000000`)).status, 404);
  const after = await post('sessions/delete', { id });
  assert.ok(!after.body.sessions.some(s => s.id === id));
});

test('DeepSeek: real image crops reach the API with original detail and reasoning_content preserved', async () => {
  const saved = await post('config', { provider: 'deepseek', baseURL: `http://127.0.0.1:${openaiPort}`, model: 'deepseek-flash', apiKey: 'ds-key', effort: 'max' });
  assert.equal(saved.body.provider, 'deepseek');
  assert.equal(saved.body.vision, true);
  const defaults = await post('config', { provider: 'deepseek', model: 'deepseek-flash' });
  assert.equal(defaults.body.baseURL, 'https://api.deepseek.com', 'empty base URL uses the DeepSeek default');
  await post('config', { provider: 'deepseek', baseURL: `http://127.0.0.1:${openaiPort}`, model: 'deepseek-flash', apiKey: 'ds-key', effort: 'max' });
  mockMode = 'deepseek';
  await start({ permissionMode: 'skip' }); await until(() => !agent.busy);
  assert.equal(agent.task.status, 'done', agent.task.result); assert.match(agent.task.result, /399/);
  const images = lastOpenAIBody.messages.filter(m => m.role === 'user').flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url');
  assert.equal(images.length, 1);
  assert.equal(images[0].image_url.detail, 'original');
  assert.match(images[0].image_url.url, /^data:image\/png;base64,/);
  const png = Buffer.from(images[0].image_url.url.split(',')[1], 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 160); assert.equal(png.readUInt32BE(20), 80);
  assert.ok(lastOpenAIBody.messages.filter(m => m.role !== 'user').every(m => !Array.isArray(m.content)), 'images only occur in user messages');
  assert.equal(lastOpenAIBody.model, 'deepseek-flash'); assert.equal(lastOpenAIBody.reasoning_effort, 'max');
  assert.equal(requestAuth, 'Bearer ds-key');
  assert.ok(lastOpenAIBody.messages.filter(m => m.role === 'assistant').every(m => m.reasoning_content));
  assert.ok(agent.task.events.some(e => e.kind === 'note' && e.message.startsWith('思考第')));
  await settle(); mockMode = 'normal'; await configureOpenAI();
});

test('pause cancels pending model response, resume continues, stop ends approval wait', async () => {
  mockMode = 'slow'; const beforeRequests = requests; await start();
  await until(() => requests > beforeRequests);
  await post('control', { command: 'pause' }); await until(() => agent.task.status === 'paused');
  await post('control', { command: 'resume', answer: '我刚看过页面' }); await until(() => agent.task.status === 'approval');
  assert.ok(JSON.stringify(lastOpenAIBody.messages).includes('我刚看过页面'));
  await post('control', { command: 'stop' }); await until(() => !agent.busy);
  assert.equal(agent.task.status, 'stopped');
});

test('ask_user hands off to the person and a rejected action is reported to the model', async () => {
  mockMode = 'question'; await start(); await until(() => agent.task.status === 'waiting_user');
  assert.equal((await post('control', { command: 'resume', answer: '' })).status, 400);
  await post('control', { command: 'resume', answer: '键盘' }); await until(() => agent.task.status === 'approval');
  await post('control', { command: 'reject' }); await until(() => agent.task.history.some(h => h.error === 'rejected'));
  await until(() => requests && JSON.stringify(lastOpenAIBody.messages).includes('用户拒绝了这个动作'));
  await settle();
});

test('model HTTP errors stop after three consecutive failures without leaking the body', async () => {
  mockMode = 'error'; const beforeRequests = requests; await start(); await until(() => !agent.busy);
  assert.equal(agent.task.status, 'failed'); assert.equal(requests - beforeRequests, 3);
  assert.ok(!agent.task.result.includes('secret-echo'));
  await settle();
});

test('Anthropic provider drives the loop through the SDK stream', async () => {
  await post('config', { provider: 'anthropic', baseURL: `http://127.0.0.1:${anthropicPort}`, model: 'claude-opus-5-5', apiKey: 'sk-test', effort: 'medium' });
  anthropicRequests = [];
  await start({ permissionMode: 'skip' }); await until(() => !agent.busy);
  assert.equal(agent.task.status, 'done', agent.task.result); assert.match(agent.task.result, /399/);
  const [first, second] = anthropicRequests;
  assert.match(first.url, /^\/v1\/messages/);
  assert.equal(first.headers['x-api-key'], 'sk-test');
  assert.match(first.headers['anthropic-beta'], /thinking-display-updates-2026-08-18/);
  assert.equal(first.body.model, 'claude-opus-5-5'); assert.equal(first.body.stream, true);
  assert.deepEqual(first.body.output_config, { effort: 'medium' });
  assert.equal(first.body.fallbacks, undefined, 'no fallbacks behind a custom base URL');
  assert.ok(first.body.tools.some(t => t.name === 'read_page' && t.input_schema.type === 'object'));
  const result = second.body.messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result'); assert.equal(result.tool_use_id, 'toolu_1');
  assert.match(result.content[0].text, /搜索产品/);
  // History is append-only: the second request starts with the first request's messages.
  assert.deepEqual(second.body.messages[0], first.body.messages[0]);
  assert.ok(agent.task.events.some(e => e.kind === 'assistant' && e.message.includes('先看看页面')));
  await settle(); await configureOpenAI();
});

test('UI demo runs the tool loop in a real browser without calling a model; layouts fit', async () => {
  agent.task = null;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await page.waitForFunction(() => document.getElementById('connection').textContent === '本地服务已连接');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/workbench.png', fullPage: true });
  const beforeRequests = requests;
  assert.equal(await page.locator('#permission-mode').inputValue(), 'skip');
  await page.locator('#demo').click();
  await until(() => agent.task?.mode === 'demo' && !agent.busy);
  await page.waitForFunction(() => document.getElementById('result').textContent.includes('演示完成'));
  assert.equal(agent.task.status, 'done'); assert.equal(requests, beforeRequests);
  assert.match(agent.task.result, /搜索结果：键盘 · 1 件/);
  assert.equal(await page.locator('#screenshot').isVisible(), true);
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.screenshot({ path: 'artifacts/demo-complete.png', fullPage: true });
  await page.locator('#settings-shortcut').click();
  assert.equal(await page.locator('#drawer').isVisible(), true);
  await page.selectOption('#provider', 'deepseek');
  assert.equal(await page.locator('#base-url').inputValue(), 'https://api.deepseek.com');
  assert.equal(await page.locator('#model').inputValue(), 'deepseek-flash');
  assert.equal(await page.locator('#effort').isVisible(), true); assert.equal(await page.locator('#vision').isVisible(), true);
  assert.equal(await page.locator('#vision').isChecked(), true);
  await page.selectOption('#provider', 'anthropic');
  assert.equal(await page.locator('#effort').isVisible(), true); assert.equal(await page.locator('#vision').isVisible(), false);
  assert.ok(await page.locator('.tool-card').count() >= 3, 'tool calls render as cards');
  assert.ok(await page.locator('.bubble.user').count() >= 1);
  await page.selectOption('#permission-mode', 'auto');
  assert.match(await page.locator('#mode-hint').textContent(), /审查/);
  await page.locator('[data-tab="browser-settings"]').click();
  assert.equal(await page.locator('#blocked-sites').inputValue(), '');
  await page.selectOption('#browser-mode', 'cdp');
  assert.equal(await page.locator('#cdp-url').isVisible(), true); assert.equal(await page.locator('#login-open').isVisible(), false);
  await page.selectOption('#browser-mode', 'persistent');
  assert.equal(await page.locator('#login-open').isVisible(), true);
  await page.screenshot({ path: 'artifacts/browser-settings.png' });
  await page.locator('[data-tab="permissions-panel"]').click();
  assert.equal(await page.locator('#blocked-sites').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#drawer').isVisible(), false);
  // New task returns to the start screen without touching the finished session.
  await page.locator('#new-task').click();
  assert.equal(await page.locator('#welcome').isVisible(), true);
  assert.equal(await page.locator('#task-composer').isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map(e => `${e.tagName}.${e.className}#${e.id} ${Math.round(e.getBoundingClientRect().right)}`).join(' | ')));
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  assert.deepEqual(errors, []); await page.close();
});
