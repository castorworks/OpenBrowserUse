import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startRuntime } from '../lib/runtime.js';
import { startDesktopRuntime } from '../lib/desktop-runtime.js';

const token = 'desktop-discovery-test-token-123456789';
const setup = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'obu-discovery-'));
  return { OBU_DATA_DIR: dir, OBU_DESKTOP_PORT: '0', BROWSER_HEADLESS: '1' };
};

test('desktop starts and owns its runtime when no service exists', async t => {
  const env = await setup(t);
  const runtime = await startDesktopRuntime(env);
  t.after(async () => { await runtime.close(); await rm(env.OBU_DATA_DIR, { recursive: true, force: true }); });
  assert.ok(runtime.agent);
  assert.equal((await runtime.api.request('GET', '/api/state')).body.service, undefined);
  await runtime.close();
  await assert.rejects(fetch(runtime.origin));
});

test('desktop discovers authenticated service without URL or token and does not stop it', async t => {
  const env = await setup(t);
  const service = await startRuntime({ port: 0, env: { ...env, OBU_API_ENABLED: '1', OBU_API_PORT: '0', OBU_API_TOKEN: token } });
  t.after(async () => { await service.close(); await rm(env.OBU_DATA_DIR, { recursive: true, force: true }); });
  const file = join(env.OBU_DATA_DIR, 'runtime-service.json');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const desktop = await startDesktopRuntime(env);
  t.after(() => desktop.close());
  const state = (await desktop.api.request('GET', '/api/state')).body;
  assert.equal(state.service.ownership, 'external');
  assert.ok(!JSON.stringify(state).includes(token));
  assert.equal((await fetch(desktop.origin + '/v1/status')).status, 401);
  await desktop.close();
  assert.equal((await fetch(desktop.origin + '/readyz')).status, 200);
  await service.close();
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('discovery authentication failure never creates a replacement runtime', async t => {
  const env = await setup(t);
  const service = await startRuntime({ port: 0, env: { ...env, OBU_API_ENABLED: '1', OBU_API_PORT: '0', OBU_API_TOKEN: token } });
  t.after(async () => { await service.close(); await rm(env.OBU_DATA_DIR, { recursive: true, force: true }); });
  const file = join(env.OBU_DATA_DIR, 'runtime-service.json');
  const record = JSON.parse(await readFile(file));
  await writeFile(file, JSON.stringify({ ...record, token: token + '-wrong' }));
  await assert.rejects(startDesktopRuntime(env), /401/);
  assert.equal((await fetch(record.url + '/readyz')).status, 200);
});

test('refused stale discovery falls back, explicit service URL failures do not', async t => {
  const env = await setup(t);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(env.OBU_DATA_DIR, 'runtime-service.json'), JSON.stringify({ version: 1, pid: process.pid, url, token }));
  await assert.rejects(startDesktopRuntime({ ...env, OBU_SERVICE_URL: url, OBU_API_TOKEN: token }));
  const desktop = await startDesktopRuntime(env);
  t.after(() => desktop.close());
  assert.ok(desktop.agent);
  await desktop.close();
  await rm(env.OBU_DATA_DIR, { recursive: true, force: true });
});

test('desktop finds a service in another data directory through its relay port', async t => {
  const env = await setup(t);
  const serviceDir = join(env.OBU_DATA_DIR, 'service');
  const service = await startRuntime({ port: 0, dataDir: serviceDir, env: { OBU_API_ENABLED: '1', OBU_API_PORT: '0', OBU_API_TOKEN: token } });
  let desktop;
  t.after(async () => { await desktop?.close(); await service.close(); await rm(env.OBU_DATA_DIR, { recursive: true, force: true }); });
  desktop = await startDesktopRuntime({ ...env, OBU_DESKTOP_PORT: String(service.port) });
  assert.equal((await desktop.api.request('GET', '/api/state')).body.service.ownership, 'external');
  assert.equal(desktop.origin, `http://127.0.0.1:${service.httpPort}`);
  await desktop.close();
  assert.equal((await fetch(desktop.origin + '/readyz')).status, 200);
});

test('desktop retries discovery when service startup temporarily occupies the relay', async t => {
  const env = await setup(t);
  const blocker = createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  let service, desktop;
  const starting = new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        await new Promise(done => blocker.close(done));
        service = await startRuntime({ port, dataDir: join(env.OBU_DATA_DIR, 'service'), env: { OBU_API_ENABLED: '1', OBU_API_PORT: '0', OBU_API_TOKEN: token } });
        resolve();
      } catch (error) { reject(error); }
    }, 300);
  });
  t.after(async () => { await starting; await desktop?.close(); await service?.close(); await rm(env.OBU_DATA_DIR, { recursive: true, force: true }); });
  desktop = await startDesktopRuntime({ ...env, OBU_DESKTOP_PORT: String(port) });
  await starting;
  assert.equal((await desktop.api.request('GET', '/api/state')).body.service.ownership, 'external');
});
