import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { parseAction, apiEndpoint } from '../lib/model.js';
import { allowedURL } from '../lib/browser.js';

const port = 14318, origin = `http://127.0.0.1:${port}`, mockPort = 14319;
const { app, runner } = createApp({ port, browserOptions: { headless: true } });
let server, modelServer, browser, mockMode = 'normal', requests = 0, requestAuth;
const headers = { 'Content-Type': 'application/json', 'X-Browser-Agent': '1' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 25000) { const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error(`Timed out. State: ${runner.task?.status}, ${runner.task?.result}`); await sleep(60); } }
async function post(path, body) { const response = await fetch(origin + '/api/' + path, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
async function configure() { return post('config', { baseURL: `http://127.0.0.1:${mockPort}/v1`, model: 'test-model', apiKey: 'test-secret', vision: false, jsonMode: false }); }
async function start() { return post('tasks', { goal: '搜索键盘并读取价格', startURL: origin + '/demo', maxSteps: 10, autoInteract: false }); }

before(async () => {
  server = await new Promise(r => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  modelServer = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests++; requestAuth = req.headers.authorization;
    const body = JSON.parse(raw); const data = JSON.parse(body.messages[1].content);
    if (mockMode === 'slow') await sleep(1500);
    if (mockMode === 'bad') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'invalid' } }] })); return; }
    let action;
    if (mockMode === 'question' && !data.recentActions.some(h => h.user)) action = { type: 'ask_user', question: '请确认要搜索的商品' };
    else if (data.page.text.includes('搜索结果：键盘')) action = { type: 'done', result: '轻音机械键盘，¥ 399。来源：本地演示页。' };
    else if (data.recentActions.some(h => h.action?.type === 'fill' && h.ok)) action = { type: 'click', element: data.page.elements.find(e => e.label.includes('搜索产品')).id, reason: '执行搜索' };
    else action = { type: 'fill', element: data.page.elements.find(e => e.label.includes('产品关键词')).id, text: '键盘', reason: '填写关键词' };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(action) } }] }));
  });
  await new Promise(r => modelServer.listen(mockPort, '127.0.0.1', r));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
});
after(async () => { if (runner.busy) runner.control('stop'); await runner.promise; await browser?.close(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => modelServer.close(r))]); });

test('validates action schema and confines protocols/private addresses', () => {
  assert.equal(parseAction('```json\n{"type":"done","result":"ok"}\n```').result, 'ok');
  assert.throws(() => parseAction('{"type":"evaluate","code":"evil()"}'));
  assert.throws(() => parseAction('{"type":"click","element":-1}'));
  assert.throws(() => allowedURL('file:///etc/passwd', origin));
  assert.throws(() => allowedURL(origin + '/api/state', origin));
  assert.throws(() => allowedURL('http://10.0.0.1', origin));
  assert.throws(() => allowedURL('http://2130706433', origin));
  assert.equal(allowedURL(origin + '/demo', origin), origin + '/demo');
  assert.equal(apiEndpoint('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
  assert.throws(() => apiEndpoint('http://example.com/v1'));
});

test('API blocks foreign origins, validates input and never returns a configured key', async () => {
  const foreign = await fetch(origin + '/api/config', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
  assert.equal((await post('tasks', { goal: '' })).status, 400);
  await configure();
  assert.ok(!(await (await fetch(origin + '/api/state')).text()).includes('test-secret'));
  const changed = await post('config', { baseURL: `http://127.0.0.1:${mockPort}/other`, model: 'test', apiKey: '', vision: false, jsonMode: false });
  assert.equal(changed.body.hasKey, false);
  await configure();
});

test('real browser + mock model: actions wait for approval, complete only after observing result', async () => {
  mockMode = 'normal'; await start();
  await until(() => runner.task.status === 'approval');
  assert.equal(runner.task.pending.type, 'fill');
  assert.equal(await runner.browser.page.locator('#query').inputValue(), '');
  assert.equal((await start()).status, 409);
  assert.equal((await configure()).status, 409);
  await post('control', { command: 'approve' });
  await until(() => runner.task.status === 'approval' && runner.task.pending.type === 'click');
  assert.equal(await runner.browser.page.locator('#query').inputValue(), '键盘');
  assert.ok(runner.task.snapshot.text.includes('全部产品'));
  await post('control', { command: 'approve' });
  await until(() => !runner.busy);
  assert.equal(runner.task.status, 'done'); assert.match(runner.task.result, /399/);
  assert.equal(requestAuth, 'Bearer test-secret');
});

test('pause cancels pending model response, resume re-observes, stop ends approval wait', async () => {
  mockMode = 'slow'; const beforeRequests = requests; await start();
  await until(() => requests > beforeRequests);
  await post('control', { command: 'pause' }); await until(() => runner.task.status === 'paused');
  assert.equal(await runner.browser.page.locator('#query').inputValue(), '');
  await post('control', { command: 'resume' }); await until(() => runner.task.status === 'approval');
  await post('control', { command: 'stop' }); await until(() => !runner.busy);
  assert.equal(runner.task.status, 'stopped');
});

test('human handoff accepts context and rejected action is recorded', async () => {
  mockMode = 'question'; await start(); await until(() => runner.task.status === 'waiting_user');
  assert.equal((await post('control', { command: 'resume', answer: '' })).status, 400);
  await post('control', { command: 'resume', answer: '键盘' }); await until(() => runner.task.status === 'approval');
  await post('control', { command: 'reject' }); await until(() => runner.task.history.some(h => h.error?.includes('用户拒绝')));
  await post('control', { command: 'stop' }); await until(() => !runner.busy);
});

test('invalid model output stops after three consecutive failures', async () => {
  mockMode = 'bad'; const beforeRequests = requests; await start(); await until(() => !runner.busy);
  assert.equal(runner.task.status, 'failed'); assert.equal(requests - beforeRequests, 3);
});

test('UI demo runs a real browser without calling model; desktop and mobile layouts fit', async () => {
  runner.task = null;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await page.waitForFunction(() => document.getElementById('connection').textContent === '本地服务已连接');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/workbench.png', fullPage: true });
  const beforeRequests = requests;
  await page.locator('#demo').click();
  await until(() => runner.task.mode === 'demo' && !runner.busy);
  await page.waitForFunction(() => document.getElementById('result').textContent.includes('演示完成'));
  assert.equal(runner.task.status, 'done'); assert.equal(requests, beforeRequests);
  assert.match(runner.task.snapshot.text, /搜索结果：键盘 · 1 件/);
  assert.equal(await page.locator('#screenshot').isVisible(), true);
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  assert.equal(await page.locator('#run').isEnabled(), true);
  await page.screenshot({ path: 'artifacts/demo-complete.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  assert.deepEqual(errors, []); await page.close();
});
