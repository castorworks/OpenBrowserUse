import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../lib/browser/session.js';
import { getTool } from '../lib/tools/index.js';
import { OpenAIProvider } from '../lib/providers/openai.js';
import { reviewerInput } from '../lib/permissions/reviewer.js';

test('document navigation invalidates refs and keyboard ref controls focus', async t => {
  const b = new BrowserSession({ headless: true, demoOrigin: 'http://127.0.0.1:4318' });
  await b.open(); t.after(() => b.close());
  await assert.rejects(b.navigate('http://localhost:4318/api/state'), /管理接口/);
  assert.equal(b.current().url(), 'about:blank');
  await b.navigate('data:text/html,<button>Search</button>');
  const old = (await b.readTree())[0].nodes[0].ref;
  await b.navigate('data:text/html,<button>Delete</button><input aria-label="target"><input id="other" value="123">');
  const tree = (await b.readTree())[0].nodes;
  assert.notEqual(tree[0].ref, old);
  await assert.rejects(b.resolve(old), /移除/);
  await b.current().locator('#other').focus();
  await getTool('computer').run({ action: 'key', ref: tree.find(n => n.name === 'target').ref, text: 'End Backspace' }, { browser: b });
  assert.equal(await b.current().locator('#other').inputValue(), '123');
});

test('script cancellation releases the pending operation', async t => {
  const b = new BrowserSession({ headless: true, demoOrigin: 'http://127.0.0.1:4318' });
  await b.open(); t.after(() => b.close());
  const controller = new AbortController();
  const pending = getTool('javascript').run({ code: 'window.started=true; await new Promise(() => {})' }, { browser: b, signal: controller.signal });
  const rejected = assert.rejects(pending, /取消/);
  await b.current().waitForFunction(() => window.started);
  controller.abort(); await rejected;
});

test('review includes actual script and batched images keep the latest two', () => {
  assert.equal(JSON.parse(reviewerInput({ input: { code: 'return 42' } })).input.code, 'return 42');
  const p = new OpenAIProvider({ baseURL: 'http://localhost', vision: true }, { system: 's', tools: [] });
  p.addToolResults([1,2,3].map(id => ({ id, image: `image${id}` }))); p.flush();
  const images = p.outgoing().flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url');
  assert.deepEqual(images.map(p => p.image_url.url), ['image2', 'image3']);
});

import { ConfigStore } from '../lib/config-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize } from '../lib/permissions/policy.js';
import { trimImages } from '../lib/providers/budget.js';

test('browser settings and protected sites survive a fresh store', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-browser-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const browser = { mode: 'cdp', cdpURL: 'http://localhost:9222', allowLocalhost: true, allowPrivateNetwork: false, blockedSites: ['protected.example'] };
  new ConfigStore({ dir }).save({ provider: 'openai', baseURL: 'http://localhost', model: 'test', apiKey: '', effort: 'high', vision: false, reviewerModel: '', browser });
  assert.deepEqual(new ConfigStore({ dir }).load().browser, browser);
});

test('protected frame origin takes precedence over allowed top page', async () => {
  const result = await authorize({ mode: 'auto', tool: getTool('computer'), input: { action: 'left_click', ref: 'ref_1' },
    browser: { current: () => ({ url: () => 'https://allowed.example' }), describeTarget: async () => ({ url: 'https://protected.example/frame' }) },
    store: { get: () => undefined }, taskSites: new Set(['allowed.example']), blockedSites: ['protected.example'], review: () => { throw new Error('must not review'); } });
  assert.equal(result.action, 'block');
});

test('native Anthropic image storage is bounded without dropping tool results', () => {
  const messages = [{ role: 'user', content: [1,2,3].map(id => ({ type: 'tool_result', tool_use_id: String(id), content: [{ type: 'image', source: { data: String(id) } }] })) }];
  trimImages(messages);
  assert.equal(messages[0].content.length, 3);
  assert.equal(messages[0].content[0].content[0].type, 'text');
  assert.equal(messages[0].content[2].content[0].source.data, '3');
});

test('management API routing blocks same-origin fetches from agent pages', async () => {
  const b = new BrowserSession({ demoOrigin: 'http://127.0.0.1:4318' });
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    let blocked = false, continued = false;
    await b.guard({ request: () => ({ url: () => `http://${host}:4318/api/extension/token` }), abort: async () => { blocked = true; }, continue: async () => { continued = true; } });
    assert.equal(blocked, true); assert.equal(continued, false);
  }
});
