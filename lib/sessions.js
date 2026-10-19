import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactTranscript } from './redact.js';
import { DEFAULT_DATA_DIR } from './permissions/store.js';

// Checkpointed task transcripts in <dataDir>/sessions.db (node:sqlite). Opened on first use.
// Screenshots are not stored; events, audit, results and tool history are.
export class SessionStore {
  constructor({ dir = process.env.OBU_DATA_DIR || DEFAULT_DATA_DIR } = {}) { this.dir = dir; }

  async db() {
    if (!this.opening) this.opening = (async () => {
      const { DatabaseSync } = await import('node:sqlite');
      mkdirSync(this.dir, { recursive: true });
      this.handle = new DatabaseSync(join(this.dir, 'sessions.db'));
      this.handle.exec('PRAGMA secure_delete = ON');
      this.handle.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, goal TEXT, status TEXT, provider TEXT, started TEXT, updated TEXT, data TEXT)');
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
    const { snapshot, ...rest } = redactTranscript(task);
    const data = JSON.stringify({ ...rest, snapshot: snapshot ? { url: snapshot.url, title: snapshot.title } : null });
    const started = task.events[0]?.time || new Date().toISOString();
    const db = await this.db();
    if (task.deleted) return;
    db.prepare(`INSERT INTO sessions (id, goal, status, provider, started, updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET goal = excluded.goal, status = excluded.status, updated = excluded.updated, data = excluded.data`)
      .run(task.id, rest.goal, task.status, task.provider, started, new Date().toISOString(), data);
  }

  async list(limit = 50) {
    return (await this.db()).prepare('SELECT id, goal, status, provider, started, updated FROM sessions ORDER BY updated DESC LIMIT ?').all(limit).map(r => ({ ...r }));
  }

  async get(id) {
    const row = (await this.db()).prepare('SELECT data FROM sessions WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }

  async remove(id) { (await this.db()).prepare('DELETE FROM sessions WHERE id = ?').run(id); }

  close() { this.handle?.close(); this.handle = null; this.opening = null; }
}
