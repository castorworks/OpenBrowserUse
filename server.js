import express from 'express';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { apiEndpoint } from './lib/model.js';
import { allowedURL } from './lib/browser.js';
import { Runner } from './lib/runner.js';

const root = dirname(fileURLToPath(import.meta.url));
export function createApp({ port = 4318, browserOptions = {} } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const app = express();
  const runner = new Runner(origin, browserOptions);
  let config = { baseURL: process.env.MODEL_BASE_URL || 'https://api.openai.com/v1', model: process.env.MODEL_NAME || '', apiKey: process.env.MODEL_API_KEY || '', vision: false, jsonMode: false };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return res.status(403).json({ error: 'Host not allowed' });
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
    if (req.path.startsWith('/api') && req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site API access blocked' });
    if (req.method !== 'GET') {
      const caller = req.headers.origin;
      if ((caller && ![origin, `http://localhost:${port}`].includes(caller)) || req.headers['x-browser-agent'] !== '1' || !req.is('application/json')) return res.status(403).json({ error: 'Invalid local request' });
    }
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  const publicConfig = () => ({ ...config, apiKey: undefined, hasKey: Boolean(config.apiKey) });
  app.get('/api/state', (req, res) => res.json({ config: publicConfig(), task: runner.state(), busy: runner.busy }));
  app.post('/api/config', (req, res) => {
    if (runner.busy) return res.status(409).json({ error: '请停止任务后再修改模型配置。' });
    const parsed = z.object({ baseURL: z.string().max(3000), model: z.string().trim().min(1).max(200), apiKey: z.string().max(4000).optional(), clearKey: z.boolean().optional(), vision: z.boolean(), jsonMode: z.boolean() }).parse(req.body);
    apiEndpoint(parsed.baseURL);
    const baseURL = parsed.baseURL.trim().replace(/\/$/, '');
    config = { baseURL, model: parsed.model, apiKey: parsed.clearKey ? '' : (parsed.apiKey || (baseURL === config.baseURL ? config.apiKey : '')), vision: parsed.vision, jsonMode: parsed.jsonMode };
    res.json(publicConfig());
  });
  app.post('/api/tasks', (req, res) => {
    const input = z.object({ goal: z.string().trim().min(1).max(8000), startURL: z.string().max(4000).default('https://example.com'), maxSteps: z.number().int().min(1).max(80).default(20), autoInteract: z.boolean().default(false), demo: z.boolean().default(false) }).parse(req.body);
    if (runner.busy) return res.status(409).json({ error: '已有任务正在执行。' });
    if (!input.demo) { if (!config.model) throw new Error('请先在模型设置中填写模型名。'); allowedURL(input.startURL, origin); }
    runner.start(input, config); res.status(202).json({ ok: true });
  });
  app.post('/api/control', (req, res) => {
    const body = z.object({ command: z.enum(['pause', 'resume', 'stop', 'approve', 'reject']), answer: z.string().max(4000).optional() }).parse(req.body);
    runner.control(body.command, body.answer); res.json({ ok: true });
  });
  app.get('/demo', (req, res) => res.sendFile(resolve(root, 'public/demo.html')));
  app.use(express.static(resolve(root, 'public')));
  app.use((err, req, res, next) => res.status(400).json({ error: err instanceof z.ZodError ? '输入格式不正确，请检查必填项和步数。' : err.message.slice(0, 1000) }));
  return { app, runner };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4318);
  const { app, runner } = createApp({ port });
  const server = app.listen(port, '127.0.0.1', () => console.log(`Browser Use ready: http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (runner.busy) runner.control('stop'); await runner.promise; server.close(); });
}
