import { z } from 'zod';

const settle = () => new Promise(r => setTimeout(r, 350));

export const navigationTools = [
  {
    name: 'navigate',
    description: 'Go to a URL in the active tab, or pass "back" / "forward" for history. Returns the resulting title and URL.',
    schema: z.object({ url: z.string().min(1).max(4000) }),
    async run({ url }, { browser }) {
      await browser.navigate(url);
      const page = browser.current();
      return { text: `已打开：${await page.title().catch(() => '')} — ${page.url()}` };
    },
  },
  {
    name: 'tabs',
    description: 'Manage tabs of the agent browser. action=list shows tabs with tabId; new opens a tab (optional url) and makes it active; switch makes tabId active; close closes tabId.',
    schema: z.object({ action: z.enum(['list', 'new', 'switch', 'close']), tabId: z.number().int().optional(), url: z.string().max(4000).optional() }),
    async run({ action, tabId, url }, { browser }) {
      if (action === 'new') { await browser.newPage(); if (url) await browser.navigate(url); }
      else if (action === 'switch') { const p = browser.pageByTab(tabId); browser.page = p; await p.bringToFront(); }
      else if (action === 'close') { await browser.pageByTab(tabId).close(); browser.current(); }
      return { text: browser.tabs().map(t => `${t.active ? '*' : ' '} tab ${t.tabId}: ${t.url}`).join('\n') };
    },
  },
  {
    name: 'form_input',
    description: 'Set a form control by ref: text for inputs/textareas, an option value or label for selects, true/false for checkboxes and radios. Replaces the current value.',
    schema: z.object({ ref: z.string().regex(/^ref_\d+$/), value: z.union([z.string().max(12000), z.boolean(), z.number()]) }),
    mutating: () => true,
    async run({ ref, value }, { browser }) {
      const handle = await browser.resolve(ref);
      await browser.guardSensitive(handle);
      const kind = await handle.evaluate(el => (el.tagName === 'SELECT' ? 'select' : ['checkbox', 'radio'].includes(el.type) ? 'check' : 'text'));
      if (kind === 'select') {
        const v = String(value);
        await handle.selectOption({ value: v }).catch(() => handle.selectOption({ label: v }));
      } else if (kind === 'check') await handle.setChecked(value === true || value === 'true');
      else await handle.fill(String(value));
      await settle();
      return { text: `已设置 ${ref}。` };
    },
  },
];
