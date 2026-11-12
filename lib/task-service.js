import { z } from 'zod';
import { TaskState } from './task-state.js';
import { TaskScheduler } from './task-scheduler.js';
import { TERMINAL_RUNS, RUN_ACTIONS, taskStatus } from './runs.js';
import { fail } from './api-error.js';
import { redactTranscript } from './redact.js';
const now = () => new Date().toISOString();
const response = (status, body) => ({ status, body });

// One owner for task commands and slot ownership, independent of IPC/HTTP.
export class TaskService extends TaskState {
  async init() { await super.init(); this.lifecycle = new TaskScheduler(this); }
  state(options) {
    const task = this.agent.state(options);
    const run = task?.runs?.at(-1), stored = run && this.get('run', run.id);
    if (!stored) return task;
    return { ...task,
      runs: task.runs.map(run => ({ ...run, ...this.get('run', run.id) })),
      status: taskStatus(stored.status),
      result: stored.result?.text || stored.error?.message || task.result,
    };
  }
  removeSession(id) { return this.transaction(() => this.lifecycle.erase(id)); }
  assertConfigurationMutable() {
    if (this.openSession() || this.agent.busy || this.agent.browser || this.agent.login) fail(409, 'session_active', '请先关闭当前会话。');
  }
  async perform(command) {
    const effects = [];
    const result = this.transaction(() => command(effects));
    for (const effect of effects) await effect();
    this.lifecycle.kick();
    return result;
  }
  createSession(input) {
    const a = this.agent;
    if (this.openSession() || a.busy || a.browser || a.login) fail(409, 'session_active');
    if (this.lifecycle.queued().length) fail(409, 'queue_pending', '请等待队列完成，或先取消排队任务。');
    const cfg = this.config();
    if (cfg.modelRequiresSelection) fail(409, 'model_selection_required', '模型协议已移除，请重新配置模型服务。');
    if (cfg.browser.requiresSelection) fail(409, 'browser_selection_required', '直接 CDP 模式已移除，请重新选择浏览器模式。');
    const browserMode = input.browser_mode || cfg.browser.mode;
    if (browserMode !== cfg.browser.mode) fail(422, 'browser_not_configured', '浏览器模式必须与服务端配置一致。');
    if (browserMode === 'extension' && !this.relay.connected()) fail(409, 'extension_unavailable');
    const s = { id: crypto.randomUUID(), status: 'open', browser_mode: browserMode, browser_status: 'not_started', permission_mode: input.permission_mode || 'skip', keep_alive: input.keep_alive === true, created_at: now(), updated_at: now(), active_run_id: null, last_run_id: null, model: { provider: cfg.provider, name: cfg.model } };
    this.put('session', s); return s;
  }
  createRun(s, input, effects, recovered) {
    const a = this.agent;
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
    return r;
  }
  closeSession(id, effects) {
    const a = this.agent, s = this.require('session', id);
    if (s.status === 'queued') fail(409, 'job_queued', '请取消排队任务。');
    if (s.active_run_id || (a.task?.id === s.id && a.busy)) fail(409, 'run_active');
    if (s.status === 'closed') return { status: 200, body: s };
    const closing = { ...s, browser_status: 'closing', updated_at: now() };
    this.put('session', closing);
    effects.push(async () => {
      const browser = a.task?.id === s.id ? a.browser : null;
      try {
        if (browser) await a.closeBrowser();
        if (a.task?.id === s.id) { a.task.status = 'stopped'; a.changed(); await a.save().catch(() => {}); }
        this.put('session', { ...closing, status: 'closed', browser_status: 'closed' });
      } catch {
        a.browser = browser;
        this.put('session', { ...s, error: { code: 'cleanup_failed', message: '关闭浏览器失败，请重试。' } });
      }
    });
    return { status: 202, body: closing };
  }
  controlRun(id, action, input, effects) {
    const a = this.agent, r = this.require('run', id);
    if (action === 'cancel' && r.status === 'cancelled') return response(200, r);
    if (action === 'pause' && ['paused', 'pausing'].includes(r.status)) return response(r.status === 'paused' ? 200 : 202, r);
    if (action === 'cancel' && r.status === 'cancelling') return response(202, r);
    if (TERMINAL_RUNS.has(r.status) || a.task?.runs?.at(-1)?.id !== r.id || !a.busy) fail(409, 'invalid_run_state');
    if (!RUN_ACTIONS[action]?.includes(r.status)) fail(409, 'invalid_run_state');
    if (action === 'messages') {
      const message = { id: crypto.randomUUID(), run_id: r.id, text: a.logText(input.text), created_at: now() };
      effects.push(() => a.message(input.text)); return response(201, message);
    }
    const updated = { ...r, status: { pause: 'pausing', resume: 'running', cancel: 'cancelling' }[action], revision: r.revision + 1 };
    this.put('run', updated); effects.push(() => a.control(action === 'cancel' ? 'stop' : action, input.answer));
    return response(202, updated);
  }
  respondInteraction(runId, id, input, effects) {
    const a = this.agent, r = this.require('run', runId), i = this.require('interaction', id);
    if (i.run_id !== r.id) fail(404, 'not_found');
    if (i.status !== 'pending' || a.task?.pending?.id !== i.id || !['waiting_input', 'waiting_approval'].includes(r.status)) fail(409, 'interaction_not_pending');
    input = i.kind === 'input' ? z.object({ answer: z.string().trim().min(1) }).strict().parse(input) : z.object({ decision: z.enum(['approve', 'reject', 'approve_site', 'deny_site']) }).strict().parse(input);
    if (input.decision && !i.allowed_decisions.includes(input.decision)) fail(422, 'invalid_decision');
    const resolved = { ...i, status: 'resolved', resolved_at: now(), response: redactTranscript({ response: input }).response };
    this.put('interaction', resolved);
    effects.push(() => a.control(input.decision || 'resume', input.answer, i.id));
    return response(200, resolved);
  }
  recoverRun(id, input, checkpoint, effects) {
    const previous = this.require('run', id);
    if (!TERMINAL_RUNS.has(previous.status)) fail(409, 'run_active');
    if (!checkpoint || checkpoint.runs?.at(-1)?.id !== id) fail(409, 'checkpoint_unavailable');
    const session = this.createSession({ permission_mode: input.permission_mode || checkpoint.permissionMode, keep_alive: input.keep_alive });
    return this.createRun(session, { goal: previous.goal }, effects, previous);
  }
  async startTask(input) {
    if (input.demo) {
      this.assertConfigurationMutable();
      if (this.lifecycle.queued().length) fail(409, 'queue_pending');
      return this.agent.start(input, this.config());
    }
    return this.perform(effects => {
      const session = this.createSession({ permission_mode: input.permissionMode, keep_alive: input.keepAlive });
      return this.createRun(session, { goal: input.goal, start_url: input.startURL }, effects);
    });
  }
  async recoverTask(id) {
    const checkpoint = await this.agent.sessions.get(id);
    if (!checkpoint || checkpoint.mode === 'demo') fail(409, 'checkpoint_unavailable');
    const open = this.openSession();
    if (open?.id === id && !this.agent.busy) await this.perform(effects => this.closeSession(id, effects));
    const previous = checkpoint.runs?.at(-1);
    if (!previous || !this.get('run', previous.id)) {
      this.assertConfigurationMutable();
      // Old checkpoints predate runs; keep the compatibility path in the service.
      await this.agent.recover(id, this.config()); return;
    }
    return this.perform(effects => this.recoverRun(previous.id, { keep_alive: this.get('session', previous.session_id)?.keep_alive === true }, checkpoint, effects));
  }
  async sendMessage(text, interactionId) {
    const task = this.agent.task, run = task?.runs?.at(-1);
    if (!run) fail(409, 'invalid_run_state');
    if (interactionId && interactionId !== task.pending?.id) fail(409, 'interaction_not_pending');
    return this.perform(effects => {
      if (task.status === 'waiting_user') return this.respondInteraction(run.id, interactionId, { answer: text }, effects);
      if (this.agent.busy) return this.controlRun(run.id, 'messages', { text }, effects);
      return this.createRun(this.require('session', task.id), { goal: text }, effects);
    });
  }
  async controlTask(command, answer, interactionId) {
    const task = this.agent.task, run = task?.runs?.at(-1);
    if (task?.mode === 'demo') return this.agent.control(command, answer, interactionId);
    if (!run) fail(409, 'invalid_run_state');
    return this.perform(effects => {
      if (['approve', 'reject', 'approve_site', 'deny_site'].includes(command) || (command === 'resume' && task.status === 'waiting_user')) {
        if (!interactionId) fail(409, 'interaction_not_pending');
        return this.respondInteraction(run.id, interactionId, command === 'resume' ? { answer } : { decision: command }, effects);
      }
      if (command === 'stop' && !this.agent.busy) return this.closeSession(task.id, effects);
      return this.controlRun(run.id, command === 'stop' ? 'cancel' : command, { answer }, effects);
    });
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
