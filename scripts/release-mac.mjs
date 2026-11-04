import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || ''}`);
  return result.stdout;
}
if (process.platform !== 'darwin') throw new Error('macOS release builds require macOS.');
const identity = process.env.CSC_NAME;
const profile = process.env.APPLE_KEYCHAIN_PROFILE;
if (!identity || !profile) throw new Error('Set CSC_NAME (company name or certificate SHA-1) and APPLE_KEYCHAIN_PROFILE (notarytool profile). Never put passwords in source files.');
const certificates = run('security', ['find-identity', '-v', '-p', 'codesigning'], true);
if (!certificates.split('\n').some(line => line.includes('Developer ID Application:') && line.includes(identity))) throw new Error('No matching Developer ID Application certificate with a private key is available.');
const credentials = ['--keychain-profile', profile, ...(process.env.APPLE_KEYCHAIN ? ['--keychain', process.env.APPLE_KEYCHAIN] : [])];
// Validate authentication before doing the expensive build. Credentials stay in Keychain.
run('xcrun', ['notarytool', 'history', ...credentials, '--output-format', 'json'], true);
run(process.execPath, [require.resolve('electron-builder/cli.js'), '--mac', '--arm64', '--publish', 'never', `--config.mac.identity=${identity}`, '--config.mac.hardenedRuntime=true', '--config.mac.notarize=true', '--config.forceCodeSigning=true']);
const app = resolve(root, 'dist/mac-arm64', `${pkg.build.productName}.app`);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
run('xcrun', ['stapler', 'validate', app]);
run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
const stem = `${pkg.build.productName}-${pkg.version}-arm64`;
const dmg = resolve(root, 'dist', `${stem}.dmg`);
// Staple the disk image too, so the distributed container carries its own ticket.
const submission = JSON.parse(run('xcrun', ['notarytool', 'submit', dmg, ...credentials, '--wait', '--output-format', 'json'], true));
if (submission.status !== 'Accepted') throw new Error(`DMG notarization failed: ${submission.status}, submission ${submission.id}`);
run('xcrun', ['stapler', 'staple', dmg]);
run('xcrun', ['stapler', 'validate', dmg]);
const files = [`${stem}.dmg`, `${stem}-mac.zip`];
const checksums = files.map(name => `${createHash('sha256').update(readFileSync(resolve(root, 'dist', name))).digest('hex')}  ${name}`).join('\n') + '\n';
writeFileSync(resolve(root, 'dist/SHA256SUMS.txt'), checksums);
console.log('Signed and notarized macOS ARM64 artifacts are ready in dist/.');
