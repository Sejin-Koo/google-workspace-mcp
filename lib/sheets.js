// google-workspace-mcp / lib/sheets.js — Google Sheets API v4
import { googleFetch, qs } from "./google_client.js";

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * 값 읽기/추가/수정/삭제.
 * append 가 이 서버를 만든 핵심 이유다 — 기존 파일을 통째로 새로 만들지 않고 행만 덧붙인다.
 */
export async function sheetsValues({
  action,
  spreadsheet_id,
  range,
  values,
  value_input_option = "USER_ENTERED",
  major_dimension = "ROWS",
  insert_data_option = "INSERT_ROWS",
}) {
  if (!spreadsheet_id) throw new Error("spreadsheet_id는 필수입니다.");

  if (action === "read") {
    if (!range) throw new Error("read에는 range가 필요합니다(예: '시트1' 또는 '시트1!A1:H50').");
    const r = await googleFetch(
      `${BASE}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}` +
        qs({ majorDimension: major_dimension })
    );
    return {
      action,
      range: r.range,
      rowCount: (r.values || []).length,
      values: r.values || [],
    };
  }

  if (action === "append") {
    if (!range) throw new Error("append에는 range가 필요합니다(붙일 표의 시작 지점, 예: '시트1!A1').");
    if (!Array.isArray(values) || values.length === 0)
      throw new Error("append에는 values(2차원 배열)가 필요합니다. 예: [[\"2026-08-19\",\"금강CC\",91]]");
    const r = await googleFetch(
      `${BASE}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}:append` +
        qs({
          valueInputOption: value_input_option,
          insertDataOption: insert_data_option,
          includeValuesInResponse: "false",
        }),
      { method: "POST", body: { values, majorDimension: major_dimension } }
    );
    return {
      action,
      updatedRange: r.updates?.updatedRange,
      updatedRows: r.updates?.updatedRows,
      updatedCells: r.updates?.updatedCells,
      note: "기존 데이터를 보존한 채 행만 추가했습니다.",
    };
  }

  if (action === "update") {
    if (!range) throw new Error("update에는 range가 필요합니다(예: '시트1!B2:D2').");
    if (!Array.isArray(values)) throw new Error("update에는 values(2차원 배열)가 필요합니다.");
    const r = await googleFetch(
      `${BASE}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}` +
        qs({ valueInputOption: value_input_option }),
      { method: "PUT", body: { values, majorDimension: major_dimension, range } }
    );
    return { action, updatedRange: r.updatedRange, updatedRows: r.updatedRows, updatedCells: r.updatedCells };
  }

  if (action === "clear") {
    if (!range) throw new Error("clear에는 range가 필요합니다.");
    const r = await googleFetch(
      `${BASE}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}:clear`,
      { method: "POST", body: {} }
    );
    return { action, clearedRange: r.clearedRange };
  }

  throw new Error(`알 수 없는 action: ${action}`);
}

/** 스프레드시트 자체와 탭(시트) 관리. */
export async function sheetsManage({
  action,
  spreadsheet_id,
  title,
  sheet_title,
  sheet_id,
  new_title,
  rows,
  columns,
  include_grid_data = false,
  requests,
}) {
  if (action === "create_spreadsheet") {
    if (!title) throw new Error("create_spreadsheet에는 title이 필요합니다.");
    const bodyObj = { properties: { title } };
    if (sheet_title) bodyObj.sheets = [{ properties: { title: sheet_title } }];
    const r = await googleFetch(BASE, { method: "POST", body: bodyObj });
    return {
      action,
      spreadsheetId: r.spreadsheetId,
      spreadsheetUrl: r.spreadsheetUrl,
      sheets: (r.sheets || []).map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title })),
      note: "새로 만든 파일은 내 드라이브 최상위에 생성됩니다. 특정 폴더로 옮기려면 drive_file(action='move')를 쓰세요.",
    };
  }

  if (!spreadsheet_id) throw new Error("spreadsheet_id는 필수입니다.");

  if (action === "get_metadata") {
    const r = await googleFetch(
      `${BASE}/${encodeURIComponent(spreadsheet_id)}` +
        qs({
          includeGridData: include_grid_data ? "true" : "false",
          fields: include_grid_data ? undefined : "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties",
        })
    );
    return {
      action,
      spreadsheetId: r.spreadsheetId,
      title: r.properties?.title,
      spreadsheetUrl: r.spreadsheetUrl,
      sheets: (r.sheets || []).map((s) => ({
        sheetId: s.properties?.sheetId,
        title: s.properties?.title,
        index: s.properties?.index,
        rowCount: s.properties?.gridProperties?.rowCount,
        columnCount: s.properties?.gridProperties?.columnCount,
      })),
    };
  }

  // 아래는 전부 batchUpdate 기반
  let reqs;
  if (action === "add_sheet") {
    if (!sheet_title) throw new Error("add_sheet에는 sheet_title이 필요합니다.");
    const props = { title: sheet_title };
    if (rows || columns) props.gridProperties = { rowCount: rows || 1000, columnCount: columns || 26 };
    reqs = [{ addSheet: { properties: props } }];
  } else if (action === "delete_sheet") {
    if (sheet_id === undefined || sheet_id === null)
      throw new Error("delete_sheet에는 sheet_id가 필요합니다(get_metadata로 확인).");
    reqs = [{ deleteSheet: { sheetId: sheet_id } }];
  } else if (action === "rename_sheet") {
    if (sheet_id === undefined || sheet_id === null || !new_title)
      throw new Error("rename_sheet에는 sheet_id와 new_title이 필요합니다.");
    reqs = [{ updateSheetProperties: { properties: { sheetId: sheet_id, title: new_title }, fields: "title" } }];
  } else if (action === "rename_spreadsheet") {
    if (!new_title) throw new Error("rename_spreadsheet에는 new_title이 필요합니다.");
    reqs = [{ updateSpreadsheetProperties: { properties: { title: new_title }, fields: "title" } }];
  } else if (action === "batch_update") {
    if (!Array.isArray(requests) || requests.length === 0)
      throw new Error("batch_update에는 requests(Sheets API batchUpdate 요청 배열)가 필요합니다.");
    reqs = requests;
  } else {
    throw new Error(`알 수 없는 action: ${action}`);
  }

  const r = await googleFetch(`${BASE}/${encodeURIComponent(spreadsheet_id)}:batchUpdate`, {
    method: "POST",
    body: { requests: reqs },
  });
  return { action, replies: r.replies, spreadsheetId: r.spreadsheetId };
}
