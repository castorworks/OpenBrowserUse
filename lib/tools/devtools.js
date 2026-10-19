import { z } from 'zod';

const match = (pattern, ...fields) => !pattern || fields.some(f => String(f ?? '').toLowerCase().includes(pattern.toLowerCase()));

export const devTools = [
  {
    name: 'read_console_messages',
    description: 'Recent console output and uncaught errors from the active tab (most recent last).',
    schema: z.object({ only_errors: z.boolean().default(false), pattern: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).default(50) }),
    async run({ only_errors, pattern, limit }, { browser }) {
      const items = browser.log().console.filter(m => (!only_errors || m.type === 'error') && match(pattern, m.text)).slice(-limit);
      return { text: items.length ? items.map(m => `[${m.type}] ${m.text}`).join('\n') : '没有匹配的控制台消息。' };
    },
  },
  {
    name: 'read_network_requests',
    description: 'Recent network requests from the active tab with method, status and resource type (most recent last).',
    schema: z.object({ pattern: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).default(50) }),
    async run({ pattern, limit }, { browser }) {
      const items = browser.log().network.filter(r => match(pattern, r.url)).slice(-limit);
      return { text: items.length ? items.map(r => `${r.method} ${r.status ?? r.failure ?? '-'} ${r.type} ${r.url}`).join('\n') : '没有匹配的网络请求。' };
    },
  },
  {
    name: 'javascript',
    description: 'Run JavaScript in the active tab as the body of an async function; use `return` to send back a JSON-serialisable value. Use for inspection or interaction when needed.',
    schema: z.object({ code: z.string().min(1).max(20000) }),
    mutating: () => true,
    async run({ code }, { browser }) {
      const value = await browser.current().evaluate(`(async () => { ${code}\n})()`);
      const text = value === undefined ? 'undefined' : JSON.stringify(value, null, 1);
      return { text: text.length > 20000 ? `${text.slice(0, 20000)}… (已截断)` : text };
    },
  },
];
