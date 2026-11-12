import { ServiceClient } from '../lib/service-client.js';
import { startRuntime } from '../lib/runtime.js';

const parent = process.parentPort;
if (!parent) throw new Error('Desktop backend must run as an Electron utility process.');
let runtime, unsubscribe, frameTimer, frame, closing;
const send = message => parent.postMessage(message);
async function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    unsubscribe?.(); clearTimeout(frameTimer);
    await runtime?.close();
    send({ type: 'closed' });
    process.exit(0);
  })();
  return closing;
}
parent.on('message', async ({ data }) => {
  if (data?.type === 'shutdown') { await shutdown(); return; }
  if (data?.type !== 'request') return;
  try {
    if (!runtime || closing) throw new Error('后台未就绪或正在关闭。');
    const response = await runtime.api.request(data.method, data.path, data.body);
    send({ type: 'response', id: data.id, ...response });
  } catch (error) { send({ type: 'response', id: data.id, status: 500, body: { error: error.message } }); }
});
try {
  if (process.env.OBU_SERVICE_URL) {
    const client = await ServiceClient.connect({ url: process.env.OBU_SERVICE_URL, token: process.env.OBU_API_TOKEN });
    runtime = { api: client, origin: client.origin, close: () => client.close() };
  } else {
    runtime = await startRuntime({
      port: Number(process.env.OBU_DESKTOP_PORT ?? process.env.PORT ?? 4318), fallbackPort: false,
      browserOptions: { headless: process.env.BROWSER_HEADLESS === '1' },
    });
  }
  unsubscribe = runtime.api.subscribe((event, data) => {
    if (event === 'desktop-focus') send({ type: 'desktop-focus' });
    else if (event === 'state' || event === 'pointer' || event === 'offline') send({ type: 'event', event, data });
    else {
      frame = data;
      frameTimer ||= setTimeout(() => { frameTimer = null; send({ type: 'event', event: 'frame', data: frame }); }, 120);
    }
  });
  send({ type: 'ready', origin: runtime.origin });
} catch (error) {
  send({ type: 'fatal', error: error.message });
  await runtime?.close(); process.exit(1);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void shutdown(); });
