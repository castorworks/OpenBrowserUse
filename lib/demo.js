import { readFileSync } from 'node:fs';

const asset = name => readFileSync(new URL(`../assets/demo/${name}`, import.meta.url), 'utf8');
// Trusted bundled assets form a standalone page; no local HTTP server is needed.
export const demoHTML = asset('demo.html')
  .replace('<link rel="stylesheet" href="/demo.css">', () => `<style>${asset('demo.css')}</style>`)
  .replace('<script src="/demo.js" defer></script>', '')
  .replace('</body>', () => `<script>${asset('demo.js')}</script></body>`);
export const demoURL = `data:text/html;charset=utf-8;base64,${Buffer.from(demoHTML).toString('base64')}`;
