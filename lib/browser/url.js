// Browser navigation has no application-level address restrictions.
export const DEFAULT_POLICY = { allowLocalhost: true, allowPrivateNetwork: true };

export function allowedURL(raw) {
  return new URL(raw).href;
}
