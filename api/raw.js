// google-workspace-mcp / api/raw.js — Drive 파일의 바이트 구간을 원본 그대로 돌려주는 엔드포인트
//
//   GET /api/raw?k=<게이트키>&f=<fileId>&s=<시작바이트>&e=<끝바이트>
//
// drive_file(action='download_link')이 발급한 조각 주소가 이곳을 가리킨다. Drive API에
// alt=media + Range 헤더를 붙여 받은 바이트를 application/octet-stream으로 그대로 흘려보내므로
// 글꼴(.ttf/.ttc) 같은 이진 파일이 깨지지 않는다.
//
// 보안은 두 겹이다.
//   ① 게이트키 검사 — api/mcp.js와 같은 lib/gate.js를 쓴다(MCP_GATE_KEYS/MCP_GATE_MODE).
//   ② 허용 폴더 검사 — download_link에서 이미 했더라도 **여기서 다시 한다**. 발급된 주소의
//      f= 값만 바꾸면 다른 파일을 가리킬 수 있으므로, 바이트를 내보내는 이 지점의 검사가
//      실질적인 방어선이다.
import { assertDownloadAllowed, RAW_MAX_RANGE_BYTES } from "../lib/drive.js";
import { googleFetch, qs } from "../lib/google_client.js";
import { checkGateKey, gateUnauthorizedMessage } from "../lib/gate.js";

export const config = {
  api: { bodyParser: false },
};

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";

function fail(res, status, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: message }));
}

/** Google API 오류 문자열에 박혀 있는 HTTP 상태를 그대로 돌려준다(없으면 502). */
function upstreamStatus(err) {
  const m = /HTTP (\d{3})/.exec(err?.message || "");
  const st = m ? Number(m[1]) : NaN;
  return Number.isInteger(st) && st >= 400 && st < 600 ? st : 502;
}

/** 한글 파일명이 깨지지 않도록 RFC 5987 형식을 함께 넣는다. */
function contentDisposition(name, start, end) {
  const label = `${name || "download"}.part${start}-${end}`;
  const ascii = label.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(label)}`;
}

export default async function handler(req, res) {
  const gate = checkGateKey(req);
  if (gate.blocked) return fail(res, 401, gateUnauthorizedMessage("/api/raw"));

  if (req.method !== "GET" && req.method !== "HEAD")
    return fail(res, 405, "GET만 지원합니다.");

  let params;
  try {
    params = new URL(req.url, "http://localhost").searchParams;
  } catch (e) {
    return fail(res, 400, "요청 URL을 해석할 수 없습니다.");
  }

  const fileId = (params.get("f") || "").trim();
  if (!fileId) return fail(res, 400, "파일 ID(f)가 필요합니다. 예: /api/raw?k=…&f=<fileId>&s=0&e=3145727");

  const start = Number(params.get("s"));
  const end = Number(params.get("e"));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start)
    return fail(res, 400, "구간(s,e)은 0 이상의 정수여야 하고 s ≤ e 여야 합니다. 예: s=0&e=3145727");

  const length = end - start + 1;
  if (length > RAW_MAX_RANGE_BYTES)
    return fail(
      res,
      400,
      `한 요청으로 받을 수 있는 구간은 ${RAW_MAX_RANGE_BYTES}바이트 이하입니다(요청: ${length}바이트). ` +
        `Vercel 응답 본문 상한 때문이며, drive_file action='download_link'가 나눠 준 조각 주소를 그대로 쓰세요.`
    );

  // 허용 폴더 검사(메타데이터 조회를 겸한다)
  let meta;
  try {
    meta = await assertDownloadAllowed(fileId);
  } catch (err) {
    const status = err?.code === "DOWNLOAD_FORBIDDEN" ? 403 : upstreamStatus(err);
    return fail(res, status, err?.message || String(err));
  }

  const size = Number(meta.size);
  if (Number.isFinite(size) && size > 0 && start >= size)
    return fail(res, 416, `시작 위치(${start})가 파일 크기(${size}바이트)를 넘습니다.`);
  const upstreamEnd = Number.isFinite(size) && size > 0 ? Math.min(end, size - 1) : end;

  let gres;
  try {
    gres = await googleFetch(`${DRIVE_FILES}/${encodeURIComponent(fileId)}` + qs({ alt: "media" }), {
      raw: true,
      headers: { Range: `bytes=${start}-${upstreamEnd}` },
    });
  } catch (err) {
    return fail(res, upstreamStatus(err), err?.message || String(err));
  }

  const buf = Buffer.from(await gres.arrayBuffer());
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader("Content-Disposition", contentDisposition(meta.name, start, upstreamEnd));
  res.setHeader("X-Gws-Range", `bytes ${start}-${upstreamEnd}/${Number.isFinite(size) ? size : "*"}`);
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(buf);
}
