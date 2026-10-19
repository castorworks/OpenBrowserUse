import { chromium } from 'playwright';
import { allowedURL } from './url.js';
import { detectChannel, launchChannel } from './channel.js';
import { snapshotFrame, elementById } from './page-script.js';

export const VIEWPORT = { width: 1280, height: 800 };
const LOG_LIMIT = 300;

// One agent browser: its pages, stable element refs across reads, and per-tab console/network logs.
export class BrowserSession {
  constructor({ demoOrigin, headless = false, channel = detectChannel() }) {
    Object.assign(this, { demoOrigin, headless, channel });
    this.refs = new Map();       // ref number → { page, frame, localId }
    this.refKeys = new Map();    // `${frameKey}:${localId}` → ref number, so refs stay stable
    this.frameKeys = new WeakMap();
    this.tabIds = new WeakMap();
    this.logs = new WeakMap();
    this.nextRef = 1; this.nextFrame = 1; this.nextTab = 1;
  }

  async open() {
    this.browser = await chromium.launch({ headless: this.headless, ...launchChannel(this.channel) });
    this.context = await this.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block' });
    this.context.setDefaultTimeout(7000);
    this.context.setDefaultNavigationTimeout(20000);
    await this.context.route('**/*', async route => {
      try { allowedURL(route.request().url(), this.demoOrigin); await route.continue(); }
      catch { await route.abort(); }
    });
    this.context.on('page', page => this.track(page));
    this.page = await this.context.newPage();
  }

  track(page) {
    this.tabIds.set(page, this.nextTab++);
    const log = { console: [], network: [] };
    this.logs.set(page, log);
    const push = (list, entry) => { list.push(entry); if (list.length > LOG_LIMIT) list.shift(); };
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('console', m => push(log.console, { type: m.type(), text: m.text().slice(0, 2000) }));
    page.on('pageerror', e => push(log.console, { type: 'error', text: `Uncaught ${e.message}`.slice(0, 2000) }));
    page.on('requestfinished', async r => push(log.network, { method: r.method(), url: r.url().slice(0, 500), type: r.resourceType(), status: (await r.response().catch(() => null))?.status() ?? null }));
    page.on('requestfailed', r => push(log.network, { method: r.method(), url: r.url().slice(0, 500), type: r.resourceType(), status: null, failure: r.failure()?.errorText }));
    // A popup or new tab becomes the active tab, the same way a person's focus would follow it.
    this.page = page;
  }

  pages() { return this.context.pages().filter(p => !p.isClosed()); }
  current() {
    const pages = this.pages();
    if (!pages.length) throw new Error('浏览器窗口已关闭。');
    if (!this.page || this.page.isClosed()) this.page = pages.at(-1);
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
    else await page.goto(allowedURL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`, this.demoOrigin), { waitUntil: 'domcontentloaded' });
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

  // Passwords and file pickers stay with the person (see README safety rules).
  async guardSensitive(handle) {
    const type = handle ? await handle.evaluate(el => (el.getAttribute('type') || '').toLowerCase()) : await this.current().evaluate(() => (document.activeElement?.getAttribute?.('type') || '').toLowerCase()).catch(() => '');
    if (type === 'password' || type === 'file') throw new Error('密码或文件上传需要暂停后人工操作，请使用 ask_user 请用户接管。');
  }

  async screenshot({ clip, quality = 70 } = {}) {
    const buffer = await this.current().screenshot({ type: 'jpeg', quality, timeout: 7000, ...(clip ? { clip } : {}) });
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }

  // What the workbench shows after each step. Not sent to the model.
  async view() {
    const page = this.current();
    return { url: page.url(), title: await page.title().catch(() => ''), tabs: this.tabs(), screenshot: await this.screenshot({ quality: 60 }).catch(() => null) };
  }

  async close() { await this.browser?.close().catch(() => {}); }
}
