(() => {
  // ---- 1) 허용/차단 엔드포인트 정의 ----
  const ALLOW = [
    /https:\/\/chatgpt\.com\/backend-(anon|api)\/.*\/conversation/,
    /https:\/\/chat\.openai\.com\/backend-(anon|api)\/.*\/conversation/
  ];
  const BLOCK = [
    /\/auth\//, /\/login/, /\/session/, /csrf/, /turnstile/i, /sentinel/i,
    /check/, /account/, /device/, /verify/, /callback/
  ];

  const _fetch = window.fetch;

  const urlMatch = (u, arr) => arr.some(rx => rx.test(u));

  // Request 또는 init에서 URL/메서드/헤더/본문을 통합 추출
  async function extractRequest(input, init = {}) {
    let url, method, headers = {}, bodyText = '';

    if (typeof input === 'string') {
      url = input;
      method = (init.method || 'GET').toUpperCase();
      // init.headers -> 객체/배열/Headers 모두 처리
      if (init.headers) headers = Object.fromEntries(new Headers(init.headers).entries());
      if (init.body) bodyText = await bodyToText(init.body);
    } else {
      // input이 Request인 경우
      const req = input;
      url = req.url;
      method = (init.method || req.method || 'GET').toUpperCase();

      // 기본: 원본 Request 헤더
      headers = Object.fromEntries(req.headers.entries());

      // init.headers가 있으면 merge(덮어쓰기 우선)
      if (init.headers) {
        const override = Object.fromEntries(new Headers(init.headers).entries());
        headers = { ...headers, ...override };
      }

      // 본문: init.body 우선, 없으면 Request.clone().text()
      if (init.body) {
        bodyText = await bodyToText(init.body);
      } else {
        try {
          // 이미 소모된 readable이어도 clone().text()로 복구
          bodyText = await req.clone().text();
        } catch {
          bodyText = '';
        }
      }
    }

    return { url, method, headers, bodyText };
  }

  async function bodyToText(body) {
    if (!body) return '';
    if (typeof body === 'string') return body;
    if (body instanceof Blob) return await body.text();
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    // ReadableStream / FormData / URLSearchParams 등은 ChatGPT 프롬프트에서는 안 씀
    // 필요시 여기서 추가 처리
    return '';
  }

  function shouldIntercept(url, method, bodyText) {
    // 1) URL 필터
    if (!urlMatch(url, ALLOW)){
      console.warn("URL Not Matched 1.\n")
      return false;  
    }
    if (urlMatch(url, BLOCK)){
        console.warn("URL Not Matched 2.\n")
        return false;
    }

    // 2) 메서드
    if (method !== 'POST') return false;

    // 3) 바디 검사: ChatGPT 대화 형식(action:"next", messages[])
    if (!bodyText) return false;
    try {
      const b = JSON.parse(bodyText);
      return !!(b && b.action === 'next' && Array.isArray(b.messages) &&
                b.messages.some(m => m?.author?.role === 'user'));
    } catch {
      return false;
    }
  }

  // ---- 2) fetch 후킹 ----
  window.fetch = async function(input, init = {}) {
    try {
      const { url, method, headers, bodyText } = await extractRequest(input, init);

      if (!shouldIntercept(url, method, bodyText)) {
        // 로그인/세션/기타 트래픽은 그대로 통과
        console.debug('[PII] intercept', url, method, bodyText.slice(0,120));
        return _fetch(input, init);
      }

      // 프롬프트 호출만 확장으로 전달
      const msgId = crypto.randomUUID();
      window.postMessage({
        type: 'PII_PROXY_FETCH',
        msgId,
        url,
        method,
        headers,
        bodyText
      }, '*');

      const reply = await new Promise((resolve, reject) => {
        const onMsg = (e) => {
          const d = e.data;
          if (d && d.type === 'PII_PROXY_FETCH_RESULT' && d.msgId === msgId) {
            window.removeEventListener('message', onMsg);
            resolve(d);
          }
        };
        window.addEventListener('message', onMsg);
        setTimeout(() => {
          window.removeEventListener('message', onMsg);
          reject(new Error('pseudonymizer timeout'));
        }, 60000);
      });

      if (!reply.ok) return _fetch(input, init);
      return new Response(reply.bodyText, { status: reply.status, headers: reply.headers });

    } catch (e) {
      // 안전 폴백
      return _fetch(input, init);
    }
  };
})();
