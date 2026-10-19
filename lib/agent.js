import { EventEmitter } from 'node:events';
import { redactTranscript } from './redact.js';
import { BrowserSession } from './browser/session.js';
import { getTool, parseInput, askUserTool } from './tools/index.js';
import { PermissionStore, siteOf } from './permissions/store.js';
import { authorize } from './permissions/policy.js';
import { DEFAULT_BLOCKED_SITES } from './permissions/rules.js';
import { SessionStore } from './sessions.js';
import { createProvider } from './providers/index.js';

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
    const entry = { time: new Date().toISOString(), kind, message: extra.final ? String(message) : clip(String(message), 4000), ...extra };
    this.task.events.push(entry);
    this.changed();
    return entry;
  }

  changed() { this.emit('change'); }

  logText(text) { return redactTranscript({ _secrets: this.task?._secrets, text }).text; }

  state({ compact = false } = {}) {
    if (!this.task) return null;
    const publicTask = redactTranscript(this.task);
    if (compact) {
      publicTask.events = publicTask.events.slice(-400);
      delete publicTask.history; delete publicTask.audit; delete publicTask.userMessages;
      if (publicTask.snapshot) delete publicTask.snapshot.screenshot;
    }
    return { ...publicTask, sessionOpen: Boolean(this.browser) };
  }

  // Browser settings from the workbench config; demo runs always use a throwaway browser.
  sessionOptions(browser = {}, demo = false) {
    return {
      demoOrigin: this.origin, ...this.options,
      mode: demo ? 'ephemeral' : browser.mode || 'ephemeral', cdpURL: browser.cdpURL,
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
    this.task = { id: crypto.randomUUID(), goal: input.goal, mode: input.demo ? 'demo' : 'ai', provider: input.demo ? 'demo' : config.provider, permissionMode, status: 'starting', step: 0, modelTurns: 0, metrics: { requests: [], tools: [], retries: 0 }, _secrets: new Set(), maxSteps: input.maxSteps, events: [], history: [], audit: [], userMessages: [input.goal], snapshot: null, pending: null, result: '', controller: new AbortController() };
    // Sites the user typed (start page, URLs in the goal) count as allowed for this task.
    const typed = input.demo ? [`${this.origin}/demo`] : [input.startURL, ...(input.goal.match(/https?:\/\/[^\s，。、；！？）)\]】"'<>]+/g) || [])];
    this.taskSites = new Set(typed.map(siteOf).filter(Boolean));
    this.blockedSites = config.browser?.blockedSites || DEFAULT_BLOCKED_SITES;
    this.provider = createProvider({ ...config }, { demo: input.demo });
    this.browserOptions = this.sessionOptions(config.browser, input.demo);
    this.promise = this.boot(input).finally(() => { this.busy = false; this.changed(); });
    return this.state();
  }

  // Send a follow-up in the same browser and conversation after the agent answered.
  // A chat message: steers a running task, answers a pending question, or continues an idle session.
  message(text) {
    const t = this.task;
    if (this.busy && t?.status === 'waiting_user') return this.control('resume', text);
    if (this.busy && t && !['stopping', 'pausing'].includes(t.status)) {
      this.event(text, 'user'); t.userMessages.push(text);
      this.provider.addUserText(`[用户在执行过程中补充] ${text}`);
      return;
    }
    return this.followUp(text);
  }

  followUp(text) {
    const t = this.task;
    if (this.busy || !t || !this.browser || !['done', 'failed'].includes(t.status) || t.mode === 'demo') throw new Error('当前没有可继续的会话。');
    this.busy = true;
    Object.assign(t, { status: 'running', step: 0, modelTurns: 0, result: '', controller: new AbortController() });
    this.event(text, 'user'); t.userMessages.push(text);
    this.provider.addUserText(text);
    this.promise = this.loop().finally(() => { this.busy = false; this.changed(); });
  }

  control(command, answer) {
    const t = this.task;
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
      this.resolveGate?.({ command: 'resume', answer: answer?.trim().slice(0, 4000) || '' });
    } else if (['approve', 'reject', 'approve_site', 'deny_site'].includes(command) && t.status === 'approval') {
      t.status = 'running'; this.resolveGate?.({ command });
    } else throw new Error('操作与当前任务状态不匹配。');
    this.changed();
  }

  async gate(status, pending = null) {
    this.task.status = status; this.task.pending = pending;
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
    clearInterval(this.castTimer); this.lastFrame = null; this.lastFrameAt = 0;
    const b = this.browser; this.browser = null; this.changed(); await b?.close();
  }

  startLiveView() {
    const b = this.browser;
    void b.screencast(data => { if (this.browser === b) this.publishFrame(data); }).catch(() => {});
    this.castTimer = setInterval(() => { void b.syncScreencast().catch(() => {}); }, 500);
  }

  async save() {
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
      const url = input.demo ? `${this.origin}/demo` : input.startURL;
      if (url) await this.browser.navigate(url);
      await this.refreshView();
      if (t.status === 'starting') t.status = 'running';
      this.event(t.goal, 'user');
      this.provider.addUserText(`${t.goal}\n\n${url ? `（浏览器已打开起始网页：${this.browser.current().url()}）` : '（浏览器已打开一个空白标签页，请用 navigate 打开需要的网站。）'}`);
    } catch (error) {
      if (t.status !== 'stopping') { t.status = 'failed'; t.result = error.message.slice(0, 800); this.event(t.result, 'error'); }
      await this.closeBrowser();
      return this.finish();
    }
    return this.loop();
  }

  async loop() {
    const t = this.task;
    let failures = 0;
    try {
      while (t.status !== 'stopping') {
        if (t.status === 'pausing') { await this.pause(); continue; }
        if (t.step >= t.maxSteps) { t.status = 'failed'; t.result = `已达到 ${t.maxSteps} 步上限，任务未完成。可以发送消息让它继续。`; this.event(t.result, 'error'); break; }
        if (t.modelTurns >= t.maxSteps + 3) throw new Error('已达到模型请求轮数上限，请发送消息继续。');
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
          failures++; t.metrics.retries += failures < 3 ? 1 : 0;
          this.event(error.message.slice(0, 600), 'error');
          if (failures >= 3) throw new Error(`连续 3 次模型请求失败，任务已停止。${error.message.slice(0, 300)}`);
          continue;
        } finally {
          request.durationMs = Math.round(performance.now() - requestStart);
          t.metrics.requests.push(request); this.changed();
        }
        for (const note of reply.notes || []) this.event(note, 'note');
        if (reply.text && reply.toolCalls.length) this.event(reply.text, 'assistant');
        if (reply.stop === 'refusal') { t.status = 'failed'; t.result = `模型拒绝了这个请求。${reply.text || ''}`; this.event(t.result, 'error'); break; }
        if (reply.stop === 'max_tokens' && !reply.toolCalls.length) throw new Error('模型输出被截断，任务未完成。可以发送消息继续。');
        if (!reply.toolCalls.length) {
          t.result = reply.text || '（模型没有返回内容）'; t.status = 'done'; this.event(t.result, 'assistant', { final: true }); this.event('本轮完成，可以继续发送消息', 'success'); break;
        }
        const results = [];
        for (const call of reply.toolCalls) {
          // Every tool call needs a result, even when skipped, or the conversation becomes invalid.
          if (this.stopping() || reply.stop === 'max_tokens') { results.push({ id: call.id, isError: true, text: reply.stop === 'max_tokens' ? '工具参数被截断（max_tokens），未执行。' : '未执行：用户暂停或停止了任务。' }); continue; }
          if (t.step >= t.maxSteps) { results.push({ id: call.id, isError: true, text: '已达到工具尝试次数上限，未执行。' }); continue; }
          t.step++;
          const toolStart = performance.now();
          const result = await this.runTool(call);
          t.metrics.tools.push({ tool: call.name, durationMs: Math.round(performance.now() - toolStart), ok: !result.isError });
          results.push(result);
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

    const card = this.event(summary, 'action', { tool: call.name, input: clip(this.logText(JSON.stringify(displayInput)), 1200), state: 'running' });
    await this.save();
    if (this.stopping()) {
      Object.assign(card, { state: 'error', output: '未执行：用户暂停或停止了任务。' });
      return { id: call.id, isError: true, text: card.output };
    }
    try {
      const out = await tool.run(input, { browser: this.browser });
      t.history.push({ tool: call.name, input, sensitive, ok: true });
      Object.assign(card, { state: 'ok', output: clip(this.logText(out.text || ''), 1500), image: Boolean(out.image) });
      return { id: call.id, text: out.text, image: out.image };
    } catch (error) {
      const message = this.logText(error.message).split('\n')[0].slice(0, 600);
      Object.assign(card, { state: 'error', output: message });
      t.history.push({ tool: call.name, input, sensitive, ok: false, error: message });
      return { id: call.id, isError: true, text: message };
    }
  }

  async finish() {
    const t = this.task;
    if (t.status === 'stopping') { t.status = 'stopped'; this.event('任务已停止'); }
    // Keep the browser for follow-ups (also after a failure, so the user can steer it); demo sessions always close.
    if (t.status === 'stopped' || t.mode === 'demo') await this.closeBrowser();
    await this.save();
  }
}
