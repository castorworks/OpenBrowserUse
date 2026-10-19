import { z } from 'zod';

const quote = s => JSON.stringify(s);
function formatAttrs(attrs) {
  return Object.entries(attrs).filter(([, v]) => v !== undefined && v !== '' && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}=${Array.isArray(v) ? `[${v.map(quote).join(', ')}]` : quote(String(v))}`)).join(' ');
}

export function formatTree(sections, maxChars) {
  const lines = [];
  for (const s of sections) {
    if (!s.nodes.length && !s.main) continue;
    lines.push(s.main ? `# ${s.title || '(untitled)'} — ${s.url}` : `# iframe — ${s.url}`);
    for (const n of s.nodes) {
      const attrs = formatAttrs(n.attrs);
      lines.push(`${'  '.repeat(n.d)}- ${n.role}${n.name ? ` ${quote(n.name)}` : ''}${n.ref ? ` [${n.ref}]` : ''}${attrs ? ` ${attrs}` : ''}`);
    }
    if (s.truncated) lines.push('… (节点过多，已截断；可用 find 缩小范围)');
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (已截断，共 ${text.length} 字符；可用 find 或 filter=interactive)` : text;
}

export const pageTools = [
  {
    name: 'read_page',
    description: 'Read the active tab as an accessibility tree. Every interactive element has a ref like ref_12 that other tools accept. Refs stay valid until the element leaves the page. filter=interactive (default) lists controls only; filter=all also includes headings, text and landmarks. Includes iframes and open shadow DOM.',
    schema: z.object({ filter: z.enum(['interactive', 'all']).default('interactive'), max_chars: z.number().int().min(1000).max(60000).default(20000) }),
    async run({ filter, max_chars }, { browser }) {
      return { text: formatTree(await browser.readTree({ filter }), max_chars) };
    },
  },
  {
    name: 'find',
    description: 'Search the active tab for elements matching a short description (e.g. "search box", "add to cart button"). Returns the best matches with refs. Cheaper than read_page on large pages.',
    schema: z.object({ query: z.string().min(1).max(300) }),
    async run({ query }, { browser }) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = [];
      for (const s of await browser.readTree({ filter: 'all' })) {
        for (const n of s.nodes) {
          if (!n.ref && n.role !== 'heading') continue;
          const hay = `${n.role} ${n.name} ${formatAttrs(n.attrs)}`.toLowerCase();
          let score = hay.includes(query.toLowerCase()) ? 5 : 0;
          for (const t of terms) if (hay.includes(t)) score += 1;
          if (score) scored.push({ score, line: `- ${n.role} ${quote(n.name)}${n.ref ? ` [${n.ref}]` : ''} ${formatAttrs(n.attrs)}`.trim() });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return { text: scored.length ? scored.slice(0, 20).map(s => s.line).join('\n') : `没有找到与 ${quote(query)} 匹配的元素。试试 read_page 或截图。` };
    },
  },
  {
    name: 'get_page_text',
    description: 'Return the visible text of the active tab (main/article content first, otherwise the whole body). Use for reading and summarising, not for finding controls.',
    schema: z.object({ max_chars: z.number().int().min(500).max(100000).default(20000) }),
    async run({ max_chars }, { browser }) {
      const page = browser.current();
      const text = await page.evaluate(() => (document.querySelector('main, article, [role="main"]') || document.body)?.innerText || '');
      return { text: `${await page.title()} — ${page.url()}\n\n${text.length > max_chars ? `${text.slice(0, max_chars)}\n… (已截断，共 ${text.length} 字符)` : text}` };
    },
  },
];
