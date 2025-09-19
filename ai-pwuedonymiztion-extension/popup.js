// popup.js

const API = 'http://127.0.0.1:5000/prompt_logs';

const $ = (id) => document.getElementById(id);
const bySel = (root, sel) => root.querySelector(sel);

function fmtTime(t) {
  return t || '';
}

/** detection.items를 사용해 프롬프트 치환 미리보기 생성 (과치환 방지: 항목별 1회) */
function buildMaskedPreview(original, items) {
  if (!original || !Array.isArray(items) || !items.length) return original || '';
  let out = String(original);
  // index 신뢰 어려울 수 있어 value→token 1회 치환 위주
  for (const it of items) {
    const val = it?.value || '';
    const tok = it?.token || '';
    if (!val || !tok) continue;
    // 첫 매치만 치환
    const re = new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'); // escape
    out = out.replace(re, tok);
  }
  return out;
}

function renderLogs(logsObj) {
  const host = $('reqList');
  const ts = $('ts');
  host.innerHTML = '';

  const rows = Array.isArray(logsObj?.logs) ? logsObj.logs : [];
  if (!rows.length) {
    host.innerHTML = `<div class="muted">아직 로그가 없습니다.</div>`;
    ts.textContent = '';
    return;
  }

  const tpl = /** @type {HTMLTemplateElement} */ (document.getElementById('row-tpl'));
  rows.slice().reverse().forEach(r => {
    const frag = tpl.content.cloneNode(true);

    const badge = bySel(frag, '[data-badge]');
    const promptSpan = bySel(frag, '[data-prompt]');
    const timeSpan = bySel(frag, '[data-time]');
    const detWrap = bySel(frag, '[data-detection]');
    const mapWrap = bySel(frag, '[data-mapping]');
    const toggleBtn = bySel(frag, '[data-toggle-masked]');
    const maskedPre = bySel(frag, '[data-masked]');

    const prompt = r?.input?.prompt || '';
    const time = r?.time || '';
    const items = Array.isArray(r?.detection?.items) ? r.detection.items : [];

    // 배지
    const contains = !!r?.detection?.contains_pii;
    badge.textContent = contains ? 'PII' : 'NO-PII';
    badge.classList.add(contains ? 'warn' : 'ok');

    promptSpan.textContent = prompt;
    timeSpan.textContent = fmtTime(time);

    // 탐지 상세 테이블
    if (!items.length) {
      detWrap.innerHTML = `<div class="muted">탐지 결과 없음</div>`;
      mapWrap.innerHTML = '';
    } else {
      const fragItems = document.createDocumentFragment();
      items.forEach((it, idx) => {
        const box = document.createElement('div');
        box.className = 'item';
        box.innerHTML = `
          <div class="grid">
            <div><b>#${idx + 1} Type</b></div><div>${it.type || '-'}</div>
            <div><b>Value</b></div><div class="mono">${it.value || ''}</div>
            <div><b>Token</b></div><div class="mono">${it.token || ''}</div>
            <div><b>Index</b></div><div>${Number.isFinite(it.start) ? it.start : 0} ~ ${Number.isFinite(it.end) ? it.end : 0}</div>
          </div>
        `;
        fragItems.appendChild(box);
      });
      detWrap.appendChild(fragItems);

      // 매핑 리스트 (무엇이 → 무엇으로)
      const list = document.createElement('div');
      items.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'map-row';
        row.innerHTML = `
          <span class="tag">${it.type || '-'}</span>
          <span class="mono">${it.value || ''}</span>
          <span class="arrow">→</span>
          <span class="mono">${it.token || ''}</span>
        `;
        list.appendChild(row);
      });
      mapWrap.innerHTML = ''; // 초기화
      mapWrap.appendChild(list);
    }

    // 가명화 미리보기 토글
    toggleBtn?.addEventListener('click', () => {
      const visible = maskedPre.style.display !== 'none';
      if (visible) {
        maskedPre.style.display = 'none';
        toggleBtn.textContent = '가명화된 문장 보기';
      } else {
        const preview = buildMaskedPreview(prompt, items);
        maskedPre.textContent = preview;
        maskedPre.style.display = 'block';
        toggleBtn.textContent = '가명화된 문장 숨기기';
      }
    });

    host.appendChild(frag);
  });

  // 상단 타임스탬프
  ts.textContent = fmtTime(rows[rows.length - 1]?.time || '');
}

async function load() {
  try {
    const res = await fetch(API, { method: 'GET' });
    const text = await res.text();
    let obj;
    try { obj = JSON.parse(text); } catch { obj = { logs: [] }; }
    renderLogs(obj);
  } catch (e) {
      const host = $('reqList');
      const ts = $('ts');
      if (host) host.innerHTML = `<div class="muted">백엔드 연결 실패: ${e}</div>`;
      if (ts) ts.textContent = '';
      console.warn('[popup] backend connection failed:', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('refresh').addEventListener('click', load);
  load();
});
