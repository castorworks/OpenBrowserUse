import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

test('large inputs get actionable errors and valid browser settings exceed the old 64 KB limit', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'obu-size-'));
  const { app, agent, relay } = createApp({ port: 14530, dataDir, env: {} });
  const server = await new Promise(resolve => {
    const s = app.listen(14530, '127.0.0.1', () => resolve(s));
  });
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Browser-Agent': '1' }, body: JSON.stringify(body),
  });
  try {
    agent.start = async input => { assert.equal(input.goal.length, 2000000); assert.equal(input.maxSteps, 200000); };
    const accepted = await post({ goal: '中'.repeat(2000000), maxSteps: 200000 });
    assert.equal(accepted.status, 202);
    const invalidSteps = await post({ goal: 'test', maxSteps: 200001 });
    assert.equal(invalidSteps.status, 400);
    const long = await post({ goal: '中'.repeat(2000001) });
    assert.equal(long.status, 400);
    assert.match((await long.json()).error, /2,000,000/);
    assert.equal(agent.busy, false);
    const huge = await post({ goal: 'x'.repeat(8 * 1024 * 1024) });
    assert.equal(huge.status, 413);
    assert.match((await huge.json()).error, /8 MB/);
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
