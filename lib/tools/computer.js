import { z } from 'zod';

const KEYS = {
  ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', super: 'Meta', win: 'Meta', alt: 'Alt', option: 'Alt', shift: 'Shift',
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', insert: 'Insert',
};
export const normalizeKey = combo => combo.split('+').map(k => KEYS[k.toLowerCase()] || (/^f\d{1,2}$/i.test(k) ? k.toUpperCase() : k)).join('+');

// Plain arrays (not tuples) keep the JSON schema simple for OpenAI-compatible providers.
const point = z.array(z.number().nonnegative()).length(2).describe('[x, y] in screenshot pixels, inside the current viewport');
const ACTIONS = ['screenshot', 'left_click', 'right_click', 'double_click', 'triple_click', 'type', 'key', 'scroll', 'left_click_drag', 'hover', 'zoom', 'wait'];
// Actions that change the page and need approval when auto-interact is off.
export const MUTATING = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'type', 'key', 'left_click_drag']);
const CLICKS = { left_click: ['left', 1], right_click: ['right', 1], double_click: ['left', 2], triple_click: ['left', 3] };

const settle = () => new Promise(r => setTimeout(r, 350));
async function where(browser) { const p = browser.current(); return `当前页面：${await p.title().catch(() => '')} — ${p.url()}`; }

export const computerTool = {
  name: 'computer',
  description: `Mouse, keyboard and screen for the active tab. Screenshot pixels equal click coordinates. Extension mode uses the actual window viewport; read screenshot dimensions instead of assuming a fixed size.
Actions: screenshot; left_click/right_click/double_click/triple_click (coordinate or ref); type (text into the focused element); key (e.g. "Enter", "ctrl+a", "cmd+l", space-separated for a sequence; repeat optional); scroll (coordinate or ref, scroll_direction, scroll_amount ticks); left_click_drag (start_coordinate → coordinate); hover (coordinate or ref); zoom (region [x0,y0,x1,y1] for a lossless PNG crop of small text or image details); wait (duration seconds, max 10).
Prefer refs from read_page/find when the element has one; use coordinates for canvas, maps, custom widgets or when refs fail.`,
  schema: z.object({
    action: z.enum(ACTIONS),
    coordinate: point.optional(), start_coordinate: point.optional(),
    ref: z.string().regex(/^ref_\d+$/).optional(),
    text: z.string().max(12000).optional(), repeat: z.number().int().min(1).max(50).optional(),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(), scroll_amount: z.number().int().min(1).max(20).optional(),
    region: z.array(z.number()).length(4).optional().describe('[x0, y0, x1, y1]'),
    duration: z.number().min(0).max(10).optional(),
  }),
  mutating: input => MUTATING.has(input.action),
  async run(input, { browser }) {
    const page = browser.current();
    const { action, coordinate, ref } = input;
    const target = async () => {
      if (ref) return { handle: await browser.resolve(ref) };
      if (coordinate) return { coordinate };
      throw new Error(`${action} 需要 coordinate 或 ref。`);
    };
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    for (const p of [coordinate, input.start_coordinate]) {
      if (p && (p[0] >= viewport.width || p[1] >= viewport.height)) throw new Error(`coordinate must be inside ${viewport.width}x${viewport.height}`);
    }
    if (action === 'screenshot') return { text: `截图 ${viewport.width}x${viewport.height}。${await where(browser)}`, image: await browser.screenshot() };
    if (action === 'zoom') {
      if (!input.region) throw new Error('zoom 需要 region [x0,y0,x1,y1]。');
      const [x0, y0, x1, y1] = input.region;
      if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > viewport.width || y1 > viewport.height) throw new Error('region 必须位于当前视口内，且 x1>x0、y1>y0。');
      return { text: `区域 (${x0},${y0})-(${x1},${y1}) 的放大图。`, image: await browser.screenshot({ clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, format: 'png' }) };
    }
    if (action === 'wait') { await new Promise(r => setTimeout(r, (input.duration ?? 1) * 1000)); return { text: `已等待。${await where(browser)}` }; }
    if (action in CLICKS) {
      const [button, clickCount] = CLICKS[action];
      const t = await target();
      if (t.handle) { await t.handle.click({ button, clickCount }); }
      else await page.mouse.click(...t.coordinate, { button, clickCount });
      await settle();
      return { text: `已${action}${ref ? ` ${ref}` : ` (${coordinate.join(', ')})`}。${await where(browser)}` };
    }
    if (action === 'hover') {
      const t = await target();
      if (t.handle) await t.handle.hover(); else await page.mouse.move(...t.coordinate);
      return { text: `已悬停。${await where(browser)}` };
    }
    if (action === 'type') {
      if (input.text == null) throw new Error('type 需要 text。');
      if (ref) { const h = await browser.resolve(ref); await h.focus(); }
      await page.keyboard.type(input.text, { delay: 10 });
      await settle();
      return { text: `已输入 ${input.text.length} 个字符。${await where(browser)}` };
    }
    if (action === 'key') {
      if (!input.text) throw new Error('key 需要 text，例如 "Enter" 或 "ctrl+a"。');
      for (let i = 0; i < (input.repeat ?? 1); i++) for (const combo of input.text.trim().split(/\s+/)) await page.keyboard.press(normalizeKey(combo));
      await settle();
      return { text: `已按键 ${input.text}。${await where(browser)}` };
    }
    if (action === 'scroll') {
      const ticks = (input.scroll_amount ?? 3) * 100;
      const dir = input.scroll_direction ?? 'down';
      if (ref) await (await browser.resolve(ref)).scrollIntoViewIfNeeded();
      else {
        await page.mouse.move(...(coordinate || [viewport.width / 2, viewport.height / 2]));
        await page.mouse.wheel(dir === 'left' ? -ticks : dir === 'right' ? ticks : 0, dir === 'up' ? -ticks : dir === 'down' ? ticks : 0);
      }
      await settle();
      const pos = await page.evaluate(() => `scrollY=${Math.round(scrollY)} / ${document.documentElement.scrollHeight - innerHeight}`).catch(() => '');
      return { text: `已滚动${ref ? `到 ${ref}` : ` ${dir}`}。${pos}` };
    }
    if (action === 'left_click_drag') {
      if (!input.start_coordinate || !coordinate) throw new Error('left_click_drag 需要 start_coordinate 和 coordinate。');
      await page.mouse.move(...input.start_coordinate); await page.mouse.down();
      await page.mouse.move(...coordinate, { steps: 12 }); await page.mouse.up();
      await settle();
      return { text: `已拖动。${await where(browser)}` };
    }
    throw new Error(`未知动作 ${action}`);
  },
};
