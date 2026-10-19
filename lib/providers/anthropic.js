import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Conversation, dataURLParts } from './base.js';
import { REVIEWER_PROMPT, Verdict } from '../permissions/reviewer.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const DEFAULT_REVIEWER_MODEL = 'claude-haiku-5-5';
// Models that take adaptive thinking + effort; others get neither field.
const ADAPTIVE = /^claude-(fable-5|mythos-5|opus-5|sonnet-5|haiku-5-5|opus-4-[678]|sonnet-4-6)/;
// Between-tool progress notes, shown in the workbench as narration.
const UPDATES = /^claude-(fable-5|opus-5-5|sonnet-5-5)/;
// Server-side refusal fallback ("default" routing).
const FALLBACKS = /^claude-(fable-5-1|opus-5-5|opus-5$|sonnet-5-5)/;

export class AnthropicProvider {
  constructor(config, { system, tools }) {
    this.config = config;
    this.client = new Anthropic({ ...(config.apiKey ? { apiKey: config.apiKey } : {}), ...(config.baseURL ? { baseURL: config.baseURL } : {}), maxRetries: 2 });
    this.system = [{ type: 'text', text: system }];
    this.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    this.convo = new Conversation();
  }

  addUserText(text) { this.convo.queue([{ type: 'text', text }]); }

  addToolResults(results) {
    this.convo.queue(results.map(r => {
      const image = dataURLParts(r.image);
      return {
        type: 'tool_result', tool_use_id: r.id, ...(r.isError ? { is_error: true } : {}),
        content: [{ type: 'text', text: r.text || '(empty)' }, ...(image ? [{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }] : [])],
      };
    }), { first: true });
  }

  request() {
    const model = this.config.model || DEFAULT_ANTHROPIC_MODEL;
    const betas = [];
    const params = { model, max_tokens: 64000, system: this.system, tools: this.tools, messages: this.convo.messages, cache_control: { type: 'ephemeral' } };
    if (ADAPTIVE.test(model)) {
      params.output_config = { effort: this.config.effort || 'high' };
      params.thinking = { type: 'adaptive' };
      if (UPDATES.test(model)) { params.thinking.display = 'updates'; betas.push('thinking-display-updates-2026-08-18'); }
    }
    // Fallbacks are a first-party Claude API feature; skip them behind a custom base URL.
    if (FALLBACKS.test(model) && !this.config.baseURL) { params.fallbacks = 'default'; betas.push('server-side-fallback-2026-07-01'); }
    return { params, betas };
  }

  async step({ signal }) {
    this.convo.flush(blocks => ({ role: 'user', content: blocks }));
    this.convo.unanswered = true;
    const { params, betas } = this.request();
    let message;
    try {
      const stream = betas.length ? this.client.beta.messages.stream({ ...params, betas }, { signal }) : this.client.messages.stream(params, { signal });
      message = await stream.finalMessage();
    } catch (error) {
      throw describeError(error, signal);
    }
    const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const notes = message.content.filter(b => b.type === 'thinking' && b.thinking).map(b => b.thinking);
    if (message.stop_reason === 'refusal') {
      // A refusal can cut a tool call off mid-input: do not keep or run that turn.
      return { stop: 'refusal', text: message.stop_details?.explanation || text, notes, toolCalls: [] };
    }
    this.convo.messages.push({ role: 'assistant', content: message.content });
    this.convo.unanswered = false;
    const toolCalls = message.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input }));
    return { stop: message.stop_reason, text, notes, toolCalls, model: message.model, usage: message.usage };
  }

  // Auto-mode safety review: a separate small request, never part of the agent conversation.
  async review(input, signal) {
    const model = this.config.reviewerModel || (this.config.baseURL ? this.config.model || DEFAULT_ANTHROPIC_MODEL : DEFAULT_REVIEWER_MODEL);
    try {
      const response = await this.client.messages.parse({
        model, max_tokens: 4000, system: REVIEWER_PROMPT, messages: [{ role: 'user', content: input }],
        output_config: { format: zodOutputFormat(Verdict), ...(ADAPTIVE.test(model) ? { effort: 'low' } : {}) },
      }, { signal });
      if (response.stop_reason === 'refusal' || !response.parsed_output) return { decision: 'ask', reason: '审查模型没有给出结论，需要你确认。' };
      return response.parsed_output;
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      return { decision: 'ask', reason: `审查请求失败（${describeError(error).message.slice(0, 80)}），需要你确认。` };
    }
  }
}

function describeError(error, signal) {
  if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) return Object.assign(new Error('aborted'), { aborted: true });
  // Do not echo provider response bodies: proxies can reflect credentials or page contents.
  if (error instanceof Anthropic.AuthenticationError) return new Error('Anthropic 认证失败（HTTP 401）。请检查 API Key，或运行 ant auth login。');
  if (error instanceof Anthropic.PermissionDeniedError) return new Error('Anthropic 拒绝访问（HTTP 403）。请检查 Key 的权限和组织设置。');
  if (error instanceof Anthropic.NotFoundError) return new Error('模型或地址不存在（HTTP 404）。请检查模型名和 Base URL。');
  if (error instanceof Anthropic.RateLimitError) return new Error('触发限流（HTTP 429），SDK 已重试。请稍后再试。');
  if (error instanceof Anthropic.BadRequestError) return new Error('请求参数被拒绝（HTTP 400）。所选模型可能不支持思考、effort 或工具设置。');
  if (error instanceof Anthropic.APIConnectionError) return new Error('无法连接 Anthropic 接口。请检查网络或 Base URL。');
  if (error instanceof Anthropic.APIError) return new Error(`Anthropic 接口错误 HTTP ${error.status ?? '?'}。`);
  if (/api key|apiKey|authToken|credentials/i.test(error.message)) return new Error('没有找到 Anthropic 凭据。请在模型设置中填写 Key，设置 ANTHROPIC_API_KEY，或运行 ant auth login。');
  return error;
}
