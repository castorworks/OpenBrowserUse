import { createServer } from 'node:http';
import { demoHTML } from '../../lib/demo.js';

// Test website only: no workbench, configuration endpoints, or application transport.
export function demoServer() {
  return createServer((req, res) => {
    if (req.url !== '/demo') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(demoHTML);
  });
}
