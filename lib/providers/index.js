import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { DemoProvider } from './demo.js';
import { TOOLS, jsonSchema } from '../tools/index.js';
import { SYSTEM_PROMPT } from '../prompt.js';

const toolDefs = TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: jsonSchema(t) }));

export function createProvider(config, { demo = false } = {}) {
  if (demo) return new DemoProvider();
  const options = { system: SYSTEM_PROMPT, tools: toolDefs };
  return config.provider === 'openai' ? new OpenAIProvider(config, options) : new AnthropicProvider(config, options);
}
