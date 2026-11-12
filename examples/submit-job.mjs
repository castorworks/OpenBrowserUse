// Node.js 22+: OBU_API_URL=https://browser.example.com OBU_API_TOKEN=... node examples/submit-job.mjs "your goal"
import { randomUUID } from 'node:crypto';
const base = (process.env.OBU_API_URL || 'http://127.0.0.1:4319').replace(/\/$/, '');
const token = process.env.OBU_API_TOKEN;
const goal = process.argv[2];
if (!token || !goal) throw new Error('Set OBU_API_TOKEN and pass a goal as the first argument.');
async function request(path, body) {
  const response = await fetch(`${base}/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${result.code}: ${result.detail} (request ${response.headers.get('x-request-id')})`);
  return result;
}
const job = await request('/jobs', { goal, permission_mode: 'skip' });
console.log(JSON.stringify({ job_id: job.id, run_id: job.run_id }));
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const deadline = Date.now() + 30 * 60 * 1000;
while (Date.now() < deadline) {
  const state = await request(`/jobs/${job.id}`);
  if (terminal.has(state.status)) {
    console.log(JSON.stringify(await request(`/runs/${job.run_id}`), null, 2));
    process.exitCode = state.status === 'completed' ? 0 : 1; break;
  }
  if (['waiting_input', 'waiting_approval', 'paused'].includes(state.run_status)) {
    console.log(`Run ${job.run_id} requires interaction: ${state.run_status}. Use the interactions/control API to continue.`);
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (Date.now() >= deadline) throw new Error(`Polling timed out; job ${job.id} is still retained by the service. Query or cancel it explicitly.`);
