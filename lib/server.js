// google-workspace-mcp / lib/server.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { jsonResult } from "./google_client.js";
import { sheetsValues, sheetsManage } from "./sheets.js";
import { docsRead, docsWrite } from "./docs.js";
import { slidesRead, slidesWrite } from "./slides.js";
import { formsTool } from "./forms.js";
import {
  driveSearch,
  driveFile,
  driveComments,
  driveRevisions,
  drivePermissions,
  driveSharedDrives,
  driveChanges,
} from "./drive.js";

// 응답 총량 상한(자). 호출자가 max_chars로 조절할 수 있고 0이면 자르지 않는다.
const MAX_CHARS_DEFAULT = 60000;
const maxCharsSchema = z
  .number()
  .int()
  .min(0)
  .default(MAX_CHARS_DEFAULT)
  .describe("응답 길이 상한(자). 0이면 자르지 않고 전문을 반환합니다.");

/** 도구 핸들러 공통 래퍼 — 오류를 사람이 읽을 수 있는 형태로 돌려준다. */
function wrap(fn) {
  return async (args) => {
    const { max_chars, ...rest } = args || {};
    try {
      return jsonResult(await fn(rest), max_chars);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `오류: ${err?.message || String(err)}` }],
      };
    }
  };
}

/**
 * ctx는 이번 HTTP 요청에서 온 값이다(api/mcp.js가 채운다).
 *   gateKey : 이번 호출에 쓰인 게이트키 — download_link가 돌려주는 조각 URL에 그대로 싣는다.
 *   baseUrl : 호출자가 실제로 쓴 주소(스킴+호스트) — 조각 URL의 기준 도메인.
 * 도구 인자로는 받지 않는다(호출자가 임의의 키·도메인을 심지 못하게).
 */
export function buildServer(ctx = {}) {
  const server = new McpServer({ name: "google-workspace-mcp", version: "1.0.0" });

  // ── Google Sheets ────────────────────────────────────────────────────────
  server.tool(
    "sheets_values",
    "Google Sheets의 셀 값을 읽고 쓴다. action으로 4종 선택: read(범위 읽기), " +
      "append(**기존 데이터를 보존한 채 표 맨 아래에 행만 추가** — 파일을 새로 만들지 않고 " +
      "누적 기록을 이어붙일 때 쓰는 핵심 동작), update(지정 범위 덮어쓰기), clear(범위 비우기). " +
      "spreadsheet_id는 시트 URL의 /d/와 /edit 사이 문자열이다. " +
      "range는 A1 표기법('시트1' 전체, '시트1!A1:H50' 부분, append는 '시트1!A1'처럼 표 시작점).",
    {
      action: z.enum(["read", "append", "update", "clear"]),
      spreadsheet_id: z.string().describe("스프레드시트 ID (URL의 /d/…/edit 사이 값)"),
      range: z.string().optional().describe("A1 표기법 범위"),
      values: z
        .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
        .optional()
        .describe("append/update에 넣을 2차원 배열. 예: [[\"2026-08-19\",\"금강CC\",91]]"),
      value_input_option: z
        .enum(["USER_ENTERED", "RAW"])
        .default("USER_ENTERED")
        .describe("USER_ENTERED면 날짜·수식·숫자를 시트가 해석, RAW면 문자열 그대로"),
      major_dimension: z.enum(["ROWS", "COLUMNS"]).default("ROWS"),
      insert_data_option: z.enum(["INSERT_ROWS", "OVERWRITE"]).default("INSERT_ROWS"),
      max_chars: maxCharsSchema,
    },
    wrap(sheetsValues)
  );

  server.tool(
    "sheets_manage",
    "스프레드시트 파일과 탭(시트)을 관리한다. action: create_spreadsheet(새 파일 생성), " +
      "get_metadata(**탭 목록·sheetId·행열 크기 확인 — 다른 action에 필요한 sheet_id는 여기서 얻는다**), " +
      "add_sheet(탭 추가), delete_sheet(탭 삭제), rename_sheet(탭 이름 변경), " +
      "rename_spreadsheet(파일명 변경), batch_update(서식·행열 삽입 등 Sheets API 원시 요청).",
    {
      action: z.enum([
        "create_spreadsheet",
        "get_metadata",
        "add_sheet",
        "delete_sheet",
        "rename_sheet",
        "rename_spreadsheet",
        "batch_update",
      ]),
      spreadsheet_id: z.string().optional().describe("create_spreadsheet 외에는 필수"),
      title: z.string().optional().describe("create_spreadsheet의 파일명"),
      sheet_title: z.string().optional().describe("add_sheet의 탭 이름 / create_spreadsheet의 첫 탭 이름"),
      sheet_id: z.number().int().optional().describe("delete_sheet·rename_sheet 대상 탭의 sheetId(get_metadata로 확인)"),
      new_title: z.string().optional().describe("rename_sheet·rename_spreadsheet의 새 이름"),
      rows: z.number().int().optional(),
      columns: z.number().int().optional(),
      include_grid_data: z.boolean().default(false).describe("get_metadata에서 셀 값까지 포함(응답이 매우 커짐)"),
      requests: z.array(z.any()).optional().describe("batch_update용 Sheets API 요청 배열"),
      max_chars: maxCharsSchema,
    },
    wrap(sheetsManage)
  );

  // ── Google Docs ──────────────────────────────────────────────────────────
  server.tool(
    "docs_read",
    "Google Docs 문서를 읽는다. format='text'(기본)면 표까지 포함해 본문 텍스트로 평탄화하고, " +
      "'raw'면 Docs API 원본 구조(스타일·인덱스 포함 — insert_text 위치를 계산할 때 필요)를 준다.",
    {
      document_id: z.string().describe("문서 ID (URL의 /document/d/…/edit 사이 값)"),
      format: z.enum(["text", "raw"]).default("text"),
      max_chars: maxCharsSchema,
    },
    wrap(docsRead)
  );

  server.tool(
    "docs_write",
    "Google Docs 문서를 만들고 고친다. action: create(새 문서 — text를 함께 주면 본문까지 채움), " +
      "append_text(문서 맨 끝에 덧붙임 — 위치를 몰라도 됨), insert_text(index 위치에 삽입), " +
      "replace_text(문서 전체에서 찾아 바꾸기 — 템플릿 채우기에 유용), " +
      "batch_update(스타일·표·이미지 등 Docs API 원시 요청).",
    {
      action: z.enum(["create", "append_text", "insert_text", "replace_text", "batch_update"]),
      document_id: z.string().optional().describe("create 외에는 필수"),
      title: z.string().optional().describe("create의 문서 제목"),
      text: z.string().optional().describe("삽입할 텍스트"),
      index: z.number().int().optional().describe("insert_text의 삽입 위치(본문 시작은 1)"),
      find_text: z.string().optional().describe("replace_text에서 찾을 문자열"),
      replace_text: z.string().optional().describe("replace_text에서 바꿀 문자열"),
      match_case: z.boolean().default(false),
      requests: z.array(z.any()).optional().describe("batch_update용 Docs API 요청 배열"),
      max_chars: maxCharsSchema,
    },
    wrap(docsWrite)
  );

  // ── Google Slides ────────────────────────────────────────────────────────
  server.tool(
    "slides_read",
    "Google Slides 프레젠테이션을 읽는다. 기본은 슬라이드별 텍스트·발표자노트 요약이고, " +
      "format='raw'면 API 원본(도형 objectId 포함 — 특정 도형을 지우거나 고칠 때 필요)을 준다. " +
      "slide_index를 주면 그 한 장만 본다.",
    {
      presentation_id: z.string().describe("프레젠테이션 ID"),
      format: z.enum(["text", "raw"]).default("text"),
      slide_index: z.number().int().min(0).optional().describe("0부터 시작하는 슬라이드 번호"),
      max_chars: maxCharsSchema,
    },
    wrap(slidesRead)
  );

  server.tool(
    "slides_write",
    "Google Slides를 만들고 고친다. action: create(새 프레젠테이션), " +
      "add_slide(레이아웃을 골라 슬라이드 추가 — texts로 제목·본문까지 한 번에 채움), " +
      "delete_slide(slides_read로 얻은 objectId로 삭제), replace_text(전체 찾아 바꾸기), " +
      "batch_update(도형·표·차트 등 Slides API 원시 요청).",
    {
      action: z.enum(["create", "add_slide", "delete_slide", "replace_text", "batch_update"]),
      presentation_id: z.string().optional().describe("create 외에는 필수"),
      title: z.string().optional().describe("create의 제목"),
      layout: z
        .enum([
          "BLANK",
          "TITLE",
          "TITLE_AND_BODY",
          "TITLE_AND_TWO_COLUMNS",
          "TITLE_ONLY",
          "SECTION_HEADER",
          "CAPTION_ONLY",
          "BIG_NUMBER",
        ])
        .default("TITLE_AND_BODY")
        .describe("add_slide의 레이아웃"),
      insert_at_index: z.number().int().min(0).optional().describe("add_slide 삽입 위치(생략 시 맨 뒤)"),
      slide_object_id: z.string().optional().describe("delete_slide 대상 objectId"),
      texts: z
        .array(
          z.object({
            placeholder: z.enum(["TITLE", "BODY", "SUBTITLE", "CENTERED_TITLE"]).optional(),
            placeholder_index: z.number().int().optional(),
            text: z.string(),
          })
        )
        .optional()
        .describe("add_slide에서 채울 placeholder별 텍스트. 예: [{placeholder:'TITLE',text:'제목'},{placeholder:'BODY',text:'내용'}]"),
      find_text: z.string().optional(),
      replace_text: z.string().optional(),
      match_case: z.boolean().default(false),
      requests: z.array(z.any()).optional().describe("batch_update용 Slides API 요청 배열"),
      max_chars: maxCharsSchema,
    },
    wrap(slidesWrite)
  );

  // ── Google Forms ─────────────────────────────────────────────────────────
  server.tool(
    "forms_tool",
    "Google Forms를 다룬다. action: create(설문 생성 — 문항은 이후 batch_update로), " +
      "get(설문 구조·문항 조회), list_responses(응답 목록), get_response(개별 응답), " +
      "batch_update(문항 추가·수정 등 Forms API 원시 요청).",
    {
      action: z.enum(["create", "get", "list_responses", "get_response", "batch_update"]),
      form_id: z.string().optional().describe("create 외에는 필수"),
      title: z.string().optional().describe("create의 설문 제목"),
      document_title: z.string().optional().describe("create의 파일명(생략 시 title과 동일)"),
      response_id: z.string().optional(),
      filter: z.string().optional().describe("list_responses 필터(예: timestamp > 2026-08-01T00:00:00Z)"),
      page_size: z.number().int().min(1).max(5000).default(50),
      page_token: z.string().optional(),
      requests: z.array(z.any()).optional().describe("batch_update용 Forms API 요청 배열"),
      max_chars: maxCharsSchema,
    },
    wrap(formsTool)
  );

  // ── Google Drive ─────────────────────────────────────────────────────────
  server.tool(
    "drive_search",
    "Google Drive에서 파일·폴더를 찾는다. name_contains(파일명), full_text(**파일 내용 전문검색**), " +
      "mime_type, parent_folder_id를 조합하면 자동으로 쿼리를 만들고, 익숙하면 q에 Drive 쿼리 문법을 " +
      "직접 넣어도 된다. 폴더의 mime_type은 'application/vnd.google-apps.folder', " +
      "스프레드시트는 '…spreadsheet', 문서는 '…document', 슬라이드는 '…presentation'.",
    {
      q: z.string().optional().describe("Drive 쿼리 문법 직접 지정(주면 아래 조건들은 무시)"),
      name_contains: z.string().optional(),
      full_text: z.string().optional().describe("파일 내용에 포함된 문자열로 검색"),
      mime_type: z.string().optional(),
      parent_folder_id: z.string().optional().describe("이 폴더 바로 아래만 검색"),
      include_trashed: z.boolean().default(false),
      order_by: z.string().default("modifiedTime desc"),
      page_size: z.number().int().min(1).max(100).default(20),
      page_token: z.string().optional(),
      include_shared_drives: z.boolean().default(false).describe("공유 드라이브 항목도 포함"),
      drive_id: z.string().optional().describe("특정 공유 드라이브로 한정"),
      max_chars: maxCharsSchema,
    },
    wrap(driveSearch)
  );

  server.tool(
    "drive_file",
    "Drive 파일 단위 작업. action: get_metadata, create(내용까지 업로드 가능), create_folder, " +
      "update_content(**파일 ID를 유지한 채 내용만 교체 — 새 파일을 만들어 갈아끼울 필요가 없다**), " +
      "rename, move(폴더 이동), copy, trash(휴지통), untrash, delete(완전삭제 — permanent=true 필요), " +
      "download(일반 파일 내용을 텍스트로 읽기), " +
      "download_link(**이진 파일은 download를 쓰지 말고 이것을 쓸 것** — 글꼴(.ttf/.ttc)·이미지·" +
      "압축파일처럼 바이트가 깨지면 안 되는 파일과 수 MB 이상 대용량 파일을 조각 다운로드 " +
      "주소 목록으로 돌려준다. 보안상 허용 폴더 안의 파일만 받을 수 있다), " +
      "export(구글 문서형 파일을 text/plain·text/csv·application/pdf 등으로 변환해 읽기).",
    {
      action: z.enum([
        "get_metadata",
        "create",
        "create_folder",
        "update_content",
        "rename",
        "move",
        "copy",
        "trash",
        "untrash",
        "delete",
        "download",
        "download_link",
        "export",
      ]),
      file_id: z.string().optional(),
      name: z.string().optional().describe("create/create_folder/rename/copy의 이름"),
      mime_type: z.string().optional().describe("create/update_content의 콘텐츠 타입(기본 text/plain)"),
      content: z.string().optional().describe("create/update_content에 넣을 본문 텍스트"),
      parent_folder_id: z.string().optional().describe("create/create_folder/copy를 넣을 폴더"),
      new_parent_folder_id: z.string().optional().describe("move의 목적지 폴더"),
      remove_parent_folder_id: z.string().optional().describe("move에서 뺄 기존 폴더(생략 시 자동 조회)"),
      export_mime_type: z.string().optional().describe("export 형식. 예: text/plain, text/csv, application/pdf"),
      permanent: z.boolean().default(false).describe("delete를 실제로 수행하려면 true(되돌릴 수 없음)"),
      chunk_bytes: z.coerce
        .number()
        .int()
        .min(1)
        .max(4 * 1024 * 1024)
        .optional()
        .describe("download_link가 나눌 조각 크기(바이트, 기본 3145728=3MB, 최대 4MB)"),
      include_shared_drives: z.boolean().default(false),
      max_chars: maxCharsSchema,
    },
    wrap((args) => driveFile({ ...args, gate_key: ctx.gateKey, base_url: ctx.baseUrl }))
  );

  server.tool(
    "drive_comments",
    "파일에 달린 댓글을 다룬다. action: list(댓글·답글 조회 — 인용된 원문 구간도 함께), " +
      "create(새 댓글), reply(답글, resolve=true면 해결 처리까지), resolve(해결 처리), delete. " +
      "리뷰 의견을 수집하거나 검토 코멘트를 남길 때 쓴다.",
    {
      action: z.enum(["list", "create", "reply", "resolve", "delete"]),
      file_id: z.string().describe("대상 파일 ID"),
      comment_id: z.string().optional(),
      reply_id: z.string().optional().describe("delete에서 답글만 지울 때"),
      content: z.string().optional().describe("댓글·답글 본문"),
      resolve: z.boolean().default(false).describe("reply와 함께 해결 처리"),
      include_deleted: z.boolean().default(false),
      page_size: z.number().int().min(1).max(100).default(20),
      page_token: z.string().optional(),
      max_chars: maxCharsSchema,
    },
    wrap(driveComments)
  );

  server.tool(
    "drive_revisions",
    "파일의 버전 이력(리비전)을 다룬다. action: list(누가 언제 고쳤는지), get(단건 정보), " +
      "download(**그 시점 내용을 그대로 받아오기 — 실수로 덮어쓴 내용을 되살릴 때**), " +
      "keep_forever(자동 삭제되지 않도록 보존 고정).",
    {
      action: z.enum(["list", "get", "download", "keep_forever"]),
      file_id: z.string().describe("대상 파일 ID"),
      revision_id: z.string().optional(),
      keep_forever: z.boolean().optional().describe("keep_forever의 값(기본 true)"),
      page_size: z.number().int().min(1).max(1000).default(50),
      page_token: z.string().optional(),
      max_chars: maxCharsSchema,
    },
    wrap(driveRevisions)
  );

  server.tool(
    "drive_permissions",
    "파일·폴더의 공유 권한을 다룬다. action: list(**누구에게 열려 있는지 점검**), " +
      "create(공유 추가 — type user/group/domain/anyone, role reader/commenter/writer/owner), " +
      "update(권한 등급 변경), delete(공유 해제). 외부 공유 여부를 점검하거나 회수할 때 쓴다.",
    {
      action: z.enum(["list", "create", "update", "delete"]),
      file_id: z.string().describe("대상 파일·폴더 ID"),
      permission_id: z.string().optional().describe("update/delete 대상(list로 확인)"),
      role: z.enum(["reader", "commenter", "writer", "fileOrganizer", "organizer", "owner"]).optional(),
      type: z.enum(["user", "group", "domain", "anyone"]).optional(),
      email_address: z.string().optional().describe("type이 user/group일 때"),
      domain: z.string().optional().describe("type이 domain일 때"),
      send_notification_email: z.boolean().default(false),
      transfer_ownership: z.boolean().default(false).describe("role='owner'로 넘길 때 필요"),
      allow_file_discovery: z.boolean().optional().describe("type='domain'/'anyone'에서 검색 노출 여부"),
      include_shared_drives: z.boolean().default(false),
      max_chars: maxCharsSchema,
    },
    wrap(drivePermissions)
  );

  server.tool(
    "drive_shared_drives",
    "공유 드라이브(구 팀 드라이브)를 조회한다. action: list(목록), get(단건 상세). " +
      "여기서 얻은 drive_id를 drive_search의 drive_id로 넘기면 그 드라이브 안만 검색한다.",
    {
      action: z.enum(["list", "get"]).default("list"),
      drive_id: z.string().optional(),
      query: z.string().optional().describe("이름 검색 예: name contains '영업'"),
      page_size: z.number().int().min(1).max(100).default(20),
      page_token: z.string().optional(),
      max_chars: maxCharsSchema,
    },
    wrap(driveSharedDrives)
  );

  server.tool(
    "drive_changes",
    "마지막 확인 시점 이후 Drive에서 무엇이 바뀌었는지 본다. 먼저 action='get_start_token'으로 " +
      "시작 토큰을 받아 두고, 나중에 action='list'에 그 토큰을 넘기면 그 사이의 변경분만 나온다. " +
      "예약 작업에서 '새로 올라온 파일만' 처리할 때 체크포인트 대용으로 쓸 수 있다.",
    {
      action: z.enum(["get_start_token", "list"]).default("list"),
      page_token: z.string().optional().describe("list에 필요한 토큰(get_start_token으로 받은 값)"),
      page_size: z.number().int().min(1).max(1000).default(50),
      include_shared_drives: z.boolean().default(false),
      max_chars: maxCharsSchema,
    },
    wrap(driveChanges)
  );

  return server;
}
