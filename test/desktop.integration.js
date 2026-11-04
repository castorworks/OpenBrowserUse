import { demoServer } from './helpers/demo-server.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron, chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

function extensionChromium() {
  if (process.env.OBU_TEST_CHROMIUM) return process.env.OBU_TEST_CHROMIUM;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  if (!existsSync(cache)) return null;
  for (const build of readdirSync(cache).filter(x => /^chromium-\d+$/.test(x)).reverse()) {
    for (const suffix of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux64/chrome', 'chrome-win64/chrome.exe']) {
      const file = join(cache, build, suffix); if (existsSync(file)) return file;
    }
  }
  return null;
}
async function until(check, timeout = 30000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for desktop state');
    await new Promise(r => setTimeout(r, 80));
  }
}

test('desktop IPC, live demo, model chat, export, extension relay, restart and clean exit', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-desktop-'));
  const site = demoServer();
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const siteURL = `http://127.0.0.1:${site.address().port}/demo`;
  const requests = [];
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    const read = body.messages.some(m => m.role === 'tool');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: read ? 'stop' : 'tool_calls', message: read ? { role: 'assistant', content: '桌面模型测试完成。' } : { role: 'assistant', content: '观察当前页面。', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_page', arguments: '{"filter":"all"}' } }] } }] }));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  // Occupy the preferred port to prove the app chooses a free port and reports it.
  const occupied = createServer((_req, res) => res.end('other service'));
  await new Promise(r => occupied.listen(0, '127.0.0.1', r));
  let desktop, extensionBrowser;
  const env = { ...process.env, OBU_DATA_DIR: join(dir, 'data'), OBU_DESKTOP_USER_DATA: join(dir, 'electron'), OBU_DESKTOP_PORT: String(occupied.address().port), OBU_DESKTOP_TEST: '1', BROWSER_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({ ...(process.env.OBU_ELECTRON_EXECUTABLE ? { executablePath: process.env.OBU_ELECTRON_EXECUTABLE, args: [] } : { args: [resolve('.')] }), env, timeout: 30000 });
  t.after(async () => {
    await desktop?.close().catch(() => {}); await extensionBrowser?.close().catch(() => {});
    site.closeAllConnections(); await new Promise(r => site.close(r));
    mock.closeAllConnections(); occupied.closeAllConnections();
    await Promise.all([new Promise(r => mock.close(r)), new Promise(r => occupied.close(r))]);
    await rm(dir, { recursive: true, force: true });
  });
  desktop = await launch();
  desktop.process().stderr?.on('data', data => { if (String(data).includes('Error')) console.error(String(data)); });
  const page = await desktop.firstWindow();
  await page.waitForFunction(() => document.querySelector('#connection')?.textContent === '本地服务已连接');
  assert.equal(page.url(), 'obu://workbench/');
  assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process, bridge: typeof window.desktop?.request })), { require: 'undefined', process: 'undefined', bridge: 'function' });
  const api = (path, data) => page.evaluate(([path, data]) => window.desktop.request(path, data), [path, data]);
  const second = spawn(desktop.process().spawnfile, process.env.OBU_ELECTRON_EXECUTABLE ? [] : [resolve('.')], { env, stdio: 'ignore' });
  const secondTimer = setTimeout(() => second.kill('SIGKILL'), 10000);
  const secondExit = await new Promise(r => second.once('exit', r)); clearTimeout(secondTimer);
  assert.equal(secondExit, 0, 'second instance exits without starting another engine');
  const deniedSender = await desktop.evaluate(async ({ BrowserWindow }) => {
    const other = new BrowserWindow({ show: false, webPreferences: { preload: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().preload, contextIsolation: true, sandbox: true } });
    try {
      await other.loadURL('data:text/html,<h1>Untrusted window</h1>');
      return await other.webContents.executeJavaScript("typeof window.desktop === 'undefined' ? 'bridge unavailable' : window.desktop.request('state').then(() => 'allowed', e => e.message)");
    } finally { other.destroy(); }
  });
  assert.match(deniedSender, /不允许|bridge unavailable/);
  const initial = await api('state');
  const origin = initial.extension.serverURL;
  assert.notEqual(new URL(origin).port, String(occupied.address().port));
  await assert.rejects(api('../secret'), /不支持/);
  for (const path of ['/', '/api/state', '/api/events', '/demo', '/app.js']) assert.equal((await fetch(origin + path)).status, 404, path);
  await page.locator('#demo').click();
  await until(async () => { const s = await api('state'); return s.task?.mode === 'demo' && s.task.status === 'done' && !s.busy; });
  await page.waitForFunction(() => document.querySelector('#screenshot')?.src.startsWith('data:image/'));
  assert.ok((await page.locator('#screenshot').getAttribute('src'))?.startsWith('data:image/'));
  assert.match((await api('state')).task.result, /搜索结果：键盘 · 1 件/);
  assert.equal(requests.length, 0, 'demo does not call a model');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('result').textContent.includes('演示完成'));
  await page.locator('#settings-shortcut').click();
  await page.selectOption('#provider', 'deepseek');
  assert.equal(await page.locator('#base-url').inputValue(), 'https://api.deepseek.com');
  assert.equal(await page.locator('#vision').isChecked(), true);
  await page.selectOption('#provider', 'anthropic');
  assert.equal(await page.locator('#vision').isVisible(), false);
  await page.locator('[data-tab="browser-settings"]').click();
  await page.selectOption('#browser-mode', 'cdp');
  assert.equal(await page.locator('#cdp-url').isVisible(), true);
  await page.selectOption('#browser-mode', 'extension');
  await page.waitForFunction(() => document.getElementById('extension-token').value.length >= 20);
  assert.equal(await page.locator('#open-extension-directory').isVisible(), true);
  await page.selectOption('#browser-mode', 'persistent');
  assert.equal(await page.locator('#login-open').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#drawer').isVisible(), false);
  await api('config', { provider: 'openai', baseURL: `http://127.0.0.1:${mock.address().port}`, model: 'desktop-test', apiKey: 'desktop-fixture-key', vision: false });
  await api('tasks', { goal: '测试桌面工作台', startURL: siteURL });
  await until(async () => { const s = await api('state'); return s.task?.mode === 'ai' && s.task.status === 'done' && !s.busy; });
  assert.match((await api('state')).task.result, /桌面模型测试完成/);
  await api('messages', { text: '继续确认' });
  await until(async () => !(await api('state')).busy);
  assert.ok(requests.length >= 3);
  await page.waitForFunction(() => document.querySelector('#model-badge')?.textContent === 'desktop-test');
  await page.waitForFunction(() => { const img = document.querySelector('#screenshot'); return !img.hidden && img.naturalWidth > 0; });
  if (process.env.OBU_DESKTOP_SCREENSHOT) {
    await mkdir(dirname(process.env.OBU_DESKTOP_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.OBU_DESKTOP_SCREENSHOT });
  }
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
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'renderer fits a narrow window');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sessions = (await api('sessions')).sessions;
  assert.equal(sessions.length, 1);
  assert.ok(!JSON.stringify(await api('state')).includes('desktop-fixture-key'));
  const exportPath = join(dir, 'export.json');
  await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
  await page.evaluate(id => window.desktop.exportSession(id), sessions[0].id);
  assert.match(JSON.parse(await readFile(exportPath, 'utf8')).result, /桌面模型测试完成/);
  assert.ok(!(await readFile(exportPath, 'utf8')).includes('desktop-fixture-key'));
  await api('control', { command: 'stop' });
  await until(async () => !(await api('state')).task.sessionOpen);

  const executablePath = extensionChromium();
  assert.ok(executablePath, 'Install Playwright Chromium or set OBU_TEST_CHROMIUM for the extension integration test');
  const extensionPath = process.env.OBU_ELECTRON_EXECUTABLE ? resolve(process.env.OBU_ELECTRON_EXECUTABLE, '../../Resources/extension') : resolve('extension');
  extensionBrowser = await chromium.launchPersistentContext(join(dir, 'chrome'), { executablePath, headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  const worker = extensionBrowser.serviceWorkers()[0] || await extensionBrowser.waitForEvent('serviceworker');
  const token = (await api('extension/token', {})).token;
  await worker.evaluate(({ server, token }) => chrome.storage.local.set({ server, token }), { server: origin, token });
  await until(async () => (await api('state')).extension.connected);
  const panel = await extensionBrowser.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.waitForFunction(() => document.getElementById('status').textContent === '已连接');
  assert.equal(await panel.locator('iframe').count(), 0);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await panel.locator('#open-desktop').click();
  await until(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()));
  await panel.close();
  await api('browser', { mode: 'extension', cdpURL: 'http://127.0.0.1:9222', allowLocalhost: true, allowPrivateNetwork: false, blockedSites: [] });
  await api('tasks', { goal: '验证桌面应用连接真实 Chrome 扩展', startURL: siteURL });
  await until(async () => { const s = await api('state'); return s.task.status === 'done' && !s.busy; });
  assert.match((await api('state')).task.result, /桌面模型测试完成/);
  assert.ok(await worker.evaluate(() => obu.agentTabs.size > 0));
  // Quitting with an open extension session must release the relay and owned tabs.
  await desktop.close(); desktop = null;
  await assert.rejects(fetch(origin + '/api/state'));
  await extensionBrowser.close(); extensionBrowser = null;
  desktop = await launch();
  const restoredPage = await desktop.firstWindow();
  await restoredPage.waitForFunction(() => document.querySelector('#connection')?.textContent === '本地服务已连接');
  const restored = await restoredPage.evaluate(() => window.desktop.request('state'));
  assert.equal(restored.config.model, 'desktop-test'); assert.equal(restored.config.hasKey, true);
  assert.equal(restored.config.browser.mode, 'extension');
  assert.equal((await restoredPage.evaluate(() => window.desktop.request('sessions'))).sessions.length, 2);
  const row = restoredPage.locator(`.history-row[data-id="${sessions[0].id}"]`);
  await row.locator('.history-item').click();
  assert.equal(await restoredPage.locator('#replay-banner').isVisible(), true);
  assert.match(await restoredPage.locator('#result').textContent(), /桌面模型测试完成/);
  await row.hover();
  await row.locator('.history-delete').click();
  assert.equal(await row.locator('.history-delete').textContent(), '确认删除');
  assert.equal((await restoredPage.evaluate(() => window.desktop.request('sessions'))).sessions.length, 2);
  await row.locator('.history-delete').click();
  await row.waitFor({ state: 'detached' });
  assert.equal((await restoredPage.evaluate(() => window.desktop.request('sessions'))).sessions.length, 1);

  await desktop.close(); desktop = null;
});
