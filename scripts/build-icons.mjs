// Regenerate platform icons from the approved artwork (macOS: sips + iconutil).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const source = join(root, 'assets/icons/open-browser-use-concept-v2-orange.png');
const output = join(root, 'assets/icons');
const temporary = mkdtempSync(join(tmpdir(), 'obu-icons-'));
const resize = (size, target) => execFileSync('sips', ['-z', String(size), String(size), source, '--out', target], { stdio: 'ignore' });
try {
  const iconset = join(temporary, 'icon.iconset'); mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    resize(size, join(iconset, `icon_${size}x${size}.png`));
    resize(size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
  }
  resize(1024, join(output, 'icon.png'));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(output, 'icon.icns')]);
  // ICO supports embedded PNG frames; preserve alpha without re-encoding pixels.
  const sizes = [16, 32, 48, 64, 128, 256];
  const frames = sizes.map(size => { const file = join(temporary, `${size}.png`); resize(size, file); return readFileSync(file); });
  const header = Buffer.alloc(6 + 16 * sizes.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  frames.forEach((frame, i) => { const entry = 6 + i * 16; header[entry] = header[entry + 1] = sizes[i] % 256; header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6); header.writeUInt32LE(frame.length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += frame.length; });
  writeFileSync(join(output, 'icon.ico'), Buffer.concat([header, ...frames]));
  for (const size of [16, 32, 48, 128]) resize(size, join(root, `extension/icons/${size}.png`));
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log('Generated desktop and extension icons.');
