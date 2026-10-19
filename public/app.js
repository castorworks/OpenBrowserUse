const $ = id => document.getElementById(id);
let current = null, configured = false, lastImage = null, lastEventKey = '', lastTask = null;
const states = { starting: '启动浏览器', running: '执行中', pausing: '正在暂停', paused: '已暂停 · 可接管', approval: '等待确认', waiting_user: '需要你的帮助', stopping: '正在停止', stopped: '已停止', done: '已完成', failed: '执行失败' };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 6500); }
async function api(path, data) {
  const res = await fetch(`/api/${path}`, data ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Browser-Agent': '1' }, body: JSON.stringify(data) } : {});
  const body = await res.json(); if (!res.ok) throw new Error(body.error || '请求失败'); return body;
}
function showConfig(config) {
  $('base-url').value = config.baseURL; $('model').value = config.model; $('vision').checked = config.vision; $('json-mode').checked = config.jsonMode;
  $('model-badge').textContent = config.model || '待配置'; $('key-status').textContent = config.hasKey ? '· 已配置，留空保留' : '· 尚未配置';
}
function render(state) {
  current = state;
  $('connection').textContent = '本地服务已连接'; $('connection-dot').classList.remove('offline');
  if (!configured) { showConfig(state.config); configured = true; }
  const t = state.task, busy = state.busy;
  for (const id of ['run', 'demo', 'save-config']) $(id).disabled = busy;
  $('pause').disabled = !t || !['running', 'starting'].includes(t.status);
  $('stop').disabled = !busy || t?.status === 'stopping';
  $('resume').hidden = t?.status !== 'paused'; $('pause').hidden = t?.status === 'paused';
  $('export').disabled = !t;
  if (!t) return;
  if (lastTask !== t.id) { lastImage = null; lastEventKey = ''; lastTask = t.id; }
  $('status').textContent = `${t.mode === 'demo' ? '演示 · ' : ''}${states[t.status] || t.status}`; $('status').classList.toggle('error', t.status === 'failed');
  $('step-count').textContent = `步骤 ${t.step} / ${t.maxSteps} · ${t.mode === 'demo' ? '固定脚本演示' : 'AI 决策'} · 截图随步骤更新`;
  $('page-url').textContent = t.snapshot?.url || '正在打开浏览器…';
  const screenshot = t.snapshot?.screenshot;
  if (screenshot !== lastImage) { if (screenshot) $('screenshot').src = screenshot; else $('screenshot').removeAttribute('src'); lastImage = screenshot; }
  $('screenshot').hidden = !screenshot; $('empty-state').hidden = Boolean(screenshot);
  const eventKey = JSON.stringify(t.events);
  if (lastEventKey !== eventKey) {
    const nearEnd = $('events').scrollTop + $('events').clientHeight >= $('events').scrollHeight - 45;
    $('events').replaceChildren(...t.events.map(e => { const div = document.createElement('div'); div.className = `event ${e.kind}`; const time = document.createElement('time'); time.textContent = new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false }); const text = document.createElement('span'); text.textContent = e.message; div.append(time, text); return div; }));
    if (nearEnd) $('events').scrollTop = $('events').scrollHeight;
    lastEventKey = eventKey;
  }
  $('result-box').hidden = !t.result; $('result').textContent = t.result;
  const approval = t.status === 'approval', question = t.status === 'waiting_user';
  $('decision').hidden = !(approval || question);
  $('decision-title').textContent = question ? '需要你的帮助' : '确认下一步';
  $('decision-detail').textContent = question ? t.pending.question : approval ? `${t.pending.reason}\n动作：${t.pending.type} · 目标：${t.pending.target}${t.pending.text != null ? `\n输入内容：${t.pending.text}` : ''}${t.pending.value != null ? `\n选项：${t.pending.value}` : ''}${t.pending.key ? `\n按键：${t.pending.key}` : ''}` : '';
  $('user-answer').hidden = !question; $('answer').hidden = !question; $('approve').hidden = !approval; $('reject').hidden = !approval;
}
async function poll() { try { render(await api('state')); } catch { $('connection').textContent = '服务连接中断'; $('connection-dot').classList.add('offline'); } finally { setTimeout(poll, 1000); } }
function handle(id, fn) { $(id).addEventListener('click', async () => { $(id).disabled = true; try { await fn(); render(await api('state')); } catch (e) { toast(e.message); } finally { $(id).disabled = false; if (current) render(current); } }); }
handle('save-config', async () => {
  const config = await api('config', { baseURL: $('base-url').value.trim(), model: $('model').value.trim(), apiKey: $('api-key').value.trim(), clearKey: $('clear-key').checked, vision: $('vision').checked, jsonMode: $('json-mode').checked });
  $('api-key').value = ''; $('clear-key').checked = false; showConfig(config); toast('配置已保存到本地服务内存。');
});
async function start(demo) {
  if (!demo && !current?.config.model) { $('settings').open = true; $('model').focus(); throw new Error('先填写模型设置并保存，再开始 AI 任务。'); }
  const goal = demo ? '在演示商店搜索键盘，并读取搜索结果。' : $('goal').value.trim();
  if (!goal) { $('goal').focus(); throw new Error('请先描述任务目标。'); }
  await api('tasks', { goal, startURL: $('start-url').value.trim(), maxSteps: Number($('max-steps').value), autoInteract: $('auto-interact').checked, demo });
}
handle('run', () => start(false)); handle('demo', () => start(true));
for (const command of ['pause', 'resume', 'stop', 'approve', 'reject']) handle(command, () => api('control', { command }));
handle('answer', async () => { await api('control', { command: 'resume', answer: $('user-answer').value }); $('user-answer').value = ''; });
$('settings-shortcut').onclick = () => { $('settings').open = true; $('settings').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
document.querySelectorAll('[data-goal]').forEach(button => button.onclick = () => { $('goal').value = button.dataset.goal; $('start-url').value = button.dataset.url; });
$('export').onclick = () => { const t = current?.task; if (!t) return; const data = { ...t, snapshot: t.snapshot ? { ...t.snapshot, screenshot: undefined } : null }; const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `browser-use-${t.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
poll();
