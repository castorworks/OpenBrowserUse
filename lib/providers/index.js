import { OpenAIProvider } from './openai.js';
import { DemoProvider } from './demo.js';
import { TOOLS, jsonSchema } from '../tools/index.js';
import { SYSTEM_PROMPT } from '../prompt.js';

const toolDefs = TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: jsonSchema(t) }));

export function createProvider(config, { demo = false } = {}) {
  if (demo) return new DemoProvider();
  const options = { system: SYSTEM_PROMPT, tools: toolDefs };
  // DeepSeek and other OpenAI-compatible services share one provider.
  if (!['openai', 'deepseek'].includes(config.provider)) throw new Error('不支持此模型协议，请配置 OpenAI 兼容服务或 DeepSeek。');
  if (!config.model) throw new Error('请先配置模型名称、Base URL 和 API Key。');
  return new OpenAIProvider(config, options);
}
