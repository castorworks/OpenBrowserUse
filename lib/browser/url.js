// Browser navigation has no application-level address restrictions.
export function allowedURL(raw) {
  return new URL(raw).href;
}
