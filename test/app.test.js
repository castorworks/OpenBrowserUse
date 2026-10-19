import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { apiEndpoint, OpenAIProvider } from '../lib/providers/openai.js';
import { AnthropicProvider } from '../lib/providers/anthropic.js';
import { allowedURL } from '../lib/browser/url.js';
import { detectChannel, launchChannel } from '../lib/browser/channel.js';
import { BrowserSession } from '../lib/browser/session.js';
import { TOOLS, getTool, jsonSchema, parseInput } from '../lib/tools/index.js';
import { normalizeKey } from '../lib/tools/computer.js';

const port = 14318, origin = `http://127.0.0.1:${port}`, openaiPort = 14319, anthropicPort = 14320;
const { app, agent } = createApp({ port, browserOptions: { headless: true }, env: {} });
let server, openaiServer, anthropicServer, browser, mockMode = 'normal', requests = 0, requestAuth, lastOpenAIBody, anthropicRequests = [];
const headers = { 'Content-Type': 'application/json', 'X-Browser-Agent': '1' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 25000) { const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error(`Timed out. State: ${agent.task?.status}, ${agent.task?.result}, ${JSON.stringify(agent.task?.events.slice(-3))}`); await sleep(60); } }
async function post(path, body) { const response = await fetch(origin + '/api/' + path, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
async function configureOpenAI() { return post('config', { provider: 'openai', baseURL: `http://127.0.0.1:${openaiPort}/v1`, model: 'test-model', apiKey: 'test-secret', vision: false }); }
async function start(extra = {}) { return post('tasks', { goal: '搜索键盘并读取价格', startURL: origin + '/demo', maxSteps: 20, autoInteract: false, ...extra }); }
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
  const answered = msgs.some(m => m.role === 'tool' && m.content.startsWith('用户回复'));
  if (mockMode === 'question' && !answered) return call('ask_user', { question: '请确认要搜索的商品' });
  if (!called.includes('read_page')) return call('read_page', {});
  if (!called.includes('form_input')) return call('form_input', { ref: ref('产品关键词'), value: '键盘' });
  if (!called.includes('computer')) return call('computer', { action: 'left_click', ref: ref('搜索产品') });
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
    const body = JSON.parse(raw); lastOpenAIBody = body;
    if (mockMode === 'slow') await sleep(1500);
    if (mockMode === 'error') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"secret-echo"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, ...openaiReply(body) }, finish_reason: 'stop' }] }));
  });
  anthropicServer = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    anthropicRequests.push({ url: req.url, headers: req.headers, body });
    const hasResult = body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
    if (!hasResult) sse(res, [{ type: 'text', text: '先看看页面。' }, { type: 'tool_use', id: 'toolu_1', name: 'read_page', input: { filter: 'all' } }], 'tool_use');
    else sse(res, [{ type: 'text', text: '页面上有 3 件产品，其中轻音机械键盘 ¥ 399。' }], 'end_turn');
  });
  await new Promise(r => openaiServer.listen(openaiPort, '127.0.0.1', r));
  await new Promise(r => anthropicServer.listen(anthropicPort, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, ...launchChannel(detectChannel()) });
});
after(async () => { await settle(); await browser?.close(); await Promise.all([server, openaiServer, anthropicServer].map(s => new Promise(r => s.close(r)))); });

test('URL guard, endpoints, key names and tool schemas', () => {
  assert.throws(() => allowedURL('file:///etc/passwd', origin));
  assert.throws(() => allowedURL(origin + '/api/state', origin));
  assert.throws(() => allowedURL('http://10.0.0.1', origin));
  assert.throws(() => allowedURL('http://2130706433', origin));
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
    await assert.rejects(getTool('form_input').run({ ref: pw, value: 'x' }, { browser: session }), /密码/);
  } finally { await session.close(); }
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
  await start({ autoInteract: true }); await until(() => !agent.busy);
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
  await page.locator('#demo').click();
  await until(() => agent.task?.mode === 'demo' && !agent.busy);
  await page.waitForFunction(() => document.getElementById('result').textContent.includes('演示完成'));
  assert.equal(agent.task.status, 'done'); assert.equal(requests, beforeRequests);
  assert.match(agent.task.result, /搜索结果：键盘 · 1 件/);
  assert.equal(await page.locator('#screenshot').isVisible(), true);
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.screenshot({ path: 'artifacts/demo-complete.png', fullPage: true });
  await page.locator('#settings').evaluate(el => { el.open = true; });
  await page.selectOption('#provider', 'anthropic');
  assert.equal(await page.locator('#effort').isVisible(), true); assert.equal(await page.locator('#vision').isVisible(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  assert.deepEqual(errors, []); await page.close();
});
