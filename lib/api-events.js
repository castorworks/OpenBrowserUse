import { redactTranscript } from './redact.js';

// Durable per-run log. Notifications are deferred until the synchronous transaction
// has committed; subscribers always query committed rows, never notification payloads.
export class RunEvents {
  constructor(db) {
    this.db = db; this.listeners = new Map(); this.streams = new Set(); this.pending = new Set();
    db.exec('CREATE TABLE IF NOT EXISTS api_events (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,sequence));');
  }
  append(runId, type, data) {
    const seq = this.last(runId) + 1;
    let truncated = false;
    const clip = value => {
      if (typeof value === 'string' && value.length > 16000) { truncated = true; return value.slice(0, 16000); }
      if (Array.isArray(value)) return value.map(clip);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]));
      return value;
    };
    const safe = clip(redactTranscript({ data }).data);
    const event = { id: `${runId}:${seq}`, run_id: runId, sequence: seq, type, created_at: new Date().toISOString(), data: safe, ...(truncated ? { truncated: true } : {}) };
    this.db.prepare('INSERT INTO api_events VALUES(?,?,?)').run(runId, seq, JSON.stringify(event));
    this.notify(runId); return event;
  }
  last(id) { return this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM api_events WHERE run_id=?').get(id).n; }
  page(id, after = 0, limit = 100) { return this.db.prepare('SELECT data FROM api_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id, after, limit).map(x => JSON.parse(x.data)); }
  notify(id) {
    if (this.pending.has(id)) return;
    this.pending.add(id);
    queueMicrotask(() => { this.pending.delete(id); for (const fn of this.listeners.get(id) || []) fn(); });
  }
  remove(id) { this.db.prepare('DELETE FROM api_events WHERE run_id=?').run(id); this.notify(id); }
  stream(req, res, id, after, exists, terminal) {
    let cursor = after, blocked = false, closed = false, heartbeat;
    const cleanup = () => {
      if (closed) return; closed = true;
      clearInterval(heartbeat); res.off('drain', drain);
      this.listeners.get(id)?.delete(pump);
      if (!this.listeners.get(id)?.size) this.listeners.delete(id);
      this.streams.delete(end);
    };
    const end = () => { cleanup(); res.end(); };
    const pump = () => {
      if (closed || blocked) return;
      if (!exists()) { end(); return; }
      // Bound each pass; drain resumes from the last enqueued ID. A reconnect starts
      // from the client's last processed ID, giving at-least-once delivery.
      const rows = this.page(id, cursor, 100);
      for (const row of rows) {
        const accepted = res.write(`id: ${row.id}\nevent: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`);
        cursor = row.sequence;
        if (res.writableLength > 1024 * 1024) { cleanup(); res.destroy(); return; }
        if (!accepted) { blocked = true; return; }
      }
      if (cursor < this.last(id)) { setImmediate(pump); return; }
      if (terminal()) end();
    };
    const drain = () => { blocked = false; pump(); };
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(pump); this.streams.add(end);
    res.on('close', cleanup); res.on('drain', drain);
    heartbeat = setInterval(() => { if (!blocked && !closed && !res.write(': heartbeat\n\n')) blocked = true; }, 15000);
    heartbeat.unref(); pump();
  }
  close() { for (const end of [...this.streams]) end(); this.listeners.clear(); }
}
