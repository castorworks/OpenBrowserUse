import { createServer } from 'node:http';
import { createApplication } from './application.js';

// Reserve the loopback WebSocket relay port before constructing the application.
export async function startRuntime({ port = 4318, fallbackPort = false, ...options } = {}) {
  const server = createServer((_req, res) => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Not found'); });
  const listen = value => new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready);
    server.listen(value, '127.0.0.1');
  });
  try { await listen(port); }
  catch (error) { if (error.code !== 'EADDRINUSE' || !fallbackPort) throw error; await listen(0); }
  port = server.address().port;
  let application;
  try { const api = createApplication({ ...options, port }); application = { api, agent: api.agent, relay: api.relay }; }
  catch (error) { server.close(); throw error; }
  application.relay.attach(server, port);
  let closing;
  const close = () => closing ||= (async () => {
    try { await application.api.close(); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  })();
  return { ...application, server, port, origin: `http://127.0.0.1:${port}`, close };
}
