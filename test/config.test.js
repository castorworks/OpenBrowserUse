import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../lib/application.js';
import { ConfigStore } from '../lib/config-store.js';

test('model credentials survive restart, remain private, and clear persistently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-config-'));
  let api;
  const open = async () => { api = createApplication({ env: {}, dataDir: dir }); };
  const close = async () => { await api?.close(); api = null; };
  const state = async () => (await api.request('GET', '/api/state')).body.config;
  const save = async body => {
    const response = await api.request('POST', '/api/config', body);
    assert.equal(response.status, 200);
    assert.ok(!JSON.stringify(response.body).includes('fixture-secret'));
    return response.body;
  };
  const disk = async () => JSON.parse(await readFile(join(dir, 'model-config.json'), 'utf8'));
  const model = { provider: 'deepseek', model: 'deepseek-flash', effort: 'max', vision: true };
  try {
    await open();
    await save({ ...model, apiKey: 'fixture-secret' });
    assert.equal((await disk()).apiKey, 'fixture-secret');
    await close(); await open();
    const restored = await state();
    assert.equal(restored.hasKey, true); assert.equal(restored.apiKey, undefined);
    assert.equal(restored.provider, 'deepseek'); assert.equal(restored.baseURL, 'https://api.deepseek.com');
    assert.equal(restored.model, model.model); assert.equal(restored.effort, 'max'); assert.equal(restored.vision, true);
    await save({ ...model, apiKey: '' });
    assert.equal((await disk()).apiKey, 'fixture-secret', 'blank input preserves restored key');
    await save({ ...model, clearKey: true });
    await close(); await open();
    assert.equal((await state()).hasKey, false); assert.equal((await disk()).apiKey, '');
    await save({ ...model, apiKey: 'fixture-secret' });
    await save({ ...model, baseURL: 'https://proxy.example/v1' });
    await close(); await open();
    assert.equal((await state()).hasKey, false, 'endpoint change cannot reuse the old key');
    assert.equal((await disk()).apiKey, '');
  } finally { await close(); await rm(dir, { recursive: true, force: true }); }
});

test('invalid configuration fails without exposing secrets or overwriting the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-config-invalid-'));
  try {
    const file = join(dir, 'model-config.json');
    await writeFile(file, '{"apiKey":"fixture-secret", invalid');
    assert.throws(() => new ConfigStore({ dir }).load(), error => !error.message.includes('fixture-secret') && /无法读取/.test(error.message));
    assert.match(await readFile(file, 'utf8'), /fixture-secret/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('obsolete browser flags are discarded from saved settings and older desktop requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-config-browser-'));
  let api;
  try {
    api = createApplication({ env: {}, dataDir: dir });
    const response = await api.request('POST', '/api/browser', { mode: 'persistent', blockedSites: ['protected.example'], allowLocalhost: false, allowPrivateNetwork: false });
    assert.equal(response.status, 200);
    const browser = { mode: 'persistent', blockedSites: ['protected.example'] };
    assert.deepEqual(response.body.browser, browser);
    const file = join(dir, 'model-config.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.browser, browser);
    await api.close(); api = null;
    await writeFile(file, JSON.stringify({ ...saved, browser: { ...browser, allowLocalhost: false, allowPrivateNetwork: false } }));
    api = createApplication({ env: {}, dataDir: dir });
    assert.deepEqual((await api.request('GET', '/api/state')).body.config.browser, browser);
    const current = await api.request('POST', '/api/browser', browser);
    assert.equal(current.status, 200);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).browser, browser);
  } finally { await api?.close(); await rm(dir, { recursive: true, force: true }); }
});
