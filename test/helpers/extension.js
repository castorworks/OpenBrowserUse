import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Isolate real-extension tests from the user's local service. Production always uses 4318.
export async function testExtension(directory, origin, source = resolve('extension')) {
  const target = join(directory, 'extension');
  await cp(source, target, { recursive: true });
  const file = join(target, 'background.js');
  const code = await readFile(file, 'utf8');
  const defaultURL = 'ws://127.0.0.1:4318/relay/extension';
  if (!code.includes(defaultURL)) throw new Error('Unexpected extension auto-connect endpoint');
  await writeFile(file, code.replace(defaultURL, origin.replace('http:', 'ws:') + '/relay/extension'));
  return target;
}
