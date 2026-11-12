import { setTimeout as delay } from 'node:timers/promises';
import { ServiceClient } from './service-client.js';
import { discoverService } from './service-discovery.js';
import { startRuntime } from './runtime.js';

function refused(error) {
  if (error?.code === 'ECONNREFUSED') return true;
  if (error?.cause && refused(error.cause)) return true;
  return Array.isArray(error?.errors) && error.errors.length > 0 && error.errors.every(refused);
}

async function attach(env, relayPort) {
  const explicit = Boolean(env.OBU_SERVICE_URL);
  const service = explicit ? { url: env.OBU_SERVICE_URL, token: env.OBU_API_TOKEN } : await discoverService(env.OBU_DATA_DIR, relayPort);
  if (service) {
    try {
      const client = await ServiceClient.connect({ ...service, timeout: 3000 });
      return { api: client, origin: client.origin, close: () => client.close() };
    } catch (error) {
      // A refused connection is a stale record. Authentication/protocol/timeouts are
      // not proof of absence: never launch another backend after those failures.
      if (explicit || !refused(error)) throw error;
    }
  }
  return null;
}

export async function startDesktopRuntime(env = process.env) {
  const port = Number(env.OBU_DESKTOP_PORT ?? env.PORT ?? 4318);
  const client = await attach(env, port);
  if (client) return client;
  try {
    return await startRuntime({ port, env, browserOptions: { headless: env.BROWSER_HEADLESS === '1' } });
  } catch (error) {
    if (!['EADDRINUSE', 'OBU_RUNTIME_BUSY'].includes(error.code)) throw error;
    // A concurrently starting service may own the port before publishing discovery.
    for (let i = 0; i < 20; i++) {
      await delay(150);
      const client = await attach(env, port);
      if (client) return client;
    }
    throw new Error('本机后台已占用端口或数据目录，但未发现可连接的标准服务。请先重启已更新的独立服务再打开桌面；若仍失败，请检查占用端口的程序。', { cause: error });
  }
}
