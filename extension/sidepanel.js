const $ = id => document.getElementById(id);
const labels = { connected: '已连接', connecting: '连接中', disconnected: '等待本机服务', error: '错误' };

function show({ status, error }) {
  $('status').textContent = labels[status] || status;
  $('status').className = `pill ${status}`;
  $('error').hidden = !error; $('error').textContent = error || '';
  const connected = status === 'connected';
  $('open-desktop').disabled = !connected; $('offline').hidden = connected;
}

chrome.runtime.sendMessage({ type: 'get-status' }).then(show).catch(() => {});
chrome.runtime.onMessage.addListener(message => { if (message?.type === 'status') show(message); });
$('open-desktop').onclick = async () => {
  try { const result = await chrome.runtime.sendMessage({ type: 'open-desktop' }); if (!result?.ok) throw new Error('请先启动并连接桌面应用。'); }
  catch (error) { $('error').hidden = false; $('error').textContent = error.message; }
};
