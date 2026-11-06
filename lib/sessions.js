import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactTranscript } from './redact.js';
import { DEFAULT_DATA_DIR } from './permissions/store.js';

// Node 22 marks node:sqlite experimental and prints a warning when it loads; hide only that one.
async function loadSQLite() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
    return emitWarning.call(this, warning, ...rest);
  };
  try { return await import('node:sqlite'); } finally { process.emitWarning = emitWarning; }
}

// Checkpointed task transcripts in <dataDir>/sessions.db (node:sqlite). Opened on first use.
// Screenshots are not stored; events, audit, results and tool history are.
export class SessionStore {
  constructor({ dir = process.env.OBU_DATA_DIR || DEFAULT_DATA_DIR } = {}) { this.dir = dir; this.cursors = new Map(); }

  async db() {
    if (!this.opening) this.opening = (async () => {
      const { DatabaseSync } = await loadSQLite();
      mkdirSync(this.dir, { recursive: true });
      this.handle = new DatabaseSync(join(this.dir, 'sessions.db'));
      this.handle.exec('PRAGMA secure_delete = ON');
      this.handle.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, goal TEXT, status TEXT, provider TEXT, started TEXT, updated TEXT, data TEXT)');
      this.handle.exec('CREATE TABLE IF NOT EXISTS session_items (session_id TEXT, kind TEXT, seq INTEGER, data TEXT, PRIMARY KEY(session_id, kind, seq))');
      this.handle.exec('CREATE TABLE IF NOT EXISTS session_memory (session_id TEXT, id TEXT, label TEXT, text TEXT, PRIMARY KEY(session_id, id))');
      this.handle.exec('CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated)');
      // Sanitize legacy transcripts too, without changing their original timestamps.
      this.handle.exec('BEGIN');
      try {
        const update = this.handle.prepare('UPDATE sessions SET goal = ?, data = ? WHERE id = ?');
        for (const row of this.handle.prepare('SELECT id, data FROM sessions').all()) {
          const safe = redactTranscript(JSON.parse(row.data));
          const data = JSON.stringify(safe);
          if (data !== row.data) update.run(safe.goal, data, row.id);
        }
        this.handle.exec('COMMIT');
      } catch (error) { this.handle.exec('ROLLBACK'); throw error; }
      return this.handle;
    })().catch(error => { this.handle?.close(); this.handle = null; this.opening = null; throw error; });
    return this.opening;
  }

  async save(task) {
    const db = await this.db();
    if (task.deleted) return;
    const previous = this.cursors.get(task.id) || {};
    const arrays = { events: task.events || [], history: task.history || [], audit: task.audit || [], userMessages: task.userMessages || [], requests: task.metrics?.requests || [], tools: task.metrics?.tools || [] };
    // Learn credentials from new data before serializing any checkpoint or delta.
    redactTranscript({ _secrets: task._secrets, history: arrays.history.slice(previous.history || 0), userMessages: arrays.userMessages.slice(previous.userMessages || 0), events: arrays.events.slice(Math.max(0, (previous.events || 0) - 400)), progress: task.progress, result: task.result });
    const changedSecrets = previous.secrets !== task._secrets?.size;
    const { events, history, audit, userMessages, metrics, snapshot, ...metadata } = task;
    const safe = redactTranscript({ ...metadata, _secrets: task._secrets, metrics: { retries: metrics?.retries || 0 }, snapshot: snapshot ? { url: snapshot.url, title: snapshot.title } : null, incremental: true });
    db.exec('BEGIN');
    try {
      const write = db.prepare('INSERT INTO session_items VALUES (?, ?, ?, ?) ON CONFLICT(session_id, kind, seq) DO UPDATE SET data = excluded.data WHERE session_items.data != excluded.data');
      for (const [kind, items] of Object.entries(arrays)) {
        // Cards can finish after additional user events; revisit the live display window.
        const start = changedSecrets ? 0 : Math.max(0, (previous[kind] || 0) - (kind === 'events' ? 400 : 0));
        const cleaned = redactTranscript({ _secrets: task._secrets, [kind]: items.slice(start) })[kind];
        for (let i = 0; i < cleaned.length; i++) write.run(task.id, kind, start + i, JSON.stringify(cleaned[i]));
      }
      if (changedSecrets) {
        const update = db.prepare('UPDATE session_memory SET text = ? WHERE session_id = ? AND id = ?');
        for (const row of db.prepare('SELECT id, text FROM session_memory WHERE session_id = ?').all(task.id)) update.run(redactTranscript({ _secrets: task._secrets, text: row.text }).text, task.id, row.id);
      }
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET goal=excluded.goal, status=excluded.status, updated=excluded.updated, data=excluded.data`)
        .run(task.id, safe.goal, task.status, task.provider, task.events[0]?.time || now, now, JSON.stringify(safe));
      db.exec('COMMIT');
      this.cursors.set(task.id, { ...Object.fromEntries(Object.entries(arrays).map(([k,v]) => [k,v.length])), secrets: task._secrets?.size });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  async putMemory(task, text, label) {
    const id = crypto.randomUUID();
    const safe = redactTranscript({ _secrets: task._secrets, text }).text;
    const db = await this.db();
    if (task.deleted) throw new Error('会话已删除，无法存档资料。');
    db.prepare('INSERT INTO session_memory VALUES (?, ?, ?, ?)').run(task.id, id, label, safe);
    return id;
  }

  async readMemory(sessionId, { id, offset = 0, length = 6000, query = '' }) {
    const db = await this.db();
    if (!id) return JSON.stringify(db.prepare('SELECT id, label, length(text) AS size FROM session_memory WHERE session_id = ? ORDER BY rowid DESC LIMIT 100 OFFSET ?').all(sessionId, offset));
    const row = db.prepare('SELECT text FROM session_memory WHERE session_id = ? AND id = ?').get(sessionId, id);
    if (!row) return '资料不存在。';
    if (query) { const found = row.text.indexOf(query, offset); if (found < 0) return '未找到。'; offset = Math.max(0, found - 200); }
    return JSON.stringify({ id, offset, total: row.text.length, next: offset + length < row.text.length ? offset + length : null, text: row.text.slice(offset, offset + length) });
  }

  async page(id, offset = 0, limit = 100) {
    const db = await this.db();
    const row = db.prepare('SELECT data FROM sessions WHERE id = ?').get(id);
    if (!row) return null;
    const data = JSON.parse(row.data);
    const total = data.incremental ? db.prepare("SELECT count(*) AS n FROM session_items WHERE session_id = ? AND kind = 'events'").get(id).n : (data.events || []).length;
    const events = data.incremental ? db.prepare("SELECT data FROM session_items WHERE session_id = ? AND kind = 'events' ORDER BY seq LIMIT ? OFFSET ?").all(id, limit, offset).map(x => JSON.parse(x.data)) : data.events.slice(offset, offset + limit);
    return { ...data, events, totalEvents: total, nextOffset: offset + events.length < total ? offset + events.length : null };
  }

  async list(limit = 50) {
    return (await this.db()).prepare('SELECT id, goal, status, provider, started, updated FROM sessions ORDER BY updated DESC LIMIT ?').all(limit).map(r => ({ ...r }));
  }

  async get(id, { includeMemory = false } = {}) {
    const row = (await this.db()).prepare('SELECT data FROM sessions WHERE id = ?').get(id);
    if (!row) return null;
    const task = JSON.parse(row.data);
    if (task.incremental) {
      for (const kind of ['events', 'history', 'audit', 'userMessages', 'requests', 'tools']) {
        const items = (await this.db()).prepare('SELECT data FROM session_items WHERE session_id = ? AND kind = ? ORDER BY seq').all(id, kind).map(x => JSON.parse(x.data));
        if (['requests', 'tools'].includes(kind)) task.metrics[kind] = items; else task[kind] = items;
      }
    }
    if (includeMemory) task.archives = (await this.db()).prepare('SELECT id, label, text FROM session_memory WHERE session_id = ? ORDER BY rowid').all(id);
    return task;
  }

  async remove(id) { const db = await this.db(); db.exec('BEGIN'); try { for (const table of ['session_items', 'session_memory']) db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id); db.prepare('DELETE FROM sessions WHERE id = ?').run(id); db.exec('COMMIT'); this.cursors.delete(id); } catch (error) { db.exec('ROLLBACK'); throw error; } }

  close() { this.cursors.clear(); this.handle?.close(); this.handle = null; this.opening = null; }
}
