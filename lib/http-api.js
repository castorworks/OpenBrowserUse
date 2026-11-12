import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { desktopRequest, requireLocalPeer, streamDesktop } from './desktop-bridge.js';
import { z } from 'zod';
import { TERMINAL_RUNS } from './runs.js';
import { redactTranscript } from './redact.js';

import { ApiError, fail } from './api-error.js';
export { ApiError } from './api-error.js';

const now = () => new Date().toISOString();
const empty = z.object({}).strict();
const text = z.string().trim().min(1);
const mode = z.enum(['ephemeral', 'persistent', 'extension']);
const permission = z.enum(['ask', 'auto', 'skip']);
const canonical = x => JSON.stringify(x && typeof x === 'object' ? (Array.isArray(x) ? x.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(x).sort().map(k => [k, JSON.parse(canonical(x[k]))]))) : x);

export class HttpApi {
  constructor(tasks) { this.tasks = tasks; }
  async request(method, rawPath, body, key, identity) {
    return this.tasks.serialize(async () => {
      const url = new URL(rawPath, 'http://localhost'), path = url.pathname;
      if (method === 'GET') return this.read(path, url.searchParams);
      if (!['POST', 'DELETE'].includes(method)) fail(405, 'method_not_allowed');
      if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) fail(400, 'idempotency_key_required');
      const scoped = createHash('sha256').update(`${identity}\n${method}\n${path}\n${key}`).digest('hex');
      const digest = createHash('sha256').update(canonical(body)).digest('hex');
      const old = this.tasks.db.prepare('SELECT * FROM api_idempotency WHERE key=?').get(scoped);
      if (old) {
        if (old.digest !== digest) fail(409, 'idempotency_conflict');
        return JSON.parse(old.response);
      }
      if ([...url.searchParams].length) fail(400, 'unexpected_query');
      // Recover checkpoint lookup can await before entering the synchronous SQLite transaction.
      let checkpoint;
      const recovery = /^\/v1\/runs\/([^/]+)\/recover$/.exec(path);
      if (recovery) {
        const r = this.tasks.require('run', recovery[1]);
        checkpoint = await this.tasks.agent.sessions.get(r.session_id);
        if (!checkpoint) fail(409, 'checkpoint_unavailable');
        // The legacy checkpoint is per-conversation. Never silently restore a different round.
        if (checkpoint.runs?.at(-1)?.id !== r.id) fail(409, 'checkpoint_unavailable', '仅最后一轮的检查点可恢复。');
      }
      const effects = [];
      const response = this.tasks.transaction(() => {
        const response = redactTranscript(this.mutate(path, body, effects, checkpoint, method));
        this.tasks.db.prepare('INSERT INTO api_idempotency VALUES(?,?,?,?)').run(scoped, digest, JSON.stringify(response), Date.now());
        return response;
      });
      // Hold the shared command lock through start/control, but not the model execution.
      for (const effect of effects) await effect();
      this.tasks.lifecycle.kick();
      return response;
    });
  }
  async read(path, q) {
    if (path === '/v1/status') return { status: 200, body: { version: 'v1', ready: true, max_active_sessions: 1, max_active_runs: 1, active_session_id: this.tasks.openSession()?.id || null, max_request_bytes: 8388608, queued_jobs: this.tasks.lifecycle.queued().length, features: ['polling', 'sse', 'screenshots', 'export', 'retention', 'fifo_queue', 'virtual_cursor', 'interactions', 'idempotency', 'latest_checkpoint_recovery'] } };
    let m;
    if (path === '/v1/settings/lifecycle') return { status: 200, body: this.tasks.lifecycle.settings() };
    if (path === '/v1/jobs') return this.list(this.tasks.all('job'), q);
    if ((m = /^\/v1\/jobs\/([^/]+)$/.exec(path))) return { status: 200, body: this.tasks.require('job', m[1]) };
    if ((m = /^\/v1\/runs\/([^/]+)\/events(\/stream)?$/.exec(path))) {
      this.tasks.require('run', m[1]);
      const raw = q.get('after') || '0';
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail(400, 'invalid_event_cursor');
      const after = Number(raw);
      if (after > this.tasks.events.last(m[1])) fail(400, 'invalid_event_cursor');
      if (m[2]) return { status: 200, stream: { runId: m[1], after } };
      const limit = q.has('limit') ? Number(q.get('limit')) : 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 400) fail(400, 'invalid_limit');
      const data = this.tasks.events.page(m[1], after, limit), next = data.at(-1)?.sequence || after;
      return { status: 200, body: { data, next_after: next, has_more: next < this.tasks.events.last(m[1]) } };
    }
    if ((m = /^\/v1\/sessions\/([^/]+)\/(screenshot|export|cursor)$/.exec(path))) {
      const session = this.tasks.require('session', m[1]);
      if (m[2] === 'export') {
        if (this.tasks.agent.task?.id === session.id) await this.tasks.agent.save();
        const checkpoint = await this.tasks.agent.sessions.get(session.id, { includeMemory: true });
        const runs = this.tasks.all('run').filter(r => r.session_id === session.id);
        const events = runs.flatMap(r => this.tasks.db.prepare('SELECT data FROM api_events WHERE run_id=? ORDER BY sequence').all(r.id).map(x => JSON.parse(x.data)));
        return { status: 200, headers: { 'Content-Disposition': `attachment; filename="openbrowseruse-${session.id}.json"` }, body: redactTranscript({ format_version: 1, exported_at: now(), session, runs, interactions: this.tasks.all('interaction').filter(i => runs.some(r => r.id === i.run_id)), events, checkpoint }) };
      }
      if (this.tasks.agent.task?.id !== session.id || !this.tasks.agent.browser) fail(409, 'browser_unavailable');
      if (m[2] === 'cursor') return { status: 200, body: this.tasks.agent.pointer || { visible: false } };
      const format = q.get('format') || 'jpeg';
      if (!['jpeg', 'png'].includes(format)) fail(400, 'invalid_format');
      let shot;
      try { shot = await this.tasks.agent.browser.screenshot({ format }); }
      catch { fail(409, 'screenshot_unavailable'); }
      return { status: 200, contentType: `image/${format}`, binary: Buffer.from(shot.split(',')[1], 'base64') };
    }
    if (path === '/v1/sessions') return this.list(this.tasks.all('session'), q);
    if ((m = /^\/v1\/sessions\/([^/]+)$/.exec(path))) return { status: 200, body: this.tasks.require('session', m[1]) };
    if ((m = /^\/v1\/sessions\/([^/]+)\/runs$/.exec(path))) { this.tasks.require('session', m[1]); return this.list(this.tasks.all('run').filter(r => r.session_id === m[1]), q); }
    if ((m = /^\/v1\/runs\/([^/]+)$/.exec(path))) return { status: 200, body: this.tasks.require('run', m[1]) };
    if ((m = /^\/v1\/runs\/([^/]+)\/interactions$/.exec(path))) {
      this.tasks.require('run', m[1]);
      const status = q.get('status');
      if (status && !['pending', 'resolved', 'expired'].includes(status)) fail(400, 'invalid_status');
      return this.list(this.tasks.all('interaction').filter(i => i.run_id === m[1] && (!status || i.status === status)), q);
    }
    fail(404, 'not_found');
  }
  list(items, q) {
    const limit = q.has('limit') ? Number(q.get('limit')) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(400, 'invalid_limit');
    items.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const cursor = q.get('cursor');
    if (cursor) {
      const index = items.findIndex(x => Buffer.from(`${x.created_at}/${x.id}`).toString('base64url') === cursor);
      if (index < 0) fail(400, 'invalid_cursor');
      items = items.slice(index + 1);
    }
    const data = items.slice(0, limit), last = data.at(-1);
    return { status: 200, body: { data, next_cursor: items.length > limit ? Buffer.from(`${last.created_at}/${last.id}`).toString('base64url') : null } };
  }
  mutate(path, body, effects, checkpoint, method = 'POST') {
    const t = this.tasks;
    let m;
    if (method === 'DELETE') {
      if (!(m = /^\/v1\/sessions\/([^/]+)$/.exec(path))) fail(404, 'not_found');
      empty.parse(body); t.require('session', m[1]); t.lifecycle.erase(m[1]); return { status: 204 };
    }
    if (path === '/v1/settings/lifecycle') return t.lifecycle.updateSettings(body, effects);
    if (path === '/v1/jobs') return t.lifecycle.createJob(body, effects);
    if ((m = /^\/v1\/jobs\/([^/]+)\/cancel$/.exec(path))) { empty.parse(body); return t.lifecycle.cancelJob(m[1], effects); }
    if (path === '/v1/sessions') {
      const input = z.object({ browser_mode: mode.optional(), permission_mode: permission.optional() }).strict().parse(body);
      const session = t.createSession(input);
      return { status: 201, body: session, location: `/v1/sessions/${session.id}` };
    }
    if ((m = /^\/v1\/sessions\/([^/]+)\/runs$/.exec(path))) {
      const input = z.object({ goal: text, start_url: z.string().url().optional() }).strict().parse(body);
      const run = t.createRun(t.require('session', m[1]), input, effects);
      return { status: 202, body: run, location: `/v1/runs/${run.id}` };
    }
    if ((m = /^\/v1\/sessions\/([^/]+)\/close$/.exec(path))) { empty.parse(body); return t.closeSession(m[1], effects); }
    if ((m = /^\/v1\/runs\/([^/]+)\/recover$/.exec(path))) {
      const input = z.object({ permission_mode: permission.optional() }).strict().parse(body);
      const run = t.recoverRun(m[1], input, checkpoint, effects);
      return { status: 202, body: run, location: `/v1/runs/${run.id}` };
    }
    if ((m = /^\/v1\/runs\/([^/]+)\/(pause|resume|cancel|messages)$/.exec(path))) {
      const input = m[2] === 'messages' ? z.object({ text }).strict().parse(body) : empty.parse(body);
      if (m[2] === 'cancel') { const result = t.lifecycle.cancelQueuedRun(m[1], effects); if (result) return result; }
      return t.controlRun(m[1], m[2], input, effects);
    }
    if ((m = /^\/v1\/runs\/([^/]+)\/interactions\/([^/]+)\/response$/.exec(path))) return t.respondInteraction(m[1], m[2], body, effects);
    fail(404, 'not_found');
  }
}
export async function startHttpListener(api, { token, port = 4319, host = '127.0.0.1', desktop }) {
  if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new Error('OBU_API_TOKEN must contain at least 32 non-whitespace characters.');
  if (!isIP(host)) throw new Error('OBU_API_HOST must be an IPv4 or IPv6 address.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('OBU_API_PORT must be an integer between 0 and 65535.');
  let closing = false;
  const desktopStreams = new Set();
  const spec = JSON.parse(await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
  const secret = createHash('sha256').update(token).digest();
  const server = createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-ID', requestId); res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET' && ['/healthz', '/readyz'].includes(req.url)) {
        const ready = !closing;
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: ready ? 'ok' : 'stopping' })); return;
      }
      if (!timingSafeEqual(secret, createHash('sha256').update((req.headers.authorization || '').replace(/^Bearer /, '')).digest()) || !req.headers.authorization?.startsWith('Bearer ')) fail(401, 'unauthorized');
      // This first release supports non-browser clients only: no cookie auth or CORS.
      if (req.headers.origin || req.headers['sec-fetch-site']) fail(403, 'browser_origin_forbidden');
      if (closing) fail(503, 'service_stopping');
      if (req.method === 'GET' && req.url === '/v1/openapi.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...spec, servers: [{ url: '/v1' }] })); return;
      }
      let body = {};
      if (req.method === 'POST' || (req.method === 'DELETE' && (req.headers['content-length'] || req.headers['transfer-encoding']))) {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'unsupported_media_type');
        if (Number(req.headers['content-length']) > 8388608) fail(413, 'request_too_large');
        let bytes = 0; const chunks = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8388608) fail(413, 'request_too_large'); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json'); }
      }
      if (req.url.startsWith('/internal/desktop/')) {
        requireLocalPeer(req);
        if (!desktop) fail(404, 'not_found');
        if (req.method === 'GET' && req.url === '/internal/desktop/v1/events') { streamDesktop(desktop, res, desktopStreams); return; }
        if (req.method !== 'POST' || req.url !== '/internal/desktop/v1/request') fail(404, 'not_found');
        const command = desktopRequest.parse(body);
        const result = await desktop.request(command.method, command.path, command.body);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      let requestURL = req.url;
      if (req.method === 'GET' && req.headers['last-event-id']) {
        const u = new URL(req.url, 'http://localhost'), match = /^\/v1\/runs\/([^/]+)\/events\/stream$/.exec(u.pathname);
        const id = req.headers['last-event-id'];
        if (!match || !id.startsWith(match[1] + ':') || !/^\d+$/.test(id.slice(match[1].length + 1))) fail(400, 'invalid_event_cursor');
        u.searchParams.set('after', id.slice(match[1].length + 1)); requestURL = u.pathname + u.search;
      }
      const result = await api.request(req.method, requestURL, body, req.headers['idempotency-key'], secret.toString('hex'));
      if (result.status >= 400) fail(result.status, result.body.code || 'request_failed');
      if (result.stream) {
        const { runId, after } = result.stream;
        api.tasks.events.stream(req, res, runId, after, () => Boolean(api.tasks.get('run', runId)), () => TERMINAL_RUNS.has(api.tasks.get('run', runId)?.status));
        return;
      }
      if (result.status === 204) { res.writeHead(204); res.end(); return; }
      if (result.headers) for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
      if (result.binary) { res.writeHead(200, { 'Content-Type': result.contentType }); res.end(result.binary); return; }
      if (result.location) res.setHeader('Location', result.location);
      res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.body));
    } catch (error) {
      const status = error instanceof z.ZodError ? 422 : error.status || 500;
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      res.writeHead(status, { 'Content-Type': 'application/problem+json' });
      res.end(JSON.stringify({ type: `urn:openbrowseruse:problem:${error.code || (status === 422 ? 'validation_error' : 'internal_error')}`, title: status === 500 ? 'Internal server error' : error.code || 'Validation error', status, code: error.code || (status === 422 ? 'validation_error' : 'internal_error'), detail: error instanceof ApiError ? error.message : status === 422 ? '请求字段不符合接口定义。' : '服务端处理失败。', request_id: requestId, ...(error instanceof z.ZodError ? { errors: error.issues.map(i => ({ pointer: '/' + i.path.join('/'), code: i.code })) } : {}) }));
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, host, port: server.address().port, close: () => new Promise(resolve => {
    closing = true; for (const end of [...desktopStreams]) end(); api.tasks.events.close();
    const timer = setTimeout(() => server.closeAllConnections(), 5000); timer.unref();
    server.close(() => { clearTimeout(timer); resolve(); }); server.closeIdleConnections();
  }) };
}
