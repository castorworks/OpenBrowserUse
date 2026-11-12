import { z } from 'zod';
import { QueuePayload } from './queue-payload.js';
import { fail } from './api-error.js';
import { TERMINAL_RUNS } from './runs.js';

const now = () => new Date().toISOString();
const empty = z.object({}).strict();
const settingsSchema = z.object({ history_retention_days: z.number().int().min(0).max(3650), idle_timeout_seconds: z.number().int().min(0).max(86400), max_queued_jobs: z.number().int().min(1).max(1000) }).strict();

export class ApiLifecycle {
  constructor(api) {
    this.api = api; this.payload = new QueuePayload(api.agent.sessions.dir);
    api.db.exec('CREATE TABLE IF NOT EXISTS api_queue (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);');
    if (!api.get('settings', 'lifecycle')) api.put('settings', { id: 'lifecycle', history_retention_days: 0, idle_timeout_seconds: 900, max_queued_jobs: 100 });
    for (const job of api.all('job')) if (job.status === 'running') api.put('job', { ...job, status: 'interrupted', run_status: 'interrupted', finished_at: now() });
  }
  settings() { const { id, ...s } = this.api.get('settings', 'lifecycle'); return s; }
  queued() { return this.api.db.prepare('SELECT job_id FROM api_queue ORDER BY ordinal').all().map(x => this.api.get('job', x.job_id)).filter(Boolean); }
  start() { if (this.timer) return; this.timer = setInterval(() => this.kick(), 5000); this.timer.unref(); this.kick(); }
  stop() { this.stopped = true; clearInterval(this.timer); }
  kick() {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.api.serialize(async () => { this.scheduled = false; if (!this.stopped) await this.tick(); }).catch(() => { this.scheduled = false; });
    });
  }
  async tick(time = Date.now()) {
    const api = this.api, a = api.agent;
    // An idle queued-job session belongs to the scheduler, not to interactive reuse.
    if (!a.busy) {
      for (const job of api.all('job').filter(j => j.status === 'running')) {
        const r = api.get('run', job.run_id);
        if (!r || !TERMINAL_RUNS.has(r.status)) continue;
        try { if (a.task?.id === job.session_id && a.browser) await a.closeBrowser(); }
        catch { continue; }
        const s = api.get('session', job.session_id);
        if (s) api.put('session', { ...s, status: 'closed', browser_status: 'closed', active_run_id: null, updated_at: now() });
        api.put('job', { ...job, status: r.status, run_status: r.status, finished_at: now() });
      }
    }
    const settings = this.settings(), s = api.openSession();
    if (s && !a.busy && !s.active_run_id && settings.idle_timeout_seconds && time - Date.parse(s.updated_at) >= settings.idle_timeout_seconds * 1000) {
      try {
        if (a.task?.id === s.id && a.browser) await a.closeBrowser();
        api.put('session', { ...s, status: 'closed', browser_status: 'closed', active_run_id: null, updated_at: now(), close_reason: 'idle_timeout' });
      } catch { /* Keep the reservation and retry; never steal a still-open browser. */ }
    }
    if (settings.history_retention_days) {
      const cutoff = new Date(time - settings.history_retention_days * 86400000).toISOString();
      const ids = new Set(api.all('session').filter(s => s.status === 'closed' && s.updated_at < cutoff).map(s => s.id));
      for (const row of api.db.prepare('SELECT id FROM sessions WHERE updated < ?').all(cutoff)) ids.add(row.id);
      for (const id of ids) {
        const record = api.get('session', id);
        if (record && record.status !== 'closed') continue;
        if (a.task?.id === id && (a.busy || a.browser)) continue;
        api.transaction(() => this.erase(id));
      }
    }
    if (a.busy || a.browser || a.login || api.openSession() || this.stopped) return;
    const next = this.queued()[0];
    if (!next) return;
    const row = api.db.prepare('SELECT payload FROM api_queue WHERE job_id=?').get(next.id);
    let payload;
    try { payload = this.payload.open(row.payload); }
    catch {
      api.transaction(() => this.finishQueued(next, 'failed', { code: 'queue_payload_unavailable', message: '无法读取队列配置；请重新提交任务。', retryable: false }));
      this.kick(); return;
    }
    if (!['openai', 'deepseek'].includes(payload.config?.provider)) {
      api.transaction(() => this.finishQueued(next, 'failed', { code: 'model_provider_removed', message: '模型协议已移除，请配置 OpenAI 兼容服务或 DeepSeek 后重新提交任务。', retryable: false }));
      this.kick(); return;
    }
    if (payload.config?.browser?.mode === 'cdp') {
      api.transaction(() => this.finishQueued(next, 'failed', { code: 'browser_mode_removed', message: '直接 CDP 模式已移除，请选择新的浏览器模式后重新提交任务。', retryable: false }));
      this.kick(); return;
    }
    const session = api.require('session', next.session_id), run = api.require('run', next.run_id);
    api.transaction(() => {
      api.db.prepare('DELETE FROM api_queue WHERE job_id=?').run(next.id);
      api.put('job', { ...next, status: 'running', run_status: 'starting', started_at: now() });
      api.put('session', { ...session, status: 'open', active_run_id: run.id, updated_at: now() });
      api.put('run', { ...run, status: 'starting', revision: run.revision + 1 });
    });
    await api.launchRun(session, run, payload.input, payload.config);
    this.kick();
  }
  finishQueued(job, status, error = null) {
    const api = this.api, run = api.require('run', job.run_id), s = api.require('session', job.session_id);
    api.db.prepare('DELETE FROM api_queue WHERE job_id=?').run(job.id);
    api.put('run', { ...run, status, error, finished_at: now(), revision: run.revision + 1 });
    api.put('session', { ...s, status: 'closed', browser_status: 'closed', active_run_id: null, updated_at: now() });
    api.put('job', { ...job, status, run_status: status, finished_at: now() });
  }
  erase(id) {
    const api = this.api, a = api.agent, s = api.get('session', id);
    if (s && s.status !== 'closed') fail(409, 'session_not_closed');
    if (a.task?.id === id && (a.busy || a.browser)) fail(409, 'run_active');
    const runIds = api.all('run').filter(r => r.session_id === id).map(r => r.id);
    const jobs = api.all('job').filter(j => j.session_id === id);
    const ids = new Set([id, ...runIds, ...jobs.map(j => j.id)]);
    for (const i of api.all('interaction')) if (runIds.includes(i.run_id)) ids.add(i.id);
    if (a.task?.id === id) a.task.deleted = true;
    for (const rid of runIds) api.events.remove(rid);
    for (const rid of ids) api.db.prepare('DELETE FROM api_resources WHERE id=?').run(rid);
    for (const job of jobs) api.db.prepare('DELETE FROM api_queue WHERE job_id=?').run(job.id);
    for (const table of ['sessions', 'session_items', 'session_memory']) api.db.prepare(`DELETE FROM ${table} WHERE ${table === 'sessions' ? 'id' : 'session_id'}=?`).run(id);
    a.sessions.cursors.delete(id);
    // Preserve every affected key as a tombstone, including responses to messages,
    // interactions, job submissions and recovery requests.
    for (const row of api.db.prepare('SELECT key,response FROM api_idempotency').all()) {
      const body = JSON.parse(row.response).body;
      if (body && ['id', 'session_id', 'run_id', 'job_id'].some(k => ids.has(body[k]))) api.db.prepare('UPDATE api_idempotency SET response=? WHERE key=?').run(JSON.stringify({ status: 410, body: { code: 'resource_deleted' } }), row.key);
    }
  }
  mutate(method, path, body, effects) {
    const api = this.api;
    let m;
    if (method === 'DELETE') {
      if (!(m = /^\/v1\/sessions\/([^/]+)$/.exec(path))) fail(404, 'not_found');
      empty.parse(body); api.require('session', m[1]); this.erase(m[1]); return { status: 204 };
    }
    if (path === '/v1/settings/lifecycle') {
      const next = settingsSchema.parse(body);
      api.put('settings', { id: 'lifecycle', ...next }); effects.push(() => this.kick());
      return { status: 200, body: next };
    }
    if (path === '/v1/jobs') {
      const input = z.object({ goal: z.string().trim().min(1), start_url: z.string().url().optional(), permission_mode: z.enum(['ask', 'auto', 'skip']).default('skip') }).strict().parse(body);
      if (input.start_url && !['http:', 'https:'].includes(new URL(input.start_url).protocol)) fail(422, 'invalid_start_url');
      if (this.queued().length >= this.settings().max_queued_jobs) fail(409, 'queue_full');
      const cfg = api.config();
      if (cfg.browser.requiresSelection) fail(409, 'browser_selection_required', '直接 CDP 模式已移除，请重新选择浏览器模式。');
      if (!cfg.model) fail(422, 'model_not_configured');
      const jid = crypto.randomUUID(), sid = crypto.randomUUID(), rid = crypto.randomUUID(), time = now();
      const seq = Number(api.db.prepare('INSERT INTO api_queue(job_id,payload) VALUES(?,?)').run(jid, this.payload.seal({ input, config: cfg })).lastInsertRowid);
      const s = { id: sid, job_id: jid, status: 'queued', browser_mode: cfg.browser.mode, browser_status: 'not_started', permission_mode: input.permission_mode, created_at: time, updated_at: time, active_run_id: null, last_run_id: rid, model: { provider: cfg.provider, name: cfg.model } };
      const r = { id: rid, session_id: sid, goal: input.goal, start_url: input.start_url || null, status: 'queued', created_at: time, started_at: null, finished_at: null, result: null, error: null, pending_interaction_id: null, recovered_from_run_id: null, metrics: { requests: 0, tools: 0, retries: 0, usage: [] }, revision: 0 };
      const job = { id: jid, session_id: sid, run_id: rid, goal: input.goal, status: 'queued', run_status: 'queued', queue_sequence: seq, created_at: time, started_at: null, finished_at: null };
      api.put('session', s); api.put('run', r); api.put('job', job);
      effects.push(() => this.kick()); return { status: 202, body: job, location: `/v1/jobs/${jid}` };
    }
    if ((m = /^\/v1\/jobs\/([^/]+)\/cancel$/.exec(path))) {
      empty.parse(body); const job = api.require('job', m[1]);
      if (job.status === 'queued') { this.finishQueued(job, 'cancelled'); effects.push(() => this.kick()); }
      else if (job.status === 'running') {
        const run = api.require('run', job.run_id);
        if (!TERMINAL_RUNS.has(run.status) && run.status !== 'cancelling') {
          if (api.agent.task?.runs?.at(-1)?.id !== run.id) fail(409, 'invalid_run_state');
          api.put('run', { ...run, status: 'cancelling', revision: run.revision + 1 });
          effects.push(() => api.agent.control('stop'));
        }
      } else if (job.status !== 'cancelled') fail(409, 'invalid_job_state');
      return { status: job.status === 'running' ? 202 : 200, body: api.get('job', job.id) };
    }
    if ((m = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(path))) {
      const job = api.all('job').find(j => j.run_id === m[1] && j.status === 'queued');
      if (job) { empty.parse(body); this.finishQueued(job, 'cancelled'); effects.push(() => this.kick()); return { status: 200, body: api.get('run', m[1]) }; }
    }
    return undefined;
  }
}
