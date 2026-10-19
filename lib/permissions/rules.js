// Deterministic checks that run before any reviewer model: they never depend on model judgement.

// Banks, brokerages, payment and crypto exchanges: the agent may read but never act there.
export const DEFAULT_BLOCKED_SITES = [
  'paypal.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'hsbc.com', 'capitalone.com', 'americanexpress.com',
  'schwab.com', 'fidelity.com', 'vanguard.com', 'robinhood.com', 'etrade.com', 'interactivebrokers.com',
  'coinbase.com', 'binance.com', 'kraken.com', 'okx.com', 'alipay.com', 'icbc.com.cn', 'ccb.com', 'boc.cn', 'abchina.com', 'cmbchina.com',
];

export function isBlockedSite(site, blocked = DEFAULT_BLOCKED_SITES) {
  if (!site) return false;
  const host = site.replace(/:\d+$/, '');
  return blocked.some(b => host === b || host.endsWith(`.${b}`));
}

const CONSEQUENTIAL = /\b(buy|purchase|pay|checkout|check out|place order|order now|subscribe|send|submit|post|publish|delete|remove|transfer|withdraw|confirm|sign up|unsubscribe)\b|购买|支付|付款|下单|结算|订阅|发送|提交|发布|删除|移除|转账|提现|确认|注册/i;
const PAYMENT_FIELD = /^cc-|card|cvv|cvc|iban|account.?number|routing/i;

// target: what the action touches (see BrowserSession.describeTarget). Returns null when no rule applies.
export function ruleDecision({ tool, input, target }) {
  if (target?.password || target?.file) return { type: 'block', reason: '密码和文件上传必须由用户本人操作。' };
  const typing = tool === 'form_input' || (tool === 'computer' && input.action === 'type');
  if (typing && target && PAYMENT_FIELD.test(`${target.autocomplete || ''} ${target.name || ''} ${target.id || ''}`)) return { type: 'block', reason: '支付信息字段必须由用户本人填写。' };
  const submitting = target?.submit || (tool === 'computer' && input.action === 'key' && /enter/i.test(input.text || '') && target?.inForm);
  if (submitting && target?.crossOriginForm) return { type: 'ask', reason: `表单会提交到其他网站（${target.formOrigin}）。` };
  if (target?.label && CONSEQUENTIAL.test(target.label) && (tool === 'computer' || submitting)) return { type: 'ask', reason: `“${target.label.slice(0, 60)}”可能是有后果的操作。` };
  return null;
}
