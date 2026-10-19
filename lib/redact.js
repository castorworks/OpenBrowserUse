// Redact at presentation/storage boundaries; the model and browser retain original values.
const MASK = '[REDACTED]';
const labelled = /(?:password|passwd|api[_ -]?key|access[_ -]?token|密码|口令)\s*["'`]?\s*(?:[:：=]|是|为)\s*["'`“]?([^\s"'`”<>,，。;；]+)/gi;

export function redactTranscript(task) {
  const secrets = new Set(task._secrets || []);
  const learn = value => {
    if (typeof value === 'string') {
      if (value.startsWith('data:image/')) return;
      for (const match of value.matchAll(labelled)) if (match[1] !== MASK) secrets.add(match[1]);
    } else if (Array.isArray(value)) value.forEach(learn);
    else if (value && typeof value === 'object') Object.values(value).forEach(learn);
  };
  const { controller, _secrets, ...rest } = task;
  learn(rest);
  for (const h of task.history || []) if (h.sensitive) {
    const value = h.input?.value ?? h.input?.text;
    if (value != null && String(value)) secrets.add(String(value));
  }
  // Remember discoveries before a log entry is clipped or a follow-up replaces the result.
  if (task._secrets instanceof Set) for (const secret of secrets) task._secrets.add(secret);
  const values = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  const clean = value => {
    if (typeof value === 'string') {
      if (value.startsWith('data:image/')) return value;
      // JSON strings in tool cards may contain escaped copies of the same value.
      for (const secret of values) {
        if (secret.length < 3) {
          const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          value = value.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), MASK);
          continue;
        }
        value = value.split(JSON.stringify(secret).slice(1, -1)).join(MASK);
        value = value.split(secret).join(MASK);
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
      ['id', 'ref', 'tool', 'provider', 'status', 'state', 'kind', 'time', 'started', 'model', 'action'].includes(k) ? v :
        k === 'value' && typeof v === 'number' && secrets.has(String(v)) ? MASK : clean(v)]));
    return value;
  };
  return clean(rest);
}
