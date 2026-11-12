const $ = id => document.getElementById(id);
let current = null, configured = false, lastImage = null, lastEventKey = '', lastTask = null, lastFrameAt = 0, replay = null, lastStatus = '', composeNew = false;
const states = { starting: '启动浏览器', running: '执行中', pausing: '正在暂停', paused: '已暂停 · 可接管', approval: '等待确认', waiting_user: '需要你的帮助', stopping: '正在停止', stopped: '已停止', done: '本轮结束 · 结果待验证', failed: '执行失败' };
const providerLabel = { deepseek: 'DeepSeek', openai: 'OpenAI 兼容', demo: '固定脚本演示' };
function toast(message) { $('toast-message').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 6500); }
$('toast-dismiss').onclick = () => { $('toast').hidden = true; clearTimeout(toast.timer); };
const pendingButtons = new Set();
let historyCache = [], queueFilter = 'active';
const api = (path, data) => window.desktop.request(path, data && ['control', 'messages'].includes(path) ? { ...data, interactionId: current?.task?.pending?.id } : data);
const providerHints = {
  deepseek: { base: 'https://api.deepseek.com', hint: '（默认官方地址）', model: '图像识别使用 deepseek-flash' },
  openai: { base: 'https://api.openai.com/v1', hint: '（含 /v1，不含 /chat/completions）', model: '服务商提供的模型 ID' },
};
function syncProvider() {
  const provider = $('provider').value, h = providerHints[provider];
  document.querySelectorAll('.provider-effort').forEach(el => el.hidden = provider === 'openai');
  $('base-url').placeholder = h.base; $('base-url-hint').textContent = h.hint; $('model').placeholder = h.model;
}
const browserModes = { ephemeral: '独立会话', persistent: '持久化配置', extension: 'Chrome 扩展' };
function syncBrowserMode() {
  const mode = $('browser-mode').value;
  document.querySelectorAll('.browser-persistent').forEach(el => el.hidden = mode !== 'persistent');
  document.querySelectorAll('.browser-extension').forEach(el => el.hidden = mode !== 'extension');
}
function showBrowserConfig(b) {
  $('blocked-sites').value = (b.blockedSites || []).join('\n');
  $('browser-mode').value = b.mode; $('browser-migration').hidden = !b.requiresSelection;
  $('browser-badge').textContent = browserModes[b.mode]; syncBrowserMode();
}
function showConfig(config) {
  showBrowserConfig(config.browser);
  $('model-migration').hidden = !config.modelRequiresSelection;
  $('provider').value = config.provider; $('base-url').value = config.baseURL; $('model').value = config.model;
  $('context-window').value = config.contextWindow || 128000; $('output-reserve').value = config.outputReserve || 16000;
  $('effort').value = config.effort; $('vision').checked = config.vision; $('reviewer-model').value = config.reviewerModel || ''; syncProvider();
  $('model-badge').textContent = config.model || '待配置';
  $('key-status').textContent = config.hasKey ? '· 已配置，留空保留' : '· 尚未配置';
}
function pendingText(p) {
  if (!p) return '';
  if (p.question) return p.question;
  const lines = [p.summary];
  if (p.reason) lines.push(`原因：${p.reason}`);
  if (p.target) lines.push(`目标：${p.target}`);
  if (p.input?.code) lines.push(`代码：\n${p.input.code}`);
  return lines.join('\n');
}
const modeHints = {
  ask: '每次点击、输入前都请你确认；首次访问新网站时也会询问。',
  auto: '规则和审查模型判断风险：安全的操作直接执行，购买、发送、删除等有后果的操作会请你确认。',
  skip: '直接执行操作，无需逐步确认。',
};
let lastGrants = '';
function renderGrants(list) {
  const key = JSON.stringify(list);
  if (key === lastGrants) return; lastGrants = key;
  if (!list.length) { $('site-grants').replaceChildren(el('p', 'muted small', '还没有保存的网站权限。')); return; }
  $('site-grants').replaceChildren(...list.map(g => {
    const row = document.createElement('div'); row.className = 'grant';
    const name = document.createElement('b'); name.textContent = g.site;
    const tag = document.createElement('em'); tag.textContent = g.decision === 'allow' ? '始终允许' : '已禁止'; if (g.decision !== 'allow') tag.className = 'deny';
    const revoke = document.createElement('button'); revoke.className = 'text-button'; revoke.textContent = '撤销';
    revoke.onclick = async () => { try { renderGrants((await api('permissions', { action: 'revoke', site: g.site })).permissions); } catch (e) { toast(e.message); } };
    row.append(name, tag, revoke); return row;
  }));
}
const toolIcons = { read_page: '☰', find: '⌕', get_page_text: '¶', computer: '⌖', navigate: '↗', tabs: '▭', form_input: '✎', javascript: '{}', read_console_messages: '>_', read_network_requests: '⇅' };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function markdown(node, text) {
  if (node.dataset.source === (text || '')) return;
  node.dataset.source = text || '';
  node.classList.add('markdown');
  node.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), { FORBID_TAGS: ['img', 'style', 'input', 'form'], FORBID_ATTR: ['style'] });
}
// Chat transcript: user and agent messages as bubbles, each tool call as a collapsible card.
function renderEvents(events, result = '') {
  const lastFinal = events.findLastIndex(e => e.final && e.message === result);
  events = events.filter((e, i) => i !== lastFinal);
  const key = JSON.stringify(events);
  if (key === lastEventKey) return;
  lastEventKey = key;
  const box = $('events'), scroller = $('chat-scroll');
  const nearEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 60;
  const previous = [...box.children];
  const nodes = events.map((e, index) => {
    const source = JSON.stringify(e);
    if (previous[index]?.dataset.event === source) return previous[index];
    const node = renderEvent(e);
    node.dataset.event = source;
    if (node.tagName === 'DETAILS' && previous[index]?.tagName === 'DETAILS') node.open = previous[index].open;
    return node;
  });
  nodes.forEach((node, index) => {
    if (box.children[index] === node) return;
    if (box.children[index]) box.children[index].replaceWith(node);
    else box.append(node);
  });
  while (box.children.length > nodes.length) box.lastElementChild.remove();
  if (nearEnd) scroller.scrollTop = scroller.scrollHeight;
}
function renderEvent(e) {
    const time = new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false });
    if (e.kind === 'user' || e.kind === 'assistant') {
      const bubble = el('div', `bubble ${e.kind}`);
      const content = el(e.kind === 'assistant' ? 'div' : 'p', '', e.message);
      if (e.kind === 'assistant') markdown(content, e.message);
      bubble.append(content, el('time', '', time)); return bubble;
    }
    if (e.kind === 'action') {
      const card = el('details', `tool-card ${e.state || ''}`);
      const summary = el('summary');
      summary.append(el('span', 'tool-icon', toolIcons[e.tool] || '•'), el('span', 'tool-summary', e.message), el('span', 'tool-state', e.state === 'running' ? '…' : e.state === 'error' ? '✗' : '✓'), el('time', '', time));
      card.append(summary);
      if (e.input) card.append(el('pre', 'tool-io', `输入 ${e.input}`));
      if (e.output) card.append(el('pre', 'tool-io', `${e.image ? '[截图] ' : ''}结果 ${e.output}`));
      return card;
    }
    const line = el('div', `event ${e.kind}`); line.append(el('time', '', time), el('span', '', e.message)); return line;
}
function showFrame(data) {
  lastFrameAt = Date.now();
  $('screenshot').src = `data:image/jpeg;base64,${data}`; lastImage = 'frame';
  $('screenshot').hidden = false; $('empty-state').hidden = true;
}
let pointerState = null, pointerTimer, lastPointerPulse = '';
const pointerNames = { left_click: '点击', right_click: '右键点击', double_click: '双击', triple_click: '三击', hover: '移动', left_click_drag: '拖动', type: '输入', key: '按键', form_input: '填写', scroll: '滚动' };
function positionPointer() {
  const layer = $('agent-pointer-layer'), p = pointerState, img = $('screenshot');
  if (!p?.visible || !p.coordinate || img.hidden || p.session_id !== current?.task?.id || replay) { layer.hidden = true; return; }
  const box = $('viewport').getBoundingClientRect(), v = p.viewport;
  if (!v?.width || !v?.height || !box.width || !box.height) return;
  const scale = Math.min(box.width / v.width, box.height / v.height);
  const offset = [(box.width - v.width * scale) / 2, (box.height - v.height * scale) / 2];
  const point = xy => xy.map((value, index) => offset[index] + value * scale);
  const [x, y] = point(p.coordinate);
  layer.hidden = false; $('agent-pointer').classList.toggle('dragging', p.action === 'left_click_drag'); $('agent-pointer').style.transform = `translate(${x}px,${y}px)`;
  $('agent-pointer-label').textContent = `代理 · ${p.phase === 'error' ? '操作失败' : pointerNames[p.action] || '操作'}`;
  $('agent-pointer').classList.toggle('error', p.phase === 'error');
  const dragging = p.action === 'left_click_drag' && p.start_coordinate;
  $('agent-drag-path').setAttribute('d', dragging ? `M ${point(p.start_coordinate).join(' ')} L ${x} ${y}` : '');
}
function showPointer(data) {
  pointerState = data; clearTimeout(pointerTimer);
  positionPointer();
  const pulse = `${data.at}:${data.action}`;
  if (data.phase === 'start' && /click/.test(data.action || '') && data.action !== 'left_click_drag' && pulse !== lastPointerPulse) {
    lastPointerPulse = pulse;
    const p = $('agent-pointer'); p.classList.remove('click'); void p.offsetWidth; p.classList.add('click');
  }
  pointerTimer = setTimeout(() => { pointerState = null; positionPointer(); }, 2500);
}
new ResizeObserver(positionPointer).observe($('viewport'));
$('screenshot').addEventListener('load', positionPointer);
function renderQueue(queue) {
  if (!queue) return;
  const jobs = queue.jobs || [], active = jobs.filter(j => ['queued', 'running'].includes(j.status));
  $('queue-count').textContent = String(queue.queued_count);
  $('queue-summary-hint').textContent = active.some(j => j.status === 'running') ? '正在执行' : queue.queued_count ? `${queue.queued_count} 项等待` : '暂无等待任务';
  $('queue-hint').textContent = queue.blocked_by_session && queue.queued_count ? '当前会话仍占用浏览器。关闭后，队列将自动继续。' : '每次执行一个任务，完成后自动开始下一项。';
  $('queue-release').hidden = !(queue.blocked_by_session && queue.queued_count && current?.task?.sessionOpen && !current?.busy);
  for (const name of ['active', 'all']) $(`queue-filter-${name}`).setAttribute('aria-pressed', String(queueFilter === name));
  const signature = JSON.stringify([queueFilter, jobs.map(j => [j.id, j.status, j.run_status])]);
  if ($('queue-list').dataset.signature === signature) return;
  $('queue-list').dataset.signature = signature; $('queue-list').replaceChildren();
  const labels = { queued: '等待中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
  const visible = queueFilter === 'active' ? active : jobs;
  if (!visible.length) $('queue-list').append(el('p', 'queue-empty', queueFilter === 'active' ? '没有待执行任务。可在输入区加入新任务。' : '还没有队列任务。'));
  visible.forEach((job, index) => {
    const row = el('div', 'queue-row'); row.dataset.status = job.status;
    const number = el('span', 'queue-order', job.status === 'running' ? '●' : String(index + 1).padStart(2, '0'));
    const copy = el('div', 'queue-copy'), goal = el('span', 'queue-goal', job.goal); goal.title = job.goal;
    const status = el('span', 'queue-state', job.status === 'running' && job.run_status.startsWith('waiting_') ? '需要你的回应' : labels[job.status]);
    copy.append(goal, status); row.append(number, copy);
    if (job.status === 'running') {
      const view = el('button', 'btn btn-sm btn-ghost', '查看'); view.onclick = returnCurrent; row.append(view);
    } else if (job.started_at && ['completed', 'failed', 'interrupted'].includes(job.status)) {
      const view = el('button', 'btn btn-sm btn-ghost', '查看记录'); view.onclick = () => void openReplay(job.session_id); row.append(view);
    }
    if (['queued', 'running'].includes(job.status)) {
      const cancel = el('button', 'btn btn-sm btn-ghost', '取消'); cancel.setAttribute('aria-label', `取消任务：${job.goal}`);
      cancel.onclick = async () => { cancel.disabled = true; try { await api(`jobs/${job.id}/cancel`, {}); } catch (e) { toast(e.message); cancel.disabled = false; } };
      row.append(cancel);
    }
    $('queue-list').append(row);
  });
}
function returnCurrent() { composeNew = false; if (replay) exitReplay(); else if (current) render(current); }
$('return-current').onclick = returnCurrent;
for (const name of ['active', 'all']) $(`queue-filter-${name}`).onclick = () => { queueFilter = name; renderQueue(current?.queue); };
function updateComposer() {
  const blocked = Boolean(current?.busy || current?.task?.sessionOpen || current?.queue?.queued_count || current?.loginOpen || current?.queue?.blocked_by_session);
  const empty = !$('goal').value.trim();
  $('run').disabled = blocked || empty || pendingButtons.has('run');
  $('run').title = blocked ? '当前浏览器正在使用，请加入队列或先关闭当前会话。' : '开始执行新任务';
  $('enqueue').disabled = empty || pendingButtons.has('enqueue');
  $('enqueue').classList.toggle('btn-primary', blocked);
  $('run').classList.toggle('btn-primary', !blocked);
  $('submit-hint').textContent = blocked ? 'Enter 加入队列 · Shift + Enter 换行' : 'Enter 开始 · Shift + Enter 换行';
}
function resizeInput(input) { input.style.height = 'auto'; input.style.height = `${Math.min(180, Math.max(60, input.scrollHeight))}px`; }
for (const id of ['goal', 'follow-up', 'user-answer']) $(id).addEventListener('input', () => {
  resizeInput($(id)); $('composer-error').hidden = true; $('decision-error').hidden = true; updateComposer();
});
function render(state) {
  const previousBusy = current?.busy;
  renderGrants(state.permissions || []);
  if (state.extension) {
    $('extension-server').value = state.extension.serverURL || location.origin;
    $('extension-connection-hint').textContent = new URL($('extension-server').value).port === '4318' ? '扩展自动连接，无需配对。请保持 Chrome 和扩展运行。' : '当前中继端口不是 4318。请将 PORT / OBU_DESKTOP_PORT 改为 4318 并重启后台，扩展才能自动连接。';
    $('extension-dot').classList.toggle('offline', !state.extension.connected);
    $('extension-status').textContent = state.extension.connected ? `扩展已连接${state.extension.browser ? ` · ${(/Chrome\/[\d.]+/.exec(state.extension.browser) || [''])[0]}` : ''}` : '等待 Chrome 扩展自动连接';
  }
  current = state;
  renderQueue(state.queue);
  positionPointer();
  $('model-badge').textContent = state.config.model || '待配置';
  $('browser-badge').textContent = browserModes[state.config.browser.mode];
  $('connection').textContent = state.service?.ownership === 'external' ? '已连接独立服务' : '本地服务已连接';
  $('connection').title = state.service?.ownership === 'external' ? `${state.service.url} · 退出桌面不会停止服务或任务` : '退出应用会停止随桌面启动的后台'; $('connection-dot').classList.remove('offline');
  if (!configured) { showConfig(state.config); configured = true; }
  const t = state.task, busy = state.busy;
  $('demo').disabled = busy || Boolean(t?.sessionOpen) || Boolean(state.queue?.queued_count);
  $('save-config').disabled = busy || Boolean(t?.sessionOpen);
  $('save-browser').disabled = busy || Boolean(t?.sessionOpen); $('login-open').disabled = busy || Boolean(t?.sessionOpen);
  $('browser-locked').hidden = !$('save-browser').disabled;
  $('login-open').hidden = state.loginOpen; $('login-close').hidden = !state.loginOpen;
  $('pause').disabled = !t || !['running', 'starting'].includes(t.status);
  $('stop').disabled = !(busy || t?.sessionOpen) || t?.status === 'stopping';
  $('resume').hidden = t?.status !== 'paused'; $('pause').hidden = t?.status === 'paused';
  $('export').disabled = !t && !replay;
  // Which view the conversation pane shows: a replayed session, the current task, or the new-task screen.
  const showingTask = Boolean(t) && !replay && !composeNew;
  const managed = state.queue?.jobs.some(j => j.session_id === t?.id);
  const canChat = showingTask && t.sessionOpen && t.mode !== 'demo' && !managed && !['stopping', 'pausing', 'starting', 'approval', 'waiting_user'].includes(t.status);
  $('welcome').hidden = Boolean(replay) || showingTask;
  $('events').hidden = !replay && !showingTask;
  if (!replay && !showingTask) $('result-box').hidden = true;
  $('chat-title').textContent = replay ? replay.goal : showingTask ? t.goal : '新任务';
  $('task-composer').hidden = Boolean(replay) || showingTask;
  $('follow-up-box').hidden = !canChat;
  const contextVisible = Boolean((composeNew || replay) && (busy || t?.sessionOpen));
  $('task-context').hidden = !contextVisible;
  $('context-title').textContent = busy ? '当前任务仍在进行' : '当前浏览器会话仍然打开';
  $('context-description').textContent = busy ? (['approval', 'waiting_user'].includes(t?.status) ? '有一项操作需要你的回应。你也可以先起草下一项任务。' : '可以起草新任务并加入队列，当前任务不会被中断。') : '继续原任务请返回当前会话；新任务可以排队，或关闭当前会话后开始。';
  $('context-close').hidden = busy || !t?.sessionOpen;
  updateComposer();
  for (const id of pendingButtons) $(id).disabled = true;
  if (!t) { $('decision').hidden = true; return; }
  if (lastTask !== t.id) { lastImage = null; lastEventKey = ''; lastTask = t.id; }
  $('status').dataset.state = t.status;
  $('status').textContent = t.mode === 'demo' ? `演示 · ${t.status === 'done' ? '已完成' : states[t.status] || t.status}` : t.status === 'done' ? '本轮结束' : states[t.status] || t.status; $('status').classList.toggle('error', t.status === 'failed');
  const live = Date.now() - lastFrameAt < 3000 && t.sessionOpen;
  $('replay-recover').disabled = busy;
  $('step-count').textContent = `${t.step || 0} 次操作${t.progress ? ` · ${t.progress.stages.filter(s => s.status === 'done').length}/${t.progress.stages.length} 阶段` : ''}`;
  $('frame-label').textContent = !t.sessionOpen ? '会话已关闭' : live ? '实时画面' : '最近画面';
  $('browser-context-label').textContent = t.status === 'paused' ? '已暂停，可在浏览器中接管' : ['approval', 'waiting_user'].includes(t.status) ? '等待你的回应' : t.sessionOpen ? (t.snapshot?.title || '代理浏览器') : '上一会话画面';
  $('run-details-content').replaceChildren(...[
    ['模型服务', providerLabel[t.provider] || t.provider],
    ['上下文估算', t.context ? `${t.context.estimatedTokens} / ${t.context.contextWindow}` : '暂无'],
    ['历史压缩', `${t.context?.compactions || 0} 次`],
    ['最近请求', t.metrics?.requests?.length ? `${(t.metrics.requests.at(-1).durationMs / 1000).toFixed(1)} 秒` : '暂无'],
  ].map(([label, value]) => { const row = el('div', 'detail-row'); row.append(el('span', '', label), el('strong', '', value)); return row; }));
  $('page-url').textContent = t.snapshot?.url || '正在打开浏览器…';
  const screenshot = t.snapshot?.screenshot;
  if (!live && screenshot !== undefined && screenshot !== lastImage) { if (screenshot) $('screenshot').src = screenshot; else $('screenshot').removeAttribute('src'); lastImage = screenshot; }
  if (!live) { const visible = Boolean(screenshot || lastImage === 'frame'); $('screenshot').hidden = !visible; $('empty-state').hidden = visible; }
  if (t.status !== lastStatus || (previousBusy && !busy)) { if (['done', 'failed', 'stopped'].includes(t.status)) void loadHistory(); lastStatus = t.status; }
  if (showingTask) {
    renderEvents(t.events, t.result);
    $('result-box').hidden = !t.result; markdown($('result'), t.result);
  }
  // One chat box: steers a running task, continues an idle session.
  $('chat-label').textContent = t.status === 'paused' ? '补充说明（继续执行后生效）' : busy ? '补充说明（下一步生效）' : '继续对话';
  $('send').textContent = busy ? '发送补充' : '发送';
  $('close-session').hidden = busy;
  const approval = t.status === 'approval', question = t.status === 'waiting_user';
  $('decision').hidden = !showingTask || !(approval || question);
  if (!(approval || question)) $('decision-error').hidden = true;
  $('decision-title').textContent = question ? '需要你的帮助' : '确认下一步';
  $('decision-detail').textContent = approval || question ? pendingText(t.pending) : '';
  $('user-answer').hidden = !question; $('answer').hidden = !question; $('approve').hidden = !approval; $('reject').hidden = !approval;
  const site = approval ? t.pending?.site : null;
  $('approve-site').hidden = !(site && t.pending.needsSite); $('approve-site').textContent = site ? `始终允许 ${site}` : '';
  $('deny-site').hidden = !site; $('deny-site').textContent = site ? `禁止 ${site}` : '';
}
function offline() { $('connection').textContent = '服务连接中断'; $('connection-dot').classList.add('offline'); }
function connect() {
  const unsubscribe = window.desktop.subscribe(({ event, data }) => {
    if (event === 'state') render(data);
    else if (event === 'pointer') showPointer(data);
    else if (event === 'frame' && current?.task) showFrame(data);
    else if (event === 'offline') { offline(); if (data) toast(data); }
  });
  window.addEventListener('beforeunload', unsubscribe, { once: true });
}
async function loadHistory() {
  try { renderHistory((await api('sessions')).sessions); } catch (e) { toast(e.message); }
}
function renderHistory(sessions) {
  historyCache = sessions;
  const query = $('history-search').value.trim().toLocaleLowerCase();
  sessions = sessions.filter(s => s.goal.toLocaleLowerCase().includes(query));
  $('history-count').textContent = sessions.length ? String(sessions.length) : '';
  if (!sessions.length) { $('history-list').replaceChildren(el('p', 'muted small', query ? '没有匹配的会话。' : '完成任务后，会话会保存在这里。')); return; }
  $('history-list').replaceChildren(...sessions.map(s => {
    const row = el('div', 'history-row'); row.dataset.id = s.id;
    const item = el('button', `history-item ${s.status}${replay?.id === s.id ? ' active' : ''}`);
    item.title = s.goal;
    item.append(el('strong', '', s.goal), el('span', '', `${states[s.status]?.split(' ·')[0] || s.status} · ${new Date(s.updated).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`));
    item.onclick = () => { $('sidebar').classList.remove('open'); void openReplay(s.id); };
    row.append(item, deleteButton(s));
    return row;
  }));
}
$('history-search').addEventListener('input', () => renderHistory(historyCache));
// Deleting takes two clicks: the first turns the button into “确认删除” for a few seconds.
function deleteButton(session) {
  const button = el('button', 'history-delete');
  const reset = () => { clearTimeout(button.timer); button.classList.remove('confirm'); button.replaceChildren(trashIcon()); button.title = '删除会话'; };
  button.setAttribute('aria-label', `删除会话：${session.goal}`);
  reset();
  button.onblur = reset;
  button.onclick = async () => {
    if (!button.classList.contains('confirm')) {
      button.classList.add('confirm'); button.textContent = '确认删除'; button.title = '再点一次删除，无法恢复';
      button.timer = setTimeout(reset, 4000); return;
    }
    reset(); button.disabled = true;
    try {
      const { sessions } = await api('sessions/delete', { id: session.id });
      if (replay?.id === session.id) exitReplay();
      renderHistory(sessions); toast('会话已删除。');
    } catch (e) { button.disabled = false; toast(e.message); }
  };
  return button;
}
function trashIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10');
  svg.append(path); return svg;
}
async function openReplay(id) {
  try {
    replay = await api('sessions/page', { id });
    if (!replay) throw new Error('会话不存在。');
    $('replay-more').hidden = replay.nextOffset == null;
    $('replay-banner').hidden = false; $('replay-title').textContent = `正在回放已保存的会话 · ${new Date(replay.events[0]?.time || Date.now()).toLocaleString('zh-CN', { hour12: false })}`;
    lastEventKey = ''; renderEvents(replay.events, replay.result);
    $('result-box').hidden = !replay.result; markdown($('result'), replay.result);
    if (current) render(current);
    void loadHistory();
  } catch (e) { toast(e.message); }
}
function exitReplay() { replay = null; $('replay-banner').hidden = true; lastEventKey = ''; void loadHistory(); if (current) render(current); }
$('replay-exit').onclick = exitReplay;
handle('replay-more', async () => {
  if (!replay || replay.nextOffset == null) return;
  const id = replay.id;
  const page = await api('sessions/page', { id, offset: replay.nextOffset });
  if (!replay || replay.id !== id) return;
  replay.events.push(...page.events); replay.nextOffset = page.nextOffset;
  $('replay-more').hidden = page.nextOffset == null;
  lastEventKey = ''; renderEvents(replay.events, replay.result);
});
handle('replay-recover', async () => {
  if (!replay) return;
  await api('sessions/recover', { id: replay.id });
  composeNew = false; exitReplay(); toast('正在从检查点恢复并核验页面。');
});
$('new-task').onclick = () => {
  if (replay) exitReplay();
  composeNew = true; $('sidebar').classList.remove('open');
  if (current) render(current);
  $('goal').focus();
};
$('sidebar-toggle').onclick = () => $('sidebar').classList.toggle('open');

// Settings drawer with tabs (模型 / 浏览器 / 网站权限).
let drawerReturnFocus = null;
function showTab(tab) {
  document.querySelectorAll('.tabs button').forEach(b => {
    const selected = b.dataset.tab === tab; b.classList.toggle('active', selected);
    b.id ||= `tab-${b.dataset.tab}`; b.setAttribute('aria-controls', b.dataset.tab); b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1;
    $(b.dataset.tab).setAttribute('aria-labelledby', b.id);
  });
  document.querySelectorAll('.drawer-panel').forEach(p => { p.hidden = p.id !== tab; });
}
function openDrawer(tab = 'settings') {
  if ($('drawer').hidden) { drawerReturnFocus = document.activeElement; if (current) showConfig(current.config); }
  if (current?.queue?.settings) { const s = current.queue.settings; $('idle-timeout').value = s.idle_timeout_seconds; $('history-retention').value = s.history_retention_days; $('queue-capacity').value = s.max_queued_jobs; }
  showTab(tab); $('drawer').hidden = false; $('backdrop').hidden = false; document.querySelector('.app').inert = true;
  document.querySelector(`.tabs [data-tab="${tab}"]`).focus();
}
function closeDrawer() { $('drawer').hidden = true; $('backdrop').hidden = true; document.querySelector('.app').inert = false; drawerReturnFocus?.focus(); }
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
$('drawer-close').onclick = closeDrawer; $('backdrop').onclick = closeDrawer;
document.addEventListener('keydown', e => {
  if ($('drawer').hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
  const tabs = [...document.querySelectorAll('.tabs button')];
  if (tabs.includes(document.activeElement) && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.preventDefault(); const index = tabs.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    showTab(tabs[next].dataset.tab); tabs[next].focus();
  }
  if (e.key === 'Tab') {
    const items = [...$('drawer').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')].filter(n => n.tabIndex >= 0 && n.getClientRects().length);
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
$('settings-shortcut').onclick = () => openDrawer('settings');
$('model-chip').onclick = () => openDrawer('settings');
function handle(id, fn) {
  $(id).addEventListener('click', async () => {
    if (pendingButtons.has(id)) return;
    pendingButtons.add(id); $(id).disabled = true; $(id).setAttribute('aria-busy', 'true');
    try { await fn(); render(await api('state')); }
    catch (e) {
      const target = ['run', 'enqueue'].includes(id) ? $('composer-error') : ['answer', 'approve', 'reject', 'approve-site', 'deny-site'].includes(id) ? $('decision-error') : null;
      if (target) { target.textContent = e.message; target.hidden = false; } else toast(e.message);
    } finally { pendingButtons.delete(id); $(id).disabled = false; $(id).removeAttribute('aria-busy'); if (current) render(current); }
  });
}
$('provider').addEventListener('change', () => {
  syncProvider();
  $('vision').checked = $('provider').value === 'deepseek';
  // Switching service fills in that service's default address and model.
  const defaults = current?.config.defaults;
  if (defaults) { $('base-url').value = defaults.baseURL[$('provider').value] || ''; $('model').value = defaults.model[$('provider').value] || ''; }
});
handle('save-config', async () => {
  const config = await api('config', { contextWindow: Number($('context-window').value), outputReserve: Number($('output-reserve').value), provider: $('provider').value, baseURL: $('base-url').value.trim(), model: $('model').value.trim(), apiKey: $('api-key').value.trim(), clearKey: $('clear-key').checked, effort: $('effort').value, vision: $('vision').checked, reviewerModel: $('reviewer-model').value.trim() });
  $('api-key').value = ''; $('clear-key').checked = false; showConfig(config); toast('配置已保存到本机，重启后自动恢复。');
});
$('browser-mode').addEventListener('change', syncBrowserMode);
async function saveBrowser(message) {
  const config = await api('browser', { mode: $('browser-mode').value, blockedSites: $('blocked-sites').value.split(/\s+/).map(x => x.trim()).filter(Boolean) });
  showBrowserConfig(config.browser);
  $('model-migration').hidden = !config.modelRequiresSelection; toast(message);
}
handle('save-browser', () => saveBrowser('浏览器设置已保存。'));
handle('save-blocked', () => saveBrowser('受保护网站已保存。'));
handle('login-open', () => api('login', { action: 'open' }));
handle('login-close', () => api('login', { action: 'close' }));
async function start(demo) {
  if (!demo && !current?.config.model) { openDrawer('settings'); $('model').focus(); throw new Error('先填写模型设置并保存，再开始 AI 任务。'); }
  const goal = demo ? '在演示商店搜索键盘，并读取搜索结果。' : $('goal').value.trim();
  if (!goal) { $('goal').focus(); throw new Error('请先描述任务目标。'); }
  await api('tasks', { goal, permissionMode: $('permission-mode').value, demo });
  composeNew = false; if (replay) exitReplay();
  if (!demo) $('goal').value = '';
}
handle('enqueue', async () => {
  if (!current?.config.model) { openDrawer('settings'); $('model').focus(); throw new Error('请先配置模型，再提交任务。'); }
  const goal = $('goal').value.trim(); if (!goal) throw new Error('请先描述任务目标。');
  const button = $('enqueue'); button.disabled = true;
  try { await api('jobs', { goal, permission_mode: $('permission-mode').value }); $('goal').value = ''; $('queue-panel').open = true; toast('已加入队列'); }
  finally { button.disabled = false; }
});
handle('save-lifecycle', async () => {
  await api('lifecycle', { idle_timeout_seconds: Number($('idle-timeout').value), history_retention_days: Number($('history-retention').value), max_queued_jobs: Number($('queue-capacity').value) });
  toast('会话与队列设置已保存');
});
handle('run', () => start(false)); handle('demo', () => start(true));
for (const command of ['pause', 'resume', 'stop', 'approve', 'reject']) handle(command, () => api('control', { command }));
handle('close-session', () => api('control', { command: 'stop' }));
handle('context-close', () => api('control', { command: 'stop' }));
handle('queue-release', () => api('control', { command: 'stop' }));
handle('approve-site', () => api('control', { command: 'approve_site' }));
handle('deny-site', () => api('control', { command: 'deny_site' }));
$('mode-hint').textContent = modeHints[$('permission-mode').value];
$('permission-mode').addEventListener('change', () => { $('mode-hint').textContent = modeHints[$('permission-mode').value]; });
handle('answer', async () => { await api('control', { command: 'resume', answer: $('user-answer').value }); $('user-answer').value = ''; });
handle('send', async () => { await api('messages', { text: $('follow-up').value }); $('follow-up').value = ''; });
document.querySelectorAll('[data-goal]').forEach(button => button.onclick = () => { $('goal').value = button.dataset.goal; resizeInput($('goal')); updateComposer(); $('goal').focus(); });
// Enter sends from either composer; Shift+Enter adds a line.
for (const [input, button] of [['goal', 'run'], ['follow-up', 'send']]) $(input).addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $(input === 'goal' && $('run').disabled ? 'enqueue' : button).click(); } });
$('export').onclick = async () => { try { const result = await window.desktop.exportSession(replay?.id || null); if (!result.canceled) toast('会话已导出。'); } catch (e) { toast(e.message); } };
$('open-extension-directory').hidden = false;
$('open-extension-directory').onclick = () => window.desktop.openExtensionDirectory().catch(e => toast(e.message));
showTab('settings');
connect();
void loadHistory();
