import { chromium } from 'playwright';

export function allowedURL(raw, demoOrigin) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('只允许 HTTP(S) 网页地址。');
  const h = u.hostname.toLowerCase();
  const local = h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '[::]' || h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('[fe80:') || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (local && !(u.origin === demoOrigin && u.pathname.startsWith('/demo'))) throw new Error('原型不允许访问本机和内网地址（内置演示除外）。');
  return u.href;
}

export class BrowserSession {
  constructor({ demoOrigin, headless = false, channel = process.env.BROWSER_CHANNEL || 'msedge' }) {
    Object.assign(this, { demoOrigin, headless, channel, handles: new Map() });
  }
  async open() {
    this.browser = await chromium.launch({ headless: this.headless, ...(this.channel === 'chromium' ? {} : { channel: this.channel }) });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: 'block' });
    this.context.setDefaultTimeout(7000);
    this.context.setDefaultNavigationTimeout(20000);
    await this.context.route('**/*', async route => {
      try { allowedURL(route.request().url(), this.demoOrigin); await route.continue(); }
      catch { await route.abort(); }
    });
    this.context.on('page', page => { this.page = page; page.on('dialog', dialog => dialog.dismiss().catch(() => {})); });
    this.page = await this.context.newPage();
  }
  async snapshot() {
    const pages = this.context.pages().filter(p => !p.isClosed());
    if (!pages.length) throw new Error('浏览器窗口已关闭。');
    if (this.page.isClosed()) this.page = pages.at(-1);
    await Promise.all([...this.handles.values()].map(({ handle }) => handle.dispose().catch(() => {})));
    this.handles.clear();
    const handles = await this.page.$$('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],[tabindex="0"]');
    const elements = [];
    for (const handle of handles) {
      if (elements.length >= 100 || !(await handle.isVisible().catch(() => false))) { await handle.dispose(); continue; }
      const detail = await handle.evaluate(el => ({
        tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '',
        label: (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 180),
        href: el.getAttribute('href'), disabled: Boolean(el.disabled),
        options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 30).map(o => ({ value: o.value, label: o.text })) : undefined,
      }));
      const id = elements.length + 1;
      this.handles.set(id, { handle, detail, url: this.page.url(), page: this.page });
      elements.push({ id, ...detail });
    }
    const text = await this.page.locator('body').innerText({ timeout: 7000 }).catch(() => '');
    const screenshot = await this.page.screenshot({ type: 'jpeg', quality: 65, timeout: 7000 }).catch(() => null);
    return { url: this.page.url(), title: await this.page.title(), text: text.slice(0, 16000), elements, tabs: pages.map((p, id) => ({ id, url: p.url() })), screenshot: screenshot ? `data:image/jpeg;base64,${screenshot.toString('base64')}` : null };
  }
  async execute(action) {
    const page = this.page;
    if (action.type === 'navigate') await page.goto(allowedURL(action.url, this.demoOrigin), { waitUntil: 'domcontentloaded' });
    else if (action.type === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
    else if (action.type === 'scroll') await page.mouse.wheel(0, action.direction === 'down' ? 650 : -650);
    else if (action.type === 'wait') await new Promise(r => setTimeout(r, 1000));
    else if (action.type === 'switch_tab') {
      const target = this.context.pages().filter(p => !p.isClosed())[action.tab];
      if (!target) throw new Error('标签页已不存在。');
      this.page = target; await target.bringToFront();
    } else {
      const item = this.handles.get(action.element);
      if (!item || item.page !== page || item.url !== page.url()) throw new Error('页面已变化，需要重新观察。');
      const currentLabel = await item.handle.evaluate(el => (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 180));
      if (currentLabel !== item.detail.label) throw new Error('目标元素已变化，需要重新观察。');
      if (item.detail.type === 'password' || item.detail.type === 'file') throw new Error('密码或文件上传需要暂停后人工操作。');
      if (action.type === 'click') await item.handle.click();
      if (action.type === 'fill') await item.handle.fill(action.text);
      if (action.type === 'select') await item.handle.selectOption(action.value);
      if (action.type === 'press') await item.handle.press(action.key);
    }
    await new Promise(r => setTimeout(r, 350));
  }
  async close() { await this.browser?.close().catch(() => {}); }
}
