import { z } from 'zod';
import { pageTools } from './page.js';
import { computerTool } from './computer.js';
import { navigationTools } from './navigation.js';
import { devTools } from './devtools.js';

export const askUserTool = {
  name: 'ask_user',
  description: 'Ask the user a question and wait for the answer. Use for missing information or when user assistance is needed to continue.',
  schema: z.object({ question: z.string().min(1).max(2000) }),
};

// Order is fixed so the tool list stays byte-identical across requests (prompt caching).
export const TOOLS = [...pageTools, computerTool, ...navigationTools, ...devTools, askUserTool];
const byName = new Map(TOOLS.map(t => [t.name, t]));
export const getTool = name => byName.get(name);

export function jsonSchema(tool) {
  const { $schema, ...schema } = z.toJSONSchema(tool.schema, { io: 'input' });
  return schema;
}

export function parseInput(tool, input) {
  const parsed = tool.schema.safeParse(input ?? {});
  if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`.slice(0, 600));
  return parsed.data;
}
