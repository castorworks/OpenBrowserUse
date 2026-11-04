import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../lib/application.js';

test('task input, follow-ups and control answers pass former size limits without a step cap', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'obu-size-'));
  const api = createApplication({ port: 14530, dataDir, env: {} });
  const { agent } = api;
  const post = body => api.request('POST', '/api/tasks', body);
  try {
    const goal = '中'.repeat(3000000); // Over both former character and 8 MB body limits.
    agent.start = async input => { assert.equal(input.goal, goal); assert.equal(input.maxSteps, undefined); };
    const accepted = await post({ goal, maxSteps: 1 }); // Legacy callers cannot reintroduce a step cap.
    assert.equal(accepted.status, 202);
    agent.message = text => assert.equal(text, goal);
    agent.control = (command, answer) => { assert.equal(command, 'resume'); assert.equal(answer, goal); };
    for (const [path, body] of [['messages', { text: goal }], ['control', { command: 'resume', answer: goal }]]) {
      const response = await api.request('POST', '/api/' + path, body);
      assert.ok(response.status < 300, JSON.stringify(response.body));
    }
    assert.equal((await post({ goal: '   ' })).status, 400);
    const response = await api.request('POST', '/api/browser', { mode: 'ephemeral', allowLocalhost: true, allowPrivateNetwork: false, blockedSites: Array.from({ length: 500 }, (_, i) => `${'a'.repeat(150)}${i}.example.com`) });
    assert.equal(response.status, 200);
  } finally {
    await api.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
