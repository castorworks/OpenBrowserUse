import { publicRun, TERMINAL_RUNS, assertRunStatus } from './runs.js';
import { redactTranscript } from './redact.js';
import { fail } from './api-error.js';
import { RunEvents } from './api-events.js';
const now = () => new Date().toISOString();

// Canonical persisted Session/Run/Interaction state, shared by all transports.
export class TaskState {
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
    const old = this.get(kind, value.id);
    if (kind === 'run' && old?.finished_at) return old;
    if (kind === 'run') {
      assertRunStatus(value.status);
      value = { ...value, revision: Math.max(value.revision || 0, old ? old.revision + 1 : 0) };
    }
    const safe = redactTranscript(value);
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
}
