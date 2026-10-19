// Browser navigation has no application-level address restrictions.
export const DEFAULT_POLICY = { allowLocalhost: true, allowPrivateNetwork: true };

export function allowedURL(raw) {
  return new URL(raw).href;
}

export function localCDPURL(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) throw new Error('CDP 地址需要 HTTP(S) 或 WS(S) 协议。');
  return u.href.replace(/\/$/, '');
}
