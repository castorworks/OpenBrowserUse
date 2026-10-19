const $ = id => document.getElementById(id);
let current = null, configured = false, lastImage = null, lastEventKey = '', lastTask = null, lastFrameAt = 0, replay = null, lastStatus = '';
const states = { starting: '启动浏览器', running: '执行中', pausing: '正在暂停', paused: '已暂停 · 可接管', approval: '等待确认', waiting_user: '需要你的帮助', stopping: '正在停止', stopped: '已停止', done: '已完成 · 可继续', failed: '执行失败' };
const providerLabel = { anthropic: 'Claude', openai: 'OpenAI 兼容', demo: '固定脚本演示' };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 6500); }
async function api(path, data) {
  const res = await fetch(`/api/${path}`, data ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Browser-Agent': '1' }, body: JSON.stringify(data) } : {});
  const body = await res.json(); if (!res.ok) throw new Error(body.error || '请求失败'); return body;
}
function syncProvider() {
  const anthropic = $('provider').value === 'anthropic';
  document.querySelectorAll('.provider-anthropic').forEach(el => el.hidden = !anthropic);
  document.querySelectorAll('.provider-openai').forEach(el => el.hidden = anthropic);
  $('base-url').placeholder = anthropic ? '留空使用 Anthropic 官方地址' : 'https://api.openai.com/v1';
  $('base-url-hint').textContent = anthropic ? '（可选）' : '（含 /v1，不含 /chat/completions）';
  $('model').placeholder = anthropic ? '例如 claude-opus-5-5' : '服务商提供的模型 ID';
}
const browserModes = { ephemeral: '独立会话', persistent: '持久化配置', cdp: '连接 Chrome' };
function syncBrowserMode() {
  const mode = $('browser-mode').value;
  document.querySelectorAll('.browser-persistent').forEach(el => el.hidden = mode !== 'persistent');
  document.querySelectorAll('.browser-cdp').forEach(el => el.hidden = mode !== 'cdp');
}
function showBrowserConfig(b) {
  $('blocked-sites').value = (b.blockedSites || []).join('\n');
  $('browser-mode').value = b.mode; $('cdp-url').value = b.cdpURL || ''; $('allow-localhost').checked = b.allowLocalhost; $('allow-private').checked = b.allowPrivateNetwork;
  $('browser-badge').textContent = browserModes[b.mode]; syncBrowserMode();
}
function showConfig(config) {
  showBrowserConfig(config.browser);
  $('provider').value = config.provider; $('base-url').value = config.baseURL; $('model').value = config.model;
  $('effort').value = config.effort; $('vision').checked = config.vision; $('reviewer-model').value = config.reviewerModel || ''; syncProvider();
  $('model-badge').textContent = config.model || '待配置';
  $('key-status').textContent = config.hasKey ? '· 已配置，留空保留' : config.envKey ? '· 使用环境变量' : '· 尚未配置';
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
  skip: '不再确认（脚本和受保护网站除外）。只用于你完全信任的任务。',
};
let lastGrants = '';
function renderGrants(list) {
  const key = JSON.stringify(list);
  if (key === lastGrants) return; lastGrants = key;
  if (!list.length) { $('site-grants').innerHTML = '<p class="hint">还没有保存的网站权限。</p>'; return; }
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
// Chat transcript: user and agent messages as bubbles, each tool call as a collapsible card.
function renderEvents(events) {
  const key = JSON.stringify(events);
  if (key === lastEventKey) return;
  lastEventKey = key;
  const box = $('events');
  const nearEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 45;
  if (!events.length) { box.replaceChildren(el('p', 'empty-log', '你的目标、代理的说明和每次工具调用会显示在这里。')); return; }
  box.replaceChildren(...events.map(e => {
    const time = new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false });
    if (e.kind === 'user' || e.kind === 'assistant') {
      const bubble = el('div', `bubble ${e.kind}`); bubble.append(el('p', '', e.message), el('time', '', time)); return bubble;
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
  }));
  if (nearEnd) box.scrollTop = box.scrollHeight;
}
function showFrame(data) {
  lastFrameAt = Date.now();
  $('screenshot').src = `data:image/jpeg;base64,${data}`; lastImage = 'frame';
  $('screenshot').hidden = false; $('empty-state').hidden = true;
}
function render(state) {
  renderGrants(state.permissions || []);
  current = state;
  $('connection').textContent = '本地服务已连接'; $('connection-dot').classList.remove('offline');
  if (!configured) { showConfig(state.config); configured = true; }
  const t = state.task, busy = state.busy;
  for (const id of ['run', 'demo', 'save-config']) $(id).disabled = busy;
  $('save-browser').disabled = busy || Boolean(t?.sessionOpen); $('login-open').disabled = busy || Boolean(t?.sessionOpen);
  $('login-open').hidden = state.loginOpen; $('login-close').hidden = !state.loginOpen;
  $('pause').disabled = !t || !['running', 'starting'].includes(t.status);
  $('stop').disabled = !(busy || t?.sessionOpen) || t?.status === 'stopping';
  $('resume').hidden = t?.status !== 'paused'; $('pause').hidden = t?.status === 'paused';
  $('export').disabled = !t && !replay;
  if (!t) return;
  if (lastTask !== t.id) { lastImage = null; lastEventKey = ''; lastTask = t.id; }
  $('status').textContent = t.mode === 'demo' ? `演示 · ${t.status === 'done' ? '已完成' : states[t.status] || t.status}` : states[t.status] || t.status; $('status').classList.toggle('error', t.status === 'failed');
  const live = Date.now() - lastFrameAt < 3000 && t.sessionOpen;
  $('step-count').textContent = `动作 ${t.step} / ${t.maxSteps} · ${providerLabel[t.provider] || t.provider} · ${live ? '实时画面' : '截图随步骤更新'}`;
  $('page-url').textContent = t.snapshot?.url || '正在打开浏览器…';
  const screenshot = t.snapshot?.screenshot;
  if (!live && screenshot !== lastImage) { if (screenshot) $('screenshot').src = screenshot; else $('screenshot').removeAttribute('src'); lastImage = screenshot; }
  if (!live) { $('screenshot').hidden = !screenshot; $('empty-state').hidden = Boolean(screenshot); }
  if (t.status !== lastStatus) { if (['done', 'failed', 'stopped'].includes(t.status) && $('history').open) void loadHistory(); lastStatus = t.status; }
  if (!replay) {
    renderEvents(t.events);
    $('result-box').hidden = !t.result; $('result').textContent = t.result;
  }
  // One chat box: steers a running task, continues an idle session.
  const canChat = !replay && t.sessionOpen && t.mode !== 'demo' && !['stopping', 'pausing', 'starting'].includes(t.status);
  $('follow-up-box').hidden = !canChat;
  $('chat-label').textContent = busy ? '补充说明（下一步生效）' : '继续对话';
  $('send').textContent = busy ? '发送补充' : '发送';
  $('close-session').hidden = busy;
  const approval = t.status === 'approval', question = t.status === 'waiting_user';
  $('decision').hidden = !(approval || question);
  $('decision-title').textContent = question ? '需要你的帮助' : '确认下一步';
  $('decision-detail').textContent = approval || question ? pendingText(t.pending) : '';
  $('user-answer').hidden = !question; $('answer').hidden = !question; $('approve').hidden = !approval; $('reject').hidden = !approval;
  const site = approval ? t.pending?.site : null;
  $('approve-site').hidden = !(site && t.pending.needsSite); $('approve-site').textContent = site ? `始终允许 ${site}` : '';
  $('deny-site').hidden = !site; $('deny-site').textContent = site ? `禁止 ${site}` : '';
}
function offline() { $('connection').textContent = '服务连接中断'; $('connection-dot').classList.add('offline'); }
async function poll() { try { render(await api('state')); } catch { offline(); } finally { if (!window.EventSource) setTimeout(poll, 1000); } }
// Live updates over server-sent events; the browser reconnects on its own after errors.
function connect() {
  if (!window.EventSource) return poll();
  const source = new EventSource('/api/events');
  source.addEventListener('state', e => render(JSON.parse(e.data)));
  source.addEventListener('frame', e => { if (current?.task?.sessionOpen) showFrame(e.data); });
  source.onerror = offline;
}
async function loadHistory() {
  try {
    const { sessions } = await api('sessions');
    $('history-count').textContent = sessions.length ? `${sessions.length} 个` : '';
    if (!sessions.length) { $('history-list').replaceChildren(el('p', 'hint', '还没有保存的会话。')); return; }
    $('history-list').replaceChildren(...sessions.map(s => {
      const row = el('div', 'grant');
      const open = el('button', 'text-button history-open', s.goal.slice(0, 60)); open.title = s.goal;
      open.onclick = () => openReplay(s.id);
      row.append(open, el('em', s.status === 'failed' ? 'deny' : '', `${states[s.status] || s.status} · ${new Date(s.updated).toLocaleString('zh-CN', { hour12: false })}`));
      return row;
    }));
  } catch (e) { toast(e.message); }
}
async function openReplay(id) {
  try {
    replay = await api(`sessions/${id}`);
    $('replay-banner').hidden = false; $('replay-title').textContent = `回放：${replay.goal.slice(0, 80)}`;
    lastEventKey = ''; renderEvents(replay.events);
    $('result-box').hidden = !replay.result; $('result').textContent = replay.result;
    if (current) render(current);
  } catch (e) { toast(e.message); }
}
$('replay-exit').onclick = () => { replay = null; $('replay-banner').hidden = true; lastEventKey = ''; if (current) render(current); };
$('history').addEventListener('toggle', () => { if ($('history').open) void loadHistory(); });
function handle(id, fn) { $(id).addEventListener('click', async () => { $(id).disabled = true; try { await fn(); render(await api('state')); } catch (e) { toast(e.message); } finally { $(id).disabled = false; if (current) render(current); } }); }
$('provider').addEventListener('change', () => {
  syncProvider();
  if ($('provider').value === 'anthropic' && !$('model').value) $('model').value = 'claude-opus-5-5';
  if ($('provider').value === 'openai' && $('model').value.startsWith('claude-')) $('model').value = '';
});
handle('save-config', async () => {
  const config = await api('config', { provider: $('provider').value, baseURL: $('base-url').value.trim(), model: $('model').value.trim(), apiKey: $('api-key').value.trim(), clearKey: $('clear-key').checked, effort: $('effort').value, vision: $('vision').checked, reviewerModel: $('reviewer-model').value.trim() });
  $('api-key').value = ''; $('clear-key').checked = false; showConfig(config); toast('配置已保存到本地服务内存。');
});
$('browser-mode').addEventListener('change', syncBrowserMode);
handle('save-browser', async () => {
  const config = await api('browser', { mode: $('browser-mode').value, cdpURL: $('cdp-url').value.trim(), allowLocalhost: $('allow-localhost').checked, allowPrivateNetwork: $('allow-private').checked, blockedSites: $('blocked-sites').value.split(/\s+/).map(x => x.trim()).filter(Boolean) });
  showBrowserConfig(config.browser); toast('浏览器设置已保存。');
});
handle('login-open', () => api('login', { action: 'open', url: $('start-url').value.trim() || undefined }));
handle('login-close', () => api('login', { action: 'close' }));
async function start(demo) {
  if (!demo && !current?.config.model) { $('settings').open = true; $('model').focus(); throw new Error('先填写模型设置并保存，再开始 AI 任务。'); }
  const goal = demo ? '在演示商店搜索键盘，并读取搜索结果。' : $('goal').value.trim();
  if (!goal) { $('goal').focus(); throw new Error('请先描述任务目标。'); }
  await api('tasks', { goal, startURL: $('start-url').value.trim(), maxSteps: Number($('max-steps').value), permissionMode: $('permission-mode').value, demo });
}
handle('run', () => start(false)); handle('demo', () => start(true));
for (const command of ['pause', 'resume', 'stop', 'approve', 'reject']) handle(command, () => api('control', { command }));
handle('close-session', () => api('control', { command: 'stop' }));
handle('approve-site', () => api('control', { command: 'approve_site' }));
handle('deny-site', () => api('control', { command: 'deny_site' }));
$('permission-mode').addEventListener('change', () => { $('mode-hint').textContent = modeHints[$('permission-mode').value]; });
handle('answer', async () => { await api('control', { command: 'resume', answer: $('user-answer').value }); $('user-answer').value = ''; });
handle('send', async () => { await api('messages', { text: $('follow-up').value }); $('follow-up').value = ''; });
$('settings-shortcut').onclick = () => { $('settings').open = true; $('settings').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
document.querySelectorAll('[data-goal]').forEach(button => button.onclick = () => { $('goal').value = button.dataset.goal; $('start-url').value = button.dataset.url; });
$('export').onclick = () => { const t = replay || current?.task; if (!t) return; const data = { ...t, snapshot: t.snapshot ? { ...t.snapshot, screenshot: undefined } : null }; const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `browser-use-${t.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
connect();
