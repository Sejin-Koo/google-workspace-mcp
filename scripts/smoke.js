// 로컬 스모크테스트 — 실제 Google API에 붙어서 각 도구의 정상 경로와 오류 경로를 확인한다.
// 자격증명은 이 스크립트를 실행하기 전에 환경변수로 넣어둔다(명령줄에 노출하지 않는다).
// 자격증명 로더 — 셸 명령줄에 비밀을 노출하지 않기 위해 파일에서 읽어 환경변수로 넣는다.
// 이 파일(scripts/.env.local.json)은 .gitignore 되어 저장소에 올라가지 않는다.
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
import { sheetsValues, sheetsManage } from "../lib/sheets.js";
import { docsRead, docsWrite } from "../lib/docs.js";
import { slidesRead, slidesWrite } from "../lib/slides.js";
import { driveSearch, driveFile, driveComments, driveRevisions, drivePermissions, driveSharedDrives, driveChanges } from "../lib/drive.js";
import { getAccessToken } from "../lib/google_client.js";

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

const created = { spreadsheetId: null, docId: null, presId: null, folderId: null, fileId: null };

// 0. 서버 빌드(도구 스키마 등록이 깨지지 않는지)
await step("buildServer(): 도구 등록", async () => {
  const s = buildServer();
  return { built: true, name: "google-workspace-mcp" };
});

// 1. 인증
await step("OAuth access_token 발급", async () => {
  const t = await getAccessToken();
  return { tokenLength: t.length, prefix: t.slice(0, 6) + "…" };
});

// 2. Drive 검색 (읽기)
await step("drive_search: 골프 스코어카드 찾기", () =>
  driveSearch({ name_contains: "골프 스코어카드", page_size: 5 })
);

await step("drive_search: 전문검색(fullText)", () => driveSearch({ full_text: "금강CC", page_size: 3 }));

// 3. Sheets — 생성 → append → read → update → metadata
const ss = await step("sheets_manage create_spreadsheet", () =>
  sheetsManage({ action: "create_spreadsheet", title: "[스모크테스트] gws-mcp", sheet_title: "테스트탭" })
);
if (ss?.spreadsheetId) created.spreadsheetId = ss.spreadsheetId;

if (created.spreadsheetId) {
  await step("sheets_values append (핵심 기능)", () =>
    sheetsValues({
      action: "append",
      spreadsheet_id: created.spreadsheetId,
      range: "테스트탭!A1",
      values: [
        ["날짜", "코스", "스코어"],
        ["2026-08-15", "금강CC", 91],
      ],
    })
  );
  await step("sheets_values append 2회차(누적 확인)", () =>
    sheetsValues({
      action: "append",
      spreadsheet_id: created.spreadsheetId,
      range: "테스트탭!A1",
      values: [["2026-08-14", "라비에벨 둔스", 85]],
    })
  );
  await step("sheets_values read (누적 3행이어야 정상)", () =>
    sheetsValues({ action: "read", spreadsheet_id: created.spreadsheetId, range: "테스트탭" })
  );
  await step("sheets_values update", () =>
    sheetsValues({
      action: "update",
      spreadsheet_id: created.spreadsheetId,
      range: "테스트탭!C3",
      values: [[85]],
    })
  );
  await step("sheets_manage add_sheet", () =>
    sheetsManage({ action: "add_sheet", spreadsheet_id: created.spreadsheetId, sheet_title: "두번째탭" })
  );
  await step("sheets_manage get_metadata", () =>
    sheetsManage({ action: "get_metadata", spreadsheet_id: created.spreadsheetId })
  );
  await step("sheets_values 오류경로(range 누락)", () =>
    sheetsValues({ action: "read", spreadsheet_id: created.spreadsheetId }).then(
      () => { throw new Error("오류가 나야 정상인데 성공했다"); },
      (e) => ({ expectedError: e.message })
    )
  );
}

// 4. Docs — 생성 → append → replace → read
const doc = await step("docs_write create(+본문)", () =>
  docsWrite({ action: "create", title: "[스모크테스트] gws-mcp 문서", text: "첫 줄입니다.\n{{치환대상}}\n" })
);
if (doc?.documentId) created.docId = doc.documentId;

if (created.docId) {
  await step("docs_write append_text", () =>
    docsWrite({ action: "append_text", document_id: created.docId, text: "맨 끝에 덧붙인 줄입니다.\n" })
  );
  await step("docs_write replace_text", () =>
    docsWrite({ action: "replace_text", document_id: created.docId, find_text: "{{치환대상}}", replace_text: "치환 성공" })
  );
  await step("docs_read text", () => docsRead({ document_id: created.docId }));
}

// 5. Slides — 생성 → 슬라이드 추가 → 읽기 → 치환
const pres = await step("slides_write create", () =>
  slidesWrite({ action: "create", title: "[스모크테스트] gws-mcp 덱" })
);
if (pres?.presentationId) created.presId = pres.presentationId;

if (created.presId) {
  await step("slides_write add_slide(제목+본문 채우기)", () =>
    slidesWrite({
      action: "add_slide",
      presentation_id: created.presId,
      layout: "TITLE_AND_BODY",
      texts: [
        { placeholder: "TITLE", text: "스모크테스트 슬라이드" },
        { placeholder: "BODY", text: "본문 텍스트 {{바꿀말}}" },
      ],
    })
  );
  await step("slides_read text", () => slidesRead({ presentation_id: created.presId }));
  await step("slides_write replace_text", () =>
    slidesWrite({ action: "replace_text", presentation_id: created.presId, find_text: "{{바꿀말}}", replace_text: "치환됨" })
  );
}

// 6. Drive 고급 — 폴더 생성, 파일 생성/수정(ID 유지), 이동, 댓글, 리비전, 권한
const folder = await step("drive_file create_folder", () =>
  driveFile({ action: "create_folder", name: "[스모크테스트] gws-mcp 폴더" })
);
if (folder?.id) created.folderId = folder.id;

const f = await step("drive_file create(내용 포함)", () =>
  driveFile({ action: "create", name: "smoke.txt", content: "최초 내용", mime_type: "text/plain" })
);
if (f?.id) created.fileId = f.id;

if (created.fileId) {
  await step("drive_file update_content (파일ID 유지 확인)", async () => {
    const r = await driveFile({ action: "update_content", file_id: created.fileId, content: "덮어쓴 내용" });
    if (r.id !== created.fileId) throw new Error(`파일 ID가 바뀌었다: ${created.fileId} → ${r.id}`);
    return r;
  });
  await step("drive_file download (내용 검증)", async () => {
    const r = await driveFile({ action: "download", file_id: created.fileId });
    if (r.text !== "덮어쓴 내용") throw new Error(`내용 불일치: ${JSON.stringify(r.text)}`);
    return r;
  });
  if (created.folderId) {
    await step("drive_file move", () =>
      driveFile({ action: "move", file_id: created.fileId, new_parent_folder_id: created.folderId })
    );
  }
  await step("drive_comments create", () =>
    driveComments({ action: "create", file_id: created.fileId, content: "스모크테스트 댓글" })
  );
  await step("drive_comments list", () => driveComments({ action: "list", file_id: created.fileId }));
  await step("drive_revisions list", () => driveRevisions({ action: "list", file_id: created.fileId }));
  await step("drive_permissions list", () => drivePermissions({ action: "list", file_id: created.fileId }));
  await step("drive_file 오류경로(permanent 없이 delete)", () =>
    driveFile({ action: "delete", file_id: created.fileId }).then(
      () => { throw new Error("오류가 나야 정상인데 성공했다"); },
      (e) => ({ expectedError: e.message })
    )
  );
}

// 7. 공유드라이브 / 변경감지
await step("drive_shared_drives list", () => driveSharedDrives({ action: "list" }));
const tok = await step("drive_changes get_start_token", () => driveChanges({ action: "get_start_token" }));
if (tok?.startPageToken) {
  await step("drive_changes list", () => driveChanges({ action: "list", page_token: tok.startPageToken }));
}

// 8. Docs export (구글 문서형 → 텍스트)
if (created.docId) {
  await step("drive_file export(docs → text/plain)", () =>
    driveFile({ action: "export", file_id: created.docId, export_mime_type: "text/plain" })
  );
}

// 9. 정리 — 테스트로 만든 것 전부 휴지통으로
for (const [k, id] of Object.entries(created)) {
  if (!id) continue;
  await step(`정리: ${k} 휴지통 이동`, () => driveFile({ action: "trash", file_id: id }));
}

console.log("\n\n════════ 요약 ════════");
const pass = results.filter((r) => r.ok).length;
console.log(`통과 ${pass} / 전체 ${results.length}`);
for (const r of results.filter((r) => !r.ok)) console.log(`  ❌ ${r.label}: ${r.err}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
