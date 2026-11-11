#!/usr/bin/env node
import { startRuntime } from '../lib/runtime.js';

let runtime;
try {
  runtime = await startRuntime({ port: Number(process.env.PORT ?? 4318), fallbackPort: false, env: { ...process.env, OBU_API_ENABLED: '1' }, browserOptions: { headless: process.env.BROWSER_HEADLESS === '1' } });
  console.error(`OpenBrowserUse API listening on http://127.0.0.1:${runtime.httpPort}/v1`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
if (runtime) {
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return; closing = true;
    try { await runtime.close(); } catch (error) { console.error(error.message); process.exitCode = 1; }
  });
}
