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
    this.endpoint = apiEndpoint(config.baseURL);
    this.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    this.messages = [{ role: 'system', content: system }];
    this.pendingTools = []; this.pendingUser = [];
  }

  addUserText(text) { this.pendingUser.push({ type: 'text', text }); }

  addToolResults(results) {
    for (const r of results) {
      this.pendingTools.push({ role: 'tool', tool_call_id: r.id, content: `${r.isError ? 'ERROR: ' : ''}${r.text || '(empty)'}` });
      if (!r.image) continue;
      if (this.config.vision) this.pendingUser.push({ type: 'text', text: `Image from tool call ${r.id}:` }, { type: 'image_url', image_url: { url: r.image } });
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
      return { ...m, content: m.content.map(part => (part.type === 'image_url' && ++seen > KEEP_IMAGES ? { type: 'text', text: '(较早的截图已省略)' } : part)) };
    }).reverse();
  }

  async step({ signal }) {
    this.flush();
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.config.model, messages: this.outgoing(), tools: this.tools, tool_choice: 'auto' }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    }).catch(error => { throw signal.aborted ? Object.assign(new Error('aborted'), { aborted: true }) : new Error(`无法连接模型接口：${error.message}`); });
    // Do not expose provider response bodies: some proxies echo credentials or page contents.
    if (!res.ok) throw new Error(`模型接口 HTTP ${res.status}。请检查地址、Key、模型名，以及服务是否支持 function calling。`);
    const data = await res.json().catch(() => null);
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error('模型接口返回格式无效（缺少 choices[0].message）。');
    const toolCalls = (message.tool_calls || []).map(c => {
      let input = null, parseError = null;
      try { input = JSON.parse(c.function?.arguments || '{}'); } catch { parseError = '参数不是有效 JSON'; }
      return { id: c.id, name: c.function?.name, input, parseError };
    });
    this.messages.push({ role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    return { stop: toolCalls.length ? 'tool_use' : (data.choices[0].finish_reason === 'length' ? 'max_tokens' : 'end_turn'), text, notes: [], toolCalls };
  }
}
