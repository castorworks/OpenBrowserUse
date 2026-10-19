import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_DATA_DIR } from '../permissions/store.js';

// The extension pairing token survives restarts so the user pastes it once.
export function loadExtensionToken(dir = process.env.OBU_DATA_DIR || DEFAULT_DATA_DIR) {
  const file = join(dir, 'extension-token');
  try { const token = readFileSync(file, 'utf8').trim(); if (token.length >= 20) return token; } catch {}
  const token = randomBytes(18).toString('base64url');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}
