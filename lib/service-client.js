import { setTimeout as delay } from 'node:timers/promises';

export function localServiceURL(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('OBU_SERVICE_URL 必须是本机 HTTP 服务地址，例如 http://127.0.0.1:4319。');
  return url.origin;
}

// Attaching never starts, stops or takes the data-directory lock of the service.
export class ServiceClient {
  constructor({ url, token }) {
    this.origin = localServiceURL(url);
    if (!token || token.length < 32 || /\s/.test(token)) throw new Error('连接已有服务需要配置 OBU_API_TOKEN。');
    this.headers = { Authorization: `Bearer ${token}` };
    this.listeners = new Set(); this.latest = new Map(); this.controller = new AbortController();
  }
  static async connect(options) {
    const client = new ServiceClient(options);
    try {
      const response = await client.request('GET', '/api/state');
      if (response.status !== 200) throw new Error('无法读取服务状态。');
      client.publish('state', response.body);
      client.streaming = client.stream();
      return client;
    } catch (error) { await client.close(); throw error; }
  }
  async request(method, path, body) {
    const res = await fetch(`${this.origin}/internal/desktop/v1/request`, {
      method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ method, path, ...(body === undefined ? {} : { body }) }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(60000)]),
    });
    if (!res.ok) throw new Error(`服务连接失败（HTTP ${res.status}）。请检查地址、令牌及服务版本。`);
    const result = await res.json();
    if (method === 'GET' && path === '/api/state' && result.status === 200) result.body = { ...result.body, service: { ownership: 'external', url: this.origin } };
    return result;
  }
  publish(event, data) {
    if (event === 'state') data = { ...data, service: { ownership: 'external', url: this.origin } };
    if (['state', 'frame', 'pointer'].includes(event)) this.latest.set(event, data);
    for (const listener of this.listeners) listener(event, data);
  }
  subscribe(listener) {
    this.listeners.add(listener);
    for (const [event, data] of this.latest) listener(event, data);
    return () => this.listeners.delete(listener);
  }
  async stream() {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.origin}/internal/desktop/v1/events`, { headers: this.headers, signal, redirect: 'error' });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const decoder = new TextDecoder(); let pending = '';
        for await (const bytes of res.body) {
          pending += decoder.decode(bytes, { stream: true });
          let split;
          while ((split = pending.indexOf('\n\n')) !== -1) {
            const block = pending.slice(0, split); pending = pending.slice(split + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
            if (event && data && ['state', 'frame', 'pointer', 'desktop-focus'].includes(event)) this.publish(event, JSON.parse(data));
          }
          if (pending.length > 16 * 1024 * 1024) throw new Error('服务事件超过大小限制。');
        }
        if (!signal.aborted) throw new Error('服务事件连接已关闭。');
      } catch {
        if (signal.aborted) break;
        this.publish('offline', '已有服务连接中断，正在重连；已提交的任务不会自动重发。');
        await delay(1000, undefined, { signal }).catch(() => {});
      }
    }
  }
  async close() { this.controller.abort(); await this.streaming; this.listeners.clear(); this.latest.clear(); }
}
