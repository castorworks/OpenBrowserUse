// Which addresses the agent browser may load. The workbench's own port is never reachable
// (except the built-in /demo pages); localhost and LAN access are separate settings.
export const DEFAULT_POLICY = { allowLocalhost: true, allowPrivateNetwork: false };

const isLoopback = h => h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '[::]' || h === '0.0.0.0' || /^127\./.test(h) || /^0\./.test(h);
const isPrivate = h => /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('[fe80:');
const portOf = u => u.port || (u.protocol === 'https:' ? '443' : '80');

export function allowedURL(raw, demoOrigin, policy = DEFAULT_POLICY) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('只允许 HTTP(S) 网页地址。');
  const h = u.hostname.toLowerCase();
  if (isLoopback(h)) {
    const workbench = demoOrigin && portOf(u) === portOf(new URL(demoOrigin));
    if (workbench) {
      if (u.origin === demoOrigin && u.pathname.startsWith('/demo')) return u.href;
      throw new Error('不允许访问工作台自身的地址。');
    }
    if (!policy.allowLocalhost) throw new Error('未允许访问本机地址（localhost）。可在模型设置的浏览器选项中开启。');
  } else if (isPrivate(h) && !policy.allowPrivateNetwork) throw new Error('未允许访问内网地址。可在浏览器选项中开启“允许内网地址”。');
  return u.href;
}

// The CDP endpoint must be on this machine: attaching to a remote browser would hand it our session.
export function localCDPURL(raw) {
  const u = new URL(raw);
  if (!['http:', 'ws:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || !u.port) throw new Error('CDP 地址必须是本机地址，例如 http://127.0.0.1:9222。');
  return u.href.replace(/\/$/, '');
}
