import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Where each branded channel is installed. Playwright finds them itself; this only decides the default.
const installs = {
  darwin: { chrome: ['/Applications/Google Chrome.app'], msedge: ['/Applications/Microsoft Edge.app'] },
  win32: {
    chrome: ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].map(v => process.env[v] && join(process.env[v], 'Google/Chrome/Application/chrome.exe')),
    msedge: ['PROGRAMFILES', 'PROGRAMFILES(X86)'].map(v => process.env[v] && join(process.env[v], 'Microsoft/Edge/Application/msedge.exe')),
  },
  linux: { chrome: ['/opt/google/chrome/chrome'], msedge: ['/opt/microsoft/msedge/msedge'] },
};

// BROWSER_CHANNEL wins; otherwise prefer installed Chrome, then Edge, then Playwright's bundled Chromium.
export function detectChannel(env = process.env, platform = process.platform) {
  if (env.BROWSER_CHANNEL) return env.BROWSER_CHANNEL;
  const known = installs[platform] || {};
  for (const channel of ['chrome', 'msedge']) if ((known[channel] || []).some(p => p && existsSync(p))) return channel;
  return 'chromium';
}

export const launchChannel = channel => (channel === 'chromium' ? {} : { channel });
