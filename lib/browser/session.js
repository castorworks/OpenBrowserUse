import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { allowedURL, localCDPURL, DEFAULT_POLICY } from './url.js';
import { detectChannel, launchChannel } from './channel.js';
import { snapshotFrame, elementById } from './page-script.js';

export const VIEWPORT = { width: 1280, height: 800 };
const LOG_LIMIT = 300;

export const DEFAULT_PROFILE_DIR = join(homedir(), '.openbrowseruse', 'profile');

// One agent browser: its pages, stable element refs across reads, and per-tab console/network logs.
// mode: 'ephemeral' (fresh browser, nothing kept), 'persistent' (dedicated profile that keeps logins),
// 'cdp' (attach to the user's running Chrome; only tabs the agent opens are used or closed).
export class BrowserSession {
  constructor({ demoOrigin, headless = false, channel = detectChannel(), mode = 'ephemeral', profileDir = DEFAULT_PROFILE_DIR, cdpURL, policy = DEFAULT_POLICY, relay }) {
    Object.assign(this, { demoOrigin, headless, channel, mode, profileDir, cdpURL, policy, relay });
    this.refs = new Map();       // ref number → { page, frame, localId }
    this.refKeys = new Map();    // `${frameKey}:${localId}` → ref number, so refs stay stable
    this.frameKeys = new WeakMap();
    this.tabIds = new WeakMap();
    this.logs = new WeakMap();
    this.owned = new Set();      // pages this session may read, act on and close
    this.nextRef = 1; this.nextFrame = 1; this.nextTab = 1;
  }

  guard = async route => {
    try { allowedURL(route.request().url(), this.demoOrigin, this.policy); await route.continue(); }
    catch { await route.abort(); }
  };

  async open() {
    const contextOptions = { viewport: VIEWPORT, deviceScaleFactor: 1, acceptDownloads: true, serviceWorkers: 'allow' };
    if (this.mode === 'extension') {
      // The user's Chrome via the Open Browser Use extension: the relay only exposes agent tabs.
      if (!this.relay?.connected()) throw new Error('Chrome 扩展未连接。请在 Chrome 中安装扩展，并在扩展侧边栏填写配对令牌。');
      await this.relay.prepare();
      this.browser = await chromium.connectOverCDP(this.relay.cdpEndpoint());
      this.context = this.browser.contexts()[0];
      if (!this.context) throw new Error('扩展连接没有返回浏览器上下文。');
    } else if (this.mode === 'cdp') {
      if (!this.cdpURL) throw new Error('未配置 CDP 地址。');
      this.browser = await chromium.connectOverCDP(localCDPURL(this.cdpURL)).catch(() => { throw new Error(`无法连接 ${this.cdpURL}。请用 --remote-debugging-port 启动 Chrome。`); });
      this.context = this.browser.contexts()[0] || await this.browser.newContext(contextOptions);
    } else if (this.mode === 'persistent') {
      await mkdir(this.profileDir, { recursive: true });
      this.context = await chromium.launchPersistentContext(this.profileDir, { headless: this.headless, ...launchChannel(this.channel), ...contextOptions })
        .catch(error => { throw /lock|in use|ProcessSingleton/i.test(error.message) ? new Error('持久化配置正被另一个浏览器窗口使用，请先关闭它。') : error; });
    } else {
      this.browser = await chromium.launch({ headless: this.headless, ...launchChannel(this.channel) });
      this.context = await this.browser.newContext(contextOptions);
    }
    this.context.setDefaultTimeout(7000);
    this.context.setDefaultNavigationTimeout(20000);
    if (this.mode === 'cdp') {
      // The user's own tabs live in this context: guard and follow only pages we open.
      this.page = await this.newPage();
    } else {
      await this.context.route('**/*', this.guard);
      this.context.on('page', page => this.track(page));
      for (const page of this.context.pages()) this.track(page);
      this.page = this.context.pages().at(-1) || await this.context.newPage();
    }
  }

  async newPage() {
    const page = await this.context.newPage();
    if (this.mode === 'cdp') { await this.track(page); await page.setViewportSize(VIEWPORT); }
    return page;
  }

  async track(page) {
    if (this.owned.has(page)) return;
    this.owned.add(page);
    this.tabIds.set(page, this.nextTab++);
    const log = { console: [], network: [] };
    this.logs.set(page, log);
    const push = (list, entry) => { list.push(entry); if (list.length > LOG_LIMIT) list.shift(); };
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('console', m => push(log.console, { type: m.type(), text: m.text().slice(0, 2000) }));
    page.on('pageerror', e => push(log.console, { type: 'error', text: `Uncaught ${e.message}`.slice(0, 2000) }));
    page.on('requestfinished', async r => push(log.network, { method: r.method(), url: r.url().slice(0, 500), type: r.resourceType(), status: (await r.response().catch(() => null))?.status() ?? null }));
    page.on('requestfailed', r => push(log.network, { method: r.method(), url: r.url().slice(0, 500), type: r.resourceType(), status: null, failure: r.failure()?.errorText }));
    page.on('close', () => this.owned.delete(page));
    // Extension tabs keep the real window size, including the space occupied by the side panel.
    if (this.mode === 'cdp') {
      page.on('popup', popup => this.track(popup));
      await page.route('**/*', this.guard);
    }
    // A popup or new tab becomes the active tab, the same way a person's focus would follow it.
    this.page = page;
  }

  pages() { return [...this.owned].filter(p => !p.isClosed()); }
  current() {
    const pages = this.pages();
    if (!pages.length) throw new Error('浏览器窗口已关闭。');
    if (!this.page || this.page.isClosed() || !this.owned.has(this.page)) this.page = pages.at(-1);
    return this.page;
  }
  tabId(page) { return this.tabIds.get(page); }
  tabs() { const active = this.current(); return this.pages().map(p => ({ tabId: this.tabId(p), url: p.url(), active: p === active })); }
  pageByTab(tabId) {
    const page = this.pages().find(p => this.tabId(p) === tabId);
    if (!page) throw new Error(`标签页 ${tabId} 不存在。`);
    return page;
  }
  log(page = this.current()) { return this.logs.get(page) || { console: [], network: [] }; }

  async navigate(url) {
    const page = this.current();
    if (url === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
    else if (url === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
    else await page.goto(allowedURL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`, this.demoOrigin, this.policy), { waitUntil: 'domcontentloaded' });
  }

  frameKey(frame) {
    if (!this.frameKeys.has(frame)) this.frameKeys.set(frame, this.nextFrame++);
    return this.frameKeys.get(frame);
  }

  // Accessibility-style tree for every frame of the active tab, with ref_N ids the model can act on.
  async readTree({ filter = 'interactive', maxDepth = 40 } = {}) {
    const page = this.current();
    const sections = [];
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      const snap = await frame.evaluate(snapshotFrame, { filter, maxDepth }).catch(() => null);
      if (!snap) continue;
      const fk = this.frameKey(frame);
      const nodes = snap.nodes.map(n => {
        if (n.id == null) return n;
        const key = `${fk}:${n.id}`;
        let ref = this.refKeys.get(key);
        if (!ref) { ref = this.nextRef++; this.refKeys.set(key, ref); }
        this.refs.set(ref, { page, frame, localId: n.id, label: `${n.role} "${n.name}"` });
        return { ...n, ref: `ref_${ref}` };
      });
      sections.push({ main: frame === page.mainFrame(), url: snap.url, title: snap.title, nodes, truncated: snap.truncated });
    }
    return sections;
  }

  refLabel(ref) { return this.refs.get(Number(String(ref).replace(/^ref_/, '')))?.label; }

  async resolve(ref) {
    const num = Number(String(ref).replace(/^ref_/, ''));
    const entry = this.refs.get(num);
    if (!entry) throw new Error(`未知元素 ${ref}，请先调用 read_page 或 find。`);
    if (entry.page !== this.current()) throw new Error(`${ref} 属于其他标签页，请先切换标签页或重新读取页面。`);
    const handle = entry.frame.isDetached() ? null : (await entry.frame.evaluateHandle(elementById, entry.localId).catch(() => null))?.asElement();
    if (!handle) throw new Error(`${ref} 已从页面移除，请重新调用 read_page。`);
    return handle;
  }

  // What a tool call would touch, for permission rules and the reviewer. Best effort: never throws.
  async describeTarget(tool, input) {
    const page = this.current();
    let handle = null;
    try {
      if (input.ref) handle = await this.resolve(input.ref);
      else if (input.coordinate) handle = (await page.evaluateHandle(([x, y]) => document.elementFromPoint(x, y), input.coordinate)).asElement();
      else if (tool === 'computer' && ['type', 'key'].includes(input.action)) {
        handle = (await page.evaluateHandle(() => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el; })).asElement();
      }
    } catch { handle = null; }
    if (!handle) return { url: page.url() };
    const info = await handle.evaluate(el => {
      const control = el.closest?.('button,a,input,select,textarea,[role=button],[role=link]') || el;
      const form = control.form || control.closest?.('form');
      const type = (control.getAttribute?.('type') || '').toLowerCase();
      const tag = control.tagName.toLowerCase();
      const submit = (tag === 'button' && (!type || type === 'submit') && Boolean(form)) || (tag === 'input' && ['submit', 'image'].includes(type));
      const formOrigin = form ? new URL(form.getAttribute('action') || location.href, location.href).origin : null;
      const buttonValue = tag === 'input' && ['submit', 'button', 'reset'].includes(type) ? control.value : '';
      const label = (control.getAttribute('aria-label') || buttonValue || (['input', 'textarea', 'select'].includes(tag) ? control.labels?.[0]?.innerText : control.innerText) || control.getAttribute('title') || control.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return { label, tag, type, name: control.getAttribute('name') || '', id: control.id || '', autocomplete: control.getAttribute('autocomplete') || '', password: type === 'password', file: type === 'file', submit, inForm: Boolean(form), formOrigin, crossOriginForm: Boolean(formOrigin) && formOrigin !== location.origin };
    }).catch(() => ({}));
    return { url: page.url(), ...info };
  }

  async screenshot({ clip, quality = 70, format = 'jpeg' } = {}) {
    const buffer = await this.current().screenshot({ type: format, scale: 'css', caret: 'initial', ...(format === 'jpeg' ? { quality } : {}), timeout: 7000, ...(clip ? { clip } : {}) });
    return `data:image/${format};base64,${buffer.toString('base64')}`;
  }

  // Live view: stream JPEG frames of the active tab over CDP. syncScreencast() follows tab switches.
  async screencast(onFrame) { this.onFrame = onFrame; await this.syncScreencast(); }
  async syncScreencast() {
    if (!this.onFrame || this.casting) return;
    let page;
    try { page = this.current(); } catch { return; }
    if (this.castPage === page) return;
    this.casting = true;
    try {
      await this.stopScreencast();
      const cdp = await this.context.newCDPSession(page);
      this.cast = cdp; this.castPage = page;
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => { cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {}); this.onFrame?.(data); });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 2 });
    } catch { this.castPage = null; } finally { this.casting = false; }
  }
  async stopScreencast() {
    const cdp = this.cast; this.cast = null; this.castPage = null;
    await cdp?.send('Page.stopScreencast').catch(() => {});
    await cdp?.detach().catch(() => {});
  }

  // What the workbench shows after each step. Not sent to the model.
  async view() {
    const page = this.current();
    return { url: page.url(), title: await page.title().catch(() => ''), tabs: this.tabs(), screenshot: await this.screenshot({ quality: 60 }).catch(() => null) };
  }

  // CDP: close only our tabs and disconnect; the user's Chrome keeps running.
  async close() {
    this.onFrame = null;
    await this.stopScreencast();
    if (this.mode === 'cdp') {
      await Promise.all(this.pages().map(p => p.close().catch(() => {})));
      await this.browser?.close().catch(() => {});
    } else if (this.mode === 'extension') {
      await Promise.all(this.pages().map(p => p.close().catch(() => {})));
      await this.browser?.close().catch(() => {});
    } else if (this.mode === 'persistent') await this.context?.close().catch(() => {});
    else await this.browser?.close().catch(() => {});
  }
}
