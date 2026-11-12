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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize } from '../lib/permissions/policy.js';
import { trimImages } from '../lib/providers/budget.js';

test('browser settings and protected sites survive a fresh store', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-browser-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const browser = { mode: 'extension', allowLocalhost: true, allowPrivateNetwork: false, blockedSites: ['protected.example'] };
  new ConfigStore({ dir }).save({ provider: 'openai', baseURL: 'http://localhost', model: 'test', apiKey: '', effort: 'high', vision: false, reviewerModel: '', browser });
  assert.deepEqual(new ConfigStore({ dir }).load().browser, browser);
});

test('protected frame origin takes precedence over allowed top page', async () => {
  const result = await authorize({ mode: 'auto', tool: getTool('computer'), input: { action: 'left_click', ref: 'ref_1' },
    browser: { current: () => ({ url: () => 'https://allowed.example' }), describeTarget: async () => ({ url: 'https://protected.example/frame' }) },
    store: { get: () => undefined }, taskSites: new Set(['allowed.example']), blockedSites: ['protected.example'], review: () => { throw new Error('must not review'); } });
  assert.equal(result.action, 'block');
});

test('native OpenAI image storage is bounded without dropping text', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'keep me' }, ...[1,2,3].map(id => ({ type: 'image_url', image_url: { url: String(id) } }))] }];
  trimImages(messages);
  assert.equal(messages[0].content.length, 4);
  assert.equal(messages[0].content[0].text, 'keep me');
  assert.equal(messages[0].content[1].type, 'text');
  assert.equal(messages[0].content[3].image_url.url, '3');
});

test('management API routing blocks same-origin fetches from agent pages', async () => {
  const b = new BrowserSession({ demoOrigin: 'http://127.0.0.1:4318' });
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    let blocked = false, continued = false;
    await b.guard({ request: () => ({ url: () => `http://${host}:4318/api/extension/token` }), abort: async () => { blocked = true; }, continue: async () => { continued = true; } });
    assert.equal(blocked, true); assert.equal(continued, false);
  }
});


test('legacy direct connection config requires a new browser selection without losing model settings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-legacy-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ConfigStore({ dir });
  await writeFile(store.file, JSON.stringify({ provider: 'openai', baseURL: 'http://localhost', model: 'test', apiKey: 'preserved', effort: 'high', vision: false, reviewerModel: '', browser: { mode: 'cdp', cdpURL: 'http://localhost:9222', allowLocalhost: true, allowPrivateNetwork: false, blockedSites: [] } }));
  const config = store.load();
  assert.equal(config.apiKey, 'preserved');
  assert.equal(config.browser.requiresSelection, true);
  assert.equal('cdpURL' in config.browser, false);
  store.save({ ...config, browser: { mode: 'extension', allowLocalhost: true, allowPrivateNetwork: false, blockedSites: [] } });
  assert.equal(store.load().browser.mode, 'extension');
  assert.equal(store.load().browser.requiresSelection, undefined);
});


test('removed model configuration never reuses old credentials or endpoint', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-legacy-model-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ConfigStore({ dir });
  await writeFile(store.file, JSON.stringify({ provider: 'anthropic', baseURL: 'https://old.example', model: 'old-model', apiKey: 'old-secret', effort: 'high', vision: true, reviewerModel: 'old-reviewer' }));
  const config = store.load();
  assert.equal(config.provider, 'openai');
  assert.equal(config.baseURL, 'https://api.openai.com/v1');
  assert.equal(config.modelRequiresSelection, true);
  assert.equal(config.apiKey, '');
  assert.equal(config.model, '');
  assert.equal(config.reviewerModel, '');
  store.save(config);
  assert.equal(store.load().modelRequiresSelection, true);
});
