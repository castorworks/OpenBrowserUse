const $ = id => document.getElementById(id);
const labels = { connected: '已连接', connecting: '连接中', disconnected: '未连接', unpaired: '未配对', error: '错误' };

function show({ status, error }) {
  $('status').textContent = labels[status] || status;
  $('status').className = `pill ${status}`;
  $('error').hidden = !error; $('error').textContent = error || '';
  if (status === 'unpaired') $('pair').hidden = false;
  const connected = status === 'connected';
  $('open-desktop').disabled = !connected; $('offline').hidden = connected || status === 'unpaired';
}

chrome.storage.local.get(['server', 'token']).then(({ server, token }) => { if (server) $('server').value = server; if (token) $('token').value = token; });
chrome.runtime.sendMessage({ type: 'get-status' }).then(show).catch(() => {});
chrome.runtime.onMessage.addListener(message => { if (message?.type === 'status') show(message); });
$('toggle-pair').onclick = () => { $('pair').hidden = !$('pair').hidden; };
$('pair').onsubmit = async event => {
  event.preventDefault();
  await chrome.storage.local.set({ server: $('server').value.trim().replace(/\/$/, ''), token: $('token').value.trim() });
  $('pair').hidden = true;
};

$('open-desktop').onclick = async () => {
  try { const result = await chrome.runtime.sendMessage({ type: 'open-desktop' }); if (!result?.ok) throw new Error('请先启动并连接桌面应用。'); }
  catch (error) { $('error').hidden = false; $('error').textContent = error.message; $('pair').hidden = false; }
};
