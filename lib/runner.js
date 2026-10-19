import { BrowserSession } from './browser.js';
import { decide } from './model.js';

const interaction = new Set(['click', 'fill', 'select', 'press']);
const terminal = new Set(['done', 'failed', 'stopped']);
export class Runner {
  constructor(origin, options = {}) { this.origin = origin; this.options = options; this.task = null; this.busy = false; }
  event(message, kind = 'info', extra = {}) {
    this.task.events.push({ time: new Date().toISOString(), kind, message, ...extra });
    if (this.task.events.length > 250) this.task.events.shift();
  }
  state() {
    if (!this.task) return null;
    const { controller, ...publicTask } = this.task;
    return publicTask;
  }
  start(input, config) {
    if (this.busy) throw new Error('已有任务正在执行，请先停止。');
    this.busy = true;
    this.task = { id: crypto.randomUUID(), goal: input.goal, mode: input.demo ? 'demo' : 'ai', status: 'starting', step: 0, maxSteps: input.maxSteps, events: [], history: [], snapshot: null, pending: null, result: '', autoInteract: input.autoInteract, controller: new AbortController() };
    this.promise = this.run(input, { ...config }).finally(() => { this.busy = false; });
    return this.state();
  }
  control(command, answer) {
    const t = this.task;
    if (!this.busy || !t || terminal.has(t.status)) throw new Error('没有正在执行的任务。');
    if (command === 'stop') {
      t.status = 'stopping'; t.controller.abort(); this.resolveGate?.('stop');
      void this.browser?.close();
    } else if (command === 'pause') {
      if (!['running', 'starting'].includes(t.status)) throw new Error('当前状态不能暂停。');
      t.status = 'pausing'; t.controller.abort(); this.event('正在暂停；已发出的浏览器操作可能需要完成。');
    } else if (command === 'resume' && ['paused', 'waiting_user'].includes(t.status)) {
      if (t.status === 'waiting_user' && !answer?.trim()) throw new Error('请填写补充信息或说明人工操作已完成。');
      if (answer?.trim()) t.history.push({ user: answer.trim().slice(0, 4000) });
      t.controller = new AbortController(); t.status = 'running'; this.resolveGate?.('resume');
    } else if (['approve', 'reject'].includes(command) && t.status === 'approval') {
      t.status = 'running'; this.resolveGate?.(command);
    } else throw new Error('操作与当前任务状态不匹配。');
  }
  async gate(status, pending = null) {
    this.task.status = status; this.task.pending = pending;
    const choice = await new Promise(resolve => { this.resolveGate = resolve; });
    this.resolveGate = null; this.task.pending = null;
    return choice;
  }
  async observe() { this.task.snapshot = await this.browser.snapshot(); }
  demoAction(snapshot) {
    const t = this.task;
    const find = label => snapshot.elements.find(e => e.label.includes(label))?.id;
    if (t.history.some(h => h.action?.type === 'click' && h.ok)) return { type: 'done', reason: '读取演示结果', result: `演示完成：真实浏览器已打开本地页面、填写关键词并点击搜索。\n\n${snapshot.text}\n\n这是固定脚本演示，尚未调用 AI。` };
    if (t.history.some(h => h.action?.type === 'fill' && h.ok)) return { type: 'click', element: find('搜索产品'), reason: '点击搜索，检查结果' };
    return { type: 'fill', element: find('产品关键词'), text: '键盘', reason: '在真实浏览器中输入关键词' };
  }
  async run(input, config) {
    const t = this.task;
    this.browser = new BrowserSession({ demoOrigin: this.origin, ...this.options });
    let errors = 0;
    try {
      this.event(input.demo ? '启动固定脚本演示（不调用 AI）' : '启动独立浏览器会话');
      await this.browser.open();
      if (t.status === 'stopping') return;
      await this.browser.execute({ type: 'navigate', url: input.demo ? `${this.origin}/demo` : input.startURL });
      await this.observe();
      if (t.status === 'starting') t.status = 'running';
      while (t.step < t.maxSteps && t.status !== 'stopping') {
        if (t.status === 'pausing') {
          this.event('已暂停。可在浏览器窗口操作，然后继续。');
          await this.gate('paused');
          if (t.status === 'stopping') break;
          await this.observe();
        }
        let action;
        try {
          action = input.demo ? this.demoAction(t.snapshot) : await decide(config, t.goal, t.snapshot, t.history, t.controller.signal);
          if (t.status === 'pausing' || t.status === 'stopping') continue;
          t.step++;
          if (action.type === 'done') {
            t.result = action.result; t.status = 'done'; this.event('任务完成', 'success'); break;
          }
          if (action.type === 'ask_user') {
            this.event(action.question, 'question');
            await this.gate('waiting_user', action);
            if (t.status === 'stopping') break;
            await this.observe(); continue;
          }
          if (interaction.has(action.type) && !input.autoInteract && !input.demo) {
            const target = t.snapshot.elements.find(e => e.id === action.element);
            this.event('等待确认页面交互', 'approval');
            const choice = await this.gate('approval', { ...action, target: target?.label || `元素 ${action.element}` });
            if (t.status === 'stopping') break;
            if (choice !== 'approve') {
              t.history.push({ action, ok: false, error: '用户拒绝此动作，请选择其他方案或询问用户。' });
              this.event('已拒绝该动作'); await this.observe(); continue;
            }
          }
          this.event(action.reason || action.type, 'action', { action: { type: action.type, element: action.element, url: action.url } });
          await this.browser.execute(action);
          t.history.push({ action, ok: true });
          await this.observe(); errors = 0;
        } catch (error) {
          if (t.status === 'stopping' || t.status === 'pausing') continue;
          errors++;
          const message = error.message.slice(0, 600);
          this.event(message, 'error'); t.history.push({ action, ok: false, error: message });
          if (errors >= 3) throw new Error('连续 3 次失败，任务已停止。请检查模型配置或更换任务。');
          await this.observe();
        }
      }
      if (!terminal.has(t.status) && t.status !== 'stopping') { t.status = 'failed'; t.result = `已达到 ${t.maxSteps} 步上限，任务未完成。`; this.event(t.result, 'error'); }
    } catch (error) {
      if (t.status !== 'stopping') { t.status = 'failed'; t.result = error.message.slice(0, 800); this.event(t.result, 'error'); }
    } finally {
      if (t.status === 'stopping') { t.status = 'stopped'; this.event('任务已停止'); }
      await this.browser.close();
    }
  }
}
