import { siteOf } from './store.js';
import { isBlockedSite, ruleDecision } from './rules.js';
import { reviewerInput } from './reviewer.js';

export const MODES = ['ask', 'auto', 'skip'];

// Tools that open a new site: the first visit needs the site to be allowed.
function navigationTarget(tool, input) {
  if (tool.name === 'navigate' && !['back', 'forward'].includes(input.url)) return /^[a-z]+:\/\//i.test(input.url) ? input.url : `https://${input.url}`;
  if (tool.name === 'tabs' && input.action === 'new' && input.url) return input.url;
  return null;
}

/**
 * Decide whether a tool call runs, needs the user, or is refused.
 * Order: hard blocks (blocklist, denied site, rules) → mode → site approval → reviewer (auto only).
 * Returns { action: 'run' | 'ask' | 'block', reason, source, site, needsSite, target }.
 */
export async function authorize({ mode, tool, input, browser, store, taskSites, blockedSites, review, userMessages, summary }) {
  const navUrl = navigationTarget(tool, input);
  const mutating = Boolean(tool.alwaysAsk || tool.mutating?.(input));
  if (!navUrl && !mutating) return { action: 'run', source: 'read' };

  const site = siteOf(navUrl || browser.current().url());
  const granted = store.get(site);
  if (granted === 'deny') return { action: 'block', source: 'site', site, reason: `你已禁止代理在 ${site} 上操作。` };
  const siteOk = mode === 'skip' || granted === 'allow' || taskSites.has(site);

  if (navUrl) return siteOk ? { action: 'run', source: granted === 'allow' ? 'grant' : 'mode', site } : { action: 'ask', source: 'site', site, needsSite: true, reason: `首次访问 ${site}。` };

  if (isBlockedSite(site, blockedSites)) return { action: 'block', source: 'blocklist', site, reason: `${site} 属于受保护类别（银行、证券、支付或加密货币），代理只能阅读，不能操作。` };
  const target = await browser.describeTarget(tool.name, input);
  const rule = ruleDecision({ tool: tool.name, input, target });
  if (rule?.type === 'block') return { action: 'block', source: 'rule', site, target, reason: rule.reason };
  const base = { site, target, needsSite: !siteOk };
  if (tool.alwaysAsk) return { action: 'ask', source: 'tool', reason: '执行脚本始终需要确认。', ...base };
  if (mode === 'skip') return { action: 'run', source: 'mode', site, target };
  if (mode === 'ask') return { action: 'ask', source: rule ? 'rule' : 'mode', reason: rule?.reason || (siteOk ? '' : `首次在 ${site} 上操作。`), ...base };

  // auto
  if (rule?.type === 'ask') return { action: 'ask', source: 'rule', reason: rule.reason, ...base };
  if (!siteOk) return { action: 'ask', source: 'site', reason: `首次在 ${site} 上操作。`, ...base };
  const verdict = await review(reviewerInput({ userMessages, site, url: target.url, summary, target }));
  if (verdict.decision === 'block') return { action: 'block', source: 'reviewer', site, target, reason: verdict.reason };
  if (verdict.decision === 'ask') return { action: 'ask', source: 'reviewer', reason: verdict.reason, ...base };
  return { action: 'run', source: 'reviewer', site, target, reason: verdict.reason };
}
