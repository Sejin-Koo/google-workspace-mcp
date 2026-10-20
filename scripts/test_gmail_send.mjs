// gmail_send 스모크테스트 — 실제 Google API에 붙어 첨부 발송(일반 파일 + 구글 문서형 자동
// export)과 오류 경로(수신자 누락, 제목 누락, 본문 누락, 존재하지 않는 file_id)까지 확인한다.
// 발송 대상은 이 자격증명의 소유 계정 자신(infratechponylink@gmail.com)으로 한정한다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dir, ".env.local.json");
if (fs.existsSync(envPath)) {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(envPath, "utf8")))) {
    if (!process.env[k]) process.env[k] = v;
  }
}

import { buildServer } from "../lib/server.js";
import { gmailSend } from "../lib/gmail.js";
import { driveFile } from "../lib/drive.js";
import { docsWrite } from "../lib/docs.js";
import { getAccessToken } from "../lib/google_client.js";

const SELF = "infratechponylink@gmail.com";

const results = [];
async function step(label, fn) {
  try {
    const r = await fn();
    results.push({ label, ok: true });
    console.log(`\n✅ ${label}`);
    console.log(JSON.stringify(r, null, 2).slice(0, 900));
    return r;
  } catch (e) {
    results.push({ label, ok: false, err: e.message });
    console.log(`\n❌ ${label}\n   ${e.message}`);
    return null;
  }
}

await step("buildServer(): gmail_send 등록 확인", async () => {
  buildServer();
  return { built: true };
});

await step("OAuth access_token 발급", async () => {
  const t = await getAccessToken();
  return { tokenLength: t.length };
});

const created = {};

// ── 준비: 일반 텍스트 첨부 1건 + 구글 문서 1건(자동 PDF export 확인용) ──────────
const txt = await step("준비: 일반 파일(텍스트) 생성", () =>
  driveFile({
    action: "create",
    name: "[스모크테스트] gmail_send_attachment.txt",
    mime_type: "text/plain",
    content: "gmail_send 스모크테스트 첨부파일입니다.\n한글도 깨지지 않는지 확인.",
  })
);
if (txt?.id) created.txtFileId = txt.id;

const doc = await step("준비: 구글 문서 생성(자동 PDF export 대상)", () =>
  docsWrite({
    action: "create",
    title: "[스모크테스트] gmail_send_native_export",
    text: "구글 문서 자동 PDF 첨부 테스트입니다.\n한글 포함 확인.",
  })
);
if (doc?.documentId) created.docId = doc.documentId;

const txt2 = await step("준비: 일반 파일(두 번째 첨부) 생성", () =>
  driveFile({
    action: "create",
    name: "[스모크테스트] gmail_send_attachment2.csv",
    mime_type: "text/csv",
    content: "a,b,c\n1,2,3\n",
  })
);
if (txt2?.id) created.csvFileId = txt2.id;

// ── 정상 경로: 첨부 2건 ──────────────────────────────────────────────────────
if (created.txtFileId && created.csvFileId) {
  await step("gmail_send: 첨부 2건(파일명·mime 자동 추론)", async () => {
    const r = await gmailSend({
      to: SELF,
      subject: "[스모크테스트] drive_json_update 후속 — gmail_send 첨부 발송 확인",
      body_text: "이 메일은 gmail_send 도구의 스모크테스트입니다. 첨부 2건이 붙어 있어야 정상입니다.",
      attachments: [{ file_id: created.txtFileId }, { file_id: created.csvFileId, filename: "표.csv" }],
    });
    if (!r.id) throw new Error(`메일 발송 응답에 id가 없음: ${JSON.stringify(r)}`);
    if (r.attachments.length !== 2) throw new Error(`첨부가 2건이어야 하는데: ${JSON.stringify(r.attachments)}`);
    return r;
  });
}

// ── 정상 경로: 구글 문서형 파일은 자동으로 PDF로 export되어 첨부되는지 ──────────
if (created.docId) {
  await step("gmail_send: 구글 문서 첨부 → 자동 PDF export 확인", async () => {
    const r = await gmailSend({
      to: SELF,
      subject: "[스모크테스트] gmail_send — 구글 문서 자동 PDF 첨부 확인",
      body_text: "첨부가 PDF로 변환되어 1건 붙어 있어야 정상입니다.",
      attachments: [{ file_id: created.docId }],
    });
    if (r.attachments[0]?.mime_type !== "application/pdf")
      throw new Error(`PDF로 변환되지 않음: ${JSON.stringify(r.attachments)}`);
    if (!r.attachments[0]?.filename.endsWith(".pdf"))
      throw new Error(`파일명에 .pdf 접미사가 안 붙음: ${r.attachments[0]?.filename}`);
    return r;
  });
}

// ── 오류 경로 ────────────────────────────────────────────────────────────────
await step("오류: to 누락", () =>
  gmailSend({ subject: "제목", body_text: "본문" }).then(
    () => { throw new Error("오류가 나야 정상인데 성공했다"); },
    (e) => ({ expectedError: e.message })
  )
);

await step("오류: subject 누락", () =>
  gmailSend({ to: SELF, body_text: "본문" }).then(
    () => { throw new Error("오류가 나야 정상인데 성공했다"); },
    (e) => ({ expectedError: e.message })
  )
);

await step("오류: body_text·body_html 둘 다 누락", () =>
  gmailSend({ to: SELF, subject: "제목" }).then(
    () => { throw new Error("오류가 나야 정상인데 성공했다"); },
    (e) => ({ expectedError: e.message })
  )
);

await step("오류: 존재하지 않는 file_id 첨부", () =>
  gmailSend({
    to: SELF,
    subject: "제목",
    body_text: "본문",
    attachments: [{ file_id: "존재하지않는파일아이디_0000000000" }],
  }).then(
    () => { throw new Error("오류가 나야 정상인데 성공했다"); },
    (e) => ({ expectedError: e.message })
  )
);

// ── 정리 ─────────────────────────────────────────────────────────────────────
for (const [k, id] of Object.entries(created)) {
  if (!id) continue;
  await step(`정리: ${k} 휴지통 이동`, () => driveFile({ action: "trash", file_id: id }));
}

console.log("\n\n════════ 요약 ════════");
const pass = results.filter((r) => r.ok).length;
console.log(`통과 ${pass} / 전체 ${results.length}`);
for (const r of results.filter((r) => !r.ok)) console.log(`  ❌ ${r.label}: ${r.err}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
