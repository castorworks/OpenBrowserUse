import express from 'express';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { apiEndpoint } from './lib/providers/openai.js';
import { DEFAULT_ANTHROPIC_MODEL } from './lib/providers/anthropic.js';
import { allowedURL, localCDPURL } from './lib/browser/url.js';
import { Agent } from './lib/agent.js';
import { DEFAULT_BLOCKED_SITES } from './lib/permissions/rules.js';
import { MODES } from './lib/permissions/policy.js';

const root = dirname(fileURLToPath(import.meta.url));

function defaultConfig(env = process.env) {
  const provider = env.MODEL_PROVIDER === 'openai' ? 'openai' : 'anthropic';
  return {
    provider,
    baseURL: env.MODEL_BASE_URL || (provider === 'openai' ? 'https://api.openai.com/v1' : ''),
    model: env.MODEL_NAME || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : ''),
    apiKey: env.MODEL_API_KEY || '',
    effort: 'high', vision: false,
    browser: {
      mode: ['persistent', 'cdp'].includes(env.BROWSER_MODE) ? env.BROWSER_MODE : 'ephemeral',
      cdpURL: env.BROWSER_CDP_URL || 'http://127.0.0.1:9222', allowLocalhost: env.BROWSER_ALLOW_LOCALHOST !== '0', allowPrivateNetwork: env.BROWSER_ALLOW_PRIVATE === '1',
      blockedSites: DEFAULT_BLOCKED_SITES,
    },
    reviewerModel: env.REVIEWER_MODEL || '',
  };
}

export function createApp({ port = 4318, browserOptions = {}, env = process.env, dataDir = env.OBU_DATA_DIR } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const app = express();
  const agent = new Agent(origin, { profileDir: env.BROWSER_PROFILE_DIR, dataDir, ...browserOptions });
  let config = defaultConfig(env);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return res.status(403).json({ error: 'Host not allowed' });
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
    if (req.path.startsWith('/api') && req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site API access blocked' });
    if (req.method !== 'GET') {
      const caller = req.headers.origin;
      if ((caller && ![origin, `http://localhost:${port}`].includes(caller)) || req.headers['x-browser-agent'] !== '1' || !req.is('application/json')) return res.status(403).json({ error: 'Invalid local request' });
    }
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  const publicConfig = () => ({ ...config, apiKey: undefined, hasKey: Boolean(config.apiKey), envKey: config.provider === 'anthropic' && !config.apiKey && Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) });
  app.get('/api/state', (req, res) => res.json({ config: publicConfig(), task: agent.state(), busy: agent.busy, loginOpen: Boolean(agent.login), permissions: agent.permissions.list() }));
  app.post('/api/config', (req, res) => {
    if (agent.busy) return res.status(409).json({ error: '请停止任务后再修改模型配置。' });
    const parsed = z.object({
      provider: z.enum(['anthropic', 'openai']).default('anthropic'), baseURL: z.string().trim().max(3000).default(''),
      model: z.string().trim().min(1).max(200), apiKey: z.string().max(4000).optional(), clearKey: z.boolean().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'), vision: z.boolean().default(false), reviewerModel: z.string().trim().max(200).default(''),
    }).parse(req.body);
    const baseURL = parsed.baseURL.replace(/\/$/, '');
    if (parsed.provider === 'openai' || baseURL) apiEndpoint(parsed.provider === 'openai' ? baseURL : `${baseURL}/v1`);
    // A key belongs to one provider + endpoint; switching either drops it.
    const sameService = parsed.provider === config.provider && baseURL === config.baseURL;
    config = { ...config, provider: parsed.provider, baseURL, model: parsed.model, apiKey: parsed.clearKey ? '' : (parsed.apiKey || (sameService ? config.apiKey : '')), effort: parsed.effort, vision: parsed.vision, reviewerModel: parsed.reviewerModel };
    res.json(publicConfig());
  });
  app.post('/api/browser', (req, res) => {
    if (agent.busy || agent.browser) return res.status(409).json({ error: '请先停止任务并关闭浏览器，再修改浏览器设置。' });
    const parsed = z.object({ mode: z.enum(['ephemeral', 'persistent', 'cdp']), cdpURL: z.string().trim().max(500).default(''), allowLocalhost: z.boolean(), allowPrivateNetwork: z.boolean(), blockedSites: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+$/).min(3).max(200)).max(500).default(DEFAULT_BLOCKED_SITES) }).parse(req.body);
    const cdpURL = parsed.mode === 'cdp' || parsed.cdpURL ? localCDPURL(parsed.cdpURL) : config.browser.cdpURL;
    config = { ...config, browser: { ...parsed, cdpURL } };
    res.json(publicConfig());
  });
  app.post('/api/login', async (req, res) => {
    const { action, url } = z.object({ action: z.enum(['open', 'close']), url: z.string().max(4000).optional() }).parse(req.body);
    if (action === 'close') await agent.closeLogin();
    else await agent.openLogin(url ? allowedURL(url, origin, config.browser) : undefined, config.browser);
    res.json({ ok: true, loginOpen: Boolean(agent.login) });
  });
  app.post('/api/permissions', (req, res) => {
    const { site } = z.object({ action: z.literal('revoke'), site: z.string().max(300) }).parse(req.body);
    agent.permissions.revoke(site); res.json({ permissions: agent.permissions.list() });
  });
  app.post('/api/tasks', async (req, res) => {
    const input = z.object({ goal: z.string().trim().min(1).max(8000), startURL: z.string().max(4000).default('https://example.com'), maxSteps: z.number().int().min(1).max(200).default(50), permissionMode: z.enum(MODES).default('ask'), demo: z.boolean().default(false) }).parse(req.body);
    if (agent.busy) return res.status(409).json({ error: '已有任务正在执行。' });
    if (!input.demo) { if (!config.model) throw new Error('请先在模型设置中填写模型名。'); allowedURL(input.startURL, origin, config.browser); }
    await agent.start(input, config); res.status(202).json({ ok: true });
  });
  app.post('/api/messages', (req, res) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(8000) }).parse(req.body);
    agent.followUp(text); res.status(202).json({ ok: true });
  });
  app.post('/api/control', (req, res) => {
    const body = z.object({ command: z.enum(['pause', 'resume', 'stop', 'approve', 'reject', 'approve_site', 'deny_site']), answer: z.string().max(4000).optional() }).parse(req.body);
    agent.control(body.command, body.answer); res.json({ ok: true });
  });
  app.get('/demo', (req, res) => res.sendFile(resolve(root, 'public/demo.html')));
  app.use(express.static(resolve(root, 'public')));
  app.use((err, req, res, next) => res.status(400).json({ error: err instanceof z.ZodError ? '输入格式不正确，请检查必填项和步数。' : err.message.slice(0, 1000) }));
  return { app, agent };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4318);
  const { app, agent } = createApp({ port });
  const server = app.listen(port, '127.0.0.1', () => console.log(`Browser Use ready: http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { try { agent.control('stop'); } catch {} await agent.promise; await agent.closeBrowser(); await agent.closeLogin(); server.close(); });
}
