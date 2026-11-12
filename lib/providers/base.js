export function dataURLParts(url) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url || '');
  return m ? { mediaType: m[1], data: m[2] } : null;
}
