import { z } from 'zod';
import { apiEndpoint } from './providers/openai.js';
import { allowedURL } from './browser/url.js';
import { Agent } from './agent.js';
import { DEFAULT_BLOCKED_SITES } from './permissions/rules.js';
import { MODES } from './permissions/policy.js';
import { ConfigStore } from './config-store.js';
import { ExtensionRelay } from './extension/relay.js';
import { HttpApi } from './http-api.js';
import { TaskService } from './task-service.js';
import { loadExtensionToken } from './extension/token.js';

const DEFAULT_BASE_URLS = { openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com' };
const DEFAULT_MODELS = { openai: '', deepseek: 'deepseek-flash' };

function defaultConfig(env = process.env) {
  if (env.BROWSER_MODE === 'cdp') throw new Error('直接 CDP 模式已移除，请将 BROWSER_MODE 改为 extension、persistent 或 ephemeral。');
  if (env.MODEL_PROVIDER && !['openai', 'deepseek'].includes(env.MODEL_PROVIDER)) throw new Error('MODEL_PROVIDER 仅支持 openai 或 deepseek。');
  const provider = env.MODEL_PROVIDER || 'openai';
  return {
    provider,
    baseURL: env.MODEL_BASE_URL || DEFAULT_BASE_URLS[provider],
    model: env.MODEL_NAME || DEFAULT_MODELS[provider],
    apiKey: env.MODEL_API_KEY || (provider === 'deepseek' ? env.DEEPSEEK_API_KEY || '' : ''),
    contextWindow: 128000, outputReserve: 16000,
    effort: 'high', vision: provider === 'deepseek',
    browser: {
      mode: ['persistent', 'extension'].includes(env.BROWSER_MODE) ? env.BROWSER_MODE : 'ephemeral',
      blockedSites: DEFAULT_BLOCKED_SITES,
    },
    reviewerModel: env.REVIEWER_MODEL || '',
  };
}

// Application operations called by the desktop background process over IPC.
export function createApplication({ port = 4318, browserOptions = {}, env = process.env, dataDir = env.OBU_DATA_DIR } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  // The Chrome extension connects over WebSocket; call relay.attach(server, port) after listen().
  const relay = new ExtensionRelay({ token: loadExtensionToken(dataDir) });
  const agent = new Agent(origin, { profileDir: env.BROWSER_PROFILE_DIR, dataDir, relay, ...browserOptions });
  const configStore = new ConfigStore({ dir: dataDir });
  let config = { ...defaultConfig(env), ...configStore.load() };
  if (config.browser.requiresSelection && ['ephemeral', 'persistent', 'extension'].includes(env.BROWSER_MODE)) {
    const { requiresSelection, ...browser } = config.browser;
    config.browser = { ...browser, mode: env.BROWSER_MODE };
    configStore.save(config);
  }
  if (config.modelRequiresSelection && ['openai', 'deepseek'].includes(env.MODEL_PROVIDER) && env.MODEL_NAME) {
    const defaults = defaultConfig(env);
    for (const key of ['provider', 'model', 'baseURL', 'apiKey', 'reviewerModel', 'vision', 'effort']) config[key] = defaults[key];
    delete config.modelRequiresSelection;
    configStore.save(config);
  }
  const publicConfig = () => ({ ...config, apiKey: undefined, hasKey: Boolean(config.apiKey), defaults: { baseURL: DEFAULT_BASE_URLS, model: DEFAULT_MODELS } });
  const fullState = (compact = false) => ({ config: publicConfig(), task: tasks.state({ compact }), busy: agent.busy, loginOpen: Boolean(agent.login), permissions: agent.permissions.list(), extension: { ...relay.status(), serverURL: origin }, queue: tasks.lifecycle ? { jobs: tasks.all('job').sort((a,b) => { const rank = j => j.status === 'running' ? 0 : j.status === 'queued' ? 1 : 2; return rank(a)-rank(b) || (a.status === 'queued' ? a.queue_sequence-b.queue_sequence : b.queue_sequence-a.queue_sequence); }).slice(0,20), queued_count: tasks.lifecycle.queued().length, blocked_by_session: Boolean(tasks.openSession() && !tasks.openSession().job_id), settings: tasks.lifecycle.settings() } : null });
  let commandTail = Promise.resolve();
  const serialize = operation => { const result = commandTail.then(operation); commandTail = result.catch(() => {}); return result; };
  const tasks = new TaskService({ agent, config: () => config, relay, serialize });
  const httpApi = new HttpApi(tasks);
  const ready = tasks.init();
  const routes = [];
  const route = (method, path, handler) => routes.push({ method, path, handler });
  const listeners = new Set();
  let queued = false;
  const publish = () => {
    if (queued || !listeners.size) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const state = fullState(true);
      for (const listener of listeners) listener('state', state);
    });
  };
  tasks.onChange = publish;
  agent.on('change', publish); relay.on('change', publish);
  route('GET', '/api/state', (req, res) => res.json(fullState()));
  route('POST', '/api/extension/token', (req, res) => res.json({ token: relay.token }));
  route('GET', '/api/sessions', async (req, res) => res.json({ sessions: await agent.sessions.list() }));
  route('GET', '/api/sessions/:id', async (req, res) => {
    if (agent.task?.id === req.params.id) await agent.save();
    const session = await agent.sessions.get(req.params.id, { includeMemory: true });
    return session ? res.json(session) : res.status(404).json({ error: '会话不存在。' });
  });
  route('POST', '/api/sessions/recover', async (req, res) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.body);
    await tasks.recoverTask(id); res.status(202).json({ ok: true });
  });
  route('POST', '/api/sessions/page', async (req, res) => {
    const { id, offset, limit } = z.object({ id: z.string().uuid(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(400).default(100) }).parse(req.body);
    res.json(await agent.sessions.page(id, offset, limit));
  });
  route('POST', '/api/sessions/delete', async (req, res) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.body);
    if (agent.task?.id === id && (agent.busy || agent.browser)) return res.status(409).json({ error: '请先关闭当前会话。' });
    tasks.removeSession(id); res.json({ sessions: await agent.sessions.list() });
  });
  route('POST', '/api/config', (req, res) => {
    if (agent.busy || agent.browser) return res.status(409).json({ error: '请关闭当前浏览器会话后再修改模型配置；当前会话继续使用创建时的模型。' });
    const parsed = z.object({
      contextWindow: z.number().int().min(16000).max(2000000).optional(), outputReserve: z.number().int().min(1000).max(64000).optional(),
      provider: z.enum(['openai', 'deepseek']).default('openai'), baseURL: z.string().trim().max(3000).default(''),
      model: z.string().trim().min(1).max(200), apiKey: z.string().max(4000).optional(), clearKey: z.boolean().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'), vision: z.boolean().optional(), reviewerModel: z.string().trim().max(200).default(''),
    }).parse(req.body);
    const baseURL = parsed.baseURL.replace(/\/$/, '') || DEFAULT_BASE_URLS[parsed.provider];
    apiEndpoint(baseURL);
    // A key belongs to one provider + endpoint; switching either drops it.
    const sameService = parsed.provider === config.provider && baseURL === config.baseURL;
    const nextConfig = { ...config, modelRequiresSelection: undefined, contextWindow: parsed.contextWindow ?? config.contextWindow, outputReserve: parsed.outputReserve ?? config.outputReserve, provider: parsed.provider, baseURL, model: parsed.model, apiKey: parsed.clearKey ? '' : (parsed.apiKey || (sameService ? config.apiKey : '')), effort: parsed.effort, vision: parsed.vision ?? (parsed.provider === 'deepseek'), reviewerModel: parsed.reviewerModel };
    configStore.save(nextConfig);
    config = nextConfig;
    res.json(publicConfig());
  });
  route('POST', '/api/browser', (req, res) => {
    if (agent.busy || agent.browser) return res.status(409).json({ error: '请先停止任务并关闭浏览器，再修改浏览器设置。' });
    // Accept obsolete address flags from older desktops, but discard them before saving.
    const parsed = z.object({ mode: z.enum(['ephemeral', 'persistent', 'extension']), allowLocalhost: z.boolean().optional(), allowPrivateNetwork: z.boolean().optional(), blockedSites: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+$/).min(3).max(200)).max(500).default(DEFAULT_BLOCKED_SITES) }).strict().parse(req.body);
    const nextConfig = { ...config, browser: { mode: parsed.mode, blockedSites: parsed.blockedSites } };
    configStore.save(nextConfig); config = nextConfig;
    res.json(publicConfig());
  });
  route('POST', '/api/login', async (req, res) => {
    const { action, url } = z.object({ action: z.enum(['open', 'close']), url: z.string().max(4000).optional() }).parse(req.body);
    if (action === 'close') await agent.closeLogin();
    else await agent.openLogin(url ? allowedURL(url) : undefined, config.browser);
    res.json({ ok: true, loginOpen: Boolean(agent.login) });
  });
  route('POST', '/api/permissions', (req, res) => {
    const { site } = z.object({ action: z.literal('revoke'), site: z.string().max(300) }).parse(req.body);
    agent.permissions.revoke(site); res.json({ permissions: agent.permissions.list() });
  });
  route('POST', '/api/tasks', async (req, res) => {
    const input = z.object({ goal: z.string().trim().min(1), startURL: z.string().trim().max(4000).optional(), permissionMode: z.enum(MODES).default('skip'), demo: z.boolean().default(false) }).parse(req.body);
    if (agent.busy) return res.status(409).json({ error: '已有任务正在执行。' });
    if (!input.demo) { if (!config.model) throw new Error('请先在模型设置中填写模型名。'); if (input.startURL) allowedURL(input.startURL); }
    await tasks.startTask(input); res.status(202).json({ ok: true });
  });
  route('POST', '/api/messages', async (req, res) => {
    const { text } = z.object({ text: z.string().trim().min(1) }).parse(req.body);
    await tasks.sendMessage(text, req.body.interactionId); res.status(202).json({ ok: true });
  });
  route('POST', '/api/control', async (req, res) => {
    const body = z.object({ command: z.enum(['pause', 'resume', 'stop', 'approve', 'reject', 'approve_site', 'deny_site']), answer: z.string().optional() }).parse(req.body);
    await tasks.controlTask(body.command, body.answer, req.body.interactionId); res.json({ ok: true });
  });

  async function dispatch(method, path, body) {
    const entry = routes.find(r => r.method === method && (r.path === path || (r.path === '/api/sessions/:id' && /^\/api\/sessions\/[^/]+$/.test(path))));
    if (!entry) return { status: 404, body: { error: '接口不存在。' } };
    let status = 200, result;
    const response = { status(code) { status = code; return this; }, json(value) { result = value; return this; } };
    try {
      if (method !== 'GET' && ['/api/config', '/api/browser'].includes(path)) tasks.assertConfigurationMutable();
      if (path === '/api/login' && body?.action === 'open') tasks.assertConfigurationMutable();
      await entry.handler({ body, params: { id: path.split('/').at(-1) } }, response);
      return { status, body: result };
    } catch (error) {
      return { status: error.status || 400, body: { error: error instanceof z.ZodError ? '输入格式不正确，请检查必填项。' : String(error.message).slice(0, 1000) } };
    } finally { if (method !== 'GET') publish(); }
  }

  async function request(method, path, body) {
    await ready;
    if (path === '/api/lifecycle') return serialize(async () => {
      try { return method === 'GET' ? { status: 200, body: tasks.lifecycle.settings() } : await tasks.perform(effects => tasks.lifecycle.updateSettings(body, effects)); }
      catch (error) { return { status: error.status || 400, body: { error: error.message } }; }
    });
    if (path === '/api/jobs' || /^\/api\/jobs\/[a-f0-9-]{36}\/cancel$/.test(path)) return serialize(async () => {
      try {
        if (method === 'GET') return { status: 200, body: { data: tasks.all('job').sort((a,b) => b.created_at.localeCompare(a.created_at)), next_cursor: null } };
        return await tasks.perform(effects => path === '/api/jobs' ? tasks.lifecycle.createJob(body, effects) : tasks.lifecycle.cancelJob(path.split('/')[3], effects));
      } catch (error) { return { status: error.status || 400, body: { error: error.message } }; }
    });
    return serialize(() => dispatch(method, path, body));
  }

  function subscribe(listener) {
    listeners.add(listener);
    const frame = data => listener('frame', data);
    const pointer = data => listener('pointer', data);
    const focus = () => listener('desktop-focus', null);
    relay.on('desktop-focus', focus);
    agent.on('pointer', pointer);
    agent.frames.add(frame);
    listener('state', fullState(true));
    const initialFrame = agent.lastFrame || agent.task?.snapshot?.screenshot?.split(',')[1];
    if (initialFrame) frame(initialFrame);
    if (agent.pointer) pointer(agent.pointer);
    return () => { listeners.delete(listener); agent.frames.delete(frame); agent.off('pointer', pointer); relay.off('desktop-focus', focus); };
  }

  async function close() {
    await ready;
    tasks.stop();
    await commandTail;
    try { agent.control('stop'); } catch {}
    try {
      await agent.promise;
      await agent.closeBrowser();
      await agent.closeLogin();
    } finally {
      tasks.close(); agent.sessions.close(); relay.close();
      agent.off('change', publish); relay.off('change', publish); listeners.clear();
    }
  }
  return { agent, relay, request, subscribe, close, httpApi, tasks, ready };
}
