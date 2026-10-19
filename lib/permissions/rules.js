// Deterministic checks that run before any reviewer model: they never depend on model judgement.

// Optional site restrictions start empty and apply only in ask/auto modes.
export const DEFAULT_BLOCKED_SITES = [];

export function isBlockedSite(site, blocked = DEFAULT_BLOCKED_SITES) {
  if (!site) return false;
  const host = site.replace(/:\d+$/, '');
  return blocked.some(b => host === b || host.endsWith(`.${b}`));
}

const CONSEQUENTIAL = /\b(buy|purchase|pay|checkout|check out|place order|order now|subscribe|send|submit|post|publish|delete|remove|transfer|withdraw|confirm|sign up|unsubscribe)\b|购买|支付|付款|下单|结算|订阅|发送|提交|发布|删除|移除|转账|提现|确认|注册/i;

// target: what the action touches (see BrowserSession.describeTarget). Returns null when no rule applies.
export function ruleDecision({ tool, input, target }) {
  const submitting = target?.submit || (tool === 'computer' && input.action === 'key' && /enter/i.test(input.text || '') && target?.inForm);
  if (submitting && target?.crossOriginForm) return { type: 'ask', reason: `表单会提交到其他网站（${target.formOrigin}）。` };
  if (target?.label && CONSEQUENTIAL.test(target.label) && (tool === 'computer' || submitting)) return { type: 'ask', reason: `“${target.label.slice(0, 60)}”可能是有后果的操作。` };
  return null;
}
