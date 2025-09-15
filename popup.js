// popup.js
const $ = (id)=>document.getElementById(id);

function fill(d) {
  const { original, pseudonymized, url, time, contains_pii, changes } = d || {};
  $('orig').value = original || '';
  $('pseudo').value = pseudonymized || '';
  $('u').textContent = url || '-';
  $('ts').textContent = time ? new Date(time).toLocaleString() : '';

  const report = Array.isArray(changes) && changes.length
    ? changes.map(c => `- ${c.type}: "${c.original}" → "${c.replaced_with}"`).join('\n')
    : (contains_pii ? '(개인정보 감지됨, 변경내역 없음)' : '(개인정보 없음)');
  const diff = document.getElementById('diff');
  if (diff) diff.textContent = report;
}

async function loadLast() {
  // 1) 서비스워커에 요청
  try {
    const resp = await chrome.runtime.sendMessage({ kind: 'GET_LAST_PROMPT' });
    if (resp?.ok) { fill(resp.data || null); return; }
  } catch (_) {}
  // 2) 폴백: 스토리지 직접 조회
  try {
    const v = await chrome.storage.local.get('lastPrompt');
    fill(v.lastPrompt || null);
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  loadLast();

  // lastPrompt가 갱신될 때 자동 반영
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.lastPrompt) {
      fill(changes.lastPrompt.newValue || null);
    }
  });

  // 기록 지우기
  $('clear').onclick = async () => {
    await chrome.runtime.sendMessage({ kind: 'CLEAR_LAST_PROMPT' });
    fill(null);
  };

  // 복사
  $('copyOrig').onclick   = async () => { try { await navigator.clipboard.writeText($('orig').value || ''); } catch {} };
  $('copyPseudo').onclick = async () => { try { await navigator.clipboard.writeText($('pseudo').value || ''); } catch {} };
});
