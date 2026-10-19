document.getElementById('search-form').addEventListener('submit', event => {
  event.preventDefault(); const query = document.getElementById('query').value.trim(); let count = 0;
  document.querySelectorAll('[data-name]').forEach(card => { card.hidden = !card.textContent.includes(query); if (!card.hidden) count++; });
  document.getElementById('search-state').textContent = `搜索结果：${query || '全部'} · ${count} 件`;
});
