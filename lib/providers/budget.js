// Retain the newest two images in native conversation storage as well as requests.
export function trimImages(messages, keep = 2) {
  let seen = 0;
  function visit(parts) {
    if (!Array.isArray(parts)) return;
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.type === 'image' || part.type === 'image_url') {
        if (++seen > keep) parts[i] = { type: 'text', text: '(较早的截图已省略)' };
      } else if (part.type === 'tool_result') visit(part.content);
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) visit(messages[i].content);
}
