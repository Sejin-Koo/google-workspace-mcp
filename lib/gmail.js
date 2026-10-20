// google-workspace-mcp / lib/gmail.js — 첨부파일이 있는 Gmail 발송
//
// 왜 필요한가: 첨부가 있는 메일은 연결된 Gmail MCP 커넥터의 send_message로 보낼 수 없고,
// 지금까지는 로컬에서 Google OAuth access_token을 직접 발급받아 Gmail REST API를 셸로
// 직접 호출하는 방식을 썼다(ref-credentials). 이 경로는 ①명령줄에 자격증명이 실려 차단
// 정책에 걸릴 수 있고, ②첨부 바이트를 모델이 base64로 직접 타이핑해야 해서 느리고 손상되기
// 쉬웠다. 이 도구는 서버가 이미 들고 있는 자격증명으로 Drive에서 첨부파일을 직접 받아
// Gmail API로 발송까지 한 번에 끝내므로, 첨부 바이트도 자격증명도 모델·셸을 거치지 않는다.
import { googleFetch, qs } from "./google_client.js";
import { guessMimeType } from "./drive.js";

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// Gmail 발송 자체 한도(25MB, base64 인코딩 전 기준)에서 여유를 둔 상한.
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

// 구글 문서형 파일은 alt=media로 원본 바이트를 받을 수 없어(그런 바이트가 없다) 내보내기(export)가
// 필요하다. export_mime_type을 따로 안 주면 이 기본값으로 PDF를 만들어 첨부한다.
const GOOGLE_NATIVE_EXPORT_DEFAULTS = {
  "application/vnd.google-apps.document": { mime: "application/pdf", ext: ".pdf" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/pdf", ext: ".pdf" },
  "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: ".pdf" },
};

/** 비ASCII가 섞인 헤더 값(제목 등)을 RFC 2047 형식으로 인코딩한다. */
function encodeHeaderValue(s) {
  const str = String(s || "");
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`;
}

/** 한글 파일명이 깨지지 않도록 ASCII 대체값과 RFC 5987 인코딩 값을 함께 만든다. */
function filenameParts(name) {
  const ascii = String(name || "attachment").replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return { ascii, encoded: encodeURIComponent(name) };
}

/** base64 본문을 76자 단위로 줄바꿈한다(일부 메일 서버가 매우 긴 한 줄을 거부하는 것을 피한다). */
function wrapBase64(b64) {
  return b64.replace(/.{76}/g, "$&\r\n");
}

/** Drive file_id 하나를 메일에 붙일 수 있는 {filename, mime_type, bytes}로 바꾼다. */
async function resolveAttachment(spec) {
  if (!spec || !spec.file_id) throw new Error("첨부 항목에 file_id가 없습니다. attachments: [{file_id:'…'}] 형태로 주세요.");

  const meta = await googleFetch(
    `${DRIVE_FILES}/${encodeURIComponent(spec.file_id)}` + qs({ fields: "id,name,mimeType,size" })
  );
  const isNative = String(meta.mimeType || "").startsWith("application/vnd.google-apps.");

  let bytes;
  let mime;
  let nameSuffix = "";

  if (isNative) {
    const fallback = GOOGLE_NATIVE_EXPORT_DEFAULTS[meta.mimeType];
    const exportMime = spec.export_mime_type || fallback?.mime;
    if (!exportMime) {
      throw new Error(
        `'${meta.name}'은 구글 문서형 파일(${meta.mimeType})이라 바로 첨부할 수 없습니다. ` +
          `attachments[].export_mime_type을 지정하세요(예: 'application/pdf', 시트는 'text/csv'도 가능).`
      );
    }
    const res = await googleFetch(
      `${DRIVE_FILES}/${encodeURIComponent(spec.file_id)}/export` + qs({ mimeType: exportMime }),
      { raw: true }
    );
    bytes = Buffer.from(await res.arrayBuffer());
    mime = exportMime;
    nameSuffix = spec.export_mime_type ? "" : fallback?.ext || "";
  } else {
    const res = await googleFetch(
      `${DRIVE_FILES}/${encodeURIComponent(spec.file_id)}` + qs({ alt: "media" }),
      { raw: true }
    );
    bytes = Buffer.from(await res.arrayBuffer());
    mime = meta.mimeType;
  }

  let filename = spec.filename || meta.name || spec.file_id;
  if (nameSuffix && !filename.toLowerCase().endsWith(nameSuffix)) filename += nameSuffix;
  const mime_type = spec.mime_type || mime || guessMimeType(filename) || "application/octet-stream";

  return { filename, mime_type, bytes };
}

/** To/Cc/Bcc/제목/본문/첨부로 RFC 2822 multipart/mixed 메시지를 만들어 base64url(raw)로 돌려준다. */
function buildRawMessage({ to, cc, bcc, subject, body_text, body_html, attachments }) {
  const boundary = `gwsmcp_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const headerLines = [`To: ${to}`];
  if (cc) headerLines.push(`Cc: ${cc}`);
  if (bcc) headerLines.push(`Bcc: ${bcc}`);
  headerLines.push(`Subject: ${encodeHeaderValue(subject)}`);
  headerLines.push("MIME-Version: 1.0");
  headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const bodyMime = body_html ? "text/html; charset=UTF-8" : "text/plain; charset=UTF-8";
  const bodyContent = body_html != null ? body_html : body_text || "";

  const pieces = [
    headerLines.join("\r\n"),
    "",
    `--${boundary}`,
    `Content-Type: ${bodyMime}`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(bodyContent, "utf8").toString("base64")),
  ];

  const headBuf = Buffer.from(pieces.join("\r\n") + "\r\n", "utf8");
  const parts = [headBuf];

  for (const att of attachments) {
    const { ascii, encoded } = filenameParts(att.filename);
    const head =
      `--${boundary}\r\n` +
      `Content-Type: ${att.mime_type}; name="${ascii}"\r\n` +
      `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encoded}\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n`;
    parts.push(Buffer.from(head, "utf8"));
    parts.push(Buffer.from(wrapBase64(att.bytes.toString("base64")) + "\r\n", "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}--`, "utf8"));

  const full = Buffer.concat(parts);
  // Gmail API의 raw 필드는 base64url(패딩 없이 +→-, /→_)을 요구한다.
  return full.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function gmailSend({ to, cc, bcc, subject, body_text, body_html, attachments = [] }) {
  if (!to) throw new Error("to(수신자)가 필요합니다. 여러 명은 쉼표로 구분하세요.");
  if (!subject) throw new Error("subject(제목)가 필요합니다.");
  if (body_text == null && body_html == null) throw new Error("body_text 또는 body_html 중 하나는 필요합니다.");

  const resolved = [];
  let totalBytes = 0;
  for (const spec of attachments) {
    const r = await resolveAttachment(spec);
    totalBytes += r.bytes.length;
    if (totalBytes > MAX_ATTACHMENTS_BYTES) {
      throw new Error(
        `첨부파일 총량이 너무 큽니다(누적 약 ${Math.round(totalBytes / 1024 / 1024)}MB, 상한 ` +
          `${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)}MB). Gmail 발송 자체 한도(25MB)를 ` +
          `감안한 값입니다. 첨부를 줄이거나 나눠 보내세요.`
      );
    }
    resolved.push(r);
  }

  const raw = buildRawMessage({ to, cc, bcc, subject, body_text, body_html, attachments: resolved });

  const result = await googleFetch(GMAIL_SEND, { method: "POST", body: { raw } });

  return {
    id: result.id,
    threadId: result.threadId,
    to,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject,
    attachments: resolved.map((a) => ({
      filename: a.filename,
      mime_type: a.mime_type,
      bytes: a.bytes.length,
    })),
  };
}
