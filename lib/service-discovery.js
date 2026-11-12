import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DATA_DIR } from './permissions/store.js';
import { localServiceURL } from './service-client.js';

const filename = dir => join(dir || DEFAULT_DATA_DIR, 'runtime-service.json');
const sharedFile = port => join(DEFAULT_DATA_DIR, 'services', `relay-${port}.json`);

// Published only after listening, while holding the data-directory runtime lock.
// Credentials stay in the local user's data directory and never reach the renderer.
export async function publishService({ dataDir, host, port, token, relayPort }) {
  const localHost = { '::': '[::1]', '::1': '[::1]', '0.0.0.0': '127.0.0.1', '127.0.0.1': '127.0.0.1', localhost: 'localhost' }[host];
  if (!localHost) return () => Promise.resolve();
  const files = [filename(dataDir), sharedFile(relayPort)];
  const nonce = randomUUID();
  const record = JSON.stringify({ version: 1, pid: process.pid, nonce, url: `http://${localHost}:${port}`, token });
  const published = [];
  const remove = async () => {
    for (const file of published) {
      try {
        const current = JSON.parse(await readFile(file, 'utf8'));
        if (current.nonce === nonce) await rm(file, { force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  try {
    for (const file of files) {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${nonce}.tmp`;
      try {
        await writeFile(temp, record, { mode: 0o600, flag: 'wx' });
        await rename(temp, file); published.push(file);
      } finally { await rm(temp, { force: true }); }
    }
  } catch (error) { await remove(); throw error; }
  return remove;
}

async function readService(file) {
  let record;
  try { record = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('无法读取本机服务发现记录，请重启独立服务并检查用户数据目录的文件权限。');
  }
  if (record.version !== 1 || !Number.isInteger(record.pid) || record.pid < 1 || typeof record.token !== 'string' || record.token.length < 32 || /\s/.test(record.token)) throw new Error('本机服务记录无效，请重启独立服务。');
  const url = localServiceURL(record.url);
  try { process.kill(record.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return null; throw new Error('无法确认本机服务进程状态。'); }
  return { url, token: record.token };
}

// The per-user relay index also finds services using a custom data directory.
export async function discoverService(dataDir, relayPort = 4318) {
  return await readService(sharedFile(relayPort)) || await readService(filename(dataDir));
}
