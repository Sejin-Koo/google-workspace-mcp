// google-workspace-mcp / lib/google_client.js
//
// Google Workspace API(Sheets / Docs / Slides / Forms / Drive) 공통 클라이언트.
//
// 인증: 서버가 환경변수로 OAuth 자격증명을 들고 있으므로 호출자는 키를 넘길 필요가 없다.
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
// refresh_token으로 매번 access_token을 발급받되(만료 1시간), 서버리스 인스턴스가
// 살아있는 동안은 메모리에 캐시해 재사용한다.
//
// 이 자격증명의 스코프는 `https://www.googleapis.com/auth/drive` + `gmail.send`이며,
// drive 스코프 하나로 Sheets/Docs/Slides/Forms API와 Drive API 전체(파일·댓글·리비전·
// 권한·공유드라이브·변경감지)가 커버된다(Google 공식 스코프 문서로 확인).

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// 워밍된 인스턴스에서 재사용하기 위한 access_token 캐시
let _cachedToken = null;
let _cachedTokenExpiry = 0;

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(
      `환경변수 ${name} 이(가) 설정되어 있지 않습니다. Vercel 프로젝트 설정의 ` +
        `Environment Variables에서 Value 칸(Note 칸 아님)에 값을 넣고 재배포하세요.`
    );
  }
  return String(v).trim();
}

/** refresh_token으로 access_token을 발급(또는 캐시 재사용)한다. */
export async function getAccessToken() {
  const now = Date.now();
  if (_cachedToken && now < _cachedTokenExpiry - 60_000) return _cachedToken;

  const body = new URLSearchParams({
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    refresh_token: requireEnv("GOOGLE_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `access_token 발급 실패 (HTTP ${res.status}). refresh_token이 만료·취소되었을 수 ` +
        `있습니다. 응답: ${text.slice(0, 500)}`
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`토큰 응답을 JSON으로 파싱할 수 없습니다: ${text.slice(0, 300)}`);
  }
  if (!json.access_token) throw new Error(`토큰 응답에 access_token이 없습니다: ${text.slice(0, 300)}`);

  _cachedToken = json.access_token;
  _cachedTokenExpiry = now + (Number(json.expires_in || 3600) * 1000);
  return _cachedToken;
}

/**
 * Google API 공통 호출기.
 * 실패 시 Google이 돌려준 error.message를 그대로 살려서 던진다 — 스코프 부족(403),
 * 잘못된 fileId(404), 잘못된 range(400) 등의 원인을 호출자가 바로 알 수 있어야 한다.
 */
export async function googleFetch(url, { method = "GET", body, headers = {}, raw = false } = {}) {
  const token = await getAccessToken();
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
  };
  if (body !== undefined && body !== null) {
    if (typeof body === "string" || body instanceof Uint8Array) {
      opts.body = body;
    } else {
      opts.body = JSON.stringify(body);
      if (!opts.headers["Content-Type"]) opts.headers["Content-Type"] = "application/json";
    }
  }

  const res = await fetch(url, opts);

  if (raw) {
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Google API 오류 (HTTP ${res.status}): ${t.slice(0, 800)}`);
    }
    return res;
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 800);
    try {
      const j = JSON.parse(text);
      if (j.error) {
        detail = `${j.error.message || ""}${j.error.status ? ` [${j.error.status}]` : ""}`;
        // 403은 원인이 셋으로 갈린다. 뭉뚱그리면 엉뚱한 곳을 고치게 되므로 구분해서 안내한다.
        if (res.status === 403) {
          if (/has not been used in project|is disabled/i.test(detail)) {
            detail +=
              " — 스코프 문제가 아니라 Google Cloud 프로젝트에서 이 API가 '사용 설정'되지 않은 상태입니다." +
              " 위 안내 URL에서 Enable을 누르고 1~2분 뒤 재시도하세요.";
          } else if (/insufficient|scope/i.test(detail)) {
            detail += " — 이 자격증명의 스코프로 커버되지 않는 API입니다. 스코프 재동의가 필요합니다.";
          } else {
            detail += " — 대상 파일·폴더에 대한 접근 권한이 없습니다(소유자/공유 설정 확인).";
          }
        }
      }
    } catch (e) {
      /* 원문 그대로 사용 */
    }
    throw new Error(`Google API 오류 (HTTP ${res.status}): ${detail}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    return { _raw: text };
  }
}

/** 쿼리스트링을 만들되 undefined/null/빈문자열은 제외한다. */
export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, String(item));
    } else {
      sp.append(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * 응답이 무한정 커지지 않도록 하는 총량 가드.
 * maxChars=0 이면 자르지 않는다(호출자가 전문을 원할 때).
 * 자를 때는 몇 자에서 잘렸는지와 후속 조치를 함께 안내한다.
 */
export function capText(text, maxChars) {
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return text;
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) +
    `\n\n…[${text.length.toLocaleString()}자 중 ${limit.toLocaleString()}자만 표시했습니다. ` +
    `전문이 필요하면 같은 호출에 max_chars=0 을 넣거나, 범위(range/페이지)를 좁혀 다시 호출하세요.]`
  );
}

/** 도구 응답을 MCP content 형태로 감싼다. */
export function jsonResult(obj, maxChars) {
  return {
    content: [{ type: "text", text: capText(JSON.stringify(obj, null, 2), maxChars) }],
  };
}
