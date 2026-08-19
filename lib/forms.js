// google-workspace-mcp / lib/forms.js — Google Forms API v1
import { googleFetch, qs } from "./google_client.js";

const BASE = "https://forms.googleapis.com/v1/forms";

export async function formsTool({ action, form_id, title, document_title, requests, response_id, page_size = 50, page_token, filter }) {
  if (action === "create") {
    if (!title) throw new Error("create에는 title이 필요합니다.");
    // Forms API는 생성 시 info.title만 허용한다(문항은 이후 batchUpdate로 추가).
    const info = { title };
    if (document_title) info.documentTitle = document_title;
    const r = await googleFetch(BASE, { method: "POST", body: { info } });
    return {
      action,
      formId: r.formId,
      title: r.info?.title,
      responderUri: r.responderUri,
      editUrl: `https://docs.google.com/forms/d/${r.formId}/edit`,
      note: "문항은 action='batch_update'로 추가하세요(Forms API의 createItem 요청 형식).",
    };
  }

  if (!form_id) throw new Error("form_id는 필수입니다.");

  if (action === "get") {
    const r = await googleFetch(`${BASE}/${encodeURIComponent(form_id)}`);
    return {
      action,
      formId: r.formId,
      title: r.info?.title,
      description: r.info?.description,
      responderUri: r.responderUri,
      itemCount: (r.items || []).length,
      items: r.items,
    };
  }

  if (action === "list_responses") {
    const r = await googleFetch(
      `${BASE}/${encodeURIComponent(form_id)}/responses` +
        qs({ pageSize: Math.min(Math.max(page_size, 1), 5000), pageToken: page_token, filter })
    );
    return {
      action,
      count: (r.responses || []).length,
      nextPageToken: r.nextPageToken,
      responses: r.responses || [],
    };
  }

  if (action === "get_response") {
    if (!response_id) throw new Error("get_response에는 response_id가 필요합니다.");
    return {
      action,
      ...(await googleFetch(`${BASE}/${encodeURIComponent(form_id)}/responses/${encodeURIComponent(response_id)}`)),
    };
  }

  if (action === "batch_update") {
    if (!Array.isArray(requests) || requests.length === 0)
      throw new Error("batch_update에는 requests(Forms API batchUpdate 요청 배열)가 필요합니다.");
    const r = await googleFetch(`${BASE}/${encodeURIComponent(form_id)}:batchUpdate`, {
      method: "POST",
      body: { requests, includeFormInResponse: false },
    });
    return { action, replies: r.replies };
  }

  throw new Error(`알 수 없는 action: ${action}`);
}
