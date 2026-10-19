import { BrowserSession } from './browser/session.js';
import { getTool, needsApproval, parseInput, askUserTool } from './tools/index.js';
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

export class Agent {
  constructor(origin, options = {}) { this.origin = origin; this.options = options; this.task = null; this.busy = false; }

  event(message, kind = 'info', extra = {}) {
    this.task.events.push({ time: new Date().toISOString(), kind, message: clip(String(message), 4000), ...extra });
    if (this.task.events.length > 400) this.task.events.shift();
  }

  state() {
    if (!this.task) return null;
    const { controller, ...publicTask } = this.task;
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
      session.context.on('close', () => { if (this.login === session) this.login = null; });
      if (url) await session.navigate(url);
    } catch (error) { this.login = null; await session.close(); throw error; }
  }

  async closeLogin() { const s = this.login; this.login = null; await s?.close(); }

  async start(input, config) {
    if (this.busy) throw new Error('已有任务正在执行，请先停止。');
    if (this.login && !input.demo && config.browser?.mode === 'persistent') throw new Error('请先关闭登录浏览器，再用持久化配置执行任务。');
    this.busy = true;
    await this.closeBrowser();
    this.task = { id: crypto.randomUUID(), goal: input.goal, mode: input.demo ? 'demo' : 'ai', provider: input.demo ? 'demo' : config.provider, status: 'starting', step: 0, maxSteps: input.maxSteps, events: [], history: [], snapshot: null, pending: null, result: '', autoInteract: input.autoInteract || input.demo, controller: new AbortController() };
    this.provider = createProvider({ ...config }, { demo: input.demo });
    this.browserOptions = this.sessionOptions(config.browser, input.demo);
    this.promise = this.boot(input).finally(() => { this.busy = false; });
    return this.state();
  }

  // Send a follow-up in the same browser and conversation after the agent answered.
  followUp(text) {
    const t = this.task;
    if (this.busy || !t || !this.browser || !['done', 'failed'].includes(t.status) || t.mode === 'demo') throw new Error('当前没有可继续的会话。');
    this.busy = true;
    Object.assign(t, { status: 'running', step: 0, result: '', controller: new AbortController() });
    this.event(text, 'user');
    this.provider.addUserText(text);
    this.promise = this.loop().finally(() => { this.busy = false; });
  }

  control(command, answer) {
    const t = this.task;
    if (command === 'stop' && t && !this.busy && this.browser) { t.status = 'stopped'; this.event('会话已关闭'); void this.closeBrowser(); return; }
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
    } else if (['approve', 'reject'].includes(command) && t.status === 'approval') {
      t.status = 'running'; this.resolveGate?.({ command });
    } else throw new Error('操作与当前任务状态不匹配。');
  }

  async gate(status, pending = null) {
    this.task.status = status; this.task.pending = pending;
    const choice = await new Promise(resolve => { this.resolveGate = resolve; });
    this.resolveGate = null; this.task.pending = null;
    return choice;
  }

  stopping() { return ['stopping', 'pausing'].includes(this.task.status); }

  async refreshView() { this.task.snapshot = await this.browser.view().catch(() => this.task.snapshot); }

  async closeBrowser() { const b = this.browser; this.browser = null; await b?.close(); }

  async boot(input) {
    const t = this.task;
    try {
      this.event(input.demo ? '启动固定脚本演示（不调用 AI）' : '启动独立浏览器会话');
      this.browser = new BrowserSession(this.browserOptions);
      await this.browser.open();
      if (t.status === 'stopping') return this.finish();
      const url = input.demo ? `${this.origin}/demo` : input.startURL;
      await this.browser.navigate(url);
      await this.refreshView();
      if (t.status === 'starting') t.status = 'running';
      this.event(t.goal, 'user');
      this.provider.addUserText(`${t.goal}\n\n（浏览器已打开起始网页：${this.browser.current().url()}）`);
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
        let reply;
        try {
          reply = await this.provider.step({ signal: t.controller.signal });
          failures = 0;
        } catch (error) {
          if (error.aborted || this.stopping()) continue;
          failures++;
          this.event(error.message.slice(0, 600), 'error');
          if (failures >= 3) throw new Error(`连续 3 次模型请求失败，任务已停止。${error.message.slice(0, 300)}`);
          continue;
        }
        for (const note of reply.notes || []) this.event(note, 'note');
        if (reply.text && reply.toolCalls.length) this.event(reply.text, 'assistant');
        if (reply.stop === 'refusal') { t.status = 'failed'; t.result = `模型拒绝了这个请求。${reply.text || ''}`; this.event(t.result, 'error'); break; }
        if (!reply.toolCalls.length) {
          t.result = reply.text || '（模型没有返回内容）'; t.status = 'done'; this.event('本轮完成，可以继续发送消息', 'success'); break;
        }
        const results = [];
        for (const call of reply.toolCalls) {
          // Every tool call needs a result, even when skipped, or the conversation becomes invalid.
          if (this.stopping() || reply.stop === 'max_tokens') { results.push({ id: call.id, isError: true, text: reply.stop === 'max_tokens' ? '工具参数被截断（max_tokens），未执行。' : '未执行：用户暂停或停止了任务。' }); continue; }
          results.push(await this.runTool(call));
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
      this.event(answer, 'user');
      return { id: call.id, text: `用户回复：${answer}` };
    }

    const summary = describeCall(call.name, input);
    if (needsApproval(tool, input, t.autoInteract)) {
      const target = input.ref ? this.browser.refLabel(input.ref) : undefined;
      this.event(`等待确认：${summary}`, 'approval');
      const { command } = await this.gate('approval', { tool: call.name, summary, target, input: { ...input, code: input.code && clip(input.code, 2000) } });
      if (command === 'stop') return { id: call.id, isError: true, text: '任务已停止。' };
      if (command !== 'approve') {
        this.event('已拒绝该动作'); t.history.push({ tool: call.name, input, ok: false, error: 'rejected' });
        return { id: call.id, isError: true, text: '用户拒绝了这个动作。不要重试同一动作；换一种方法，或用 ask_user 询问用户。' };
      }
    }

    t.step++;
    this.event(summary, 'action', { tool: call.name });
    try {
      const out = await tool.run(input, { browser: this.browser });
      t.history.push({ tool: call.name, input, ok: true });
      return { id: call.id, text: out.text, image: out.image };
    } catch (error) {
      const message = error.message.split('\n')[0].slice(0, 600);
      this.event(`${call.name}: ${message}`, 'error'); t.history.push({ tool: call.name, input, ok: false, error: message });
      return { id: call.id, isError: true, text: message };
    }
  }

  async finish() {
    const t = this.task;
    if (t.status === 'stopping') { t.status = 'stopped'; this.event('任务已停止'); }
    // Keep the browser for follow-ups (also after a failure, so the user can steer it); demo sessions always close.
    if (t.status === 'stopped' || t.mode === 'demo') await this.closeBrowser();
  }
}
