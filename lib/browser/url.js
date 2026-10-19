export function allowedURL(raw, demoOrigin) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('只允许 HTTP(S) 网页地址。');
  const h = u.hostname.toLowerCase();
  const local = h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '[::]' || h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('[fe80:') || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (local && !(u.origin === demoOrigin && u.pathname.startsWith('/demo'))) throw new Error('原型不允许访问本机和内网地址（内置演示除外）。');
  return u.href;
}
