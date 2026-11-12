import { createServer } from 'node:http';
import { createApplication } from './application.js';
import { acquireRuntimeLock } from './runtime-lock.js';
import { startHttpListener } from './http-api.js';

// Reserve the loopback WebSocket relay port before constructing the application.
export async function startRuntime({ port = 4318, fallbackPort = false, ...options } = {}) {
  const releaseLock = await acquireRuntimeLock(options.dataDir || (options.env || process.env).OBU_DATA_DIR);
  const server = createServer((_req, res) => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Not found'); });
  const listen = value => new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready);
    server.listen(value, '127.0.0.1');
  });
  try { await listen(port); }
  catch (error) {
    if (error.code !== 'EADDRINUSE' || !fallbackPort) {
      releaseLock();
      if (error.code === 'EADDRINUSE') error.message = `本机中继端口 ${port} 已被占用。若独立服务已运行，请设置 OBU_SERVICE_URL 连接它；否则请先关闭占用端口的后台。`;
      throw error;
    }
    try { await listen(0); } catch (error) { releaseLock(); throw error; }
  }
  port = server.address().port;
  let application;
  try { const api = createApplication({ ...options, port }); application = { api, agent: api.agent, relay: api.relay }; }
  catch (error) { server.close(); releaseLock(); throw error; }
  application.relay.attach(server, port);
  let http;
  try {
    await application.api.ready;
    const env = options.env || process.env;
    if (env.OBU_API_ENABLED === '1') {
      http = await startHttpListener(application.api.httpApi, { token: env.OBU_API_TOKEN, port: Number(env.OBU_API_PORT ?? 4319), host: env.OBU_API_HOST || '127.0.0.1', desktop: application.api });
      application.agent.options.apiPort = http.port;
    }
  } catch (error) { try { await application.api.close(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); releaseLock(); } throw error; }
  application.api.tasks.lifecycle.start();
  let closing;
  const close = () => closing ||= (async () => {
    application.api.tasks.stop();
    try { await http?.close(); await application.api.close(); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); releaseLock(); }
  })();
  return { ...application, httpPort: http?.port, server, port, origin: `http://127.0.0.1:${port}`, close };
}
