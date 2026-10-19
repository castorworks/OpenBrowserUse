import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { ConfigStore } from '../lib/config-store.js';

test('model credentials survive restart, remain private, and clear persistently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-config-'));
  const port = 14518, origin = `http://127.0.0.1:${port}`;
  let server;
  const open = async () => {
    const { app } = createApp({ port, env: {}, dataDir: dir });
    server = await new Promise(resolve => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
  };
  const close = async () => { if (server) { await new Promise(resolve => server.close(resolve)); server = null; } };
  const state = async () => (await (await fetch(`${origin}/api/state`)).json()).config;
  const save = async body => {
    const response = await fetch(`${origin}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Browser-Agent': '1' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('fixture-secret'));
    return JSON.parse(text);
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
