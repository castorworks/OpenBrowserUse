import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../lib/agent.js';
import { SessionStore } from '../lib/sessions.js';
import { OpenAIProvider } from '../lib/providers/openai.js';
import { ExtensionRelay } from '../lib/extension/relay.js';

async function fixture(t, maxSteps = 2) {
  const dir = await mkdtemp(join(tmpdir(), 'obu-reliability-'));
  const a = new Agent('http://localhost', { dataDir: dir });
  a.task = { id: crypto.randomUUID(), goal: 'test', mode: 'ai', provider: 'openai', permissionMode: 'skip',
    status: 'running', step: 0, modelTurns: 0, maxSteps, events: [], history: [], audit: [], userMessages: [],
    metrics: { requests: [], tools: [], retries: 0 }, _secrets: new Set(), controller: new AbortController() };
  a.refreshView = async () => {};
  a.browser = { current: () => ({ url: () => 'https://example.com' }), tabs: () => [] };
  t.after(async () => { a.sessions.close(); await rm(dir, { recursive: true, force: true }); });
  return a;
}

test('batch actions cannot exceed the budget, and skipped calls receive results', async t => {
  const a = await fixture(t, 1);
  let results;
  a.provider = { step: async () => ({ toolCalls: [1, 2, 3].map(id => ({ id: String(id), name: 'tabs', input: { action: 'list' } })) }), addToolResults: r => { results = r; } };
  await a.loop();
  assert.equal(a.task.step, 1);
  assert.equal(a.task.history.length, 1);
  assert.equal(results.length, 3);
  assert.equal(results.filter(r => r.isError).length, 2);
  assert.equal(a.task.status, 'failed');
});

test('unknown tools and invalid arguments consume attempts', async t => {
  const a = await fixture(t);
  let calls = 0;
  a.provider = { step: async () => ({ toolCalls: [{ id: String(++calls), name: calls === 1 ? 'missing' : 'tabs', input: {} }] }), addToolResults: () => {} };
  await a.loop();
  assert.equal(calls, 2);
  assert.equal(a.task.step, 2);
  assert.ok(a.task.metrics.tools.every(x => !x.ok));
});

test('truncation is preserved by the provider, never executes tools, and has a finite turn budget', async t => {
  const a = await fixture(t, 1);
  const p = new OpenAIProvider({ baseURL: 'http://localhost', model: 'mock' }, { system: 's', tools: [] });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ model: 'mock', usage: { prompt_tokens: 10 }, choices: [{ finish_reason: 'length', message: {
    tool_calls: [{ id: 't', function: { name: 'tabs', arguments: '{"action":"list"}' } }],
  } }] }) }));
  a.provider = p;
  await a.loop();
  assert.equal(a.task.modelTurns, 4);
  assert.equal(a.task.history.length, 0);
  assert.equal(a.task.status, 'failed');
  assert.equal(a.task.metrics.requests[0].usage.prompt_tokens, 10);
  assert.ok(a.task.metrics.requests.every(x => x.durationMs >= 0));
});

test('final answers survive follow-ups and display limits do not truncate stored history', async t => {
  const a = await fixture(t);
  for (let i = 0; i < 410; i++) a.event(`event ${i}`);
  const answer = 'first answer '.repeat(500);
  a.provider = { step: async () => ({ text: answer, toolCalls: [] }), addUserText: () => {} };
  await a.loop();
  a.provider.step = async () => ({ text: 'second answer', toolCalls: [] });
  a.followUp('continue'); await a.promise;
  const saved = await a.sessions.get(a.task.id);
  assert.deepEqual(saved.events.filter(e => e.final).map(e => e.message), [answer, 'second answer']);
  assert.equal(saved.events[0].message, 'event 0');
  assert.equal(a.state({ compact: true }).events.length, 400);
  assert.ok(a.state().events.length > 410);
});

test('checkpoints exist before a pending model response; deletion cannot be undone by later saves', async t => {
  const a = await fixture(t);
  let release, entered;
  const started = new Promise(r => { entered = r; });
  a.provider = { step: async () => { entered(); return new Promise(r => { release = r; }); } };
  const running = a.loop(); await started;
  assert.equal((await a.sessions.get(a.task.id)).status, 'running');
  await a.deleteSession(a.task.id);
  release({ text: 'done', toolCalls: [] }); await running;
  assert.equal(await a.sessions.get(a.task.id), null);
});

test('sensitive inputs reach the browser but never public state or persisted transcripts', async t => {
  const a = await fixture(t);
  const secret = 'private-credential-123'.repeat(100);
  let filled;
  const field = { tagName: 'INPUT', type: 'password', id: 'pass', name: 'pass', autocomplete: '' };
  a.browser.resolve = async () => ({ evaluate: async fn => fn(field), fill: async value => { filled = value; } });
  await a.runTool({ id: 'input', name: 'form_input', input: { ref: 'ref_1', value: secret } });
  a.task.result = `Signed in using ${secret}`;
  a.event(`echo ${secret}`);
  await a.save();
  assert.equal(filled, secret);
  assert.ok(!JSON.stringify(a.state()).includes(secret));
  assert.ok(!JSON.stringify(await a.sessions.get(a.task.id)).includes(secret));
  const raw = (await a.sessions.db()).prepare('SELECT data FROM sessions WHERE id = ?').get(a.task.id).data;
  assert.ok(!raw.includes(secret));
  assert.ok(!raw.includes(secret.slice(0, 30)), 'clipping must not expose a prefix of a long password');
  assert.ok(!raw.includes('_secrets'));
});

test('legacy labelled credentials are sanitized on database open without changing timestamps', async t => {
  const a = await fixture(t);
  a.task.goal = 'password: legacy-secret'; a.task.result = 'legacy-secret';
  const db = await a.sessions.db();
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(a.task.id, a.task.goal, 'done', 'openai', 'old', 'old', JSON.stringify({ ...a.task, _secrets: undefined }));
  a.sessions.close();
  a.sessions = new SessionStore({ dir: a.sessions.dir });
  assert.ok(!JSON.stringify(await a.sessions.get(a.task.id)).includes('legacy-secret'));
  const [row] = await a.sessions.list();
  assert.equal(row.updated, 'old'); assert.ok(!row.goal.includes('legacy-secret'));
});

test('live frames avoid duplicate screenshots and stale frames trigger a fallback', async t => {
  const a = await fixture(t);
  a.refreshView = Agent.prototype.refreshView;
  const options = [];
  a.browser.view = async opts => { options.push(opts); return { url: 'https://example.com', screenshot: opts.screenshot ? 'data:image/jpeg;base64,AAAA' : null }; };
  a.publishFrame('AAAA'); await a.refreshView();
  a.lastFrameAt = Date.now() - 4000; await a.refreshView();
  assert.deepEqual(options, [{ screenshot: false }, { screenshot: true }]);
  assert.equal(a.state({ compact: true }).snapshot.screenshot, undefined);
});

test('extension capability negotiation rejects old workers before opening any tab', async t => {
  const relay = new ExtensionRelay(); t.after(() => relay.close());
  let changes = 0; relay.on('change', () => { changes++; });
  let calls = 0;
  relay.call = async () => { calls++; return { id: 1 }; };
  relay.onExtensionEvent('extension.hello', [{ userAgent: 'old' }]);
  await assert.rejects(relay.prepare(), /重新加载/);
  assert.equal(calls, 0);
  relay.onExtensionEvent('extension.hello', [{ protocolVersion: 1, capabilities: ['tabs.screenshot'] }]);
  await relay.prepare(); assert.equal(calls, 1);
  assert.equal(changes, 2, 'CDP event forwarding must not shadow EventEmitter notifications');
});
