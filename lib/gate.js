// google-workspace-mcp / lib/gate.js — 접근 게이트(게이트키) 공통 모듈
//
// 엔드포인트 주소만 알면 누구나 호출할 수 있는 상태를 막기 위해, 호출자는 URL 쿼리스트링으로
// 발급받은 게이트키를 전달한다:  https://<도메인>/api/mcp?k=<발급키>
//   MCP_GATE_KEYS : 허용 키 목록(쉼표 구분). **비어 있으면 게이트 비활성**(모두 통과).
//   MCP_GATE_MODE : "enforce"면 키가 없거나 목록에 없을 때 401 차단.
//                   그 밖(기본 "observe")이면 통과시키되 로그만 남긴다.
// 로그에는 키 전문 대신 발급 대상 식별자(plk_<대상>_… 의 <대상>)만 남긴다.
// 상세 운영 절차는 sys-mcp-gatekey 스킬 참조.
//
// MCP 엔드포인트(api/mcp.js)와 이진 파일 구간 다운로드 엔드포인트(api/raw.js)가 이 모듈을
// 함께 쓴다. 두 곳에 같은 코드를 복사해 두면 한쪽만 고쳐져 게이트가 어긋나기 때문이다.

/** 환경변수는 호출 시점에 읽는다(배포 중 값이 바뀌어도 다음 요청부터 반영된다). */
function gateKeys() {
  return (process.env.MCP_GATE_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function gateMode() {
  return (process.env.MCP_GATE_MODE || "observe").trim().toLowerCase();
}

export function gateKeyLabel(k) {
  if (!k) return "(none)";
  const m = String(k).match(/^plk_([A-Za-z0-9]+)_/);
  return m ? m[1] : `${String(k).slice(0, 8)}…`;
}

/** 요청에서 게이트키(`?k=`)를 꺼낸다. req.query가 채워지지 않는 경로도 있으므로 URL 폴백을 둔다. */
export function extractGateKey(req) {
  let k = (req && req.query && req.query.k) || null;
  if (!k) {
    try {
      k = new URL(req.url, "http://localhost").searchParams.get("k");
    } catch (e) {
      k = null;
    }
  }
  return k || null;
}

/**
 * 게이트 검사 결과를 돌려준다(응답은 호출자가 각 엔드포인트 형식에 맞게 작성한다).
 *   { key, allowed, blocked, mode }
 * blocked=true 이면 차단 모드에서 거부해야 하는 요청이다.
 */
export function checkGateKey(req) {
  const key = extractGateKey(req);
  const keys = gateKeys();
  const mode = gateMode();
  const allowed = keys.length === 0 || (!!key && keys.includes(key));
  console.log(
    `[gate] mode=${mode} method=${req?.method} caller=${gateKeyLabel(key)} allowed=${allowed}`
  );
  return { key, allowed, blocked: !allowed && mode === "enforce", mode };
}

/** 401 응답에 쓸 안내 문구. 엔드포인트 경로만 갈아끼운다. */
export function gateUnauthorizedMessage(path = "/api/mcp") {
  return (
    `접근 권한이 없습니다. 이 서버는 발급받은 게이트키가 포함된 주소(…${path}?k=<발급키>)로만 ` +
    `호출할 수 있습니다.`
  );
}
