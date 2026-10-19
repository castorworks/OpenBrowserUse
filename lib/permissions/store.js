import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_DATA_DIR = join(homedir(), '.openbrowseruse');

// The permission unit is the host (without "www."), plus the port for local addresses,
// so localhost:3000 and localhost:5173 are separate sites.
export function siteOf(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    const h = u.hostname.toLowerCase();
    const local = h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '[::1]';
    return local ? u.host : h.replace(/^www\./, '');
  } catch { return null; }
}

// "Always allow" and "deny" decisions, kept in <dataDir>/permissions.json.
export class PermissionStore {
  constructor({ dir = process.env.OBU_DATA_DIR || DEFAULT_DATA_DIR } = {}) {
    this.file = join(dir, 'permissions.json'); this.dir = dir;
    try { this.sites = JSON.parse(readFileSync(this.file, 'utf8')).sites || {}; } catch { this.sites = {}; }
  }
  get(site) { return this.sites[site]?.decision; }
  set(site, decision) { this.sites[site] = { decision, time: new Date().toISOString() }; this.save(); }
  revoke(site) { delete this.sites[site]; this.save(); }
  list() { return Object.entries(this.sites).map(([site, v]) => ({ site, ...v })).sort((a, b) => a.site.localeCompare(b.site)); }
  save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sites: this.sites }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
