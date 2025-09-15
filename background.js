// background.js
const STATE = {
  maps: {},
  lastPrompt: null
};

// 서비스워커 기동 시 저장값 로드(콜드 스타트 대비)
chrome.storage.local.get(['lastPrompt'], v => {
  if (v.lastPrompt) STATE.lastPrompt = v.lastPrompt;
});

// ✅ 스토리지 변경 실시간 반영 (local만 사용)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.lastPrompt && changes.lastPrompt.newValue) {
    STATE.lastPrompt = changes.lastPrompt.newValue; // 동기화
  }
});

// 메시지 핸들러
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.kind === 'GET_LAST_PROMPT') {
    return sendResponse({ ok: true, data: STATE.lastPrompt });
  }
  if (msg?.kind === 'CLEAR_LAST_PROMPT') {
    STATE.lastPrompt = null;
    chrome.storage.local.remove('lastPrompt');
    return sendResponse({ ok: true });
  }
  if (msg?.kind !== 'PII_PROXY_FETCH' && msg?.kind !== 'PII_PROXY_XHR') {
    return sendResponse({ ok: false });
  }

  (async () => {
    try {
      const { url, method, headers, bodyText } = msg.payload || {};

      // 1) 요청 파싱 & 텍스트 추출
      let reqBody; try { reqBody = bodyText ? JSON.parse(bodyText) : {}; } catch { reqBody = {}; }
      let extraction = null;
      try { extraction = extractTextForPseudonymization(url, reqBody); } catch {}
      const joined = extraction?.joinedText ?? (typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody));
      const adapter = extraction?.adapter ?? { injectPseudonymized: (b, _s) => b };

      // 2) lastPrompt 초기 기록
      STATE.lastPrompt = {
        time: new Date().toISOString(),
        url,
        original: joined || '',
        pseudonymized: joined || ''
      };
      chrome.storage.local.set({ lastPrompt: STATE.lastPrompt });

      // 3) ✅ Ollama로 포함여부 판단 + 가명화 + 변경내역 (항상 호출)
      const oll = await askOllamaPseudonymizeReport(joined);

      // 실패 시 원문 그대로, 성공 시 가명화 결과 사용
      const sanitized =
        (oll && typeof oll.pseudonymized_text === 'string' && oll.pseudonymized_text.length > 0)
          ? oll.pseudonymized_text
          : joined;

      // 역복원 매핑은 현재 미사용(토큰 기반 가명화)
      const mapping = new Map();

      // 4) lastPrompt 갱신 (변경내역/포함여부 저장)
      STATE.lastPrompt.pseudonymized = sanitized || joined || '';
      STATE.lastPrompt.contains_pii = !!oll?.contains_pii;
      STATE.lastPrompt.changes = Array.isArray(oll?.changes) ? oll.changes : [];
      chrome.storage.local.set({ lastPrompt: STATE.lastPrompt });

      // 5) 가명화 바디 전송 → 응답 수신
      const modBody = adapter.injectPseudonymized(reqBody, sanitized);
      const bodyOut = JSON.stringify(modBody);

      const res = await fetch(url, { method, headers, body: bodyOut });
      const text = await res.text();
      const restored = applyDepseudonymization(text, mapping); // 현재 noop

      return sendResponse({
        ok: true,
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        bodyText: restored
      });
    } catch (e) {
      console.error(e);
      return sendResponse({ ok: false });
    }
  })();

  return true;
});

function tryGetOrigin(u) { try { return new URL(u).origin; } catch { return 'unknown'; } }
async function getOrCreateMap(sessionKey) {
  if (!STATE.maps[sessionKey]) {
    STATE.maps[sessionKey] = { forward: new Map(), backward: new Map() };
  }
  return STATE.maps[sessionKey];
}
function stableIndex(str, mod) {
  let h = 0;
  for (let i=0;i<str.length;i++) h = ((h<<5)-h)+str.charCodeAt(i), h|=0;
  return Math.abs(h) % mod;
}

// ✅ Ollama에게 "포함 여부/가명화/변경내역"을 JSON으로 받는 유틸 (이름풀 사용 안 함)
async function askOllamaPseudonymizeReport(text) {
  const MAX = 8000; // 안전 버퍼
  const snippet = String(text || '').slice(0, MAX);

  // 모델 로드(없으면 기본)
  let model = 'qwen2.5:7b-instruct';
  try {
    const v = await chrome.storage.local.get('model');
    if (typeof v?.model === 'string' && v.model.trim()) model = v.model.trim();
  } catch {}

  const SYSTEM = [
    '당신은 개인정보 검출 및 가명화 도우미입니다.',
    '출력은 반드시 JSON 하나로만 하세요. 설명/코드블록/여분 텍스트 금지.'
  ].join('\n');

  const SCHEMA_EXAMPLE = {
    contains_pii: false,
    pseudonymized_text: "",
    changes: [
      // { type: "PHONE|EMAIL|PERSON|ADDRESS|ORG|RRN|CARD|OTHER", original: "…", replaced_with: "[PHONE]" }
    ]
  };

  const INSTRUCTIONS = [
    '요구사항:',
    '1) 입력 텍스트에 개인정보(예: 이름, 전화번호, 이메일, 주민등록번호, 카드번호, 주소, 조직명 등)가 포함되었는지 판단해. 이때, \'이름\', \'전화번호\' 같은 명사는 개인정보가 아니고 실제 고유명사만을 개인정보라고 판단해, 예를 들어 \'안녕 내 이름은 알려줄 수 없다\'라는 문장에는 개인정보가 없어.',
    '2) 개인정보가 포함되었다면 가명화해 주세요. 일반 토큰/마스킹을 사용해.',
    '   예) 이름→[PERSON], 전화→[PHONE], 이메일→[EMAIL], 주민번호→[RRN], 카드→[CARD], 주소→[ADDRESS], 조직→[ORG]',
    '3) 어떤 정보를 어떻게 바꿨는지 changes 배열에 기록해.',
    '',
    '반드시 아래 JSON 스키마 형식만 출력하세요:',
    JSON.stringify(SCHEMA_EXAMPLE)
  ].join('\n');

  const prompt = `${SYSTEM}\n\n${INSTRUCTIONS}\n\n<INPUT>\n${snippet}\n</INPUT>`;

  const body = {
    model,
    prompt,
    stream: false,
    options: { temperature: 0, top_p: 0.1 },
    format: 'json'
  };

  let raw = '';
  try {
    const resp = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    raw = await resp.text();
    if (!resp.ok) {
      console.warn('[Ollama] HTTP error', resp.status, raw?.slice?.(0,200));
      return null;
    }
  } catch (e) {
    console.warn('[Ollama] fetch error', e);
    return null;
  }

  try {
    let obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && typeof obj.response === 'string') {
      obj = JSON.parse(obj.response);
    }
    if (typeof obj?.contains_pii !== 'boolean') obj.contains_pii = false;
    if (typeof obj?.pseudonymized_text !== 'string') obj.pseudonymized_text = snippet;
    if (!Array.isArray(obj?.changes)) obj.changes = [];
    return obj;
  } catch (e) {
    console.warn('[Ollama] JSON parse fail', raw?.slice?.(0,200));
    return null;
  }
}

function applyDepseudonymization(text, mapping) {
  const sorted = [...mapping.entries()].sort((a,b) => b[0].length - a[0].length);
  let out = text;
  sorted.forEach(([pseudo, orig]) => { out = out.split(pseudo).join(orig); });
  return out;
}

// ==== OpenAI/Anthropic 바디 어댑터 (기존 유지) ====
function extractTextForPseudonymization(url, body) {
  const u = new URL(url);

  // Anthropic v1/messages
  if (u.hostname.includes('anthropic.com')) {
    const msgs = body?.messages || [];
    const joined = msgs.map(m => m.content?.map?.(c => c.text || '').join('') || '').join('\n');
    return {
      joinedText: joined || JSON.stringify(body),
      adapter: {
        injectPseudonymized: (origBody, sanitized) => {
          const clone = structuredClone(origBody);
          if (clone.messages?.length) {
            const lastUser = [...clone.messages].reverse().find(m => m.role === 'user');
            if (lastUser) lastUser.content = [{ type: 'text', text: sanitized }];
          }
          return clone;
        }
      }
    };
  }

  // ChatGPT 웹앱 내부 API
  if (u.hostname.includes('chat.openai.com') || u.hostname.includes('chatgpt.com')) {
    const msgs = body?.messages || [];
    const joined = msgs
      .filter(m => m?.author?.role === 'user')
      .map(m => {
        const c = m?.content;
        if (!c) return '';
        if (c.content_type === 'text' && Array.isArray(c.parts)) return c.parts.join('\n');
        return typeof c === 'string' ? c : JSON.stringify(c);
      })
      .join('\n');

    return {
      joinedText: joined || JSON.stringify(body),
      adapter: {
        injectPseudonymized: (origBody, sanitized) => {
          const clone = structuredClone(origBody);
          const userMsg = (clone.messages || []).find(m => m?.author?.role === 'user');
          if (userMsg) userMsg.content = { content_type: 'text', parts: [sanitized] };
          return clone;
        }
      }
    };
  }

  // OpenAI chat.completions
  const msgs = body?.messages || [];
  const joined = msgs.map(m => m.content || '').join('\n');
  return {
    joinedText: joined || JSON.stringify(body),
    adapter: {
      injectPseudonymized: (origBody, sanitized) => {
        const clone = structuredClone(origBody);
        if (clone.messages?.length) {
          const lastUserIdx = [...clone.messages].map(m=>m.role).lastIndexOf('user');
          if (lastUserIdx >= 0) clone.messages[lastUserIdx].content = sanitized;
        }
        return clone;
      }
    }
  };
}
