const $ = id => document.getElementById(id);
const labels = { connected: '已连接', connecting: '连接中', disconnected: '未连接', unpaired: '未配对', error: '错误' };

function show({ status, error }) {
  $('status').textContent = labels[status] || status;
  $('status').className = `pill ${status}`;
  $('error').hidden = !error; $('error').textContent = error || '';
  if (status === 'unpaired') $('pair').hidden = false;
  const connected = status === 'connected';
  $('workbench').hidden = !connected; $('offline').hidden = connected || status === 'unpaired';
  if (connected && !$('workbench').src) chrome.storage.local.get('server').then(({ server }) => { $('workbench').src = server || 'http://127.0.0.1:4318'; });
  if (!connected) $('workbench').removeAttribute('src');
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
