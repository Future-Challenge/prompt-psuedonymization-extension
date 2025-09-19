// content.js
(function inject() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

window.addEventListener('message', async (e) => {
  const d = e.data;
  if (!d || (d.type !== 'PII_PROXY_FETCH' && d.type !== 'PII_PROXY_XHR')) return;

  const replyType = d.type === 'PII_PROXY_FETCH' ? 'PII_PROXY_FETCH_RESULT' : 'PII_PROXY_XHR_RESULT';
  try {
    const resp = await chrome.runtime.sendMessage({ kind: d.type, payload: d });
    window.postMessage({ type: replyType, msgId: d.msgId, ...resp }, '*');
  } catch (err) {
    window.postMessage({ type: replyType, msgId: d.msgId, ok: false }, '*');
  }
});