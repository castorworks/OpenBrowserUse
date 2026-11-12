import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DATA_DIR } from './permissions/store.js';

// A SQLite transaction makes stale-owner replacement atomic across competing processes.
// The owner row survives crashes; a live PID is never stolen (including PID reuse).
export async function acquireRuntimeLock(dataDir = DEFAULT_DATA_DIR) {
  await mkdir(dataDir, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dataDir, 'runtime-lock.db'));
  const nonce = crypto.randomUUID();
  try {
    db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL); BEGIN IMMEDIATE;');
    const owner = db.prepare('SELECT * FROM owner WHERE id=1').get();
    if (owner) {
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw Object.assign(new Error(`数据目录已由后台进程 ${owner.pid} 使用。`), { code: 'OBU_RUNTIME_BUSY' });
    }
    db.prepare('INSERT OR REPLACE INTO owner VALUES(1,?,?)').run(process.pid, nonce);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
  let released = false;
  return () => { if (released) return; released = true; try { db.prepare('DELETE FROM owner WHERE id=1 AND nonce=?').run(nonce); } finally { db.close(); } };
}
