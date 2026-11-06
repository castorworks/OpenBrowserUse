import { ContextManager } from './context.js';
import { trimImages } from './budget.js';
import { REVIEWER_PROMPT, parseVerdict } from '../permissions/reviewer.js';

const KEEP_IMAGES = 2;

export function apiEndpoint(baseURL) {
  const u = new URL(baseURL);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Base URL 必须是无账号、查询参数的 HTTP(S) 地址。');
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('远程模型服务请使用 HTTPS。');
  return u.href.replace(/\/$/, '') + '/chat/completions';
}

// OpenAI-compatible Chat Completions with function calling. Images from tools are sent as a
// follow-up user message (tool messages are text-only on most services) and only the latest few are kept.
export class OpenAIProvider {
  constructor(config, { system, tools }) {
    this.config = config;
    this.context = new ContextManager(config);
    this.endpoint = apiEndpoint(config.baseURL);
    this.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    this.messages = [{ role: 'system', content: system }];
    this.pendingTools = []; this.pendingUser = [];
  }

  addUserText(text) { this.pendingUser.push({ type: 'text', text }); }

  // DeepSeek takes reasoning_effort low | high | max; other services get no extra fields.
  extraParams() {
    if (this.config.provider !== 'deepseek') return {};
    const effort = { low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max' }[this.config.effort] || 'high';
    return { reasoning_effort: effort };
  }

  addToolResults(results) {
    for (const r of results) {
      this.pendingTools.push({ role: 'tool', tool_call_id: r.id, content: `${r.isError ? 'ERROR: ' : ''}${r.text || '(empty)'}` });
      if (!r.image) continue;
      if (this.config.vision ?? (this.config.provider === 'deepseek')) this.pendingUser.push({ type: 'text', text: `Image from tool call ${r.id}:` }, { type: 'image_url', image_url: { url: r.image, ...(this.config.provider === 'deepseek' ? { detail: 'original' } : {}) } });
      else this.pendingTools.at(-1).content += '\n(截图未发送：模型设置未开启视觉。请改用 read_page / get_page_text。)';
    }
  }

  flush() {
    this.messages.push(...this.pendingTools);
    if (this.pendingUser.length) this.messages.push({ role: 'user', content: this.pendingUser });
    this.pendingTools = []; this.pendingUser = [];
  }

  // Copy with all but the latest images replaced by a placeholder, to bound request size.
  outgoing() {
    let seen = 0;
    return [...this.messages].reverse().map(m => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return m;
      return { ...m, content: [...m.content].reverse().map(part => (part.type === 'image_url' && ++seen > KEEP_IMAGES ? { type: 'text', text: '(较早的截图已省略)' } : part)).reverse() };
    }).reverse();
  }

  async step({ signal }) {
    this.flush();
    trimImages(this.messages);
    await this.context.prepare(this.messages, { tools: this.tools }, signal);
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.config.model, messages: this.outgoing(), tools: this.tools, tool_choice: 'auto', max_tokens: this.context.reserve, ...this.extraParams() }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    }).catch(error => { throw signal.aborted ? Object.assign(new Error('aborted'), { aborted: true }) : new Error(`无法连接模型接口：${error.message}`); });
    // Do not expose provider response bodies: some proxies echo credentials or page contents.
    if (!res.ok) throw Object.assign(new Error(`模型接口 HTTP ${res.status}。`), { nonRetryable: res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status), retryAfterMs: Math.min(60000, Math.max(0, Number(res.headers?.get('retry-after')) * 1000 || 0)) });
    const data = await res.json().catch(() => null);
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error('模型接口返回格式无效（缺少 choices[0].message）。');
    const toolCalls = (message.tool_calls || []).map(c => {
      let input = null, parseError = null;
      try { input = JSON.parse(c.function?.arguments || '{}'); } catch { parseError = '参数不是有效 JSON'; }
      return { id: c.id, name: c.function?.name, input, parseError };
    });
    // Thinking models (DeepSeek) return reasoning_content; with tools it must be sent back on every later request.
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : null;
    this.messages.push({ role: 'assistant', content: message.content ?? null, ...(reasoning != null ? { reasoning_content: reasoning } : {}), ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    const notes = reasoning?.trim() ? [reasoning.trim().length > 1200 ? `${reasoning.trim().slice(0, 1199)}…` : reasoning.trim()] : [];
    return { stop: data.choices[0].finish_reason === 'length' ? 'max_tokens' : (toolCalls.length ? 'tool_use' : 'end_turn'), text, notes, toolCalls, model: data.model, usage: data.usage };
  }

  async summarize(text, signal) {
    const res = await fetch(this.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.config.model, messages: [{ role: 'user', content: text }], max_tokens: 4000 }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    });
    if (!res.ok) throw new Error('摘要请求失败');
    const result = (await res.json()).choices?.[0]?.message?.content;
    if (!result) throw new Error('摘要为空');
    return result;
  }

  // Auto-mode safety review with the same model; failures fall back to asking the user.
  async review(input, signal) {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.config.reviewerModel || this.config.model, messages: [{ role: 'system', content: REVIEWER_PROMPT }, { role: 'user', content: input }] }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      });
      if (!res.ok) return { decision: 'ask', reason: `审查请求失败（HTTP ${res.status}），需要你确认。` };
      return parseVerdict((await res.json())?.choices?.[0]?.message?.content);
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      return { decision: 'ask', reason: '审查请求失败，需要你确认。' };
    }
  }
}
