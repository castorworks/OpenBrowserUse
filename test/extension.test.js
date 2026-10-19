import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { createApp } from '../server.js';
import { computerTool } from '../lib/tools/computer.js';

// Branded Chrome no longer loads unpacked extensions from the command line; use a Chromium /
// Chrome for Testing build (OBU_TEST_CHROMIUM, Playwright's own, or any cached one).
function chromiumWithExtensions() {
  if (process.env.OBU_TEST_CHROMIUM) return process.env.OBU_TEST_CHROMIUM;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const builds = existsSync(cache) ? readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  const candidates = ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe'];
  for (const build of builds) for (const c of candidates) if (existsSync(join(cache, build, c))) return join(cache, build, c);
  return null;
}

const executablePath = chromiumWithExtensions();
const port = 14718, origin = `http://127.0.0.1:${port}`, mockPort = 14719;
let app, agent, relay, server, mock, dataDir, userDir, chrome, worker;
const headers = { 'Content-Type': 'application/json', 'X-Browser-Agent': '1' };
const post = (path, body) => fetch(`${origin}/api/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 30000) { const start = Date.now(); while (!(await check())) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${agent.task?.status} ${agent.task?.result}`); await sleep(100); } }

// OpenAI-compatible mock: read_page → form_input → click → get_page_text → answer.
function reply(body) {
  const msgs = body.messages, toolText = msgs.filter(m => m.role === 'tool').map(m => m.content).join('\n');
  const called = msgs.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(c => c.function.name);
  const ref = label => new RegExp(`"[^"]*${label}[^"]*" \\[(ref_\\d+)\\]`).exec(toolText)?.[1];
  const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `c${msgs.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (!called.includes('read_page')) return call('read_page', {});
  if (!called.includes('form_input')) return call('form_input', { ref: ref('产品关键词'), value: '键盘' });
  if (!called.includes('computer')) return call('computer', { action: 'left_click', ref: ref('搜索产品') });
  if (!called.includes('get_page_text')) return call('get_page_text', {});
  return { role: 'assistant', content: toolText.includes('搜索结果：键盘') ? '轻音机械键盘 ¥ 399' : '没有找到' };
}

before(async () => {
  if (!executablePath) return;
  dataDir = await mkdtemp(join(tmpdir(), 'obu-ext-data-'));
  userDir = await mkdtemp(join(tmpdir(), 'obu-ext-profile-'));
  ({ app, agent, relay } = createApp({ port, env: {}, dataDir }));
  server = await new Promise(r => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  relay.attach(server, port);
  mock = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: reply(JSON.parse(raw)), finish_reason: 'stop' }] }));
  });
  await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));
  const extensionPath = resolve('extension');
  chrome = await chromium.launchPersistentContext(userDir, {
    executablePath, headless: true, viewport: null,
    // A 2x display, like a Retina Mac, so CSS and device pixels differ.
    args: ['--window-size=1600,1000', '--force-device-scale-factor=2', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  worker = chrome.serviceWorkers()[0] || await chrome.waitForEvent('serviceworker');
});
after(async () => {
  if (!executablePath) return;
  try { agent.control('stop'); } catch {}
  await agent.promise; await agent.closeBrowser();
  await chrome?.close();
  await Promise.all([server, mock].map(s => new Promise(r => s.close(r))));
  agent.sessions.close();
  await rm(dataDir, { recursive: true, force: true }); await rm(userDir, { recursive: true, force: true });
});

test('extension pairs with the relay only with the right token', { skip: !executablePath && 'no Chromium build that loads extensions' }, async () => {
  await worker.evaluate(o => chrome.storage.local.set({ server: o.origin, token: 'wrong-token-wrong-token' }), { origin });
  await sleep(1500);
  assert.equal(relay.connected(), false, 'wrong token is refused');
  await worker.evaluate(o => chrome.storage.local.set({ server: o.origin, token: o.token }), { origin, token: relay.token });
  await until(() => relay.connected());
  const state = await (await fetch(`${origin}/api/state`)).json();
  assert.equal(state.extension.connected, true);
  assert.equal(state.extension.token, undefined, 'the token is not in the streamed state');
  assert.equal((await post('extension/token', {})).body.token, relay.token);
  assert.equal((await fetch(`${origin}/api/extension/token`)).status, 404, 'a plain GET (e.g. navigating to it) cannot read the token');
  assert.equal((await fetch(`${origin}/api/extension/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'requests without the workbench header are refused');
  // A plain web page cannot open the extension channel.
  const refused = (url, options) => new Promise(done => { const ws = new WebSocket(url, options); ws.on('unexpected-response', (req, res) => done(res.statusCode)); ws.on('open', () => { ws.close(); done('open'); }); ws.on('error', () => {}); });
  assert.equal(await refused(`ws://127.0.0.1:${port}/relay/extension?token=${relay.token}`, { origin: 'https://evil.example' }), 403);
  assert.equal(await refused(`ws://127.0.0.1:${port}/relay/cdp/not-the-secret`), 403);
  // The side panel shows the connection state and embeds the workbench.
  const extensionId = new URL(worker.url()).host;
  const panel = await chrome.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForFunction(() => document.getElementById('status').textContent === '已连接');
  const frame = await (await panel.waitForSelector('#workbench:not([hidden])')).contentFrame();
  await frame.waitForFunction(() => document.getElementById('connection')?.textContent === '本地服务已连接');
  await panel.close();
});

test('agent runs in the user\'s Chrome through the extension, only in its own tab group', { skip: !executablePath && 'no Chromium build that loads extensions' }, async () => {
  await until(() => relay.connected());
  const userTab = await chrome.newPage();
  await userTab.goto(`${origin}/demo`);
  await userTab.fill('#query', '用户自己的输入');
  await post('config', { provider: 'openai', baseURL: `http://127.0.0.1:${mockPort}/v1`, model: 'mock', apiKey: 'k' });
  assert.equal((await post('browser', { mode: 'extension', cdpURL: '', allowLocalhost: true, allowPrivateNetwork: false })).status, 200);
  assert.equal((await post('tasks', { goal: '搜索键盘并读取价格', startURL: `${origin}/demo`, maxSteps: 20, permissionMode: 'skip' })).status, 202);
  await until(() => !agent.busy, 60000);
  assert.equal(agent.task.status, 'done', `${agent.task.result} ${JSON.stringify(agent.task.events.slice(-4))}`);
  assert.match(agent.task.result, /399/);
  assert.ok(agent.lastFrame, 'live screencast frames arrive through the relay');

  const page = agent.browser.current();
  const size = await page.evaluate(() => {
    window.resizeCount = 0;
    addEventListener('resize', () => window.resizeCount++);
    return { width: innerWidth, height: innerHeight };
  });
  assert.ok(size.width > 1280, 'extension preserves the large native viewport');
  // Watch what the tab actually renders, from this test's own DevTools session, while screenshots are taken.
  await page.evaluate(() => { window.agentTab = true; });
  const visible = (await Promise.all(chrome.pages().map(async p => (await p.evaluate(() => window.agentTab).catch(() => false)) && p))).find(Boolean);
  const cdp = await chrome.newCDPSession(visible);
  const rendered = [];
  cdp.on('Page.screencastFrame', ({ metadata, sessionId }) => { rendered.push(`${metadata.deviceWidth}x${metadata.deviceHeight}`); cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {}); });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 30, maxWidth: 400, maxHeight: 300 });
  await until(() => rendered.length > 0);
  let full;
  for (let i = 0; i < 3; i++) {
    const data = await agent.browser.screenshot({ format: i ? 'jpeg' : 'png' });
    if (i) { assert.match(data, /^data:image\/jpeg;base64,\/9j\//); continue; }
    const png = Buffer.from(data.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), size.width, 'screenshot and click coordinates use CSS pixels');
    assert.equal(png.readUInt32BE(20), size.height);
    full = data;
  }
  const zoom = await computerTool.run({ action: 'zoom', region: [40, 20, 440, 220] }, { browser: agent.browser });
  const crop = Buffer.from(zoom.image.split(',')[1], 'base64');
  assert.deepEqual([crop.readUInt32BE(16), crop.readUInt32BE(20)], [400, 200], 'zoom crops in CSS pixels');
  const checker = await chrome.newPage();
  const difference = await checker.evaluate(async ([a, b]) => {
    const pixels = async (src, x, y) => { const c = new OffscreenCanvas(400, 200).getContext('2d'); c.drawImage(await createImageBitmap(await (await fetch(src)).blob()), x, y, 400, 200, 0, 0, 400, 200); return c.getImageData(0, 0, 400, 200).data; };
    const [p, q] = await Promise.all([pixels(a, 40, 20), pixels(b, 0, 0)]);
    let sum = 0; for (let i = 0; i < p.length; i++) sum += Math.abs(p[i] - q[i]);
    return sum / p.length;
  }, [full, zoom.image]);
  await checker.close();
  assert.ok(difference < 2, `zoom shows the same pixels as that region of the full screenshot (mean difference ${difference})`);
  await sleep(300);
  await cdp.send('Page.stopScreencast'); await cdp.detach();
  assert.deepEqual(rendered.filter(s => s !== `${size.width}x${size.height}`), [], 'screenshots never re-render the visible tab at another size (the flash)');
  assert.equal(await page.evaluate(() => window.resizeCount), 0, 'repeated screenshots do not resize the visible page');
  await computerTool.run({ action: 'hover', coordinate: [size.width - 10, 20] }, { browser: agent.browser });
  await assert.rejects(computerTool.run({ action: 'hover', coordinate: [size.width + 10, 20] }, { browser: agent.browser }), /coordinate must be inside/);

  // The user's tab was never touched, and the agent's tab lives in its own group.
  assert.equal(await userTab.inputValue('#query'), '用户自己的输入');
  const groups = await worker.evaluate(() => chrome.tabGroups.query({ title: 'Open Browser Use' }));
  assert.equal(groups.length, 1);
  const grouped = await worker.evaluate(id => chrome.tabs.query({ groupId: id }), groups[0].id);
  assert.equal(grouped.length, 1); assert.match(grouped[0].url, /\/demo$/);
  assert.ok(await worker.evaluate(() => globalThis.obu.agentTabs.size) >= 1);

  // The extension refuses to attach to a tab it did not open, even if asked directly.
  const userTabId = (await worker.evaluate(() => chrome.tabs.query({ title: '演示商店*' }))).find(t => t.groupId === -1)?.id;
  await assert.rejects(relay.call('debugger.attach', userTabId), /只能操作代理自己打开的标签页/);

  // Stopping closes the agent's tab and releases the debugger; the user's tab stays.
  await post('control', { command: 'stop' });
  await until(() => agent.task.status === 'stopped' && !agent.browser);
  await until(async () => (await worker.evaluate(() => globalThis.obu.agentTabs.size)) === 0);
  assert.equal(userTab.isClosed(), false);
});

test('chat updates preserve existing content and expanded cards; Markdown is sanitized', { skip: !executablePath && 'no Chromium build that loads extensions' }, async () => {
  const page = await chrome.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => typeof renderEvents === 'function' && typeof DOMPurify !== 'undefined');
  const result = await page.evaluate(() => {
    const events = [{ kind: 'assistant', time: 1, message: '**概览**\n\n| 指标 | 数值 |\n|---|---|\n| Assets | 8 |\n\n<img src=x onerror="window.injected=true"><script>window.injected=true</script>' }, { kind: 'action', time: 2, tool: 'computer', message: '截图', state: 'running' }];
    renderEvents(events);
    const bubble = document.querySelector('#events .bubble');
    document.querySelector('#events details').open = true;
    events[1].state = 'done';
    renderEvents(events);
    events.push({ kind: 'user', time: 3, message: '继续' });
    renderEvents(events);
    return { same: bubble === document.querySelector('#events .bubble'), open: document.querySelector('#events details').open, strong: Boolean(bubble.querySelector('strong')), table: Boolean(bubble.querySelector('table')), unsafe: Boolean(bubble.querySelector('img, script, [onerror]')), injected: Boolean(window.injected) };
  });
  assert.deepEqual(result, { same: true, open: true, strong: true, table: true, unsafe: false, injected: false });
  await page.setViewportSize({ width: 360, height: 900 });
  await page.evaluate(() => {
    document.getElementById('result-box').hidden = false;
    markdown(document.getElementById('result'), '**概览**\n\n| 指标 | 数值 |\n|---|---|\n| Releases | 1 个产品 |\n| Assets | 8（120 MiB） |\n\n- 页面布局保持窗口大小\n- 操作记录更新时保留展开状态');
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Markdown fits a narrow side panel');
  await mkdir(resolve('artifacts'), { recursive: true });
  await page.locator('#result-box').screenshot({ path: resolve('artifacts/markdown-sidepanel.png') });
  await page.close();
});
