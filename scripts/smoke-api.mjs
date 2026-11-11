// Optional live-provider smoke test; uses saved credentials without printing them.
// It only reads example.com, uses a temporary profile/database, and removes them afterward.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../lib/config-store.js';
import { startRuntime } from '../lib/runtime.js';

const saved = new ConfigStore().load();
if (!saved?.model || !saved?.apiKey) throw new Error('Configure a saved model and key in the desktop first.');
const dir = await mkdtemp(join(tmpdir(), 'obu-live-api-'));
let runtime;
try {
  new ConfigStore({ dir }).save({ ...saved, vision: false, browser: { mode: 'ephemeral', cdpURL: '', blockedSites: [], allowLocalhost: true, allowPrivateNetwork: false } });
  const token = crypto.randomUUID() + crypto.randomUUID();
  runtime = await startRuntime({ port: 0, dataDir: dir, browserOptions: { headless: true }, env: { OBU_API_ENABLED: '1', OBU_API_TOKEN: token, OBU_API_PORT: '0' } });
  const call = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${runtime.httpPort}/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(r.ok, `${path}: HTTP ${r.status}`); return r.json();
  };
  const wait = async id => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const r = await call(`/runs/${id}`);
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(r.status)) { assert.equal(r.status, 'completed', `Run ended as ${r.status}`); return r; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Live model run timed out');
  };
  const s = await call('/sessions', { permission_mode: 'skip' });
  const first = await call(`/sessions/${s.id}/runs`, { start_url: 'https://example.com', goal: '读取当前页面，告诉我页面标题。只读取，不导航到其他网站，不提交任何表单。' });
  const done = await wait(first.id);
  assert.match(done.result.text, /Example Domain/i); assert.ok(done.metrics.tools >= 1);
  console.log(JSON.stringify({ stage: 'read_public_page', provider: saved.provider, model: saved.model, status: done.status, tools: done.metrics.tools, outcome: done.result.outcome }));
  const follow = await call(`/sessions/${s.id}/runs`, { goal: '根据刚才读取的页面，只回答页面标题。不要执行任何网页修改。' });
  const next = await wait(follow.id);
  assert.match(next.result.text, /Example Domain/i);
  assert.deepEqual(await call(`/runs/${first.id}`), done);
  await call(`/sessions/${s.id}/close`, {});
  assert.equal((await call(`/sessions/${s.id}`)).status, 'closed');
  console.log(JSON.stringify({ stage: 'follow_up_and_close', status: next.status, previous_result_preserved: true }));
} finally {
  await runtime?.close();
  await rm(dir, { recursive: true, force: true });
}
