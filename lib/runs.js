// A task remains the desktop conversation. Runs are immutable completed rounds within it.
export const TERMINAL_RUNS = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const statuses = { done: 'completed', stopped: 'cancelled', stopping: 'cancelling', approval: 'waiting_approval', waiting_user: 'waiting_input' };

export function newRun(task, goal, { id = crypto.randomUUID(), startURL = null, recoveredFrom = null, createdAt } = {}) {
  task.runs ||= [];
  const now = new Date().toISOString();
  task.runs.push({ id, session_id: task.id, goal, start_url: startURL, status: 'starting', created_at: createdAt || now, started_at: now, finished_at: null, result: null, error: null, pending_interaction_id: null, recovered_from_run_id: recoveredFrom,
    metrics: { requests: 0, tools: 0, retries: 0, usage: [] }, revision: 0,
    offsets: { requests: task.metrics.requests.length, tools: task.metrics.tools.length, retries: task.metrics.retries } });
}

export function updateRun(task, finish = false) {
  const run = task?.runs?.at(-1);
  if (!run || run.finished_at) return;
  const status = statuses[task.status] || task.status;
  // Do not publish a terminal round before finish() has saved/closed its browser.
  if (!TERMINAL_RUNS.has(status) || finish) run.status = status;
  run.pending_interaction_id = task.pending?.id || null;
  const o = run.offsets;
  run.metrics = { requests: task.metrics.requests.length - o.requests, tools: task.metrics.tools.length - o.tools, retries: task.metrics.retries - o.retries, usage: task.metrics.requests.slice(o.requests).map(r => r.usage ?? null) };
  if (finish && TERMINAL_RUNS.has(status)) {
    run.finished_at = new Date().toISOString();
    run.pending_interaction_id = null;
    if (status === 'completed') run.result = { text: task.result, outcome: 'unverified', evidence: task.evidence || null };
    if (status === 'failed') run.error = { code: 'execution_failed', message: task.result || 'Execution failed', retryable: false };
  }
  run.revision++;
}

export function publicRun(run) {
  const { offsets, ...result } = run;
  return result;
}


export const RUN_ACTIONS = Object.freeze({
  pause: ['starting', 'running'], resume: ['paused'], messages: ['starting', 'running'],
  cancel: ['starting', 'running', 'pausing', 'paused', 'waiting_input', 'waiting_approval'],
});
const RUN_STATUSES = new Set(['queued', 'starting', 'running', 'pausing', 'paused', 'waiting_input', 'waiting_approval', 'cancelling', ...TERMINAL_RUNS]);
export function assertRunStatus(status) { if (!RUN_STATUSES.has(status)) throw new Error(`Invalid run status: ${status}`); }
export function taskStatus(status) { return ({ completed: 'done', cancelled: 'stopped', cancelling: 'stopping', waiting_input: 'waiting_user', waiting_approval: 'approval' })[status] || status; }
