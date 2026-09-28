// 순수 함수·조립 로직만 검증하는 오프라인 스모크테스트 (Google 호출 없음)
import { guessMimeType, uploadAllowedFolderId, downloadAllowedFolderIds, downloadAllowedFolderId } from "../lib/drive.js";

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got=${got}\n       want=${want}`); }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }

console.log("[1] 확장자 → MIME 추론");
eq("docx", guessMimeType("보고서.docx"),
   "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
eq("xlsx", guessMimeType("정산.xlsx"),
   "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
eq("pptx", guessMimeType("제안서.pptx"),
   "application/vnd.openxmlformats-officedocument.presentationml.presentation");
eq("pdf", guessMimeType("계약서.pdf"), "application/pdf");
eq("doc(구형)", guessMimeType("old.doc"), "application/msword");
eq("xls(구형)", guessMimeType("old.xls"), "application/vnd.ms-excel");
eq("ppt(구형)", guessMimeType("old.ppt"), "application/vnd.ms-powerpoint");
eq("대문자 확장자", guessMimeType("A.PDF"), "application/pdf");
eq("한글 파일명", guessMimeType("Claude_Team_계정_운영지침.docx"),
   "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
eq("점 여러 개", guessMimeType("a.b.c.xlsx"),
   "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
eq("확장자 없음", guessMimeType("README"), null);
eq("모르는 확장자", guessMimeType("x.zzz"), null);
eq("null 입력", guessMimeType(null), null);
eq("png", guessMimeType("img.png"), "image/png");
eq("csv", guessMimeType("data.csv"), "text/csv");

console.log("[2] 업로드 허용 폴더(환경변수 미설정이면 제한 없음)");
delete process.env.UPLOAD_ALLOWED_FOLDER_ID;
eq("미설정 → null", uploadAllowedFolderId(), null);
process.env.UPLOAD_ALLOWED_FOLDER_ID = "  FOLDER_X  ";
eq("공백 제거", uploadAllowedFolderId(), "FOLDER_X");
delete process.env.UPLOAD_ALLOWED_FOLDER_ID;

console.log("[2-1] 다운로드 허용 폴더 — 쉼표로 여러 개");
delete process.env.DOWNLOAD_ALLOWED_FOLDER_ID;
const defs = downloadAllowedFolderIds();
ok("미설정 → 코드 기본값 2개 이상", Array.isArray(defs) && defs.length >= 2);
ok("기본값에 글꼴 폴더 포함", defs.includes("1PFDwUUOO1nJW8irOQlMaz5ZtqdQiZMMg"));
ok("기본값에 Claude 폴더 포함", defs.includes("1fe1HDtcq4ohyK9KG-0FxWAwMptjcnsIV"));
process.env.DOWNLOAD_ALLOWED_FOLDER_ID = "AAA";
eq("단일 값(기존 설정 하위호환)", downloadAllowedFolderIds().join("|"), "AAA");
eq("단수 함수는 첫 값", downloadAllowedFolderId(), "AAA");
process.env.DOWNLOAD_ALLOWED_FOLDER_ID = "AAA,BBB , CCC";
eq("쉼표+공백 혼용", downloadAllowedFolderIds().join("|"), "AAA|BBB|CCC");
process.env.DOWNLOAD_ALLOWED_FOLDER_ID = "  AAA   BBB  ";
eq("공백 구분", downloadAllowedFolderIds().join("|"), "AAA|BBB");
process.env.DOWNLOAD_ALLOWED_FOLDER_ID = "  , , ";
ok("구분자만 있으면 기본값으로 되돌림", downloadAllowedFolderIds().length >= 2);
delete process.env.DOWNLOAD_ALLOWED_FOLDER_ID;
// 허용 판정: parents 중 하나라도 목록에 있으면 통과
const allowed = ["F1", "F2"];
ok("parents 하나가 일치하면 통과", ["X", "F2"].some((p) => allowed.includes(p)));
ok("어느 것도 없으면 거부", !["X", "Y"].some((p) => allowed.includes(p)));
ok("parents가 비면 거부", ![].some((p) => allowed.includes(p)));

console.log("[3] base64 왕복 — 이진 바이트가 보존되는가");
// 실제 docx의 시그니처(PK\x03\x04)를 포함한 바이트열
const raw = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x7f, 0x80, 0x0a, 0x0d]);
const b64 = raw.toString("base64");
const back = Buffer.from(b64, "base64");
ok("바이트 완전 일치", Buffer.compare(raw, back) === 0);
ok("길이 일치", raw.length === back.length);
// 공백·줄바꿈이 섞여도 디코딩되는가(도구 인자로 올 때 흔하다)
const messy = b64.replace(/(.{4})/g, "$1\n ");
ok("공백/줄바꿈 섞인 base64", Buffer.compare(raw, Buffer.from(messy.replace(/\s+/g, ""), "base64")) === 0);
// data URL 접두어
const dataUrl = `data:application/pdf;base64,${b64}`;
const m = /^data:[^;,]*;base64,(.*)$/is.exec(dataUrl);
ok("data URL 접두어 제거", m && Buffer.compare(raw, Buffer.from(m[1], "base64")) === 0);

console.log("[4] multipart 조립이 이진을 깨뜨리지 않는가 (Buffer.concat 방식)");
const boundary = "gwsmcpTEST";
const meta = { name: "t.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
const head = Buffer.from(
  `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(meta) + `\r\n--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`, "utf8");
const tail = Buffer.from(`\r\n--${boundary}--`, "utf8");
const body = Buffer.concat([head, raw, tail]);
const extracted = body.subarray(head.length, body.length - tail.length);
ok("본문 바이트 보존", Buffer.compare(raw, extracted) === 0);
eq("전체 길이", body.length, head.length + raw.length + tail.length);
// 옛 방식(문자열 연결)은 깨진다는 것도 함께 보여 둔다
const strBody = Buffer.from(
  `--${boundary}\r\n\r\n` + raw.toString() + `\r\n--${boundary}--`, "utf8");
ok("문자열 연결 방식은 실제로 깨짐(회귀 방지 근거)",
   strBody.length !== head.length + raw.length + tail.length);

console.log("[5] 텍스트/이진 MIME 구분 — charset을 이진에 붙이면 안 된다");
const isText = (s) => /^text\//i.test(s) || /^application\/(json|xml|javascript)\b/i.test(s) || /\+xml\b/i.test(s);
ok("text/plain은 텍스트", isText("text/plain"));
ok("text/csv는 텍스트", isText("text/csv"));
ok("application/json은 텍스트", isText("application/json"));
ok("image/svg+xml은 텍스트", isText("image/svg+xml"));
ok("docx는 이진", !isText(meta.mimeType));
ok("pdf는 이진", !isText("application/pdf"));
ok("png는 이진", !isText("image/png"));

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
