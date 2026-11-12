import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_DATA_DIR } from './permissions/store.js';

// Persist settings only; never task state or browser session contents.
const settings = z.object({
  browser: z.object({ mode: z.enum(['ephemeral', 'persistent', 'extension']), requiresSelection: z.literal(true).optional(), allowLocalhost: z.boolean(), allowPrivateNetwork: z.boolean(), blockedSites: z.array(z.string()) }).optional(),
  contextWindow: z.number().int().min(16000).max(2000000).default(128000),
  outputReserve: z.number().int().min(1000).max(64000).default(16000),
  provider: z.enum(['openai', 'deepseek']),
  modelRequiresSelection: z.literal(true).optional(),
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
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (raw.provider === 'anthropic') Object.assign(raw, {
        provider: 'openai', baseURL: 'https://api.openai.com/v1', model: '', apiKey: '', reviewerModel: '', modelRequiresSelection: true,
      });
      // Keep model credentials and history usable, but require an explicit browser choice.
      if (raw.browser?.mode === 'cdp') raw.browser = { ...raw.browser, mode: 'ephemeral', requiresSelection: true };
      return settings.parse(raw);
    }
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
