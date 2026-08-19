// google-workspace-mcp / lib/slides.js — Google Slides API v1
import { googleFetch } from "./google_client.js";

const BASE = "https://slides.googleapis.com/v1/presentations";

/** 슬라이드 1장에서 텍스트만 모아준다. */
function slideText(slide) {
  const parts = [];
  for (const el of slide.pageElements || []) {
    const runs = el.shape?.text?.textElements || [];
    for (const t of runs) if (t.textRun?.content) parts.push(t.textRun.content);
    for (const row of el.table?.tableRows || []) {
      for (const cell of row.tableCells || []) {
        for (const t of cell.text?.textElements || []) if (t.textRun?.content) parts.push(t.textRun.content);
      }
    }
  }
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export async function slidesRead({ presentation_id, format = "text", slide_index }) {
  if (!presentation_id) throw new Error("presentation_id는 필수입니다.");
  const r = await googleFetch(`${BASE}/${encodeURIComponent(presentation_id)}`);
  if (format === "raw") return r;

  let slides = r.slides || [];
  if (slide_index !== undefined && slide_index !== null) {
    if (slide_index < 0 || slide_index >= slides.length)
      throw new Error(`slide_index 범위를 벗어났습니다(0~${slides.length - 1}).`);
    slides = [slides[slide_index]];
  }
  return {
    presentationId: r.presentationId,
    title: r.title,
    slideCount: (r.slides || []).length,
    pageSize: r.pageSize,
    slides: slides.map((s, i) => ({
      index: slide_index ?? i,
      objectId: s.objectId,
      layout: s.slideProperties?.layoutObjectId,
      elementCount: (s.pageElements || []).length,
      text: slideText(s),
      speakerNotes: (() => {
        const notes = s.slideProperties?.notesPage;
        if (!notes) return undefined;
        return slideText(notes) || undefined;
      })(),
    })),
  };
}

export async function slidesWrite({
  action,
  presentation_id,
  title,
  layout = "TITLE_AND_BODY",
  insert_at_index,
  slide_object_id,
  texts,
  find_text,
  replace_text,
  match_case = false,
  requests,
}) {
  if (action === "create") {
    if (!title) throw new Error("create에는 title이 필요합니다.");
    const r = await googleFetch(BASE, { method: "POST", body: { title } });
    return {
      action,
      presentationId: r.presentationId,
      title: r.title,
      url: `https://docs.google.com/presentation/d/${r.presentationId}/edit`,
      slideCount: (r.slides || []).length,
      note: "새 프레젠테이션에는 기본 슬라이드 1장이 들어있습니다.",
    };
  }

  if (!presentation_id) throw new Error("presentation_id는 필수입니다.");
  let reqs;

  if (action === "add_slide") {
    const createReq = {
      createSlide: { slideLayoutReference: { predefinedLayout: layout } },
    };
    if (insert_at_index !== undefined && insert_at_index !== null)
      createReq.createSlide.insertionIndex = insert_at_index;

    // 레이아웃 placeholder에 곧바로 텍스트를 채우려면 placeholderIdMappings로
    // 예측 가능한 objectId를 미리 부여해야 한다.
    const stamp = `s${Math.random().toString(36).slice(2, 8)}`;
    if (Array.isArray(texts) && texts.length > 0) {
      createReq.createSlide.placeholderIdMappings = texts.map((t, i) => ({
        layoutPlaceholder: { type: t.placeholder || (i === 0 ? "TITLE" : "BODY"), index: t.placeholder_index || 0 },
        objectId: `${stamp}_${i}`,
      }));
    }
    reqs = [createReq];
    if (Array.isArray(texts)) {
      texts.forEach((t, i) => {
        if (t.text) reqs.push({ insertText: { objectId: `${stamp}_${i}`, text: t.text } });
      });
    }
  } else if (action === "delete_slide") {
    if (!slide_object_id) throw new Error("delete_slide에는 slide_object_id가 필요합니다(slides_read로 확인).");
    reqs = [{ deleteObject: { objectId: slide_object_id } }];
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
      throw new Error("batch_update에는 requests(Slides API batchUpdate 요청 배열)가 필요합니다.");
    reqs = requests;
  } else {
    throw new Error(`알 수 없는 action: ${action}`);
  }

  const r = await googleFetch(`${BASE}/${encodeURIComponent(presentation_id)}:batchUpdate`, {
    method: "POST",
    body: { requests: reqs },
  });
  return { action, presentationId: r.presentationId, replies: r.replies };
}
