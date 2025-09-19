# app.py
from flask import Flask, request, jsonify
import json, os, re, secrets
import requests
from datetime import datetime

app = Flask(__name__)
app.config['JSON_AS_ASCII'] = False

# ===== 설정 =====
OLLAMA_URL   = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434/api/generate")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:7b-instruct")
PII_TYPES    = ["이름", "전화번호", "주소", "나이", "주민등록번호"]
LOG_PATH     = os.getenv("PSEUDO_LOG_PATH", "./pseudo-log.txt")

# ===== 토큰 풀 (각 10개 이상) =====
NAME_POOL = [
    "홍길동","김철수","이영희","박민준","최서연","정우진","윤아름","장도윤","서지민","조하린",
    "한도현","임가은","강시우","오지훈","문다은","신태현","배서윤","권지후","백나윤","우재민"
]
PHONE_POOL = [
    "010-1111-2222","010-2222-3333","010-3333-4444","010-4444-5555","010-5555-6666",
    "010-6666-7777","010-7777-8888","010-8888-9999","010-0000-1111","010-1212-3434",
    "010-9090-8080","010-4545-6767"
]
ADDR_POOL = [
    "서울시 중구 세종대로 110","서울시 강남구 테헤란로 152","서울시 마포구 양화로 45",
    "경기도 성남시 분당구 정자일로 5","부산시 해운대구 센텀서로 39","대구시 수성구 동대구로 123",
    "인천시 연수구 송도과학로 85","광주시 북구 첨단과기로 123","대전시 유성구 대학로 291",
    "울산시 남구 삼산로 321","세종시 도움3로 15"
]
RRN_POOL = [
    "900101-1234567","850505-2345678","780303-3456789","950707-1122334","010101-2233445",
    "920202-3344556","881212-4455667","990909-5566778","030303-6677889","750808-7788990"
]

# (선택) 타입별 순환 인덱스
POOL_IDX = {"이름":0, "전화번호":0, "주소":0, "주민등록번호":0}

def _pick_token(t: str) -> str:
    """타입별 토큰을 풀에서 하나 선택(라운드로빈; 실패시 랜덤)."""
    try:
        if t == "이름":
            i = POOL_IDX["이름"] % len(NAME_POOL); POOL_IDX["이름"] += 1; return NAME_POOL[i]
        if t == "전화번호":
            i = POOL_IDX["전화번호"] % len(PHONE_POOL); POOL_IDX["전화번호"] += 1; return PHONE_POOL[i]
        if t == "주소":
            i = POOL_IDX["주소"] % len(ADDR_POOL); POOL_IDX["주소"] += 1; return ADDR_POOL[i]
        if t == "주민등록번호":
            i = POOL_IDX["주민등록번호"] % len(RRN_POOL); POOL_IDX["주민등록번호"] += 1; return RRN_POOL[i]
    except Exception:
        # 폴백: 랜덤
        pools = {
            "이름": NAME_POOL, "전화번호": PHONE_POOL, "주소": ADDR_POOL, "주민등록번호": RRN_POOL
        }
        arr = pools.get(t, NAME_POOL)
        return secrets.choice(arr)
    # 미지정 타입은 그대로 반환 방지용 임의 문자열
    return "MASKED"

def call_ollama_detect_pii(original_prompt: str):
    SYSTEM = (
        "당신은 개인정보(PII) 탐지기입니다.\n"
        "반드시 'JSON만' 출력하세요. 설명/코드블록/주석/텍스트 금지.\n"
    )
    SCHEMA = {
        "contains_pii": False,
        "items": [
            {"type": "이름|전화번호|주소|나이|주민등록번호", "value": "", "start": 0, "end": 0}
        ]
    }
    INSTRUCTIONS = (
        "요구사항:\n"
        f"- 다음 다섯 종류만 탐지: {', '.join(PII_TYPES)}\n"
        "- 실제로 식별 가능한 후보만 포함.\n"
        "- 출력은 아래 스키마의 JSON '하나'만:\n"
        f"{json.dumps(SCHEMA, ensure_ascii=False)}\n"
        "- 값이 없으면 items는 빈 배열.\n"
        "- item.value는 원문에 등장한 실제 문자열.\n"
        "- start/end는 가능하면 인덱스, 불명확하면 0.\n"
    )
    prompt = f"{SYSTEM}\n{INSTRUCTIONS}\n<INPUT>\n{original_prompt}\n</INPUT>"
    body = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0, "top_p": 0.1},
        "format": "json"
    }
    try:
        resp = requests.post(OLLAMA_URL, json=body, timeout=60)
        text = resp.text
        if not resp.ok:
            return {"contains_pii": False, "items": [], "_error": f"http_{resp.status_code}: {text[:200]}"}
        top = json.loads(text)
        payload = top.get("response", top)
        parsed = json.loads(payload) if isinstance(payload, str) else payload
        if not isinstance(parsed, dict):
            parsed = {}
        items = parsed.get("items", [])
        if not isinstance(items, list):
            items = []
        cleaned = []
        for it in items:
            if not isinstance(it, dict): continue
            t = str(it.get("type", "")).strip()
            v = str(it.get("value", "")).strip()
            s = int(it.get("start", 0) or 0)
            e = int(it.get("end", 0) or 0)
            if t in PII_TYPES and v:
                cleaned.append({"type": t, "value": v, "start": s, "end": e})
        parsed["items"] = cleaned
        parsed["contains_pii"] = bool(cleaned)
        return parsed
    except Exception as e:
        return {"contains_pii": False, "items": [], "_error": f"exception: {e}"}

def append_json_to_file(path: str, new_entry: dict):
    # 파일 전체를 {"logs":[ ... ]}로 유지
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = {"logs": []}
    else:
        data = {"logs": []}
    if "logs" not in data or not isinstance(data["logs"], list):
        data["logs"] = []
    data["logs"].append(new_entry)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def build_masked_prompt(original: str, items: list) -> str:
    """
    Ollama 탐지 items를 기반으로 original을 토큰으로 가명화.
    - 가능한 경우 start/end 기반 치환(뒤에서 앞으로)
    - start/end가 신뢰 어렵거나 value 매칭이 더 안전하면 value 첫 매치 치환
    """
    if not items: return original
    # 각 item에 token 채우기
    for it in items:
        t = it.get("type")
        it["token"] = _pick_token(t) if t in ["이름","전화번호","주소","주민등록번호"] else "MASKED"

    text = original

    # 1차: start/end 신뢰 가능한(0이 아닌) 항목을 end 내림차순으로 치환
    segs = [it for it in items if isinstance(it.get("start"), int) and isinstance(it.get("end"), int) and (it["end"] > it["start"] > -1)]
    segs.sort(key=lambda x: x["end"], reverse=True)
    for it in segs:
        s, e, tok = it["start"], it["end"], it["token"]
        if 0 <= s < e <= len(text):
            text = text[:s] + tok + text[e:]

    # 2차: value 기반 치환(아직 원문이 남아 있을 수 있음)
    for it in items:
        val, tok = it.get("value",""), it.get("token","MASKED")
        if val and val in text:
            # 첫 번째 매치만 치환 (과치환 방지)
            text = re.sub(re.escape(val), tok, text, count=1)

    return text

@app.route("/pseudonymize", methods=["POST"])
def pseudonymize():
    # 확장에서 {"prompt":"","id":""} 전송
    try:
        data = request.get_json(force=True, silent=False)
    except Exception as e:
        return jsonify(ok=False, error=f"invalid_json: {e}"), 400
    if not isinstance(data, dict):
        return jsonify(ok=False, error="payload_must_be_object"), 400

    original_prompt = data.get("prompt", "")
    req_id = data.get("id", "")

    detection = call_ollama_detect_pii(original_prompt)

    # 토큰 기반 가명화
    items = detection.get("items", [])
    masked_prompt = build_masked_prompt(original_prompt, items)

    # detection.items에 token이 들어가도록 이미 build_masked_prompt에서 채움
    detection["items"] = items
    detection["contains_pii"] = bool(items)

    out = {
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "remote_addr": request.remote_addr,
        "path": request.path,
        "input": {
            "id": req_id,
            "prompt": original_prompt
        },
        "detection": detection
    }
    append_json_to_file(LOG_PATH, out)

    # 확장으로 가명화 프롬프트 반환
    return jsonify(ok=True, masked_prompt=masked_prompt, detection=detection)

@app.route("/prompt_logs", methods=["GET"])
def prompt_logs():
    # 파일 그대로 반환 (유효 JSON 보장)
    try:
        with open(LOG_PATH, "r", encoding="utf-8") as f:
            raw = f.read()
        json.loads(raw)
        return app.response_class(response=raw, status=200, mimetype="application/json; charset=utf-8")
    except FileNotFoundError:
        empty = {"logs": []}
        return app.response_class(response=json.dumps(empty, ensure_ascii=False), status=200, mimetype="application/json; charset=utf-8")
    except Exception:
        safe = {"logs": []}
        return app.response_class(response=json.dumps(safe, ensure_ascii=False), status=200, mimetype="application/json; charset=utf-8")

@app.route("/health", methods=["GET"])
def health():
    return jsonify(status="ok", model=OLLAMA_MODEL, log_path=os.path.abspath(LOG_PATH))

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
