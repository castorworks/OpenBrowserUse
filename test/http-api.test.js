import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../lib/runtime.js';
import { checkResponse, spec } from './helpers/api-contract.js';
import { BrowserSession } from '../lib/browser/session.js';

const token = 'test-token-for-open-browser-use-api-123456789';
async function until(check) {
  for (let n = 0; n < 400; n++) { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('Timed out');
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'obu-http-'));
  let calls = 0, question = false, slow = false;
  const model = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks)); calls++;
    if (slow) await new Promise(r => setTimeout(r, 200));
    const answered = body.messages.some(m => m.role === 'tool' && String(m.content).includes('用户回复'));
    const message = question && !answered ? { tool_calls: [{ id: 'ask-1', type: 'function', function: { name: 'ask_user', arguments: '{"question":"继续吗？"}' } }] } : { content: `answer-${calls}` };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
  });
  await new Promise(r => model.listen(0, '127.0.0.1', r));
  const env = { OBU_API_ENABLED: '1', OBU_API_PORT: '0', OBU_API_HOST: '0.0.0.0', OBU_API_TOKEN: token, MODEL_PROVIDER: 'openai', MODEL_NAME: 'fixture', MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, MODEL_API_KEY: 'private-model-key' };
  const runtime = await startRuntime({ port: 0, env, dataDir: dir, browserOptions: { headless: true } });
  const call = async (method, path, body, key = crypto.randomUUID(), auth = token) => {
    const r = await fetch(`http://127.0.0.1:${runtime.httpPort}/v1${path}`, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = r.status === 204 ? undefined : await r.json();
    checkResponse(method, path, r.status, payload);
    return { status: r.status, body: payload, headers: r.headers };
  };
  t.after(async () => { await runtime.close(); model.closeAllConnections(); await new Promise(r => model.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { runtime, call, dir, env, calls: () => calls, question: () => { question = true; }, slow: () => { slow = true; } };
}

test('HTTP accepts once, preserves rounds, shares desktop lock, and keeps secrets private', async t => {
  const f = await fixture(t), { call, runtime } = f;
  const base = `http://127.0.0.1:${runtime.httpPort}`;
  for (const path of ['/healthz', '/readyz']) {
    const health = await fetch(base + path);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
  }
  assert.equal((await fetch(base + '/v1/openapi.json')).status, 401);
  const contract = await fetch(base + '/v1/openapi.json', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(contract.status, 200);
  assert.deepEqual((await contract.json()).servers, [{ url: '/v1' }]);
  assert.equal((await call('GET', '/status', undefined, undefined, 'wrong')).status, 401);
  assert.equal((await fetch(runtime.origin + '/v1/status')).status, 404);
  assert.equal((await call('POST', '/sessions', { browser_mode: 'cdp' })).status, 422);
  const [one, two] = await Promise.all([call('POST', '/sessions', {}, 'session-1'), call('POST', '/sessions', {}, 'session-1')]);
  assert.equal(one.status, 201); assert.deepEqual(two.body, one.body);
  const sid = one.body.id;
  assert.equal((await call('POST', '/sessions', { permission_mode: 'ask' }, 'session-1')).status, 409);
  assert.equal((await call('POST', '/sessions', {})).status, 409);
  assert.equal((await runtime.api.request('POST', '/api/tasks', { goal: 'do not replace' })).status, 409);
  const started = await call('POST', `/sessions/${sid}/runs`, { goal: 'summarize' }, 'run-1');
  assert.equal(started.status, 202);
  const rid = started.body.id;
  const done = await until(async () => { const r = await call('GET', `/runs/${rid}`); return r.body.status === 'completed' && r.body; });
  assert.equal(done.result.outcome, 'unverified');
  const lastEvent = runtime.api.tasks.events.last(rid);
  runtime.api.tasks.put('run', { ...done, status: 'running', finished_at: null, result: null });
  assert.deepEqual(runtime.api.tasks.get('run', rid), done, 'a terminal round cannot regress');
  assert.equal(runtime.api.tasks.events.last(rid), lastEvent, 'ignored stale updates produce no events');
  const count = f.calls();
  assert.deepEqual((await call('POST', `/sessions/${sid}/runs`, { goal: 'summarize' }, 'run-1')).body, started.body);
  assert.equal(f.calls(), count);
  const next = await call('POST', `/sessions/${sid}/runs`, { goal: 'follow up' });
  assert.equal(next.status, 202); assert.notEqual(next.body.id, rid);
  await until(async () => (await call('GET', `/runs/${next.body.id}`)).body.status === 'completed');
  assert.deepEqual((await call('GET', `/runs/${rid}`)).body, done);
  assert.equal((await call('GET', `/sessions/${sid}/runs`)).body.data.length, 2);
  const session = await call('GET', `/sessions/${sid}`);
  assert.ok(!JSON.stringify(session).includes('private-model-key'));
  assert.equal((await call('POST', `/sessions/${sid}/close`, {})).status, 202);
  assert.equal((await call('POST', `/sessions/${sid}/runs`, { goal: 'closed' })).status, 409);
});

test('HTTP interactions require the exact pending ID and reject stale replies', async t => {
  const { call, runtime, question } = await fixture(t); question();
  const s = (await call('POST', '/sessions', {})).body;
  const r = (await call('POST', `/sessions/${s.id}/runs`, { goal: 'ask a question' })).body;
  await until(async () => (await call('GET', `/runs/${r.id}`)).body.status === 'waiting_input');
  const i = (await call('GET', `/runs/${r.id}/interactions?status=pending`)).body.data[0];
  assert.equal((await call('POST', `/runs/${r.id}/resume`, {})).status, 409);
  assert.equal((await runtime.api.request('POST', '/api/control', { command: 'resume', answer: 'missing id' })).status, 409);
  assert.equal((await call('POST', `/runs/${r.id}/interactions/${i.id}/response`, { answer: 'yes' }, 'answer-1')).status, 200);
  assert.equal((await call('POST', `/runs/${r.id}/interactions/${i.id}/response`, { answer: 'yes' }, 'answer-1')).status, 200);
  assert.equal((await call('POST', `/runs/${r.id}/interactions/${i.id}/response`, { answer: 'late' })).status, 409);
  await until(async () => (await call('GET', `/runs/${r.id}`)).body.status === 'completed');
});

test('interrupted acceptances survive restart and are not executed again', async t => {
  const { runtime, call, env, dir, calls } = await fixture(t);
  const s = (await call('POST', '/sessions', {}, 'persist-session')).body;
  // Simulate a process dying after durable acceptance but before dispatch.
  const store = runtime.api.tasks, rid = crypto.randomUUID();
  store.put('run', { id: rid, session_id: s.id, status: 'starting', created_at: new Date().toISOString() });
  store.put('session', { ...s, active_run_id: rid });
  await runtime.close();
  const restarted = await startRuntime({ port: 0, env, dataDir: dir });
  t.after(() => restarted.close());
  const result = await fetch(`http://127.0.0.1:${restarted.httpPort}/v1/runs/${rid}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await result.json()).status, 'interrupted'); assert.equal(calls(), 0);
  assert.equal(restarted.api.tasks.get('session', s.id).status, 'closed');
  const replay = await fetch(`http://127.0.0.1:${restarted.httpPort}/v1/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'persist-session' }, body: '{}' });
  assert.equal((await replay.json()).id, s.id); assert.equal(restarted.api.tasks.openSession(), undefined);
  await restarted.close();
});

test('browser guard protects API listener through loopback aliases', () => {
  const b = new BrowserSession({ demoOrigin: 'http://127.0.0.1:4318', apiPort: 4319 });
  for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '[::ffff:127.0.0.1]', 'sub.localhost']) assert.equal(b.isManagementURL(`http://${host}:4319/v1/status`), true, host);
  assert.equal(b.isManagementURL('https://example.com:4319/v1/status'), false);
});

test('pause/resume/cancel release the slot and expire pending interactions', async t => {
  const { call, slow, question, runtime } = await fixture(t); slow(); question();
  const s = (await call('POST', '/sessions', {})).body;
  const run = (await call('POST', `/sessions/${s.id}/runs`, { goal: 'wait for user' })).body;
  assert.equal((await call('POST', `/sessions/${s.id}/runs`, { goal: 'competing' })).status, 409);
  assert.equal((await call('POST', `/runs/${run.id}/pause`, {})).status, 202);
  await until(async () => (await call('GET', `/runs/${run.id}`)).body.status === 'paused');
  assert.equal((await call('POST', `/runs/${run.id}/resume`, {})).status, 202);
  await until(async () => (await call('GET', `/runs/${run.id}`)).body.status === 'waiting_input');
  const i = (await call('GET', `/runs/${run.id}/interactions`)).body.data[0];
  assert.equal((await call('POST', `/runs/${run.id}/cancel`, {})).status, 202);
  await until(async () => (await call('GET', `/runs/${run.id}`)).body.status === 'cancelled');
  assert.equal((await call('POST', `/runs/${run.id}/interactions/${i.id}/response`, { answer: 'late' })).status, 409);
  assert.equal((await call('GET', `/runs/${run.id}/interactions`)).body.data[0].status, 'expired');
  await until(() => !runtime.agent.busy);
  assert.equal((await call('POST', '/sessions', {})).status, 201);
});

test('recovery creates a new round and session, preserves old result and memory', async t => {
  const { call, runtime } = await fixture(t);
  const s = (await call('POST', '/sessions', {})).body;
  const r = (await call('POST', `/sessions/${s.id}/runs`, { goal: 'original goal' })).body;
  const done = await until(async () => { const v = (await call('GET', `/runs/${r.id}`)).body; return v.status === 'completed' && v; });
  const memory = await runtime.agent.sessions.putMemory(runtime.agent.task, 'saved reference', 'test');
  await call('POST', `/sessions/${s.id}/close`, {});
  const recovered = await call('POST', `/runs/${r.id}/recover`, {}, 'recover-1');
  assert.equal(recovered.status, 202); assert.notEqual(recovered.body.id, r.id); assert.notEqual(recovered.body.session_id, s.id);
  await until(async () => (await call('GET', `/runs/${recovered.body.id}`)).body.status === 'completed');
  assert.equal((await call('GET', `/runs/${recovered.body.id}`)).body.recovered_from_run_id, r.id);
  assert.deepEqual((await call('GET', `/runs/${r.id}`)).body, done);
  assert.match(await runtime.agent.sessions.readMemory(recovered.body.session_id, { id: memory }), /saved reference/);
});

test('a second backend cannot acquire the same data directory', async t => {
  const { runtime, dir, env } = await fixture(t);
  await assert.rejects(startRuntime({ port: 0, dataDir: dir, env }), /数据目录已由后台进程/);
  assert.equal(runtime.api.tasks.openSession(), undefined);
});


test('OpenAPI operation identifiers and path parameters are complete', () => {
  const ids = new Set();
  for (const [path, methods] of Object.entries(spec.paths)) for (const [method, operation] of Object.entries(methods)) {
    assert.ok(!ids.has(operation.operationId)); ids.add(operation.operationId);
    for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) assert.ok(operation.parameters.some(p => p.in === 'path' && p.name === name && p.required));
    if (method === 'post') assert.ok(operation.parameters.some(p => p.name === 'Idempotency-Key' && p.required));
  }
});

test('SIGKILL recovery preserves the run acceptance without repeating model calls', async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { fileURLToPath } = await import('node:url');
  const { runtime, env, dir, question, calls } = await fixture(t); question();
  await runtime.close();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/server.js', import.meta.url))], { env: { ...process.env, ...env, OBU_API_HOST: '127.0.0.1', OBU_DATA_DIR: dir, PORT: '0', BROWSER_HEADLESS: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const origin = await until(() => /API listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]);
  const request = async (path, body, key) => {
    const r = await fetch(origin + '/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key || crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(r.ok); return r.json();
  };
  const s = await request('/sessions', {});
  const accepted = await request(`/sessions/${s.id}/runs`, { goal: 'wait for an answer' }, 'crash-run');
  await until(async () => (await request(`/runs/${accepted.id}`)).status === 'waiting_input');
  child.kill('SIGKILL'); await once(child, 'exit');
  const before = calls();
  const restarted = await startRuntime({ port: 0, env, dataDir: dir });
  t.after(() => restarted.close());
  const run = restarted.api.tasks.get('run', accepted.id);
  assert.equal(run.status, 'interrupted');
  assert.equal(restarted.api.tasks.all('interaction').find(i => i.run_id === run.id).status, 'expired');
  const retried = await fetch(`http://127.0.0.1:${restarted.httpPort}/v1/sessions/${s.id}/runs`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'crash-run' }, body: JSON.stringify({ goal: 'wait for an answer' }) });
  assert.equal(retried.status, 202); assert.deepEqual(await retried.json(), accepted);
  assert.equal(calls(), before); assert.equal(restarted.agent.task, null);
  await restarted.close();
});

const eventsFrom = text => text.split('\n\n').filter(x => x.includes('\ndata: ')).map(x => JSON.parse(x.split('\ndata: ')[1]));
const raw = (runtime, path, options = {}) => fetch(`http://127.0.0.1:${runtime.httpPort}/v1${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });

test('SSE replays then tails with a reconnect cursor; screenshots and full export are available', async t => {
  const { call, runtime, slow } = await fixture(t); slow();
  const s = (await call('POST', '/sessions', {})).body;
  const r = (await call('POST', `/sessions/${s.id}/runs`, { goal: 'stream test' })).body;
  const stream = await raw(runtime, `/runs/${r.id}/events/stream`);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = stream.body.getReader();
  const firstChunk = new TextDecoder().decode((await reader.read()).value);
  const first = eventsFrom(firstChunk); assert.ok(first.length); await reader.cancel();
  const after = first.at(-1).id;
  const resumed = await raw(runtime, `/runs/${r.id}/events/stream?after=0`, { headers: { 'Last-Event-ID': after } });
  const remaining = eventsFrom(await resumed.text());
  const all = (await call('GET', `/runs/${r.id}/events`)).body.data;
  assert.deepEqual(remaining.map(e => e.id), all.filter(e => e.sequence > first.at(-1).sequence).map(e => e.id));
  assert.equal(all.at(-1).type, 'run.finished');
  assert.ok(all.some(e => e.type === 'message.created'));
  assert.equal((await raw(runtime, `/runs/${r.id}/events/stream`, { headers: { 'Last-Event-ID': 'wrong:1' } })).status, 400);
  const screenshot = await raw(runtime, `/sessions/${s.id}/screenshot?format=png`);
  assert.equal(screenshot.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await screenshot.arrayBuffer()).slice(0, 4)], [137, 80, 78, 71]);
  const exported = await call('GET', `/sessions/${s.id}/export`);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.equal(exported.body.runs[0].id, r.id); assert.equal(exported.body.events.at(-1).type, 'run.finished');
  assert.ok(!JSON.stringify(exported.body).includes('private-model-key'));
  await call('POST', `/sessions/${s.id}/close`, {});
  assert.equal((await raw(runtime, `/sessions/${s.id}/screenshot`)).status, 409);
});

test('FIFO jobs wait for interactive sessions, run serially and close their browsers', async t => {
  const { call, runtime } = await fixture(t);
  const held = (await call('POST', '/sessions', {})).body;
  const one = (await call('POST', '/jobs', { goal: 'first' }, 'job-1')).body;
  const two = (await call('POST', '/jobs', { goal: 'second' })).body;
  assert.equal(one.status, 'queued'); assert.ok(one.queue_sequence < two.queue_sequence);
  assert.deepEqual((await call('POST', '/jobs', { goal: 'first' }, 'job-1')).body, one);
  assert.equal((await call('GET', `/runs/${one.run_id}`)).body.status, 'queued');
  const payload = runtime.api.tasks.db.prepare('SELECT payload FROM api_queue WHERE job_id=?').get(one.id).payload;
  assert.ok(!payload.includes('private-model-key'));
  const cancelled = (await call('POST', '/jobs', { goal: 'never run' })).body;
  assert.equal((await call('POST', `/jobs/${cancelled.id}/cancel`, {})).body.status, 'cancelled');
  await call('POST', `/sessions/${held.id}/close`, {});
  const finished = await until(async () => { const j = (await call('GET', `/jobs/${two.id}`)).body; return j.status === 'completed' && j; });
  const first = (await call('GET', `/jobs/${one.id}`)).body;
  assert.equal(first.status, 'completed'); assert.ok(first.finished_at <= finished.started_at);
  assert.equal((await call('GET', `/sessions/${two.session_id}`)).body.status, 'closed');
  assert.equal((await call('GET', `/runs/${one.run_id}`)).body.created_at, one.created_at);
  const e = (await call('GET', `/runs/${one.run_id}/events`)).body.data;
  assert.equal(e[0].data.status, 'queued'); assert.equal(e.at(-1).type, 'run.finished');
  assert.ok(!runtime.agent.browser);
});

test('idle cleanup and retention preserve pending work; deletion tombstones related requests', async t => {
  const { call, runtime } = await fixture(t);
  const s = (await call('POST', '/sessions', {}, 'delete-session')).body;
  await call('POST', '/settings/lifecycle', { history_retention_days: 0, idle_timeout_seconds: 1, max_queued_jobs: 1 });
  const queued = (await call('POST', '/jobs', { goal: 'queued' })).body;
  assert.equal((await call('POST', '/jobs', { goal: 'overflow' })).status, 409);
  assert.equal((await call('DELETE', `/sessions/${queued.session_id}`)).status, 409);
  // Stop automatic dispatch so this exercises lifecycle decisions deterministically.
  runtime.api.tasks.lifecycle.stop();
  await runtime.api.tasks.serialize(() => runtime.api.tasks.lifecycle.tick(Date.now() + 2000));
  assert.equal((await call('GET', `/sessions/${s.id}`)).body.status, 'closed');
  assert.equal((await call('GET', `/jobs/${queued.id}`)).body.status, 'queued');
  assert.equal((await call('DELETE', `/sessions/${s.id}`, undefined, 'delete-1')).status, 204);
  assert.equal((await call('DELETE', `/sessions/${s.id}`, undefined, 'delete-1')).status, 204);
  assert.equal((await call('POST', '/sessions', {}, 'delete-session')).status, 410);
  assert.equal((await call('GET', `/sessions/${s.id}`)).status, 404);
  await call('POST', `/jobs/${queued.id}/cancel`, {});
  await call('POST', '/settings/lifecycle', { history_retention_days: 1, idle_timeout_seconds: 0, max_queued_jobs: 2 });
  await runtime.api.tasks.serialize(() => runtime.api.tasks.lifecycle.tick(Date.now() + 2 * 86400000));
  assert.equal((await call('GET', `/jobs/${queued.id}`)).status, 404);
  assert.equal((await call('GET', `/runs/${queued.run_id}/events`)).status, 404);
});

test('queued jobs survive restart and retain FIFO order without resuming active work', async t => {
  const { call, runtime, env, dir } = await fixture(t);
  await call('POST', '/sessions', {}); // prevent dispatch before shutdown
  const job = (await call('POST', '/jobs', { goal: 'resume queue' })).body;
  await runtime.close();
  const restarted = await startRuntime({ port: 0, env, dataDir: dir, browserOptions: { headless: true } });
  t.after(() => restarted.close());
  await until(() => restarted.api.tasks.get('job', job.id).status === 'completed');
  assert.equal(restarted.api.tasks.get('run', job.run_id).status, 'completed');
  await restarted.close();
});

test('a waiting queued job owns the slot until cancelled; idle cleanup never skips it', async t => {
  const { call, runtime, question } = await fixture(t); question();
  const first = (await call('POST', '/jobs', { goal: 'ask before continuing' })).body;
  const next = (await call('POST', '/jobs', { goal: 'later' })).body;
  await until(async () => (await call('GET', `/runs/${first.run_id}`)).body.status === 'waiting_input');
  await runtime.api.tasks.serialize(() => runtime.api.tasks.lifecycle.tick(Date.now() + 86400000));
  assert.equal((await call('GET', `/jobs/${next.id}`)).body.status, 'queued');
  assert.equal((await call('GET', `/sessions/${first.session_id}`)).body.status, 'open');
  await call('POST', `/jobs/${first.id}/cancel`, {});
  await until(async () => (await call('GET', `/runs/${next.run_id}`)).body.status === 'waiting_input');
  assert.equal((await call('GET', `/jobs/${first.id}`)).body.status, 'cancelled');
  await call('POST', `/jobs/${next.id}/cancel`, {});
  await until(async () => (await call('GET', `/jobs/${next.id}`)).body.status === 'cancelled');
});

test('legacy queued direct connections fail without launching a replacement browser', async t => {
  const { runtime, call, calls } = await fixture(t);
  const session = await call('POST', '/sessions', {});
  const job = await call('POST', '/jobs', { goal: 'legacy task' });
  const api = runtime.api.tasks;
  const row = api.db.prepare('SELECT payload FROM api_queue WHERE job_id=?').get(job.body.id);
  const payload = api.lifecycle.payload.open(row.payload);
  payload.config.browser.mode = 'cdp';
  api.db.prepare('UPDATE api_queue SET payload=? WHERE job_id=?').run(api.lifecycle.payload.seal(payload), job.body.id);
  await call('POST', `/sessions/${session.body.id}/close`, {});
  const failed = await until(async () => {
    const result = await call('GET', `/jobs/${job.body.id}`);
    return result.body.status === 'failed' && result.body;
  });
  assert.equal((await call('GET', `/runs/${failed.run_id}`)).body.error.code, 'browser_mode_removed');
  assert.equal(calls(), 0);
  assert.ok(!runtime.agent.browser);
});

test('legacy queued model providers fail without calling another service', async t => {
  const { runtime, call, calls } = await fixture(t);
  const session = await call('POST', '/sessions', {});
  const job = await call('POST', '/jobs', { goal: 'legacy task' });
  const api = runtime.api.tasks;
  const row = api.db.prepare('SELECT payload FROM api_queue WHERE job_id=?').get(job.body.id);
  const payload = api.lifecycle.payload.open(row.payload);
  payload.config.provider = 'anthropic';
  api.db.prepare('UPDATE api_queue SET payload=? WHERE job_id=?').run(api.lifecycle.payload.seal(payload), job.body.id);
  await call('POST', `/sessions/${session.body.id}/close`, {});
  const failed = await until(async () => {
    const result = await call('GET', `/jobs/${job.body.id}`);
    return result.body.status === 'failed' && result.body;
  });
  assert.equal((await call('GET', `/runs/${failed.run_id}`)).body.error.code, 'model_provider_removed');
  assert.equal(calls(), 0);
  assert.ok(!runtime.agent.browser);
});
