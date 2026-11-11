import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../lib/browser/session.js';
import { getTool } from '../lib/tools/index.js';

test('virtual pointer reports viewport targets, click and drag feedback without typed contents', async t => {
  const events = [];
  const browser = new BrowserSession({ demoOrigin: 'http://localhost:4318', headless: true, onPointer: data => events.push(data) });
  await browser.open(); t.after(() => browser.close());
  await browser.current().setContent('<button style="margin:40px" onclick="this.textContent=\'clicked\'">Press</button><input aria-label="secret">');
  const tree = (await browser.readTree())[0].nodes;
  const button = tree.find(n => n.name === 'Press').ref;
  await getTool('computer').run({ action: 'left_click', ref: button }, { browser });
  assert.equal(await browser.current().locator('button').textContent(), 'clicked');
  assert.ok(events.some(e => e.action === 'left_click' && e.phase === 'start' && e.coordinate[0] > 40));
  assert.ok(events.every(e => e.viewport.width > 0));
  const input = tree.find(n => n.name === 'secret').ref;
  await getTool('form_input').run({ ref: input, value: 'do-not-expose-typed-content' }, { browser });
  assert.ok(!JSON.stringify(events).includes('do-not-expose'));
  await getTool('computer').run({ action: 'left_click_drag', start_coordinate: [10, 10], coordinate: [100, 100] }, { browser });
  const drag = events.filter(e => e.action === 'left_click_drag');
  assert.equal(drag.filter(e => e.phase === 'move').length, 12);
  assert.deepEqual(drag.at(-1).coordinate, [100, 100]); assert.equal(drag.at(-1).phase, 'complete');
  await browser.current().setContent('<input id="hidden" type="file" hidden>');
  assert.equal(await browser.pointerTarget(await browser.current().$('#hidden')), null);
});
