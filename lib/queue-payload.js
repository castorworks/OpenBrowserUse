import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// Preserve original queued instructions/config without exposing credentials in DTOs
// or plaintext SQLite records. The key is local to the owner's data directory.
export class QueuePayload {
  constructor(dir) {
    this.file = join(dir, 'queue-key');
  }
  key() {
    if (this.secret) return this.secret;
    try { this.secret = readFileSync(this.file); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const key = randomBytes(32);
      try { writeFileSync(this.file, key, { mode: 0o600, flag: 'wx' }); this.secret = key; }
      catch (e) { if (e.code !== 'EEXIST') throw e; this.secret = readFileSync(this.file); }
    }
    if (this.secret.length !== 32) throw new Error('Invalid queue encryption key');
    return this.secret;
  }
  seal(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  }
  open(value) {
    const b = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key(), b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8'));
  }
}
