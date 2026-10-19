import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ROOT_SESSION = 'obu-browser-root';
const sameToken = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Bridges Playwright to the Open Browser Use Chrome extension.
 *
 * Playwright connects to /relay/cdp/<secret> as if it were a Chrome DevTools endpoint.
 * Browser-level target management is emulated here; page commands are forwarded to the
 * extension, which runs them with chrome.debugger on tabs it created itself (the agent's
 * tab group). The extension never exposes the user's other tabs, so neither can we.
 * Modeled on Playwright's own extension relay (playwright-core tools/mcp/cdpRelay).
 */
export class ExtensionRelay {
  constructor({ token = randomBytes(18).toString('base64url') } = {}) {
    this.token = token;
    this.cdpPath = `/relay/cdp/${randomUUID()}`;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this.extension = null;  // { ws, pending: Map, nextId }
    this.cdp = null;        // the Playwright WebSocket
    this.info = null;       // what the extension reported on connect
    this.reset();
  }

  reset() {
    this.tabs = new Map();      // tabId → { tabId, sessionId, targetInfo, children: Set, virtual: Set }
    this.known = new Set();     // agent tabs reported by the extension, attached on auto-attach
    this.autoAttach = false;
    this.nextSession = 1;
  }

  connected() { return Boolean(this.extension); }
  status() { return { connected: this.connected(), browser: this.info?.userAgent || null }; }

  close() {
    // HTTP server.close() does not close upgraded WebSocket connections. Leaving
    // them alive strands the extension on a retired server after a restart.
    for (const ws of this.wss.clients) ws.terminate();
    this.extension = null;
    this.info = null;
    this.cdp = null;
    this.reset();
    this.wss.close();
  }

  // Accept upgrades on the app's HTTP server. Host, origin and token checks happen here
  // because WebSocket upgrades bypass the Express middleware.
  attach(server, port) {
    this.port = port;
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      const deny = () => { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); };
      if (!url.pathname.startsWith('/relay/')) return socket.destroy();
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) || !LOOPBACK.has(req.socket.remoteAddress)) return deny();
      if (url.pathname === '/relay/extension') {
        if (!String(req.headers.origin || '').startsWith('chrome-extension://') || !sameToken(url.searchParams.get('token'), this.token)) return deny();
        return this.wss.handleUpgrade(req, socket, head, ws => this.onExtension(ws));
      }
      if (url.pathname === this.cdpPath && !req.headers.origin) return this.wss.handleUpgrade(req, socket, head, ws => this.onPlaywright(ws));
      deny();
    });
  }

  cdpEndpoint() { return `ws://127.0.0.1:${this.port}${this.cdpPath}`; }

  // ── Extension side ──────────────────────────────────────────────────────
  onExtension(ws) {
    if (this.extension) this.extension.ws.close(1000, 'Replaced by a new connection');
    const ext = { ws, pending: new Map(), nextId: 1 };
    this.extension = ext;
    ws.on('message', data => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return ws.close(1003, 'Bad JSON'); }
      if (msg.id && ext.pending.has(msg.id)) {
        const { resolve, reject } = ext.pending.get(msg.id); ext.pending.delete(msg.id);
        return msg.error ? reject(new Error(msg.error)) : resolve(msg.result);
      }
      this.onExtensionEvent(msg.method, msg.params || []);
    });
    ws.on('close', () => {
      for (const { reject } of ext.pending.values()) reject(new Error('扩展已断开连接。'));
      if (this.extension === ext) { this.extension = null; this.info = null; this.cdp?.close(1000, 'Extension disconnected'); }
    });
  }

  call(method, ...params) {
    const ext = this.extension;
    if (!ext) return Promise.reject(new Error('Chrome 扩展未连接。'));
    const id = ext.nextId++;
    ext.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      ext.pending.set(id, { resolve, reject });
      setTimeout(() => { if (ext.pending.delete(id)) reject(new Error(`扩展响应超时：${method}`)); }, 30000);
    });
  }

  onExtensionEvent(method, params) {
    if (method === 'extension.hello') { this.info = params[0] || {}; return; }
    if (method === 'tabs.created') { const [tab] = params; this.known.add(tab.id); if (this.autoAttach) void this.attachTab(tab.id).catch(() => {}); return; }
    if (method === 'tabs.removed' || method === 'debugger.detached') { const [tabId] = params; this.known.delete(tabId); return this.detachTab(tabId); }
    if (method === 'debugger.event') {
      const [source, cdpMethod, cdpParams] = params;
      const tab = this.tabs.get(source.tabId);
      if (!tab) return;
      const child = cdpParams?.sessionId;
      if (cdpMethod === 'Target.attachedToTarget' && child) tab.children.add(child);
      if (cdpMethod === 'Target.detachedFromTarget' && child) tab.children.delete(child);
      if (source.sessionId) return this.emit({ sessionId: source.sessionId, method: cdpMethod, params: cdpParams });
      // Page-level events also go to extra sessions Playwright opened on the same tab (e.g. screencast).
      for (const sessionId of [tab.sessionId, ...tab.virtual]) this.emit({ sessionId, method: cdpMethod, params: cdpParams });
    }
  }

  // Ask the extension for a fresh agent tab before Playwright connects, so the browser is never empty.
  async prepare(url = 'about:blank') {
    const tab = await this.call('tabs.create', { url });
    this.known.add(tab.id);
    return tab;
  }

  // ── Playwright side ─────────────────────────────────────────────────────
  onPlaywright(ws) {
    if (!this.extension || this.cdp) return ws.close(1000, this.cdp ? 'Another client is connected' : 'Extension not connected');
    this.cdp = ws;
    ws.on('message', async data => {
      const { id, sessionId, method, params } = JSON.parse(data.toString());
      try { this.send({ id, sessionId, result: await this.command(method, params || {}, sessionId) }); }
      catch (error) { this.send({ id, sessionId, error: { message: error.message } }); }
    });
    ws.on('close', () => {
      if (this.cdp !== ws) return;
      this.cdp = null;
      // Playwright is gone: release every tab (the extension detaches its debugger).
      void this.call('session.end').catch(() => {});
      this.reset();
    });
  }

  send(message) { if (this.cdp?.readyState === 1) this.cdp.send(JSON.stringify(message)); }
  emit(message) { this.send(message); }

  async command(method, params, sessionId) {
    // Playwright opens extra page sessions through a browser "root" session; treat it as browser-level.
    if (sessionId === ROOT_SESSION) sessionId = undefined;
    if (!sessionId) {
      switch (method) {
        case 'Target.attachToBrowserTarget': return { sessionId: ROOT_SESSION };
        case 'Target.getTargetInfo': return { targetInfo: { targetId: 'obu-browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
        case 'Browser.getVersion': return { protocolVersion: '1.3', product: this.info?.product || 'Chrome/OpenBrowserUse-Extension', userAgent: this.info?.userAgent || '', jsVersion: '' };
        case 'Browser.setDownloadBehavior': return {};
        case 'Target.setAutoAttach':
          this.autoAttach = true;
          await Promise.all([...this.known].map(tabId => this.attachTab(tabId).catch(() => {})));
          return {};
        case 'Target.setDiscoverTargets': return {};
        case 'Target.getTargets': return { targetInfos: [...this.tabs.values()].map(t => ({ ...t.targetInfo, attached: true })) };
        case 'Target.createTarget': {
          const tab = await this.call('tabs.create', { url: params.url || 'about:blank' });
          this.known.add(tab.id);
          return { targetId: (await this.attachTab(tab.id)).targetInfo.targetId };
        }
        case 'Target.closeTarget': {
          const tab = this.find(t => t.targetInfo.targetId === params.targetId);
          if (!tab) return { success: false };
          await this.call('tabs.remove', tab.tabId);
          return { success: true };
        }
        case 'Target.attachToTarget': {
          // An extra session on a tab we already drive (Playwright uses these for page.context().newCDPSession).
          const tab = this.find(t => t.targetInfo.targetId === params.targetId);
          if (!tab) throw new Error('只能连接代理自己的标签页。');
          const virtualId = `obu-v-${this.nextSession++}`;
          tab.virtual.add(virtualId);
          return { sessionId: virtualId };
        }
        case 'Target.detachFromTarget': {
          for (const tab of this.tabs.values()) tab.virtual.delete(params.sessionId);
          return {};
        }
      }
      // Other browser-scoped commands run through any attached tab.
      const any = this.tabs.values().next().value;
      if (!any) throw new Error(`没有可用的代理标签页：${method}`);
      return this.call('debugger.send', { tabId: any.tabId }, method, params);
    }
    if (method === 'Target.getTargetInfo') { const tab = this.find(t => t.sessionId === sessionId); if (tab) return { targetInfo: tab.targetInfo }; }
    const main = this.find(t => t.sessionId === sessionId || t.virtual.has(sessionId));
    // Chrome captures a clip by briefly emulating a different viewport on the visible tab, which
    // the user sees as a flash. The extension captures the tab as it is and crops/scales the image.
    if (main && method === 'Page.captureScreenshot' && params.clip && !params.captureBeyondViewport) return this.call('tabs.screenshot', main.tabId, params);
    if (main) return this.call('debugger.send', { tabId: main.tabId }, method, params);
    const owner = this.find(t => t.children.has(sessionId));
    if (owner) return this.call('debugger.send', { tabId: owner.tabId, sessionId }, method, params);
    throw new Error(`未知会话 ${sessionId}`);
  }

  find(predicate) { for (const t of this.tabs.values()) if (predicate(t)) return t; return null; }

  async attachTab(tabId) {
    if (this.tabs.has(tabId)) return this.tabs.get(tabId);
    await this.call('debugger.attach', tabId);
    const { targetInfo } = await this.call('debugger.send', { tabId }, 'Target.getTargetInfo', {});
    const tab = { tabId, sessionId: `obu-tab-${this.nextSession++}`, targetInfo, children: new Set(), virtual: new Set() };
    this.tabs.set(tabId, tab);
    this.emit({ method: 'Target.attachedToTarget', params: { sessionId: tab.sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false } });
    return tab;
  }

  detachTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    this.emit({ method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetInfo.targetId } });
  }
}
