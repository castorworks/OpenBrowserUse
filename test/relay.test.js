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
  const extension = new WebSocket(`ws://127.0.0.1:${port}/relay/extension`, { origin: `chrome-extension://${'a'.repeat(32)}` });
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
  const next = new ExtensionRelay();
  next.attach(replacement, port);
  t.after(() => { next.close(); replacement.close(); });
  replacement.listen(port, '127.0.0.1');
  await once(replacement, 'listening');
  const reconnected = new WebSocket(`ws://127.0.0.1:${port}/relay/extension`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(reconnected, 'open');
  assert.equal(next.status().connected, true);
  assert.equal(relay.status().connected, false);
});

test('extension relay rejects missing, web and malformed origins and foreign hosts', { timeout: 5000 }, async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const relay = new ExtensionRelay();
  const port = server.address().port;
  relay.attach(server, port);
  t.after(() => { relay.close(); server.close(); });
  const refused = options => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/extension`, options);
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.on('open', () => { ws.close(); reject(new Error('Unexpected accepted connection')); });
    ws.on('error', () => {});
  });
  for (const origin of [undefined, 'null', 'https://evil.example', 'chrome-extension://', `chrome-extension://${'a'.repeat(32)}/page`, `chrome-extension://${'z'.repeat(32)}`]) {
    assert.equal(await refused(origin ? { origin } : {}), 403, origin);
  }
  assert.equal(await refused({ origin: `chrome-extension://${'a'.repeat(32)}`, headers: { Host: 'evil.example' } }), 403);
  assert.equal(relay.connected(), false);
});
