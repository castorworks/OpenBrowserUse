// Shared conversation bookkeeping. Each provider keeps its own native message list;
// user-side content (tool results, notes, follow-ups) is buffered and sent with the next step.
export class Conversation {
  constructor() {
    this.messages = [];
    this.pending = [];        // blocks for the next user message
    this.unanswered = false;  // last user message was sent but never got an assistant reply (abort/refusal)
  }
  // Tool results must lead the user message; text goes after them.
  queue(blocks, { first = false } = {}) { this.pending = first ? [...blocks, ...this.pending] : [...this.pending, ...blocks]; }
  hasPending() { return this.pending.length > 0; }
  // Only an unanswered tail is ever edited; answered history stays append-only (prompt caching, preserved thinking).
  flush(wrap) {
    if (!this.pending.length) return;
    const last = this.messages.at(-1);
    if (this.unanswered && last?.role === 'user' && Array.isArray(last.content)) last.content.push(...this.pending);
    else this.messages.push(wrap(this.pending));
    this.pending = [];
  }
}

export function dataURLParts(url) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url || '');
  return m ? { mediaType: m[1], data: m[2] } : null;
}
