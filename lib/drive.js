// google-workspace-mcp / lib/drive.js — Google Drive API v3 (파일·댓글·리비전·권한·공유드라이브)
import { googleFetch, qs } from "./google_client.js";

const BASE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

const FILE_FIELDS =
  "id,name,mimeType,parents,createdTime,modifiedTime,size,owners(displayName,emailAddress),webViewLink,trashed,shared,driveId";

/** 공유드라이브 항목까지 조회하려면 이 플래그들이 함께 필요하다. */
function sharedDriveParams(include_shared_drives, drive_id) {
  if (!include_shared_drives && !drive_id) return {};
  return {
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    ...(drive_id ? { driveId: drive_id, corpora: "drive" } : { corpora: "allDrives" }),
  };
}

/**
 * 파일 검색. name_contains/full_text/mime_type/parent_folder_id 조합으로 q를 조립하거나,
 * q를 직접 넘겨 Drive 쿼리 문법을 그대로 쓸 수도 있다.
 */
export async function driveSearch({
  q,
  name_contains,
  full_text,
  mime_type,
  parent_folder_id,
  include_trashed = false,
  order_by = "modifiedTime desc",
  page_size = 20,
  page_token,
  include_shared_drives = false,
  drive_id,
}) {
  let query = q;
  if (!query) {
    const parts = [];
    if (name_contains) parts.push(`name contains '${String(name_contains).replace(/'/g, "\\'")}'`);
    if (full_text) parts.push(`fullText contains '${String(full_text).replace(/'/g, "\\'")}'`);
    if (mime_type) parts.push(`mimeType = '${mime_type}'`);
    if (parent_folder_id) parts.push(`'${parent_folder_id}' in parents`);
    if (!include_trashed) parts.push("trashed = false");
    query = parts.join(" and ");
  }

  const r = await googleFetch(
    BASE +
      qs({
        q: query || undefined,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        orderBy: order_by,
        pageSize: Math.min(Math.max(page_size, 1), 100),
        pageToken: page_token,
        ...sharedDriveParams(include_shared_drives, drive_id),
      })
  );
  return {
    query: query || "(전체)",
    count: (r.files || []).length,
    nextPageToken: r.nextPageToken,
    files: r.files || [],
  };
}

/** 파일 단위 작업 일체. */
export async function driveFile({
  action,
  file_id,
  name,
  mime_type,
  content,
  parent_folder_id,
  new_parent_folder_id,
  remove_parent_folder_id,
  export_mime_type,
  permanent = false,
  include_shared_drives = false,
}) {
  const sd = include_shared_drives ? { supportsAllDrives: "true" } : {};

  if (action === "get_metadata") {
    if (!file_id) throw new Error("get_metadata에는 file_id가 필요합니다.");
    return await googleFetch(`${BASE}/${encodeURIComponent(file_id)}` + qs({ fields: FILE_FIELDS, ...sd }));
  }

  if (action === "create_folder") {
    if (!name) throw new Error("create_folder에는 name이 필요합니다.");
    const body = { name, mimeType: "application/vnd.google-apps.folder" };
    if (parent_folder_id) body.parents = [parent_folder_id];
    const r = await googleFetch(BASE + qs({ fields: FILE_FIELDS, ...sd }), { method: "POST", body });
    return { action, ...r };
  }

  if (action === "create") {
    if (!name) throw new Error("create에는 name이 필요합니다.");
    const meta = { name };
    if (parent_folder_id) meta.parents = [parent_folder_id];
    if (mime_type) meta.mimeType = mime_type;

    if (content === undefined || content === null) {
      const r = await googleFetch(BASE + qs({ fields: FILE_FIELDS, ...sd }), { method: "POST", body: meta });
      return { action, ...r };
    }
    // multipart 업로드: 메타데이터 + 본문을 한 번에 보낸다.
    const boundary = "gwsmcp" + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(meta) +
      `\r\n--${boundary}\r\nContent-Type: ${mime_type || "text/plain"}; charset=UTF-8\r\n\r\n` +
      content +
      `\r\n--${boundary}--`;
    const r = await googleFetch(UPLOAD + qs({ uploadType: "multipart", fields: FILE_FIELDS, ...sd }), {
      method: "POST",
      body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    });
    return { action, ...r };
  }

  if (action === "update_content") {
    if (!file_id) throw new Error("update_content에는 file_id가 필요합니다.");
    if (content === undefined || content === null) throw new Error("update_content에는 content가 필요합니다.");
    const r = await googleFetch(
      `${UPLOAD}/${encodeURIComponent(file_id)}` + qs({ uploadType: "media", fields: FILE_FIELDS, ...sd }),
      {
        method: "PATCH",
        body: content,
        headers: { "Content-Type": `${mime_type || "text/plain"}; charset=UTF-8` },
      }
    );
    return { action, ...r, note: "파일 ID를 유지한 채 내용만 교체했습니다." };
  }

  if (action === "rename") {
    if (!file_id || !name) throw new Error("rename에는 file_id와 name이 필요합니다.");
    const r = await googleFetch(`${BASE}/${encodeURIComponent(file_id)}` + qs({ fields: FILE_FIELDS, ...sd }), {
      method: "PATCH",
      body: { name },
    });
    return { action, ...r };
  }

  if (action === "move") {
    if (!file_id || !new_parent_folder_id)
      throw new Error("move에는 file_id와 new_parent_folder_id가 필요합니다.");
    let removeParents = remove_parent_folder_id;
    if (!removeParents) {
      const cur = await googleFetch(`${BASE}/${encodeURIComponent(file_id)}` + qs({ fields: "parents", ...sd }));
      removeParents = (cur.parents || []).join(",");
    }
    const r = await googleFetch(
      `${BASE}/${encodeURIComponent(file_id)}` +
        qs({ addParents: new_parent_folder_id, removeParents: removeParents || undefined, fields: FILE_FIELDS, ...sd }),
      { method: "PATCH", body: {} }
    );
    return { action, ...r };
  }

  if (action === "copy") {
    if (!file_id) throw new Error("copy에는 file_id가 필요합니다.");
    const body = {};
    if (name) body.name = name;
    if (parent_folder_id) body.parents = [parent_folder_id];
    const r = await googleFetch(
      `${BASE}/${encodeURIComponent(file_id)}/copy` + qs({ fields: FILE_FIELDS, ...sd }),
      { method: "POST", body }
    );
    return { action, ...r };
  }

  if (action === "trash" || action === "untrash") {
    if (!file_id) throw new Error(`${action}에는 file_id가 필요합니다.`);
    const r = await googleFetch(`${BASE}/${encodeURIComponent(file_id)}` + qs({ fields: FILE_FIELDS, ...sd }), {
      method: "PATCH",
      body: { trashed: action === "trash" },
    });
    return { action, ...r };
  }

  if (action === "delete") {
    if (!file_id) throw new Error("delete에는 file_id가 필요합니다.");
    if (!permanent)
      throw new Error(
        "delete는 되돌릴 수 없는 완전삭제입니다. 정말 지우려면 permanent=true를 함께 넘기세요. " +
          "휴지통으로 보내려면 action='trash'를 쓰세요."
      );
    await googleFetch(`${BASE}/${encodeURIComponent(file_id)}` + qs({ ...sd }), { method: "DELETE" });
    return { action, file_id, deleted: true, note: "휴지통을 거치지 않고 완전삭제했습니다." };
  }

  if (action === "download") {
    if (!file_id) throw new Error("download에는 file_id가 필요합니다.");
    const res = await googleFetch(`${BASE}/${encodeURIComponent(file_id)}` + qs({ alt: "media", ...sd }), {
      raw: true,
    });
    return { action, file_id, text: await res.text() };
  }

  if (action === "export") {
    if (!file_id) throw new Error("export에는 file_id가 필요합니다.");
    const mt = export_mime_type || "text/plain";
    const res = await googleFetch(
      `${BASE}/${encodeURIComponent(file_id)}/export` + qs({ mimeType: mt, ...sd }),
      { raw: true }
    );
    return { action, file_id, exportMimeType: mt, text: await res.text() };
  }

  throw new Error(`알 수 없는 action: ${action}`);
}

/** 파일 댓글 — 리뷰 코멘트를 읽고 달고 해결 처리한다. */
export async function driveComments({
  action,
  file_id,
  comment_id,
  reply_id,
  content,
  resolve = false,
  include_deleted = false,
  page_size = 20,
  page_token,
}) {
  if (!file_id) throw new Error("file_id는 필수입니다.");
  const CBASE = `${BASE}/${encodeURIComponent(file_id)}/comments`;
  const FIELDS =
    "nextPageToken,comments(id,createdTime,modifiedTime,author(displayName,emailAddress),content,resolved,quotedFileContent,replies(id,createdTime,author(displayName),content,action))";

  if (action === "list") {
    const r = await googleFetch(
      CBASE +
        qs({
          fields: FIELDS,
          pageSize: Math.min(Math.max(page_size, 1), 100),
          pageToken: page_token,
          includeDeleted: include_deleted ? "true" : "false",
        })
    );
    return { action, count: (r.comments || []).length, nextPageToken: r.nextPageToken, comments: r.comments || [] };
  }

  if (action === "create") {
    if (!content) throw new Error("create에는 content가 필요합니다.");
    const r = await googleFetch(CBASE + qs({ fields: "id,content,createdTime,author(displayName)" }), {
      method: "POST",
      body: { content },
    });
    return { action, ...r };
  }

  if (action === "reply") {
    if (!comment_id || !content) throw new Error("reply에는 comment_id와 content가 필요합니다.");
    const body = { content };
    if (resolve) body.action = "resolve";
    const r = await googleFetch(
      `${CBASE}/${encodeURIComponent(comment_id)}/replies` +
        qs({ fields: "id,content,createdTime,action,author(displayName)" }),
      { method: "POST", body }
    );
    return { action, commentId: comment_id, ...r };
  }

  if (action === "resolve") {
    if (!comment_id) throw new Error("resolve에는 comment_id가 필요합니다.");
    // Drive API에서 댓글 해결은 action='resolve'인 답글을 다는 방식이다.
    const r = await googleFetch(
      `${CBASE}/${encodeURIComponent(comment_id)}/replies` + qs({ fields: "id,action,createdTime" }),
      { method: "POST", body: { content: content || "해결 처리", action: "resolve" } }
    );
    return { action, commentId: comment_id, ...r };
  }

  if (action === "delete") {
    if (!comment_id) throw new Error("delete에는 comment_id가 필요합니다.");
    const url = reply_id
      ? `${CBASE}/${encodeURIComponent(comment_id)}/replies/${encodeURIComponent(reply_id)}`
      : `${CBASE}/${encodeURIComponent(comment_id)}`;
    await googleFetch(url, { method: "DELETE" });
    return { action, commentId: comment_id, replyId: reply_id, deleted: true };
  }

  throw new Error(`알 수 없는 action: ${action}`);
}

/** 리비전(버전 이력) — 과거 버전 확인·내용 회수. */
export async function driveRevisions({ action, file_id, revision_id, page_size = 50, page_token, keep_forever }) {
  if (!file_id) throw new Error("file_id는 필수입니다.");
  const RBASE = `${BASE}/${encodeURIComponent(file_id)}/revisions`;
  const FIELDS =
    "nextPageToken,revisions(id,modifiedTime,size,keepForever,lastModifyingUser(displayName,emailAddress),originalFilename,mimeType)";

  if (action === "list") {
    const r = await googleFetch(
      RBASE + qs({ fields: FIELDS, pageSize: Math.min(Math.max(page_size, 1), 1000), pageToken: page_token })
    );
    return { action, count: (r.revisions || []).length, nextPageToken: r.nextPageToken, revisions: r.revisions || [] };
  }

  if (action === "get") {
    if (!revision_id) throw new Error("get에는 revision_id가 필요합니다.");
    return {
      action,
      ...(await googleFetch(
        `${RBASE}/${encodeURIComponent(revision_id)}` +
          qs({ fields: "id,modifiedTime,size,keepForever,lastModifyingUser(displayName),mimeType,originalFilename" })
      )),
    };
  }

  if (action === "download") {
    if (!revision_id) throw new Error("download에는 revision_id가 필요합니다.");
    const res = await googleFetch(`${RBASE}/${encodeURIComponent(revision_id)}` + qs({ alt: "media" }), {
      raw: true,
    });
    return { action, revisionId: revision_id, text: await res.text() };
  }

  if (action === "keep_forever") {
    if (!revision_id) throw new Error("keep_forever에는 revision_id가 필요합니다.");
    const r = await googleFetch(
      `${RBASE}/${encodeURIComponent(revision_id)}` + qs({ fields: "id,keepForever" }),
      { method: "PATCH", body: { keepForever: keep_forever !== false } }
    );
    return { action, ...r };
  }

  throw new Error(`알 수 없는 action: ${action}`);
}

/** 공유 권한 — 누구에게 열려 있는지 확인하고 조정한다. */
export async function drivePermissions({
  action,
  file_id,
  permission_id,
  role,
  type,
  email_address,
  domain,
  send_notification_email = false,
  transfer_ownership = false,
  allow_file_discovery,
  include_shared_drives = false,
}) {
  if (!file_id) throw new Error("file_id는 필수입니다.");
  const PBASE = `${BASE}/${encodeURIComponent(file_id)}/permissions`;
  const sd = include_shared_drives ? { supportsAllDrives: "true" } : {};

  if (action === "list") {
    const r = await googleFetch(
      PBASE +
        qs({
          fields: "permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery,deleted)",
          pageSize: 100,
          ...sd,
        })
    );
    return { action, count: (r.permissions || []).length, permissions: r.permissions || [] };
  }

  if (action === "create") {
    if (!role || !type) throw new Error("create에는 role(reader/commenter/writer/owner)과 type(user/group/domain/anyone)이 필요합니다.");
    const body = { role, type };
    if (type === "user" || type === "group") {
      if (!email_address) throw new Error("type이 user/group이면 email_address가 필요합니다.");
      body.emailAddress = email_address;
    }
    if (type === "domain") {
      if (!domain) throw new Error("type이 domain이면 domain이 필요합니다.");
      body.domain = domain;
    }
    if (allow_file_discovery !== undefined) body.allowFileDiscovery = allow_file_discovery;
    const r = await googleFetch(
      PBASE +
        qs({
          fields: "id,type,role,emailAddress,domain",
          sendNotificationEmail: send_notification_email ? "true" : "false",
          transferOwnership: transfer_ownership ? "true" : undefined,
          ...sd,
        }),
      { method: "POST", body }
    );
    return { action, ...r };
  }

  if (action === "update") {
    if (!permission_id || !role) throw new Error("update에는 permission_id와 role이 필요합니다.");
    const r = await googleFetch(
      `${PBASE}/${encodeURIComponent(permission_id)}` +
        qs({ fields: "id,type,role,emailAddress", transferOwnership: transfer_ownership ? "true" : undefined, ...sd }),
      { method: "PATCH", body: { role } }
    );
    return { action, ...r };
  }

  if (action === "delete") {
    if (!permission_id) throw new Error("delete에는 permission_id가 필요합니다(list로 확인).");
    await googleFetch(`${PBASE}/${encodeURIComponent(permission_id)}` + qs({ ...sd }), { method: "DELETE" });
    return { action, permissionId: permission_id, deleted: true };
  }

  throw new Error(`알 수 없는 action: ${action}`);
}

/** 공유 드라이브(구 팀 드라이브) 목록·정보. */
export async function driveSharedDrives({ action = "list", drive_id, query, page_size = 20, page_token }) {
  const DBASE = "https://www.googleapis.com/drive/v3/drives";

  if (action === "list") {
    const r = await googleFetch(
      DBASE +
        qs({
          q: query,
          pageSize: Math.min(Math.max(page_size, 1), 100),
          pageToken: page_token,
          fields: "nextPageToken,drives(id,name,createdTime,capabilities/canAddChildren)",
        })
    );
    return { action, count: (r.drives || []).length, nextPageToken: r.nextPageToken, drives: r.drives || [] };
  }

  if (action === "get") {
    if (!drive_id) throw new Error("get에는 drive_id가 필요합니다.");
    return { action, ...(await googleFetch(`${DBASE}/${encodeURIComponent(drive_id)}` + qs({ fields: "*" }))) };
  }

  throw new Error(`알 수 없는 action: ${action}`);
}

/** 변경 감지 — 마지막 확인 시점 이후 무엇이 바뀌었는지. */
export async function driveChanges({ action = "list", page_token, page_size = 50, include_shared_drives = false }) {
  const CBASE = "https://www.googleapis.com/drive/v3/changes";

  if (action === "get_start_token") {
    const r = await googleFetch(
      `${CBASE}/startPageToken` + qs({ ...(include_shared_drives ? { supportsAllDrives: "true" } : {}) })
    );
    return {
      action,
      startPageToken: r.startPageToken,
      note: "이 토큰을 저장해 두었다가 다음에 action='list'의 page_token으로 넘기면 그 사이 변경분만 받습니다.",
    };
  }

  if (action === "list") {
    if (!page_token)
      throw new Error("list에는 page_token이 필요합니다. 먼저 action='get_start_token'으로 시작 토큰을 받으세요.");
    const r = await googleFetch(
      CBASE +
        qs({
          pageToken: page_token,
          pageSize: Math.min(Math.max(page_size, 1), 1000),
          fields: `nextPageToken,newStartPageToken,changes(fileId,time,removed,file(${FILE_FIELDS}))`,
          ...(include_shared_drives
            ? { supportsAllDrives: "true", includeItemsFromAllDrives: "true" }
            : {}),
        })
    );
    return {
      action,
      count: (r.changes || []).length,
      changes: r.changes || [],
      nextPageToken: r.nextPageToken,
      newStartPageToken: r.newStartPageToken,
    };
  }

  throw new Error(`알 수 없는 action: ${action}`);
}
