import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { ExtensionRelay } from '../lib/extension/relay.js';

test('shutdown disconnects upgraded clients so they cannot remain on a retired server', { timeout: 5000 }, async t => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const relay = new ExtensionRelay();
  relay.attach(server, port);
  t.after(() => { relay.close(); server.close(); });
  const extension = new WebSocket(`ws://127.0.0.1:${port}/relay/extension?token=${relay.token}`, { origin: 'chrome-extension://test' });
  await once(extension, 'open');
  const cdp = new WebSocket(relay.cdpEndpoint());
  await once(cdp, 'open');
  assert.equal(relay.status().connected, true);
  const disconnected = Promise.all([once(extension, 'close'), once(cdp, 'close')]);
  const stopped = once(server, 'close');
  relay.close();
  server.close();
  await disconnected;
  await stopped;
  assert.deepEqual(relay.status(), { connected: false, browser: null });

  // The replacement accepts a fresh connection on exactly the same address.
  const replacement = createServer();
  const next = new ExtensionRelay({ token: relay.token });
  next.attach(replacement, port);
  t.after(() => { next.close(); replacement.close(); });
  replacement.listen(port, '127.0.0.1');
  await once(replacement, 'listening');
  const reconnected = new WebSocket(`ws://127.0.0.1:${port}/relay/extension?token=${next.token}`, { origin: 'chrome-extension://test' });
  await once(reconnected, 'open');
  assert.equal(next.status().connected, true);
  assert.equal(relay.status().connected, false);
});
