document.getElementById('openBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = chrome.runtime.getURL('save.html') + `?tabId=${tab.id}&pageUrl=${encodeURIComponent(tab.url)}&title=${encodeURIComponent(tab.title || 'page')}`;
  chrome.tabs.create({ url });
  window.close();
});
