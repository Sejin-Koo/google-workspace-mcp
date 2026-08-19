"""Vercel 프로젝트 생성 + 환경변수 등록 + 배포를 REST API로 처리한다.

셸 명령줄에 비밀값이 등장하지 않도록 자격증명은 scripts/.vercel.json(gitignore됨)에서 읽는다.
"""
import json, pathlib, urllib.request, urllib.error, sys

CFG = json.loads((pathlib.Path(__file__).parent / ".vercel.json").read_text())
TOKEN = CFG["VERCEL_TOKEN"]
API = "https://api.vercel.com"
REPO = "Sejin-Koo/google-workspace-mcp"
PROJECT = "google-workspace-mcp"

ENV_VARS = {
    "GOOGLE_CLIENT_ID": CFG["GOOGLE_CLIENT_ID"],
    "GOOGLE_CLIENT_SECRET": CFG["GOOGLE_CLIENT_SECRET"],
    "GOOGLE_REFRESH_TOKEN": CFG["GOOGLE_REFRESH_TOKEN"],
    "MCP_GATE_KEYS": CFG["MCP_GATE_KEYS"],
    "MCP_GATE_MODE": CFG["MCP_GATE_MODE"],
}


def call(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:500]}


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "all"

    if action in ("all", "create"):
        st, r = call("GET", f"/v9/projects/{PROJECT}")
        if st == 200:
            print(f"프로젝트 이미 존재: {r.get('name')} (id={r.get('id')})")
        else:
            st, r = call(
                "POST",
                "/v11/projects",
                {
                    "name": PROJECT,
                    "framework": None,
                    "gitRepository": {"type": "github", "repo": REPO},
                },
            )
            print("프로젝트 생성:", st, json.dumps(r, ensure_ascii=False)[:400])
            if st >= 400:
                return

    if action in ("all", "env"):
        for k, v in ENV_VARS.items():
            st, r = call(
                "POST",
                f"/v10/projects/{PROJECT}/env?upsert=true",
                {"key": k, "value": v, "type": "encrypted",
                 "target": ["production", "preview", "development"]},
            )
            ok = "OK" if st < 400 else f"FAIL({st}) {json.dumps(r, ensure_ascii=False)[:200]}"
            print(f"  env {k}: {ok}")
        # 값이 실제로 들어갔는지(빈 값 사고 방지) 길이로 검증
        st, r = call("GET", f"/v9/projects/{PROJECT}/env?decrypt=true")
        if st == 200:
            got = {e["key"]: len(e.get("value") or "") for e in r.get("envs", [])}
            print("  등록 확인(키: 값 길이):", json.dumps(got, ensure_ascii=False))
            missing = [k for k in ENV_VARS if got.get(k, 0) == 0]
            if missing:
                print("  ⚠️ 값이 비어 있는 환경변수:", missing)

    if action in ("all", "deploy"):
        st, r = call(
            "POST",
            "/v13/deployments",
            {
                "name": PROJECT,
                "project": PROJECT,
                "target": "production",
                "gitSource": {"type": "github", "repoId": 1339002989, "ref": "main"},
            },
        )
        print("배포 요청:", st)
        print("  url:", r.get("url"))
        print("  id:", r.get("id"))
        print("  state:", r.get("readyState") or r.get("status"))
        if st >= 400:
            print("  상세:", json.dumps(r, ensure_ascii=False)[:600])

    if action == "status":
        st, r = call("GET", f"/v6/deployments?projectId={PROJECT}&limit=3")
        for d in r.get("deployments", []):
            print(d.get("state"), d.get("url"), d.get("target"))

    if action == "aliases":
        st, r = call("GET", f"/v9/projects/{PROJECT}")
        print(json.dumps(r.get("alias") or r.get("targets") or {}, ensure_ascii=False)[:800])


main()
