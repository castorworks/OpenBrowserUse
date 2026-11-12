import { z } from 'zod';
import { fail } from './api-error.js';

// Private, versioned desktop transport. Credentials stay in the utility process.
const path = /^\/api\/(state|sessions(?:\/[a-f0-9-]{36})?|sessions\/(?:delete|recover|page)|config|browser|login|permissions|tasks|messages|control|jobs(?:\/[a-f0-9-]{36}\/cancel)?|lifecycle)$/;
export const desktopRequest = z.object({ method: z.enum(['GET', 'POST']), path: z.string().regex(path), body: z.unknown().optional() }).strict();
export function requireLocalPeer(req) {
  const address = req.socket.remoteAddress || '';
  if (address !== '::1' && !/^(?:::ffff:)?127\./.test(address)) fail(403, 'local_desktop_only');
}
export function streamDesktop(application, res, streams) {
  let unsubscribe, heartbeat, closed = false, blocked = false;
  const pending = new Map();
  const end = () => { cleanup(); res.end(); };
  const cleanup = () => {
    if (closed) return; closed = true;
    unsubscribe?.(); clearInterval(heartbeat); pending.clear(); streams.delete(end); res.off('drain', drain);
  };
  const send = (event, data) => {
    if (closed) return;
    if (blocked) { pending.set(event, data); return; }
    blocked = !res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.writableLength > 4 * 1024 * 1024) { cleanup(); res.destroy(); }
  };
  const drain = () => {
    blocked = false;
    for (const [event, data] of pending) { pending.delete(event); send(event, data); if (blocked || closed) break; }
  };
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); res.on('close', cleanup); res.on('drain', drain); streams.add(end);
  // Each connection begins with a fresh snapshot, never a replay of commands.
  unsubscribe = application.subscribe(send);
  if (closed) unsubscribe();
  heartbeat = setInterval(() => { if (!closed && !blocked) blocked = !res.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();
}
