// google-workspace-mcp / lib/docs.js — Google Docs API v1
import { googleFetch } from "./google_client.js";

const BASE = "https://docs.googleapis.com/v1/documents";

/** Docs API의 중첩 구조에서 순수 텍스트만 뽑아낸다. */
function extractText(body) {
  const out = [];
  const walkElements = (elements) => {
    for (const el of elements || []) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements || []) {
          if (pe.textRun?.content) out.push(pe.textRun.content);
        }
      } else if (el.table) {
        for (const row of el.table.tableRows || []) {
          const cells = [];
          for (const cell of row.tableCells || []) {
            const before = out.length;
            walkElements(cell.content);
            cells.push(out.splice(before).join("").replace(/\n+/g, " ").trim());
          }
          out.push(cells.join(" | ") + "\n");
        }
      } else if (el.tableOfContents) {
        walkElements(el.tableOfContents.content);
      }
    }
  };
  walkElements(body?.content);
  return out.join("");
}

export async function docsRead({ document_id, format = "text" }) {
  if (!document_id) throw new Error("document_id는 필수입니다.");
  const r = await googleFetch(`${BASE}/${encodeURIComponent(document_id)}`);
  const base = {
    documentId: r.documentId,
    title: r.title,
    revisionId: r.revisionId,
  };
  if (format === "raw") return { ...base, body: r.body, inlineObjects: r.inlineObjects };
  const text = extractText(r.body);
  return {
    ...base,
    charCount: text.length,
    // endIndex는 insert_text에서 "문서 맨 끝"을 지정할 때 필요하다.
    endIndex: r.body?.content?.[r.body.content.length - 1]?.endIndex,
    text,
  };
}

export async function docsWrite({
  action,
  document_id,
  title,
  text,
  index,
  find_text,
  replace_text,
  match_case = false,
  requests,
}) {
  if (action === "create") {
    if (!title) throw new Error("create에는 title이 필요합니다.");
    const r = await googleFetch(BASE, { method: "POST", body: { title } });
    const out = {
      action,
      documentId: r.documentId,
      title: r.title,
      url: `https://docs.google.com/document/d/${r.documentId}/edit`,
    };
    // 생성과 동시에 본문을 넣어달라는 요청이면 이어서 삽입한다.
    if (text) {
      await googleFetch(`${BASE}/${encodeURIComponent(r.documentId)}:batchUpdate`, {
        method: "POST",
        body: { requests: [{ insertText: { location: { index: 1 }, text } }] },
      });
      out.insertedChars = text.length;
    }
    return out;
  }

  if (!document_id) throw new Error("document_id는 필수입니다.");
  let reqs;

  if (action === "append_text") {
    if (!text) throw new Error("append_text에는 text가 필요합니다.");
    // endOfSegmentLocation을 쓰면 현재 문서 길이를 몰라도 맨 끝에 붙일 수 있다.
    reqs = [{ insertText: { endOfSegmentLocation: {}, text } }];
  } else if (action === "insert_text") {
    if (!text) throw new Error("insert_text에는 text가 필요합니다.");
    if (index === undefined || index === null)
      throw new Error("insert_text에는 index가 필요합니다(docs_read로 위치 확인, 본문 시작은 1).");
    reqs = [{ insertText: { location: { index }, text } }];
  } else if (action === "replace_text") {
    if (!find_text) throw new Error("replace_text에는 find_text가 필요합니다.");
    reqs = [
      {
        replaceAllText: {
          containsText: { text: find_text, matchCase: !!match_case },
          replaceText: replace_text ?? "",
        },
      },
    ];
  } else if (action === "batch_update") {
    if (!Array.isArray(requests) || requests.length === 0)
      throw new Error("batch_update에는 requests(Docs API batchUpdate 요청 배열)가 필요합니다.");
    reqs = requests;
  } else {
    throw new Error(`알 수 없는 action: ${action}`);
  }

  const r = await googleFetch(`${BASE}/${encodeURIComponent(document_id)}:batchUpdate`, {
    method: "POST",
    body: { requests: reqs },
  });
  return { action, documentId: r.documentId, replies: r.replies };
}
