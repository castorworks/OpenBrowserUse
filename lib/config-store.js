import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_DATA_DIR } from './permissions/store.js';

// Persist only model settings; never task state or browser session contents.
const settings = z.object({
  provider: z.enum(['anthropic', 'openai', 'deepseek']),
  baseURL: z.string().max(3000), model: z.string().max(200),
  apiKey: z.string().max(4000),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  vision: z.boolean(), reviewerModel: z.string().max(200),
});

export class ConfigStore {
  constructor({ dir = DEFAULT_DATA_DIR } = {}) {
    this.dir = dir;
    this.file = join(dir, 'model-config.json');
  }

  load() {
    try { return settings.parse(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('无法读取本地模型配置，请检查 model-config.json 的格式和访问权限。');
    }
  }

  save(config) {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(temp, JSON.stringify(settings.parse(config), null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file);
    } catch {
      throw new Error('无法保存本地模型配置，请检查数据目录的写入权限。');
    } finally { rmSync(temp, { force: true }); }
  }
}
