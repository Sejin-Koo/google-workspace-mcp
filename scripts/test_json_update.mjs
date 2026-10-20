// drive_json_update 스모크테스트 — 실제 Google Drive API에 붙어 append/merge/set/read와
// 오류 경로(배열 아닌 경로에 append, 경로 없음, create_parents, 배열 루트에 점 경로 쓰기 금지)
// 까지 확인한다. 배열 루트용 파일과 객체 루트용 파일을 따로 만들어 각각의 실제 상태파일
// 형태(it_bid_stage_log.json=배열 루트, it_bid_progress_marker.json=객체 루트)를 흉내낸다.
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
import { driveFile, driveJsonUpdate } from "../lib/drive.js";
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

await step("buildServer(): drive_json_update 등록 확인", async () => {
  buildServer();
  return { built: true };
});

await step("OAuth access_token 발급", async () => {
  const t = await getAccessToken();
  return { tokenLength: t.length };
});

const created = {};

// ── 1부: 배열 루트 파일(it_bid_stage_log.json 흉내) — append/dedupe/배열가드 ──────
const arrFile = await step("준비: 배열 루트 JSON 파일 생성", () =>
  driveFile({
    action: "create",
    name: "[스모크테스트] drive_json_update_array.json",
    mime_type: "application/json",
    content: JSON.stringify([{ run: "a", n: 1 }], null, 2),
  })
);
if (arrFile?.id) created.arrFileId = arrFile.id;

if (created.arrFileId) {
  const fid = created.arrFileId;

  await step("read: 루트 배열 확인(1건)", () => driveJsonUpdate({ action: "read", file_id: fid }));

  await step("append: 중복 없는 항목 2건 추가", () =>
    driveJsonUpdate({ action: "append", file_id: fid, items: [{ run: "b", n: 2 }, { run: "c", n: 3 }] })
  );

  await step("append: dedupe_key로 기존 항목 건너뛰기(run='b' 중복 + 새 항목 'd')", async () => {
    const r = await driveJsonUpdate({
      action: "append",
      file_id: fid,
      items: [{ run: "b", n: 99 }, { run: "d", n: 4 }],
      dedupe_key: "run",
    });
    if (r.added !== 1 || r.skipped !== 1) throw new Error(`기대와 다름: ${JSON.stringify(r)}`);
    return r;
  });

  await step("read: 누적 4건이어야 정상(a,b,c,d)", async () => {
    const r = await driveJsonUpdate({ action: "read", file_id: fid });
    if (!Array.isArray(r.value) || r.value.length !== 4)
      throw new Error(`기대와 다름(4건이어야 함): ${JSON.stringify(r)}`);
    return r;
  });

  await step("drive_file download로 최종 바이트 직접 확인(독립 경로 교차검증, 4건)", async () => {
    const r = await driveFile({ action: "download", file_id: fid });
    const parsed = JSON.parse(r.text);
    if (!Array.isArray(parsed) || parsed.length !== 4) throw new Error(`교차검증 실패: ${r.text.slice(0, 300)}`);
    return { length: parsed.length };
  });

  await step("오류경로: 존재하지 않는 중첩 경로에 append(create_parents 없이)", () =>
    driveJsonUpdate({ action: "append", file_id: fid, json_path: "nested.logs", items: [{ x: 1 }] }).then(
      () => { throw new Error("오류가 나야 정상인데 성공했다"); },
      (e) => ({ expectedError: e.message })
    )
  );

  // ★ 회귀 테스트 — 처음 구현에서 실제로 잡힌 버그: 배열 루트에 점 경로로 merge/set을
  // 시도하면 arr.meta = {...} 식으로 조용히 성공한 것처럼 보이지만, JSON.stringify는
  // 배열의 인덱스 아닌 속성을 버려서 실제로는 저장되지 않는다. 이제는 오류로 막혀야 한다.
  await step("회귀: 배열 루트에 merge(json_path='meta', create_parents)는 거부되어야 함", () =>
    driveJsonUpdate({ action: "merge", file_id: fid, json_path: "meta", data: { x: 1 }, create_parents: true }).then(
      (r) => { throw new Error(`막혔어야 하는데 성공했다(데이터 유실 위험): ${JSON.stringify(r)}`); },
      (e) => {
        if (!/배열/.test(e.message)) throw new Error(`다른 이유로 실패함(배열 가드가 아님): ${e.message}`);
        return { expectedError: e.message };
      }
    )
  );

  await step("회귀: 배열 루트에 set(json_path='x.y', create_parents)도 거부되어야 함", () =>
    driveJsonUpdate({ action: "set", file_id: fid, json_path: "x.y", value: 1, create_parents: true }).then(
      (r) => { throw new Error(`막혔어야 하는데 성공했다(데이터 유실 위험): ${JSON.stringify(r)}`); },
      (e) => {
        if (!/배열/.test(e.message)) throw new Error(`다른 이유로 실패함(배열 가드가 아님): ${e.message}`);
        return { expectedError: e.message };
      }
    )
  );

  await step("회귀 확인: 위 거부된 시도들이 실제로 파일에 영향 없었는지(여전히 4건, meta 없음)", async () => {
    const r = await driveFile({ action: "download", file_id: fid });
    const parsed = JSON.parse(r.text);
    if (!Array.isArray(parsed) || parsed.length !== 4) throw new Error(`길이가 달라짐: ${r.text.slice(0, 300)}`);
    if (parsed.meta !== undefined) throw new Error(`배열에 meta가 섞여 들어감: ${r.text.slice(0, 300)}`);
    return { length: parsed.length, metaLeaked: false };
  });

  await step("오류경로: append를 배열 루트 자체에(json_path 생략) items 없이 호출", () =>
    driveJsonUpdate({ action: "append", file_id: fid, items: [] }).then(
      () => { throw new Error("오류가 나야 정상인데 성공했다"); },
      (e) => ({ expectedError: e.message })
    )
  );

  await step("정리: 배열 루트 테스트 파일 휴지통 이동", () => driveFile({ action: "trash", file_id: fid }));
}

// ── 2부: 객체 루트 파일(it_bid_progress_marker.json 흉내) — merge/set/read ────────
const objFile = await step("준비: 객체 루트 JSON 파일 생성", () =>
  driveFile({
    action: "create",
    name: "[스모크테스트] drive_json_update_object.json",
    mime_type: "application/json",
    content: JSON.stringify({ stage: "0_started", run_id: "r1" }, null, 2),
  })
);
if (objFile?.id) created.objFileId = objFile.id;

if (created.objFileId) {
  const fid = created.objFileId;

  await step("merge: 루트 객체에 얕은 병합(새 키 추가 + 기존 키 덮어쓰기)", async () => {
    const r = await driveJsonUpdate({ action: "merge", file_id: fid, data: { stage: "1_checkpoint_done", t1: 123 } });
    return r;
  });

  await step("read: 루트 병합 결과 확인", async () => {
    const r = await driveJsonUpdate({ action: "read", file_id: fid });
    if (r.value?.stage !== "1_checkpoint_done" || r.value?.run_id !== "r1" || r.value?.t1 !== 123)
      throw new Error(`기대와 다름: ${JSON.stringify(r)}`);
    return r;
  });

  await step("merge: create_parents로 중첩 객체 새로 만들며 병합", () =>
    driveJsonUpdate({
      action: "merge",
      file_id: fid,
      json_path: "counts",
      data: { narajangteo: 112, nia: 50 },
      create_parents: true,
    })
  );

  await step("merge: 같은 중첩 경로에 키 추가(기존 값 보존 확인)", async () => {
    const r = await driveJsonUpdate({ action: "merge", file_id: fid, json_path: "counts", data: { agency: 2 } });
    return r;
  });

  await step("read: counts 경로 확인(세 키 모두 있어야 함)", async () => {
    const r = await driveJsonUpdate({ action: "read", file_id: fid, json_path: "counts" });
    if (r.value?.narajangteo !== 112 || r.value?.nia !== 50 || r.value?.agency !== 2)
      throw new Error(`기대와 다름: ${JSON.stringify(r)}`);
    return r;
  });

  await step("set: counts.nia만 교체(set의 중첩 경로 지원 확인)", () =>
    driveJsonUpdate({ action: "set", file_id: fid, json_path: "counts.nia", value: 51 })
  );

  await step("read: set 반영 + 형제 키(narajangteo) 보존 확인", async () => {
    const r = await driveJsonUpdate({ action: "read", file_id: fid, json_path: "counts" });
    if (r.value?.nia !== 51) throw new Error(`set이 반영 안 됨: ${JSON.stringify(r)}`);
    if (r.value?.narajangteo !== 112) throw new Error(`형제 키가 사라짐: ${JSON.stringify(r)}`);
    return r;
  });

  await step("오류경로: merge에 배열(data)을 넘김", () =>
    driveJsonUpdate({ action: "merge", file_id: fid, data: [1, 2, 3] }).then(
      () => { throw new Error("오류가 나야 정상인데 성공했다"); },
      (e) => ({ expectedError: e.message })
    )
  );

  await step("오류경로: counts(객체) 경로에 merge 대신 append 시도", () =>
    driveJsonUpdate({ action: "append", file_id: fid, json_path: "counts", items: [1] }).then(
      () => { throw new Error("오류가 나야 정상인데 성공했다"); },
      (e) => ({ expectedError: e.message })
    )
  );

  await step("drive_file download로 최종 바이트 직접 확인(독립 경로 교차검증)", async () => {
    const r = await driveFile({ action: "download", file_id: fid });
    const parsed = JSON.parse(r.text);
    if (parsed.counts?.nia !== 51 || parsed.stage !== "1_checkpoint_done")
      throw new Error(`교차검증 실패: ${r.text.slice(0, 400)}`);
    return parsed;
  });

  await step("정리: 객체 루트 테스트 파일 휴지통 이동", () => driveFile({ action: "trash", file_id: fid }));
}

console.log("\n\n════════ 요약 ════════");
const pass = results.filter((r) => r.ok).length;
console.log(`통과 ${pass} / 전체 ${results.length}`);
for (const r of results.filter((r) => !r.ok)) console.log(`  ❌ ${r.label}: ${r.err}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
