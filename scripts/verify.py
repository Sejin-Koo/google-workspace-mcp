"""배포된 엔드포인트를 실제로 호출해 검증한다 — 게이트(401/200), tools/list, tools/call."""
import json, pathlib, urllib.request, urllib.error

CFG = json.loads((pathlib.Path(__file__).parent / ".vercel.json").read_text())
KEY = CFG["MCP_GATE_KEYS"].split(",")[0]
BASE = "https://google-workspace-mcp-alpha.vercel.app/api/mcp"

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


def rpc(url, method, params=None, rid=1):
    body = {"jsonrpc": "2.0", "id": rid, "method": method}
    if params is not None:
        body["params"] = params
    req = urllib.request.Request(url, method="POST", headers=HEADERS, data=json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return r.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def parse(raw):
    """StreamableHTTP는 SSE(data: {...})로 응답할 수 있다."""
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    try:
        return json.loads(raw)
    except Exception:
        return {"_raw": raw[:400]}


INIT = {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {"name": "verify", "version": "1.0"},
}

print("── 1. 게이트: 키 없이 호출(401이어야 정상) ──")
st, raw = rpc(BASE, "initialize", INIT)
print(f"   HTTP {st}  {raw[:160]}")

print("\n── 2. 게이트: 발급키로 호출 ──")
url = f"{BASE}?k={KEY}"
st, raw = rpc(url, "initialize", INIT)
print(f"   HTTP {st}")
j = parse(raw)
print("   serverInfo:", json.dumps(j.get("result", {}).get("serverInfo"), ensure_ascii=False))

print("\n── 3. tools/list ──")
st, raw = rpc(url, "tools/list", {}, 2)
j = parse(raw)
tools = j.get("result", {}).get("tools", [])
print(f"   HTTP {st}  도구 {len(tools)}개")
for t in tools:
    print(f"     - {t['name']}")

print("\n── 4. tools/call: drive_search (실데이터) ──")
st, raw = rpc(
    url,
    "tools/call",
    {"name": "drive_search", "arguments": {"name_contains": "골프 스코어카드", "page_size": 3}},
    3,
)
j = parse(raw)
txt = (j.get("result", {}).get("content") or [{}])[0].get("text", "")
print(f"   HTTP {st}")
print("   " + txt[:700].replace("\n", "\n   "))
