import { setTimeout as delay } from 'node:timers/promises';
import { demoURL } from './demo.js';
import { EventEmitter } from 'node:events';
import { redactTranscript } from './redact.js';
import { BrowserSession } from './browser/session.js';
import { getTool, parseInput, askUserTool, memoryTool, progressTool } from './tools/index.js';
import { PermissionStore, siteOf } from './permissions/store.js';
import { authorize } from './permissions/policy.js';
import { DEFAULT_BLOCKED_SITES } from './permissions/rules.js';
import { SessionStore } from './sessions.js';
import { createProvider } from './providers/index.js';
import { newRun, updateRun } from './runs.js';

// done = the agent answered; the browser stays open for follow-up messages until stopped.
const finished = new Set(['done', 'failed', 'stopped']);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Short human-readable description of a tool call for the log and approval card.
export function describeCall(name, input = {}) {
  if (name === 'computer') {
    const at = input.ref || (input.coordinate ? `(${input.coordinate.join(', ')})` : '');
    return `computer.${input.action}${at ? ` ${at}` : ''}${input.text != null ? ` “${clip(input.text, 80)}”` : ''}${input.scroll_direction ? ` ${input.scroll_direction}` : ''}`;
  }
  if (name === 'form_input') return `form_input ${input.ref} = “${clip(String(input.value), 80)}”`;
  if (name === 'navigate') return `navigate ${input.url}`;
  if (name === 'tabs') return `tabs.${input.action}${input.tabId != null ? ` ${input.tabId}` : ''}${input.url ? ` ${input.url}` : ''}`;
  if (name === 'find') return `find “${input.query}”`;
  if (name === 'javascript') return `javascript (${input.code?.length ?? 0} 字符)`;
  return name;
}

export class Agent extends EventEmitter {
  constructor(origin, { dataDir, ...options } = {}) {
    super();
    this.origin = origin; this.options = options; this.task = null; this.busy = false;
    this.permissions = new PermissionStore(dataDir ? { dir: dataDir } : {});
    this.sessions = new SessionStore(dataDir ? { dir: dataDir } : {});
    this.frames = new Set();  // live-view subscribers: (base64 jpeg) => void
    this.lastFrame = null;
  }

  event(message, kind = 'info', extra = {}) {
    message = this.logText(String(message));
    const entry = { id: crypto.randomUUID(), time: new Date().toISOString(), kind, message: extra.final ? String(message) : clip(String(message), 4000), ...extra };
    this.task.events.push(entry);
    this.changed();
    const run = this.task.runs?.at(-1);
    if (run && !run.finished_at) this.emit('activity', { type: kind === 'action' ? 'tool.started' : 'message.created', data: entry });
    return entry;
  }

  changed() { updateRun(this.task); this.emit('change'); }

  logText(text) { return redactTranscript({ _secrets: this.task?._secrets, text }).text; }

  state({ compact = false } = {}) {
    if (!this.task) return null;
    const source = compact ? { ...this.task, events: this.task.events.slice(-400), history: undefined, audit: undefined, userMessages: undefined, metrics: { ...this.task.metrics, requests: this.task.metrics.requests.slice(-20), tools: this.task.metrics.tools.slice(-20) }, snapshot: this.task.snapshot ? { ...this.task.snapshot, screenshot: undefined } : null } : this.task;
    const publicTask = redactTranscript(source);
    if (compact) {
      publicTask.events = publicTask.events.slice(-400);
      delete publicTask.history; delete publicTask.audit; delete publicTask.userMessages;
      if (publicTask.snapshot) delete publicTask.snapshot.screenshot;
    }
    return { ...publicTask, sessionOpen: Boolean(this.browser) };
  }

  // Browser settings from the workbench config; demo runs always use a throwaway browser.
  sessionOptions(browser = {}, demo = false) {
    if (!demo && browser.requiresSelection) throw new Error('直接 CDP 模式已移除，请在浏览器设置中选择并保存新的模式。');
    return {
      demoOrigin: this.origin, ...this.options,
      onPointer: data => { this.pointer = { ...data, session_id: this.task?.id, run_id: this.task?.runs?.at(-1)?.id }; this.emit('pointer', this.pointer); },
      mode: demo ? 'ephemeral' : browser.mode || 'ephemeral',
      policy: { allowLocalhost: browser.allowLocalhost ?? true, allowPrivateNetwork: Boolean(browser.allowPrivateNetwork) },
    };
  }

  // Open the persistent profile for the user to sign in by hand; no agent runs in it.
  async openLogin(url, browser) {
    if (this.busy || this.browser) throw new Error('请先停止当前任务并关闭浏览器。');
    if (this.login) throw new Error('登录浏览器已经打开。');
    const session = new BrowserSession({ ...this.sessionOptions(browser), mode: 'persistent' });
    this.login = session;
    try {
      await session.open();
      session.context.on('close', () => { if (this.login === session) { this.login = null; this.changed(); } });
      if (url) await session.navigate(url);
    } catch (error) { this.login = null; await session.close(); throw error; }
  }

  async closeLogin() { const s = this.login; this.login = null; await s?.close(); }

  async start(input, config) {
    if (this.busy) throw new Error('已有任务正在执行，请先停止。');
    if (this.login && !input.demo && config.browser?.mode === 'persistent') throw new Error('请先关闭登录浏览器，再用持久化配置执行任务。');
    this.busy = true;
    await this.closeBrowser();
    const permissionMode = input.demo ? 'skip' : input.permissionMode || 'skip';
    this.task = { id: input.sessionId || crypto.randomUUID(), goal: input.goal, mode: input.demo ? 'demo' : 'ai', provider: input.demo ? 'demo' : config.provider, permissionMode, status: 'starting', step: 0, modelTurns: 0, metrics: { requests: [], tools: [], retries: 0 }, _secrets: new Set(), events: [], history: [], audit: [], userMessages: [input.goal], snapshot: null, pending: null, result: '', controller: new AbortController() };
    // Sites the user typed (start page, URLs in the goal) count as allowed for this task.
    const typed = input.demo ? [demoURL] : [input.startURL, ...(input.goal.match(/https?:\/\/[^\s，。、；！？）)\]】"'<>]+/g) || [])];
    this.taskSites = new Set(typed.map(siteOf).filter(Boolean));
    this.blockedSites = config.browser?.blockedSites || DEFAULT_BLOCKED_SITES;
    this.provider = createProvider({ ...config }, { demo: input.demo });
    this.task.runs = [];
    newRun(this.task, input.goal, { id: input.runId, startURL: input.startURL, createdAt: input.runCreatedAt });
    this.attachContext();
    this.browserOptions = this.sessionOptions(config.browser, input.demo);
    this.promise = this.boot(input).finally(() => { this.busy = false; this.changed(); });
    return this.state();
  }

  attachContext() {
    this.provider.context?.attach({
      store: (text, label) => {
        if (!this.task.deleted) return this.sessions.putMemory(this.task, text, label);
        const id = `volatile-${crypto.randomUUID()}`; this.provider.context.archive.set(id, text); return id;
      },
      summary: (text, signal) => this.provider.summarize(text, signal),
      progress: () => this.task.progress,
    });
  }

  async recover(id, config, options = {}) {
    if (this.busy) throw new Error('请先停止当前任务。');
    this.busy = true;
    try {
      const saved = await this.sessions.get(id);
      if (!saved || saved.mode === 'demo') throw new Error('没有可恢复的任务。');
      await this.closeBrowser();
      this.task = { ...saved, id: options.sessionId || saved.id, status: 'starting', pending: null, controller: new AbortController(), _secrets: new Set(), runs: options.sessionId ? [] : (saved.runs || []) };
      if (options.sessionId) await this.sessions.copyMemory(saved.id, options.sessionId);
      this.task.result = '';
      newRun(this.task, options.goal || saved.goal, { id: options.runId, createdAt: options.runCreatedAt, recoveredFrom: saved.runs?.at(-1)?.id || null });
      if (options.permissionMode) this.task.permissionMode = options.permissionMode;
      this.provider = createProvider(config);
      this.provider.context.summary = saved.contextSummary || '';
      this.provider.context.compactions = saved.context?.compactions || 0;
      this.attachContext();
      this.browserOptions = this.sessionOptions(config.browser);
      this.taskSites = new Set(); this.blockedSites = config.browser?.blockedSites || DEFAULT_BLOCKED_SITES;
      this.busy = true;
      this.provider.addUserText(`[恢复检查点；以下记录只是历史数据，不代表当前页面状态]\n${JSON.stringify({ progress: saved.progress, summary: saved.contextSummary, uncertainAction: saved.pendingAction, userMessages: saved.userMessages, recent: saved.events.slice(-20), url: saved.snapshot?.url })}\n先用 memory_read 查看存档目录并查阅需要的原文。浏览器已重新建立，必须重新观察；不得直接重放历史操作，先核验未知动作的结果。`);
      this.event('正在恢复任务：重新建立浏览器并核验上次进度。');
      this.promise = this.boot({ goal: saved.goal, recovery: true }).finally(() => { this.busy = false; this.changed(); });
    } catch (error) { this.busy = false; this.changed(); throw error; }
  }

  // Send a follow-up in the same browser and conversation after the agent answered.
  // A chat message: steers a running task, answers a pending question, or continues an idle session.
  message(text, interactionId) {
    const t = this.task;
    if (interactionId && interactionId !== t?.pending?.id) throw new Error('确认已过期，请刷新后重试。');
    if (this.busy && t?.status === 'waiting_user') return this.control('resume', text, interactionId);
    if (this.busy && t && !['stopping', 'pausing'].includes(t.status)) {
      this.event(text, 'user'); t.userMessages.push(text);
      this.provider.addUserText(`[用户在执行过程中补充] ${text}`);
      return;
    }
    return this.followUp(text);
  }

  followUp(text, options = {}) {
    const t = this.task;
    if (this.busy || !t || !this.browser || !['done', 'failed'].includes(t.status) || t.mode === 'demo') throw new Error('当前没有可继续的会话。');
    this.busy = true;
    Object.assign(t, { status: 'running', step: 0, modelTurns: 0, result: '', controller: new AbortController() });
    newRun(t, text, options);
    this.event(text, 'user'); t.userMessages.push(text);
    this.provider.addUserText(text);
    this.promise = this.loop().finally(() => { this.busy = false; this.changed(); });
  }

  control(command, answer, interactionId) {
    const t = this.task;
    if (interactionId && interactionId !== t?.pending?.id) throw new Error('确认已过期，请刷新后重试。');
    const replying = ['approve', 'reject', 'approve_site', 'deny_site'].includes(command) || (command === 'resume' && t?.status === 'waiting_user');
    if (replying && (!interactionId || interactionId !== t?.pending?.id)) throw new Error('确认已过期，请刷新后重试。');
    if (['approve_site', 'deny_site'].includes(command) && !t?.pending?.needsSite) throw new Error('此操作不允许网站级授权。');
    if (command === 'stop' && t && !this.busy && this.browser) { t.status = 'stopped'; this.event('会话已关闭'); void this.closeBrowser(); void this.save(); return; }
    if (!this.busy || !t || finished.has(t.status)) throw new Error('没有正在执行的任务。');
    if (command === 'stop') {
      t.status = 'stopping'; t.controller.abort(); this.resolveGate?.({ command: 'stop' });
      void this.browser?.close();
    } else if (command === 'pause') {
      if (!['running', 'starting'].includes(t.status)) throw new Error('当前状态不能暂停。');
      t.status = 'pausing'; t.controller.abort(); this.event('正在暂停；进行中的浏览器操作会先完成。');
    } else if (command === 'resume' && ['paused', 'waiting_user'].includes(t.status)) {
      if (t.status === 'waiting_user' && !answer?.trim()) throw new Error('请填写补充信息或说明人工操作已完成。');
      t.controller = new AbortController(); t.status = 'running';
      this.resolveGate?.({ command: 'resume', answer: answer?.trim() || '' });
    } else if (['approve', 'reject', 'approve_site', 'deny_site'].includes(command) && t.status === 'approval') {
      t.status = 'running'; this.resolveGate?.({ command });
    } else throw new Error('操作与当前任务状态不匹配。');
    this.changed();
  }

  async gate(status, pending = null) {
    this.task.status = status; this.task.pending = pending ? { ...pending, id: crypto.randomUUID() } : null;
    const choice = await new Promise(resolve => { this.resolveGate = resolve; this.changed(); void this.save(); });
    this.resolveGate = null; this.task.pending = null; this.changed();
    return choice;
  }

  stopping() { return ['stopping', 'pausing'].includes(this.task.status); }

  async refreshView() {
    const live = this.lastFrame && Date.now() - this.lastFrameAt < 3000;
    this.task.snapshot = await this.browser.view({ screenshot: !live }).catch(() => this.task.snapshot);
    if (this.task.snapshot?.screenshot) this.publishFrame(this.task.snapshot.screenshot.split(',')[1]);
    this.changed();
  }

  publishFrame(data) {
    this.lastFrame = data; this.lastFrameAt = Date.now();
    for (const f of this.frames) f(data);
  }

  async closeBrowser() {
    if (this.task?.snapshot && this.lastFrame) this.task.snapshot.screenshot = `data:image/jpeg;base64,${this.lastFrame}`;
    this.pointer = { visible: false }; this.emit('pointer', this.pointer);
    clearInterval(this.castTimer); this.lastFrame = null; this.lastFrameAt = 0;
    const b = this.browser; this.browser = null; this.changed(); await b?.close();
  }

  startLiveView() {
    const b = this.browser;
    void b.screencast(data => { if (this.browser === b) this.publishFrame(data); }).catch(() => {});
    this.castTimer = setInterval(() => { void b.syncScreencast().catch(() => {}); }, 500);
  }

  async save() {
    updateRun(this.task);
    if (this.provider?.context) { this.task.context = this.provider.context.stats; this.task.contextSummary = this.provider.context.summary; }
    if (this.task && this.task.mode !== 'demo' && !this.task.deleted) await this.sessions.save(this.task).catch(error => this.event(`保存会话失败：${error.message}`, 'error'));
  }

  // Deleting the current task's session also keeps it from being saved again when it finishes or continues.
  async deleteSession(id) {
    if (this.task?.id === id) this.task.deleted = true;
    await this.sessions.remove(id);
  }

  async boot(input) {
    const t = this.task;
    try {
      this.event(input.demo ? '启动固定脚本演示（不调用 AI）' : '启动独立浏览器会话');
      await this.save();
      this.browser = new BrowserSession(this.browserOptions);
      await this.browser.open();
      this.startLiveView();
      if (t.status === 'stopping') return this.finish();
      const url = input.demo ? demoURL : input.startURL;
      if (url) await this.browser.navigate(url);
      await this.refreshView();
      if (t.status === 'starting') t.status = 'running';
      this.event(t.goal, 'user');
      this.provider.addUserText(`${input.recovery ? '原始目标（以历次较新的用户补充为准）：' : ''}${t.goal}\n\n${url ? `（浏览器已打开起始网页：${this.browser.current().url()}）` : '（浏览器已打开一个空白标签页，请用 navigate 打开需要的网站。）'}`);
    } catch (error) {
      if (t.status !== 'stopping') { t.status = 'failed'; t.result = error.message.slice(0, 800); this.event(t.result, 'error'); }
      await this.closeBrowser();
      return this.finish();
    }
    return this.loop();
  }

  async loop() {
    const t = this.task;
    let failures = 0; let repeatedFailures = 0; let lastFailure = null; let unchanged = 0; let lastResult = null;
    try {
      while (t.status !== 'stopping') {
        if (t.status === 'pausing') { await this.pause(); continue; }
        await this.save();
        let reply;
        const request = { started: new Date().toISOString(), attempt: ++t.modelTurns };
        const requestStart = performance.now();
        try {
          reply = await this.provider.step({ signal: t.controller.signal });
          request.usage = reply.usage || null; request.model = reply.model || null; request.ok = true;
          failures = 0;
        } catch (error) {
          request.ok = false; request.aborted = Boolean(error.aborted || this.stopping());
          if (error.aborted || this.stopping()) continue;
          if (error.nonRetryable) throw error;
          failures++; t.metrics.retries += failures < 6 ? 1 : 0;
          this.event(error.message.slice(0, 600), 'error');
          if (failures >= 6) throw new Error(`连续 6 次模型请求失败；检查点已保留，可稍后恢复。${error.message.slice(0, 300)}`);
          const waitMs = Math.max(error.retryAfterMs || 0, Math.min(30000, 1000 * 2 ** (failures - 1)));
          this.event(`请求暂时失败，${Math.ceil(waitMs / 1000)} 秒后重试（${failures}/6）。`);
          await delay(waitMs, undefined, { signal: t.controller.signal }).catch(() => {});
          continue;
        } finally {
          request.durationMs = Math.round(performance.now() - requestStart);
          t.metrics.requests.push(request); this.changed();
        }
        for (const note of reply.notes || []) this.event(note, 'note');
        if (reply.text && reply.toolCalls.length) this.event(reply.text, 'assistant');
        if (reply.stop === 'refusal') { t.status = 'failed'; t.result = `模型拒绝了这个请求。${reply.text || ''}`; this.event(t.result, 'error'); break; }
        if (reply.stop === 'max_tokens') {
          if (reply.toolCalls.length) this.provider.addToolResults(reply.toolCalls.map(call => ({ id: call.id, isError: true, text: '输出截断，未执行此动作。' })));
          throw new Error('模型输出被截断，任务未完成。可以发送消息继续。');
        }
        if (!reply.toolCalls.length) {
          t.result = reply.text || '（模型没有返回内容）'; t.status = 'done'; t.outcome = 'unverified'; t.evidence = { observedPage: t.snapshot ? { url: t.snapshot.url, title: t.snapshot.title } : null, failedTools: t.metrics.tools.filter(x => !x.ok).length, recordedAt: new Date().toISOString() }; this.event(t.result, 'assistant', { final: true }); this.event('本轮回答结束；实际操作结果请核验，可以继续发送消息', 'info'); break;
        }
        const results = [];
        for (const call of reply.toolCalls) {
          // Every tool call needs a result, even when skipped, or the conversation becomes invalid.
          if (this.stopping() || reply.stop === 'max_tokens') { results.push({ id: call.id, isError: true, text: reply.stop === 'max_tokens' ? '工具参数被截断（max_tokens），未执行。' : '未执行：用户暂停或停止了任务。' }); continue; }
          t.step++;
          const toolStart = performance.now();
          const result = await this.runTool(call);
          t.metrics.tools.push({ tool: call.name, durationMs: Math.round(performance.now() - toolStart), ok: !result.isError });
          results.push(result);
          const signature = JSON.stringify([call.name, call.input, result.text]);
          repeatedFailures = result.isError ? (lastFailure === signature ? repeatedFailures + 1 : 1) : 0;
          lastFailure = signature;
          unchanged = !result.isError && call.name !== 'task_progress' && lastResult === signature ? unchanged + 1 : 0;
          lastResult = signature;
          if (unchanged >= 24) { t.status = 'pausing'; this.event('同一动作连续返回相同结果，已暂停以避免空转。请补充说明或接管后继续。'); unchanged = 0; }
          if (repeatedFailures >= 8) { t.status = 'pausing'; this.event('同一动作连续失败 8 次，已暂停。请补充说明或接管后继续。'); repeatedFailures = 0; }
          await this.save(); this.changed();
        }
        this.provider.addToolResults(results);
        await this.refreshView();
      }
    } catch (error) {
      if (t.status !== 'stopping') { t.status = 'failed'; t.result = error.message.slice(0, 800); this.event(t.result, 'error'); }
    }
    return this.finish();
  }

  async pause() {
    this.event('已暂停。可以在浏览器窗口里操作，然后继续。');
    const { command, answer } = await this.gate('paused');
    if (command === 'stop') return;
    this.provider.addUserText(`[用户暂停后继续。页面可能已被手动修改，请重新观察后再操作。]${answer ? `\n用户说明：${answer}` : ''}`);
    await this.refreshView();
  }

  async runTool(call) {
    const t = this.task;
    const tool = getTool(call.name);
    if (!tool) return { id: call.id, isError: true, text: `没有名为 ${call.name} 的工具。` };
    if (call.parseError) return { id: call.id, isError: true, text: call.parseError };
    let input;
    try { input = parseInput(tool, call.input); } catch (error) { this.event(`${call.name}: ${error.message}`, 'error'); return { id: call.id, isError: true, text: error.message }; }

    if (tool === memoryTool) return { id: call.id, text: input.id?.startsWith('volatile-') ? this.provider.context.read(input.id, input.offset, input.length, input.query) : await this.sessions.readMemory(t.id, input) };
    if (tool === progressTool) { t.progress = input; this.event(`进度：${input.next}`, 'info'); await this.save(); return { id: call.id, text: '阶段进度已保存；完成情况仍需页面证据核验。' }; }

    if (tool === askUserTool) {
      this.event(input.question, 'question');
      const { command, answer } = await this.gate('waiting_user', { tool: 'ask_user', question: input.question });
      if (command === 'stop') return { id: call.id, isError: true, text: '任务已停止。' };
      this.event(answer, 'user'); t.userMessages.push(answer);
      return { id: call.id, text: `用户回复：${answer}` };
    }

    let sensitive = false;
    if (call.name === 'form_input' || (call.name === 'computer' && input.action === 'type')) {
      try {
        const target = input.ref ? await this.browser.resolve(input.ref) : null;
        const inspect = el => Boolean(el && (el.type === 'password' || /password|passwd|secret|token|one-time-code|cc-number|cc-csc/i.test([el.name, el.id, el.autocomplete].join(' '))));
        // Focus can be inside a cross-origin iframe or a closed shadow root.
        // Without a resolved ref, conservatively hide keyboard input.
        sensitive = target ? await target.evaluate(inspect) : true;
      } catch { sensitive = true; } // Unknown fields are conservatively hidden from logs.
      const value = input.value ?? input.text;
      if (sensitive && value != null && String(value)) t._secrets.add(String(value));
    }
    const displayInput = sensitive ? { ...input, ...(call.name === 'form_input' ? { value: '[REDACTED]' } : { text: '[REDACTED]' }) } : input;
    const summary = describeCall(call.name, displayInput);
    const verdict = await authorize({
      mode: t.permissionMode, tool, input, browser: this.browser, store: this.permissions, taskSites: this.taskSites, blockedSites: this.blockedSites,
      userMessages: t.userMessages.slice(-6), summary, review: text => (this.provider.review ? this.provider.review(text, t.controller.signal) : { decision: 'ask', reason: '' }),
    }).catch(error => (error.aborted ? { action: 'skipped' } : { action: 'ask', source: 'error', reason: `权限检查失败：${error.message.slice(0, 200)}` }));
    if (verdict.action === 'skipped' || this.stopping()) return { id: call.id, isError: true, text: '未执行：用户暂停或停止了任务。' };
    const audit = (decision, source) => t.audit.push({ time: new Date().toISOString(), site: verdict.site, tool: call.name, summary, decision, source });
    const refuse = (text, decision, source) => {
      audit(decision, source); t.history.push({ tool: call.name, input, sensitive, ok: false, error: decision });
      return { id: call.id, isError: true, text };
    };
    if (verdict.action === 'block') {
      this.event(`已阻止：${summary}（${verdict.reason}）`, 'error');
      return refuse(`已阻止：${verdict.reason} 不要重试；如确有必要，用 ask_user 请用户亲自操作。`, 'blocked', verdict.source);
    }
    let source = verdict.source;
    if (verdict.action === 'ask') {
      this.event(`等待确认：${summary}${verdict.reason ? `（${verdict.reason}）` : ''}`, 'approval');
      const { command } = await this.gate('approval', {
        tool: call.name, summary, reason: verdict.reason, site: verdict.site, needsSite: verdict.needsSite, source: verdict.source,
        target: verdict.target?.label || (input.ref ? this.browser.refLabel(input.ref) : undefined), input: { ...input, code: input.code && clip(input.code, 2000) },
      });
      if (command === 'stop') return { id: call.id, isError: true, text: '任务已停止。' };
      if (command === 'deny_site') {
        this.permissions.set(verdict.site, 'deny'); this.event(`已禁止在 ${verdict.site} 上操作`);
        return refuse(`用户禁止代理在 ${verdict.site} 上操作。不要再尝试该网站。`, 'rejected', 'user');
      }
      if (command === 'reject') {
        this.event('已拒绝该动作');
        return refuse('用户拒绝了这个动作。不要重试同一动作；换一种方法，或用 ask_user 询问用户。', 'rejected', 'user');
      }
      if (command === 'approve_site') { this.permissions.set(verdict.site, 'allow'); this.event(`已始终允许 ${verdict.site}`); }
      if (verdict.site) this.taskSites.add(verdict.site);
      source = 'user';
    }
    if (verdict.source !== 'read') audit('run', source);

    const card = this.event(summary, 'action', { tool_call_id: call.id, tool: call.name, input: clip(this.logText(JSON.stringify(displayInput)), 1200), state: 'running' });
    const previousUncertainAction = t.pendingAction;
    t.pendingAction = { id: call.id, tool: call.name, input: displayInput, state: 'unknown', started: new Date().toISOString() };
    await this.save();
    if (this.stopping()) {
      Object.assign(card, { state: 'error', output: '未执行：用户暂停或停止了任务。' });
      this.emit('activity', { type: 'tool.completed', data: { ...card } });
      return { id: call.id, isError: true, text: card.output };
    }
    try {
      const out = await tool.run(input, { browser: this.browser, signal: t.controller.signal });
      t.history.push({ tool: call.name, input, sensitive, ok: true });
      t.pendingAction = previousUncertainAction || null;
      Object.assign(card, { state: 'ok', output: clip(this.logText(out.text || ''), 1500), image: Boolean(out.image) });
      return { id: call.id, text: out.text, image: out.image };
    } catch (error) {
      const message = this.logText(error.message).split('\n')[0].slice(0, 600);
      if (['computer', 'form_input'].includes(call.name) && this.pointer?.visible) { this.pointer = { ...this.pointer, phase: 'error', at: new Date().toISOString() }; this.emit('pointer', this.pointer); }
      Object.assign(card, { state: 'error', output: message });
      t.history.push({ tool: call.name, input, sensitive, ok: false, error: message });
      return { id: call.id, isError: true, text: message };
    } finally {
      this.emit('activity', { type: 'tool.completed', data: { ...card } });
    }
  }

  async finish() {
    const t = this.task;
    if (t.status === 'stopping') { t.status = 'stopped'; this.event('任务已停止'); }
    // Keep the browser for follow-ups (also after a failure, so the user can steer it); demo sessions always close.
    if (t.status === 'stopped' || t.mode === 'demo') await this.closeBrowser();
    updateRun(t, true);
    await this.save();
  }
}
