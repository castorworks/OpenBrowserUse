import { ServiceClient } from './service-client.js';
import { discoverService } from './service-discovery.js';
import { startRuntime } from './runtime.js';

function refused(error) {
  if (error?.code === 'ECONNREFUSED') return true;
  if (error?.cause && refused(error.cause)) return true;
  return Array.isArray(error?.errors) && error.errors.length > 0 && error.errors.every(refused);
}

export async function startDesktopRuntime(env = process.env) {
  const explicit = Boolean(env.OBU_SERVICE_URL);
  const service = explicit ? { url: env.OBU_SERVICE_URL, token: env.OBU_API_TOKEN } : await discoverService(env.OBU_DATA_DIR);
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
  return startRuntime({
    port: Number(env.OBU_DESKTOP_PORT ?? env.PORT ?? 4318), env,
    browserOptions: { headless: env.BROWSER_HEADLESS === '1' },
  });
}
