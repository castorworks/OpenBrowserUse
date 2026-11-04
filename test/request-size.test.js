import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

test('task input, follow-ups and control answers pass former size limits without a step cap', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'obu-size-'));
  const { app, agent, relay } = createApp({ port: 14530, dataDir, env: {} });
  const server = await new Promise(resolve => {
    const s = app.listen(14530, '127.0.0.1', () => resolve(s));
  });
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Browser-Agent': '1' }, body: JSON.stringify(body),
  });
  try {
    const goal = '中'.repeat(3000000); // Over both former character and 8 MB body limits.
    agent.start = async input => { assert.equal(input.goal, goal); assert.equal(input.maxSteps, undefined); };
    const accepted = await post({ goal, maxSteps: 1 }); // Legacy callers cannot reintroduce a step cap.
    assert.equal(accepted.status, 202);
    agent.message = text => assert.equal(text, goal);
    agent.control = (command, answer) => { assert.equal(command, 'resume'); assert.equal(answer, goal); };
    for (const [path, body] of [['messages', { text: goal }], ['control', { command: 'resume', answer: goal }]]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Browser-Agent': '1' }, body: JSON.stringify(body),
      });
      assert.ok(response.ok, await response.text());
    }
    assert.equal((await post({ goal: '   ' })).status, 400);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/browser`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Browser-Agent': '1' },
      body: JSON.stringify({ mode: 'ephemeral', allowLocalhost: true, allowPrivateNetwork: false, blockedSites: Array.from({ length: 500 }, (_, i) => `${'a'.repeat(150)}${i}.example.com`) }),
    });
    assert.equal(response.status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    relay.close();
    agent.sessions.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
