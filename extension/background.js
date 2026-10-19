// Open Browser Use extension: connects to the local Open Browser Use server and lets it drive,
// through chrome.debugger, only the tabs this extension opened for it (the agent tab group).
// The user's own tabs are never attached, reported or closed.

const DEFAULTS = { server: 'http://127.0.0.1:4318', token: '' };
const GROUP = { title: 'Open Browser Use', color: 'green' };
const state = { status: 'disconnected', error: '' };
const agentTabs = new Set();   // tabs created for the agent (and popups they opened)
const attached = new Set();    // agent tabs with the debugger attached
let ws = null, groupId = null, retryTimer = null, pingTimer = null;

async function settings() { return { ...DEFAULTS, ...(await chrome.storage.local.get(['server', 'token'])) }; }

function setStatus(status, error = '') {
  Object.assign(state, { status, error });
  chrome.runtime.sendMessage({ type: 'status', ...state }).catch(() => {});
  chrome.action.setBadgeText({ text: status === 'connected' ? '' : status === 'unpaired' ? '?' : '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#b45309' }).catch(() => {});
}

function send(message) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }

async function connect() {
  clearTimeout(retryTimer);
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const { server, token } = await settings();
  if (!token) return setStatus('unpaired');
  let url;
  try {
    url = new URL('/relay/extension', server);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('服务器地址必须是本机');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);
  } catch (error) { return setStatus('error', error.message); }
  setStatus('connecting');
  const socket = new WebSocket(url);
  ws = socket;
  socket.onopen = () => {
    setStatus('connected');
    send({ method: 'extension.hello', params: [{ protocolVersion: 1, capabilities: ['tabs.screenshot'], extensionVersion: chrome.runtime.getManifest().version, userAgent: navigator.userAgent, product: `Chrome/${/Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] || ''}` }] });
    clearInterval(pingTimer);
    // Regular traffic keeps the service worker alive while connected.
    pingTimer = setInterval(() => send({ method: 'ping' }), 20000);
  };
  socket.onmessage = async event => {
    const { id, method, params = [] } = JSON.parse(event.data);
    try { send({ id, result: (await handle(method, params)) ?? {} }); }
    catch (error) { send({ id, error: error?.message || String(error) }); }
  };
  socket.onclose = event => {
    if (ws !== socket) return;
    ws = null; clearInterval(pingTimer);
    void endSession();
    setStatus('disconnected', event.reason || '');
    retryTimer = setTimeout(connect, 3000);
  };
}

async function addToGroup(tabId) {
  try {
    if (groupId != null) { await chrome.tabs.group({ groupId, tabIds: [tabId] }); return; }
  } catch { groupId = null; }
  try {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, GROUP);
  } catch { /* tab groups are cosmetic; never fail the task over them */ }
}

function requireAgentTab(tabId) {
  if (!agentTabs.has(tabId)) throw new Error('只能操作代理自己打开的标签页。');
}

async function handle(method, params) {
  switch (method) {
    case 'tabs.create': {
      const [{ url = 'about:blank' } = {}] = params;
      const tab = await chrome.tabs.create({ url, active: true });
      agentTabs.add(tab.id);
      await addToGroup(tab.id);
      return { id: tab.id, url: tab.url || url };
    }
    case 'tabs.remove': {
      const [tabId] = params;
      requireAgentTab(tabId);
      await chrome.tabs.remove(tabId);
      return {};
    }
    case 'debugger.attach': {
      const [tabId] = params;
      requireAgentTab(tabId);
      if (!attached.has(tabId)) { await chrome.debugger.attach({ tabId }, '1.3'); attached.add(tabId); }
      return {};
    }
    case 'debugger.send': {
      const [target, cdpMethod, cdpParams] = params;
      requireAgentTab(target.tabId);
      if (!attached.has(target.tabId)) throw new Error('标签页未连接调试器。');
      return chrome.debugger.sendCommand(target, cdpMethod, cdpParams);
    }
    case 'tabs.screenshot': {
      const [tabId, options] = params;
      requireAgentTab(tabId);
      if (!attached.has(tabId)) throw new Error('标签页未连接调试器。');
      return screenshot({ tabId }, options);
    }
    case 'session.end': await endSession(); return {};
    default: throw new Error(`未知命令 ${method}`);
  }
}

// Page.captureScreenshot with a clip makes Chrome re-render the visible tab with an emulated
// viewport while it captures (the page shrinks or jumps for a frame). Capture the viewport as the
// user sees it and cut out the clip Playwright asked for here, at the size Chrome would return.
async function screenshot(target, { format = 'png', quality, clip }) {
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  const metrics = await send('Page.getLayoutMetrics');
  const shot = await send('Page.captureScreenshot', { format: format === 'jpeg' ? 'jpeg' : 'png', quality: format === 'jpeg' ? 95 : undefined, optimizeForSpeed: true });
  const bytes = atob(shot.data), buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
  const image = await createImageBitmap(new Blob([buffer]));
  // The same device pixel ratio and viewport origin Playwright used to build the clip.
  const ratio = metrics.contentSize.width / metrics.cssContentSize.width || 1;
  const { pageX, pageY, scale: zoom } = metrics.visualViewport;
  const width = Math.max(1, Math.round(clip.width * (clip.scale ?? 1) * ratio)), height = Math.max(1, Math.round(clip.height * (clip.scale ?? 1) * ratio));
  const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, (clip.x - pageX) * ratio, (clip.y - pageY) * ratio, clip.width * zoom * ratio, clip.height * zoom * ratio, 0, 0, width, height);
  image.close();
  const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: quality == null ? undefined : quality / 100 });
  const out = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < out.length; i += 0x8000) binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return { data: btoa(binary) };
}

// Release the debugger; tabs stay open so the user can look at what the agent left.
async function endSession() {
  for (const tabId of attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  attached.clear(); agentTabs.clear(); groupId = null;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (agentTabs.has(source.tabId)) send({ method: 'debugger.event', params: [source, method, params] });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (!agentTabs.has(source.tabId)) return;
  attached.delete(source.tabId);
  send({ method: 'debugger.detached', params: [source.tabId, reason] });
});
// Popups opened by an agent tab belong to the agent too.
chrome.tabs.onCreated.addListener(async tab => {
  if (tab.openerTabId == null || !agentTabs.has(tab.openerTabId)) return;
  agentTabs.add(tab.id);
  await addToGroup(tab.id);
  send({ method: 'tabs.created', params: [{ id: tab.id }] });
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (!agentTabs.delete(tabId)) return;
  attached.delete(tabId);
  send({ method: 'tabs.removed', params: [tabId] });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'get-status') { reply({ ...state }); return; }
  if (message?.type === 'reconnect') { ws?.close(); ws = null; void connect(); reply({ ok: true }); }
});
chrome.storage.onChanged.addListener(changes => { if (changes.server || changes.token) { ws?.close(); ws = null; void connect(); } });
chrome.alarms.create('reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); void connect(); });
chrome.runtime.onStartup.addListener(() => void connect());

// Exposed for tests and debugging from the service worker console.
globalThis.obu = { connect, state, agentTabs };
void connect();
