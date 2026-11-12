import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, estimateTokens } from '../lib/providers/context.js';
import { SessionStore } from '../lib/sessions.js';
import { Agent } from '../lib/agent.js';
import { OpenAIProvider } from '../lib/providers/openai.js';

const signal = () => new AbortController().signal;
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'obu-long-'));
  const store = new SessionStore({ dir });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const task = { id: crypto.randomUUID(), goal: 'test', mode: 'ai', provider: 'openai', status: 'running', events: [], history: [], audit: [], userMessages: [], metrics: { requests: [], tools: [], retries: 0 }, _secrets: new Set() };
  return { dir, store, task };
}

test('compaction preserves recent OpenAI tool pairs and archives the original history', async () => {
  const context = new ContextManager({ contextWindow: 30000, outputReserve: 4000 });
  context.attach({ summary: async () => 'User goal, verified progress and next step' });
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'goal' }];
  for (let i = 0; i < 16; i++) messages.push({ role: 'assistant', content: null, tool_calls: [{ id: String(i) }] }, { role: 'tool', tool_call_id: String(i), content: 'x'.repeat(1800) });
  await context.prepare(messages, {}, signal());
  assert.equal(context.compactions, 1);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[1].content, /历史摘要/);
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'tool') assert.equal(messages[i-1].tool_calls[0].id, messages[i].tool_call_id);
  assert.match(context.archive.get('memory-1'), /"goal"/);
  assert.ok(context.stats.estimatedTokens < 26000);
});

test('compaction summary failure keeps OpenAI tool pairs and retrievable excerpts', async () => {
  const context = new ContextManager({ contextWindow: 30000, outputReserve: 4000 });
  context.attach({ summary: async () => { throw new Error('unavailable'); } });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'goal' }] }];
  for (let i = 0; i < 16; i++) messages.push({ role: 'assistant', content: null, tool_calls: [{ id: String(i) }] }, { role: 'tool', tool_call_id: String(i), content: 'x'.repeat(1800) });
  await context.prepare(messages, {}, signal());
  assert.equal(context.compactions, 1);
  for (let i = 1; i < messages.length; i++) if (messages[i].role === 'tool') assert.equal(messages[i-1].tool_calls[0].id, messages[i].tool_call_id);
  assert.match(messages[0].content, /memory-1/);
});

test('image estimation excludes base64 bytes and counts image allowance', () => {
  assert.ok(estimateTokens([{ type: 'image_url', image_url: { url: 'x'.repeat(1000000) } }]) < 5000);
});

test('oversized immutable overhead stops locally without retrying', async () => {
  const context = new ContextManager({ contextWindow: 16000 });
  await assert.rejects(context.prepare([{ role: 'user', content: 'goal' }], { system: 's'.repeat(18000) }, signal()), e => e.nonRetryable);
});

test('incremental checkpoints survive restart, paginate, update cards, scrub newly learned secrets and delete archives', async t => {
  const { store, task } = await fixture(t);
  task.events = Array.from({ length: 500 }, (_, i) => ({ message: `event ${i}`, state: 'running' }));
  await store.save(task);
  const id = await store.putMemory(task, 'old unknown-credential marker', 'source');
  task.events[499].state = 'ok';
  task.events.push({ message: 'password: unknown-credential' });
  await store.save(task);
  const raw = (await store.db()).prepare('SELECT data FROM sessions WHERE id = ?').get(task.id).data;
  assert.ok(!raw.includes('event 400'));
  assert.ok(!(await store.readMemory(task.id, { id })).includes('unknown-credential'));
  store.close();
  const saved = await store.get(task.id);
  assert.equal(saved.events.length, 501);
  assert.equal(saved.events[499].state, 'ok');
  const page = await store.page(task.id, 400, 100);
  assert.equal(page.events.length, 100); assert.equal(page.nextOffset, 500);
  assert.equal((await store.page(task.id, 500, 100)).nextOffset, null);
  assert.equal((await store.readMemory('other-task', { id })), '资料不存在。');
  await store.remove(task.id);
  assert.equal(await store.get(task.id), null);
  assert.equal(await store.readMemory(task.id, { id }), '资料不存在。');
});

test('memory pagination and literal search retain the original source', async t => {
  const { store, task } = await fixture(t);
  const id = await store.putMemory(task, 'a'.repeat(10000) + 'needle' + 'b'.repeat(10000), 'source');
  const found = JSON.parse(await store.readMemory(task.id, { id, query: 'needle', length: 500 }));
  assert.equal(found.offset, 9800); assert.match(found.text, /needle/); assert.equal(found.next, 10300);
});

test('recovery restores progress and uncertain action without replaying native tool calls', async t => {
  const { store, task, dir } = await fixture(t);
  task.progress = { goal: 'test', constraints: [], stages: [{ title: 'submit', status: 'running', evidence: '' }], next: 'verify submission' };
  task.pendingAction = { tool: 'computer', input: { action: 'left_click' }, state: 'unknown' };
  task.contextSummary = 'Submission outcome unknown';
  task.userMessages = ['original goal', 'later constraint: do not purchase'];
  await store.save(task);
  const agent = new Agent('http://localhost', { dataDir: dir });
  t.after(() => agent.sessions.close());
  agent.boot = async () => {};
  await agent.recover(task.id, { provider: 'openai', baseURL: 'http://localhost', model: 'mock' });
  await agent.promise;
  assert.deepEqual(agent.task.progress, task.progress);
  assert.match(agent.provider.pendingUser[0].text, /不得直接重放/);
  assert.match(agent.provider.pendingUser[0].text, /unknown/);
  assert.match(agent.provider.pendingUser[0].text, /later constraint/);
  assert.equal(agent.provider.messages.length, 1);
});

test('authentication errors are nonretryable but rate limits retain retry delay', async t => {
  const provider = new OpenAIProvider({ baseURL: 'http://localhost', model: 'mock' }, { system: 's', tools: [] });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401 }));
  await assert.rejects(provider.step({ signal: signal() }), e => e.nonRetryable);
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: false, status: 429, headers: { get: () => '4' } }));
  await assert.rejects(provider.step({ signal: signal() }), e => !e.nonRetryable && e.retryAfterMs === 4000);
});

test('truncated tool calls can be followed by another valid request without orphaned tool messages', async t => {
  const { dir } = await fixture(t);
  const agent = new Agent('http://localhost', { dataDir: dir });
  t.after(() => agent.sessions.close());
  agent.task = { id: crypto.randomUUID(), goal: 'test', mode: 'ai', provider: 'openai', status: 'running', step: 0, modelTurns: 0, events: [], history: [], audit: [], userMessages: [], metrics: { requests: [], tools: [], retries: 0 }, controller: new AbortController(), _secrets: new Set() };
  agent.browser = {};
  agent.provider = new OpenAIProvider({ baseURL: 'http://localhost', model: 'mock' }, { system: 's', tools: [] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (++calls === 2) {
      const assistant = body.messages.findIndex(m => m.tool_calls?.length);
      assert.equal(body.messages[assistant + 1].role, 'tool');
      assert.equal(body.messages[assistant + 1].tool_call_id, 'truncated');
    }
    return { ok: true, json: async () => ({ choices: [{ finish_reason: calls === 1 ? 'length' : 'stop', message: calls === 1 ? { tool_calls: [{ id: 'truncated', function: { name: 'computer', arguments: '{' } }] } : { content: 'done' } }] }) };
  });
  await agent.loop();
  assert.equal(agent.task.status, 'failed');
  agent.followUp('continue'); await agent.promise;
  assert.equal(agent.task.status, 'done');
  assert.equal(agent.task.history.length, 0);
});
