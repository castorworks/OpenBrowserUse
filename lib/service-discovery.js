import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DATA_DIR } from './permissions/store.js';
import { localServiceURL } from './service-client.js';

const filename = dir => join(dir || DEFAULT_DATA_DIR, 'runtime-service.json');

// Published only after listening, while holding the data-directory runtime lock.
// Credentials stay in the local user's data directory and never reach the renderer.
export async function publishService({ dataDir, host, port, token }) {
  const localHost = { '::': '[::1]', '::1': '[::1]', '0.0.0.0': '127.0.0.1', '127.0.0.1': '127.0.0.1', localhost: 'localhost' }[host];
  if (!localHost) return () => Promise.resolve();
  const file = filename(dataDir), nonce = randomUUID(), temp = `${file}.${nonce}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ version: 1, pid: process.pid, nonce, url: `http://${localHost}:${port}`, token }), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
  return async () => {
    try {
      const current = JSON.parse(await readFile(file, 'utf8'));
      if (current.nonce === nonce) await rm(file, { force: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

export async function discoverService(dataDir) {
  let record;
  try { record = JSON.parse(await readFile(filename(dataDir), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('无法读取本机服务记录，请检查数据目录中的 runtime-service.json。');
  }
  if (record.version !== 1 || !Number.isInteger(record.pid) || record.pid < 1 || typeof record.token !== 'string' || record.token.length < 32 || /\s/.test(record.token)) throw new Error('本机服务记录无效，请重启独立服务。');
  const url = localServiceURL(record.url);
  try { process.kill(record.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return null; throw new Error('无法确认本机服务进程状态。'); }
  return { url, token: record.token };
}
