import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { publicRun, TERMINAL_RUNS } from './runs.js';
import { redactTranscript } from './redact.js';

import { ApiError, fail } from './api-error.js';
export { ApiError } from './api-error.js';
import { RunEvents } from './api-events.js';
import { ApiLifecycle } from './api-lifecycle.js';

const now = () => new Date().toISOString();
const empty = z.object({}).strict();
const text = z.string().trim().min(1);
const mode = z.enum(['ephemeral', 'persistent', 'cdp', 'extension']);
const permission = z.enum(['ask', 'auto', 'skip']);
const canonical = x => JSON.stringify(x && typeof x === 'object' ? (Array.isArray(x) ? x.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(x).sort().map(k => [k, JSON.parse(canonical(x[k]))]))) : x);

// Shares the existing SQLite database and Agent with IPC. No browser side effects occur
// inside an acceptance transaction. A committed acceptance is never replayed on startup.
export class HttpApi {
  constructor({ agent, config, relay, serialize }) {
    Object.assign(this, { agent, config, relay, serialize });
    this.listener = () => { this.sync(); this.lifecycle?.kick(); };
    this.activity = ({ type, data }) => {
      const run = this.agent.task?.runs?.at(-1);
      if (run && !run.finished_at && this.get('run', run.id)) this.transaction(() => this.events.append(run.id, type, data));
    };
    this.pointer = data => this.activity({ type: 'cursor.updated', data });
  }
  async init() {
    this.db = await this.agent.sessions.db();
    this.db.exec(`CREATE TABLE IF NOT EXISTS api_resources (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS api_idempotency (key TEXT PRIMARY KEY, digest TEXT NOT NULL, response TEXT NOT NULL, created INTEGER NOT NULL);`);
    this.events = new RunEvents(this.db);
    for (const run of this.all('run')) if (!this.events.last(run.id)) {
      this.events.append(run.id, 'run.created', { status: run.status, session_id: run.session_id, historical_snapshot: true });
      if (TERMINAL_RUNS.has(run.status)) this.events.append(run.id, 'run.finished', { status: run.status, run_url: `/v1/runs/${run.id}` });
    }
    for (const i of this.all('interaction')) if (i.status === 'pending') this.put('interaction', { ...i, status: 'expired', resolved_at: now() });
    // API metadata is additive: legacy conversation/checkpoint data stays readable.
    for (const run of this.all('run')) if (run.status !== 'queued' && !TERMINAL_RUNS.has(run.status)) {
      Object.assign(run, { status: 'interrupted', finished_at: now(), pending_interaction_id: null, error: { code: 'process_interrupted', message: '后台已退出；请核验页面后恢复。', retryable: false } });
      this.put('run', run);
    }
    for (const s of this.all('session')) if (s.status === 'open') this.put('session', { ...s, status: 'closed', browser_status: 'closed', active_run_id: null, updated_at: now() });
    this.lifecycle = new ApiLifecycle(this);
    this.agent.on('change', this.listener);
    this.agent.on('activity', this.activity); this.agent.on('pointer', this.pointer);
  }
  all(kind) { return this.db.prepare('SELECT data FROM api_resources WHERE kind=?').all(kind).map(r => JSON.parse(r.data)); }
  get(kind, id) { const row = this.db.prepare('SELECT data FROM api_resources WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(row.data) : null; }
  require(kind, id) { return this.get(kind, id) || fail(404, 'not_found'); }
  transaction(work) {
    if (this.transactionDepth) return work();
    this.db.exec('BEGIN IMMEDIATE'); this.transactionDepth = 1;
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth = 0; }
  }
  put(kind, value) {
    if (!this.transactionDepth) return this.transaction(() => this.put(kind, value));
    const old = this.get(kind, value.id), safe = redactTranscript(value);
    this.db.prepare('INSERT INTO api_resources VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, value.id, JSON.stringify(safe));
    if (['job', 'settings', 'session'].includes(kind)) this.onChange?.();
    if (!this.events) return;
    if (kind === 'run') {
      if (!old) this.events.append(value.id, 'run.created', { status: value.status, session_id: value.session_id });
      else if (old.status !== value.status) this.events.append(value.id, 'run.status_changed', { status: value.status, revision: value.revision });
      if (TERMINAL_RUNS.has(value.status) && (!old || !TERMINAL_RUNS.has(old.status))) this.events.append(value.id, 'run.finished', { status: value.status, run_url: `/v1/runs/${value.id}` });
    } else if (kind === 'interaction' && (!old || old.status !== value.status)) {
      this.events.append(value.run_id, `interaction.${!old ? 'created' : value.status}`, safe);
    }
  }
  openSession() { return this.all('session').find(s => s.status === 'open'); }
  sync() { return this.transaction(() => this.syncState()); }
  syncState() {
    const t = this.agent.task;
    if (!t?.runs?.length || t.deleted || t.mode === 'demo') return;
    const safe = redactTranscript(t);
    const r = safe.runs.at(-1), cfg = this.config();
    let s = this.get('session', t.id) || { id: t.id, status: 'open', created_at: r.created_at, browser_mode: this.agent.browserOptions?.mode || cfg.browser.mode, permission_mode: t.permissionMode, model: { provider: cfg.provider, name: cfg.model } };
    // Completed runs never change even when the conversation is closed or continued.
    for (const run of safe.runs) {
      const old = this.get('run', run.id);
      if (!old || !TERMINAL_RUNS.has(old.status)) this.put('run', publicRun(run));
    }
    const job = this.all('job').find(j => j.run_id === r.id && j.status === 'running');
    if (job && job.run_status !== r.status) this.put('job', { ...job, run_status: r.status });
    const active = this.agent.busy && !r.finished_at ? r.id : null;
    const closed = (!this.agent.busy || Boolean(r.finished_at)) && !this.agent.browser;
    s = { ...s, status: closed ? 'closed' : 'open', browser_status: this.agent.browser ? 'ready' : this.agent.busy ? 'starting' : 'closed', active_run_id: active, last_run_id: r.id, updated_at: now() };
    this.put('session', s);
    const pending = ['approval', 'waiting_user'].includes(t.status) ? safe.pending : null;
    for (const i of this.all('interaction').filter(i => i.run_id === r.id && i.status === 'pending' && i.id !== pending?.id)) this.put('interaction', { ...i, status: ['stopping', 'stopped'].includes(t.status) ? 'expired' : 'resolved', resolved_at: now() });
    if (pending?.id && !this.get('interaction', pending.id)) this.put('interaction', { id: pending.id, run_id: r.id, kind: t.status === 'approval' ? 'approval' : 'input', status: 'pending', created_at: now(), resolved_at: null, prompt: pending.question || pending.summary || '', action: t.status === 'approval' ? pending : null, allowed_decisions: t.status === 'approval' ? ['approve', 'reject', ...(pending.needsSite ? ['approve_site', 'deny_site'] : [])] : [], response: null });
  }
  removeSession(id) { return this.transaction(() => this.lifecycle.erase(id)); }
  assertDesktop(path, body) {
    const s = this.openSession();
    // Explicitly recovering the same idle desktop conversation retains its established UX.
    if (path === '/api/sessions/recover' && s?.id === body?.id && !this.agent.busy) return;
    // A reservation before the first run must also prevent desktop takeover/config changes.
    if (s && ['/api/tasks', '/api/sessions/recover', '/api/config', '/api/browser', '/api/login'].includes(path)) fail(409, 'session_active', '请先关闭当前会话。');
  }
  async request(method, rawPath, body, key, identity) {
    return this.serialize(async () => {
      const url = new URL(rawPath, 'http://localhost'), path = url.pathname;
      if (method === 'GET') return this.read(path, url.searchParams);
      if (!['POST', 'DELETE'].includes(method)) fail(405, 'method_not_allowed');
      if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) fail(400, 'idempotency_key_required');
      const scoped = createHash('sha256').update(`${identity}\n${method}\n${path}\n${key}`).digest('hex');
      const digest = createHash('sha256').update(canonical(body)).digest('hex');
      const old = this.db.prepare('SELECT * FROM api_idempotency WHERE key=?').get(scoped);
      if (old) {
        if (old.digest !== digest) fail(409, 'idempotency_conflict');
        return JSON.parse(old.response);
      }
      if ([...url.searchParams].length) fail(400, 'unexpected_query');
      // Recover checkpoint lookup can await before entering the synchronous SQLite transaction.
      let checkpoint;
      const recovery = /^\/v1\/runs\/([^/]+)\/recover$/.exec(path);
      if (recovery) {
        const r = this.require('run', recovery[1]);
        checkpoint = await this.agent.sessions.get(r.session_id);
        if (!checkpoint) fail(409, 'checkpoint_unavailable');
        // The legacy checkpoint is per-conversation. Never silently restore a different round.
        if (checkpoint.runs?.at(-1)?.id !== r.id) fail(409, 'checkpoint_unavailable', '仅最后一轮的检查点可恢复。');
      }
      const effects = [];
      const response = this.transaction(() => {
        const response = redactTranscript(this.mutate(path, body, effects, checkpoint, method));
        this.db.prepare('INSERT INTO api_idempotency VALUES(?,?,?,?)').run(scoped, digest, JSON.stringify(response), Date.now());
        return response;
      });
      // Hold the shared command lock through start/control, but not the model execution.
      for (const effect of effects) await effect();
      this.lifecycle.kick();
      return response;
    });
  }
  async read(path, q) {
    if (path === '/v1/status') return { status: 200, body: { version: 'v1', ready: true, max_active_sessions: 1, max_active_runs: 1, active_session_id: this.openSession()?.id || null, max_request_bytes: 8388608, queued_jobs: this.lifecycle.queued().length, features: ['polling', 'sse', 'screenshots', 'export', 'retention', 'fifo_queue', 'virtual_cursor', 'interactions', 'idempotency', 'latest_checkpoint_recovery'] } };
    let m;
    if (path === '/v1/settings/lifecycle') return { status: 200, body: this.lifecycle.settings() };
    if (path === '/v1/jobs') return this.list(this.all('job'), q);
    if ((m = /^\/v1\/jobs\/([^/]+)$/.exec(path))) return { status: 200, body: this.require('job', m[1]) };
    if ((m = /^\/v1\/runs\/([^/]+)\/events(\/stream)?$/.exec(path))) {
      this.require('run', m[1]);
      const raw = q.get('after') || '0';
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail(400, 'invalid_event_cursor');
      const after = Number(raw);
      if (after > this.events.last(m[1])) fail(400, 'invalid_event_cursor');
      if (m[2]) return { status: 200, stream: { runId: m[1], after } };
      const limit = q.has('limit') ? Number(q.get('limit')) : 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 400) fail(400, 'invalid_limit');
      const data = this.events.page(m[1], after, limit), next = data.at(-1)?.sequence || after;
      return { status: 200, body: { data, next_after: next, has_more: next < this.events.last(m[1]) } };
    }
    if ((m = /^\/v1\/sessions\/([^/]+)\/(screenshot|export|cursor)$/.exec(path))) {
      const session = this.require('session', m[1]);
      if (m[2] === 'export') {
        if (this.agent.task?.id === session.id) await this.agent.save();
        const checkpoint = await this.agent.sessions.get(session.id, { includeMemory: true });
        const runs = this.all('run').filter(r => r.session_id === session.id);
        const events = runs.flatMap(r => this.db.prepare('SELECT data FROM api_events WHERE run_id=? ORDER BY sequence').all(r.id).map(x => JSON.parse(x.data)));
        return { status: 200, headers: { 'Content-Disposition': `attachment; filename="openbrowseruse-${session.id}.json"` }, body: redactTranscript({ format_version: 1, exported_at: now(), session, runs, interactions: this.all('interaction').filter(i => runs.some(r => r.id === i.run_id)), events, checkpoint }) };
      }
      if (this.agent.task?.id !== session.id || !this.agent.browser) fail(409, 'browser_unavailable');
      if (m[2] === 'cursor') return { status: 200, body: this.agent.pointer || { visible: false } };
      const format = q.get('format') || 'jpeg';
      if (!['jpeg', 'png'].includes(format)) fail(400, 'invalid_format');
      let shot;
      try { shot = await this.agent.browser.screenshot({ format }); }
      catch { fail(409, 'screenshot_unavailable'); }
      return { status: 200, contentType: `image/${format}`, binary: Buffer.from(shot.split(',')[1], 'base64') };
    }
    if (path === '/v1/sessions') return this.list(this.all('session'), q);
    if ((m = /^\/v1\/sessions\/([^/]+)$/.exec(path))) return { status: 200, body: this.require('session', m[1]) };
    if ((m = /^\/v1\/sessions\/([^/]+)\/runs$/.exec(path))) { this.require('session', m[1]); return this.list(this.all('run').filter(r => r.session_id === m[1]), q); }
    if ((m = /^\/v1\/runs\/([^/]+)$/.exec(path))) return { status: 200, body: this.require('run', m[1]) };
    if ((m = /^\/v1\/runs\/([^/]+)\/interactions$/.exec(path))) {
      this.require('run', m[1]);
      const status = q.get('status');
      if (status && !['pending', 'resolved', 'expired'].includes(status)) fail(400, 'invalid_status');
      return this.list(this.all('interaction').filter(i => i.run_id === m[1] && (!status || i.status === status)), q);
    }
    fail(404, 'not_found');
  }
  list(items, q) {
    const limit = q.has('limit') ? Number(q.get('limit')) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(400, 'invalid_limit');
    items.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const cursor = q.get('cursor');
    if (cursor) {
      const index = items.findIndex(x => Buffer.from(`${x.created_at}/${x.id}`).toString('base64url') === cursor);
      if (index < 0) fail(400, 'invalid_cursor');
      items = items.slice(index + 1);
    }
    const data = items.slice(0, limit), last = data.at(-1);
    return { status: 200, body: { data, next_cursor: items.length > limit ? Buffer.from(`${last.created_at}/${last.id}`).toString('base64url') : null } };
  }
  mutate(path, body, effects, checkpoint, method = 'POST') {
    const extended = this.lifecycle.mutate(method, path, body, effects);
    if (extended !== undefined) return extended;
    const a = this.agent;
    const response = (status, value, location) => ({ status, body: value, ...(location ? { location } : {}) });
    const createSession = input => {
      if (this.openSession() || a.busy || a.browser || a.login) fail(409, 'session_active');
      if (this.lifecycle.queued().length) fail(409, 'queue_pending', '请等待队列完成，或先取消排队任务。');
      const cfg = this.config();
      const browserMode = input.browser_mode || cfg.browser.mode;
      if (browserMode !== cfg.browser.mode) fail(422, 'browser_not_configured', '浏览器模式必须与服务端配置一致。');
      if (browserMode === 'extension' && !this.relay.connected()) fail(409, 'extension_unavailable');
      const s = { id: crypto.randomUUID(), status: 'open', browser_mode: browserMode, browser_status: 'not_started', permission_mode: input.permission_mode || 'skip', created_at: now(), updated_at: now(), active_run_id: null, last_run_id: null, model: { provider: cfg.provider, name: cfg.model } };
      this.put('session', s); return s;
    };
    const createRun = (s, input, recovered) => {
      if (s.job_id) fail(409, 'managed_session', '队列会话由调度器管理。');
      if (s.status !== 'open') fail(409, 'session_closed');
      if (s.active_run_id || a.busy) fail(409, 'run_active');
      if (!this.config().model) fail(422, 'model_not_configured');
      if (input.start_url) {
        const u = new URL(input.start_url);
        if (!['http:', 'https:'].includes(u.protocol)) fail(422, 'invalid_start_url');
        if (s.last_run_id) fail(422, 'start_url_first_run_only');
      }
      if (s.last_run_id && !a.browser) fail(409, 'browser_unavailable');
      const r = { id: crypto.randomUUID(), session_id: s.id, goal: input.goal, start_url: input.start_url || null, status: 'starting', created_at: now(), started_at: null, finished_at: null, result: null, error: null, pending_interaction_id: null, recovered_from_run_id: recovered?.id || null, metrics: { requests: 0, tools: 0, retries: 0, usage: [] }, revision: 0 };
      this.put('run', r); this.put('session', { ...s, active_run_id: r.id, last_run_id: r.id, updated_at: now() });
      effects.push(() => this.launchRun(s, r, input, this.config(), recovered));
      return response(202, r, `/v1/runs/${r.id}`);
    };
    if (path === '/v1/sessions') {
      const input = z.object({ browser_mode: mode.optional(), permission_mode: permission.optional() }).strict().parse(body);
      const s = createSession(input); return response(201, s, `/v1/sessions/${s.id}`);
    }
    let m;
    if ((m = /^\/v1\/sessions\/([^/]+)\/runs$/.exec(path))) {
      const input = z.object({ goal: text, start_url: z.string().url().optional() }).strict().parse(body);
      return createRun(this.require('session', m[1]), input);
    }
    if ((m = /^\/v1\/sessions\/([^/]+)\/close$/.exec(path))) {
      empty.parse(body); const s = this.require('session', m[1]);
      if (s.status === 'queued') fail(409, 'job_queued', '请取消排队任务。');
      if (s.active_run_id || (a.task?.id === s.id && a.busy)) fail(409, 'run_active');
      if (s.status === 'closed') return response(200, s);
      const closing = { ...s, browser_status: 'closing', updated_at: now() };
      this.put('session', closing);
      effects.push(async () => {
        const browser = a.task?.id === s.id ? a.browser : null;
        try {
          if (browser) await a.closeBrowser();
          this.put('session', { ...closing, status: 'closed', browser_status: 'closed' });
        } catch {
          a.browser = browser;
          this.put('session', { ...s, error: { code: 'cleanup_failed', message: '关闭浏览器失败，请重试。' } });
        }
      });
      return response(202, closing);
    }
    if ((m = /^\/v1\/runs\/([^/]+)\/recover$/.exec(path))) {
      const input = z.object({ permission_mode: permission.optional() }).strict().parse(body), previous = this.require('run', m[1]);
      if (!TERMINAL_RUNS.has(previous.status)) fail(409, 'run_active');
      if (!checkpoint) fail(409, 'checkpoint_unavailable');
      const s = createSession({ permission_mode: input.permission_mode || checkpoint.permissionMode });
      return createRun(s, { goal: previous.goal }, previous);
    }
    if ((m = /^\/v1\/runs\/([^/]+)\/(pause|resume|cancel|messages)$/.exec(path))) {
      const r = this.require('run', m[1]), action = m[2];
      const input = action === 'messages' ? z.object({ text }).strict().parse(body) : empty.parse(body);
      if (action === 'cancel' && r.status === 'cancelled') return response(200, r);
      if (action === 'pause' && ['paused', 'pausing'].includes(r.status)) return response(r.status === 'paused' ? 200 : 202, r);
      if (action === 'cancel' && r.status === 'cancelling') return response(202, r);
      if (TERMINAL_RUNS.has(r.status) || a.task?.runs?.at(-1)?.id !== r.id || !a.busy) fail(409, 'invalid_run_state');
      const allowed = { pause: ['starting', 'running'], resume: ['paused'], messages: ['starting', 'running'], cancel: ['starting', 'running', 'pausing', 'paused', 'waiting_input', 'waiting_approval'] };
      if (!allowed[action].includes(r.status)) fail(409, 'invalid_run_state');
      if (action === 'messages') {
        const message = { id: crypto.randomUUID(), run_id: r.id, text: a.logText(input.text), created_at: now() };
        effects.push(() => a.message(input.text)); return response(201, message);
      }
      const updated = { ...r, status: { pause: 'pausing', resume: 'running', cancel: 'cancelling' }[action], revision: r.revision + 1 };
      this.put('run', updated); effects.push(() => a.control(action === 'cancel' ? 'stop' : action));
      return response(202, updated);
    }
    if ((m = /^\/v1\/runs\/([^/]+)\/interactions\/([^/]+)\/response$/.exec(path))) {
      const r = this.require('run', m[1]), i = this.require('interaction', m[2]);
      if (i.run_id !== r.id) fail(404, 'not_found');
      if (i.status !== 'pending' || a.task?.pending?.id !== i.id || !['waiting_input', 'waiting_approval'].includes(r.status)) fail(409, 'interaction_not_pending');
      const input = i.kind === 'input' ? z.object({ answer: text }).strict().parse(body) : z.object({ decision: z.enum(['approve', 'reject', 'approve_site', 'deny_site']) }).strict().parse(body);
      if (input.decision && !i.allowed_decisions.includes(input.decision)) fail(422, 'invalid_decision');
      const resolved = { ...i, status: 'resolved', resolved_at: now(), response: redactTranscript({ response: input }).response };
      this.put('interaction', resolved);
      effects.push(() => a.control(input.decision || 'resume', input.answer, i.id));
      return response(200, resolved);
    }
    fail(404, 'not_found');
  }
  async launchRun(s, r, input, config, recovered) {
    const a = this.agent;
    try {
      if (recovered) await a.recover(recovered.session_id, config, { sessionId: s.id, runId: r.id, runCreatedAt: r.created_at, permissionMode: s.permission_mode, goal: input.goal });
      else if (s.last_run_id && !s.job_id) a.followUp(input.goal, { id: r.id, createdAt: r.created_at });
      else await a.start({ goal: input.goal, startURL: input.start_url, permissionMode: s.permission_mode, sessionId: s.id, runId: r.id, runCreatedAt: r.created_at }, config);
      this.sync();
    } catch {
      this.put('run', { ...r, status: 'failed', finished_at: now(), error: { code: 'start_failed', message: '执行启动失败，请检查服务端模型或浏览器配置。', retryable: false } });
      this.put('session', { ...s, status: 'closed', browser_status: 'closed', active_run_id: null, last_run_id: r.id });
      a.busy = false;
      await a.closeBrowser().catch(() => {});
    }
    this.lifecycle.kick();
  }
  stop() { this.lifecycle.stop(); this.events.close(); }
  close() { this.stop(); this.agent.off('change', this.listener); this.agent.off('activity', this.activity); this.agent.off('pointer', this.pointer); }

}

export async function startHttpListener(api, { token, port = 4319 }) {
  if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new Error('OBU_API_TOKEN must contain at least 32 non-whitespace characters.');
  const secret = createHash('sha256').update(token).digest();
  const server = createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-ID', requestId); res.setHeader('Cache-Control', 'no-store');
    try {
      if (!timingSafeEqual(secret, createHash('sha256').update((req.headers.authorization || '').replace(/^Bearer /, '')).digest()) || !req.headers.authorization?.startsWith('Bearer ')) fail(401, 'unauthorized');
      // This first release supports non-browser clients only: no cookie auth or CORS.
      if (req.headers.origin || req.headers['sec-fetch-site']) fail(403, 'browser_origin_forbidden');
      let body = {};
      if (req.method === 'POST' || (req.method === 'DELETE' && (req.headers['content-length'] || req.headers['transfer-encoding']))) {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'unsupported_media_type');
        if (Number(req.headers['content-length']) > 8388608) fail(413, 'request_too_large');
        let bytes = 0; const chunks = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8388608) fail(413, 'request_too_large'); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json'); }
      }
      let requestURL = req.url;
      if (req.method === 'GET' && req.headers['last-event-id']) {
        const u = new URL(req.url, 'http://localhost'), match = /^\/v1\/runs\/([^/]+)\/events\/stream$/.exec(u.pathname);
        const id = req.headers['last-event-id'];
        if (!match || !id.startsWith(match[1] + ':') || !/^\d+$/.test(id.slice(match[1].length + 1))) fail(400, 'invalid_event_cursor');
        u.searchParams.set('after', id.slice(match[1].length + 1)); requestURL = u.pathname + u.search;
      }
      const result = await api.request(req.method, requestURL, body, req.headers['idempotency-key'], secret.toString('hex'));
      if (result.status >= 400) fail(result.status, result.body.code || 'request_failed');
      if (result.stream) {
        const { runId, after } = result.stream;
        api.events.stream(req, res, runId, after, () => Boolean(api.get('run', runId)), () => TERMINAL_RUNS.has(api.get('run', runId)?.status));
        return;
      }
      if (result.status === 204) { res.writeHead(204); res.end(); return; }
      if (result.headers) for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
      if (result.binary) { res.writeHead(200, { 'Content-Type': result.contentType }); res.end(result.binary); return; }
      if (result.location) res.setHeader('Location', result.location);
      res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.body));
    } catch (error) {
      const status = error instanceof z.ZodError ? 422 : error.status || 500;
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      res.writeHead(status, { 'Content-Type': 'application/problem+json' });
      res.end(JSON.stringify({ type: `urn:openbrowseruse:problem:${error.code || (status === 422 ? 'validation_error' : 'internal_error')}`, title: status === 500 ? 'Internal server error' : error.code || 'Validation error', status, code: error.code || (status === 422 ? 'validation_error' : 'internal_error'), detail: error instanceof ApiError ? error.message : status === 422 ? '请求字段不符合接口定义。' : '服务端处理失败。', request_id: requestId, ...(error instanceof z.ZodError ? { errors: error.issues.map(i => ({ pointer: '/' + i.path.join('/'), code: i.code })) } : {}) }));
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, port: server.address().port, close: () => new Promise(resolve => { api.events.close(); server.close(resolve); server.closeIdleConnections(); }) };
}
