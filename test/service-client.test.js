import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../lib/runtime.js';
import { ServiceClient, localServiceURL } from '../lib/service-client.js';
import { requireLocalPeer } from '../lib/desktop-bridge.js';

const token = 'local-service-client-fixture-token-123456789';
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Service snapshot timed out');
}

test('desktop client accepts only local service origins', () => {
  assert.equal(localServiceURL('http://127.0.0.1:4319'), 'http://127.0.0.1:4319');
  for (const url of ['http://example.com', 'http://user:pass@localhost', 'http://localhost/v1', 'http://localhost/?token=x']) assert.throws(() => localServiceURL(url));
  assert.throws(() => requireLocalPeer({ socket: { remoteAddress: '192.168.1.2' } }), /local_desktop_only/);
});

test('attached client authenticates, resubscribes after restart, and detaches without stopping service', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-attached-client-'));
  const env = { OBU_API_ENABLED: '1', OBU_API_PORT: '0', OBU_API_TOKEN: token };
  let runtime = await startRuntime({ port: 0, dataDir: dir, env });
  let client;
  t.after(async () => { await client?.close(); await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${runtime.httpPort}`;
  await assert.rejects(ServiceClient.connect({ url: origin, token: token + '-wrong' }), /401/);
  const forbidden = await fetch(origin + '/internal/desktop/v1/request', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  const invalid = await fetch(origin + '/internal/desktop/v1/request', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'POST', path: '/api/arbitrary' }) });
  assert.equal(invalid.status, 422);
  client = await ServiceClient.connect({ url: origin, token });
  const states = [], offline = [], focus = [];
  client.subscribe((event, data) => { if (event === 'state') states.push(data); if (event === 'offline') offline.push(data); if (event === 'desktop-focus') focus.push(true); });
  await until(() => states.length >= 2);
  assert.equal(states.at(-1).service.ownership, 'external');
  runtime.relay.emit('desktop-focus');
  await until(() => focus.length === 1);
  assert.ok(!JSON.stringify(states).includes(token));
  const port = runtime.httpPort;
  await runtime.close();
  await until(() => offline.length > 0);
  const before = states.length;
  runtime = await startRuntime({ port: 0, dataDir: dir, env: { ...env, OBU_API_PORT: String(port) } });
  await until(() => states.length > before);
  await client.close();
  assert.equal((await fetch(origin + '/readyz')).status, 200);
});
