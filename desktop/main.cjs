const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, protocol, ipcMain, utilityProcess, dialog, shell, session } = require('electron');
const { join } = require('node:path');
const { readFile, writeFile } = require('node:fs/promises');

const root = join(__dirname, '..');
const WORKBENCH = 'obu://workbench/';
const extensionDirectory = () => app.isPackaged ? join(process.resourcesPath, 'extension') : join(root, 'extension');
const pending = new Map();
let window, tray, backend, sequence = 0, quitting = false, shutdownDone = false;
let lastState, lastFrame, backendReady = false;
let resolveReady, rejectReady;
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
// The startup handler awaits this promise once Electron is ready.
ready.catch(() => {});

protocol.registerSchemesAsPrivileged([{ scheme: 'obu', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Open Browser Use');
if (process.env.OBU_DESKTOP_USER_DATA) app.setPath('userData', process.env.OBU_DESKTOP_USER_DATA);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== WORKBENCH) {
    throw new Error('不允许此页面访问桌面接口。');
  }
}
function emit(event, data) {
  if (window && !window.isDestroyed()) window.webContents.send('obu:event', { event, data });
}
function request(method, path, body) {
  if (!backendReady || quitting) return Promise.reject(new Error('后台未连接，请重新打开应用。'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('后台请求超时，请查看当前任务状态。')); }, 60000);
    pending.set(id, { resolve, reject, timer });
    backend.postMessage({ type: 'request', id, method, path, body });
  });
}
async function api(path, body) {
  if (typeof path !== 'string' || !/^(state|sessions(?:\/[a-f0-9-]{36})?|sessions\/(?:delete|recover|page)|config|browser|login|permissions|tasks|messages|control|jobs(?:\/[a-f0-9-]{36}\/cancel)?|lifecycle)$/.test(path)) throw new Error('不支持的桌面操作。');
  const response = await request(body === undefined ? 'GET' : 'POST', `/api/${path}`, body);
  if (response.status >= 400) throw new Error(response.body?.error || '操作失败');
  return response.body;
}
function rejectPending(message) {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
  pending.clear();
}
function launchBackend() {
  backend = utilityProcess.fork(join(__dirname, 'backend.js'), [], { cwd: app.isPackaged ? process.resourcesPath : root, serviceName: 'Open Browser Use Engine', stdio: 'pipe' });
  backend.stdout?.on('data', chunk => process.stdout.write(chunk));
  backend.stderr?.on('data', chunk => process.stderr.write(chunk));
  const startupTimer = setTimeout(() => { rejectReady(new Error('后台启动超时。')); backend.kill(); }, 30000);
  backend.on('message', message => {
    if (message.type === 'ready') { clearTimeout(startupTimer); backendReady = true; resolveReady(message); }
    else if (message.type === 'desktop-focus') { void createWindow(); }
    else if (message.type === 'fatal') { clearTimeout(startupTimer); rejectReady(new Error(message.error)); }
    else if (message.type === 'response') {
      const item = pending.get(message.id);
      if (item) { clearTimeout(item.timer); pending.delete(message.id); item.resolve(message); }
    } else if (message.type === 'event') {
      if (message.event === 'state') lastState = message.data;
      if (message.event === 'frame') lastFrame = message.data;
      emit(message.event, message.data);
    }
  });
  backend.on('exit', code => {
    clearTimeout(startupTimer); backendReady = false;
    rejectReady(new Error(`后台退出（${code}）。`));
    rejectPending('后台已退出，请重新打开应用。');
    if (!quitting) emit('offline', '后台已退出，请退出并重新打开应用。');
  });
}
async function openExternal(url) {
  try { if (['https:', 'http:'].includes(new URL(url).protocol)) await shell.openExternal(url); } catch {}
}
async function createWindow() {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({
    title: 'Open Browser Use', width: 1440, height: 940, minWidth: 780, minHeight: 560, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191411' : '#faf5ee',
    icon: join(root, 'assets/icons/icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (url !== WORKBENCH) { event.preventDefault(); void openExternal(url); } });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => window?.show());
  await window.loadURL(WORKBENCH);
}

if (singleInstance) {
  app.on('second-instance', () => { if (backendReady) void createWindow(); });
  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock.setIcon(join(root, 'assets/icons/icon.png'));
    // Only explicitly bundled frontend files are reachable through this protocol.
    const assets = {
      '/icon.png': ['assets/icons/icon.png', 'image/png'],
      '/': ['desktop/renderer/index.html', 'text/html'], '/app.js': ['desktop/renderer/app.js', 'text/javascript'], '/style.css': ['desktop/renderer/style.css', 'text/css'],
      '/vendor/marked.js': ['node_modules/marked/lib/marked.umd.js', 'text/javascript'],
      '/vendor/purify.js': ['node_modules/dompurify/dist/purify.min.js', 'text/javascript'],
    };
    protocol.handle('obu', async req => {
      const url = new URL(req.url), asset = url.hostname === 'workbench' && assets[url.pathname];
      if (!asset || req.method !== 'GET') return new Response('Not found', { status: 404 });
      try {
        return new Response(await readFile(join(root, asset[0])), { headers: {
          'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'",
          'X-Content-Type-Options': 'nosniff',
        } });
      } catch { return new Response('Not found', { status: 404 }); }
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    ipcMain.handle('obu:request', async (event, path, body) => { trusted(event); return api(path, body); });
    ipcMain.handle('obu:subscribe', event => {
      trusted(event);
      if (lastState) emit('state', lastState);
      if (lastFrame) emit('frame', lastFrame);
      if (!backendReady) emit('offline', '后台未连接');
    });
    ipcMain.handle('obu:extension-directory', async event => { trusted(event); const error = await shell.openPath(extensionDirectory()); if (error) throw new Error(error); });
    ipcMain.handle('obu:export', async (event, id) => {
      trusted(event);
      if (id != null && !/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的会话编号。');
      const currentTask = id ? null : (await api('state')).task;
      const task = id || (currentTask && currentTask.mode !== 'demo' && !currentTask.deleted) ? await api(`sessions/${id || currentTask.id}`) : currentTask;
      if (!task) throw new Error('没有可导出的会话。');
      const data = { ...task, snapshot: task.snapshot ? { ...task.snapshot, screenshot: undefined } : null };
      const { canceled, filePath } = await dialog.showSaveDialog(window, { title: '导出会话', defaultPath: join(app.getPath('documents'), `open-browser-use-${task.id}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (canceled || !filePath) return { canceled: true };
      await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
      return { canceled: false };
    });
    const menu = [
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: '文件', submenu: [{ label: '显示工作台', click: () => { void createWindow(); } }, { label: '打开 Chrome 扩展目录', click: () => { void shell.openPath(extensionDirectory()); } }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
    launchBackend(); await ready;
    tray = new Tray(nativeImage.createFromPath(join(extensionDirectory(), 'icons/32.png')).resize({ width: 16, height: 16 }));
    tray.setToolTip('Open Browser Use');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '显示工作台', click: () => { void createWindow(); } }, { role: 'quit' }]));
    tray.on('click', () => { void createWindow(); });
    await createWindow();
  }).catch(error => {
    console.error(error.message);
    if (process.env.OBU_DESKTOP_TEST !== '1') dialog.showErrorBox('Open Browser Use 启动失败', error.message);
    app.quit();
  });
  app.on('activate', () => { if (backendReady) void createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (shutdownDone || !backend?.pid) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true; rejectPending('应用正在退出。');
    const timer = setTimeout(() => { backend.kill(); shutdownDone = true; app.quit(); }, 15000);
    backend.once('exit', () => { clearTimeout(timer); shutdownDone = true; app.quit(); });
    backend.postMessage({ type: 'shutdown' });
  });
}
