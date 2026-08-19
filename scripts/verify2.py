"""배포 엔드포인트를 통해 실제 골프 스코어카드 시트를 읽어 Sheets 경로까지 라이브 검증한다."""
import json, pathlib, urllib.request, urllib.error

CFG = json.loads((pathlib.Path(__file__).parent / ".vercel.json").read_text())
KEY = CFG["MCP_GATE_KEYS"].split(",")[0]
URL = f"https://google-workspace-mcp-alpha.vercel.app/api/mcp?k={KEY}"
HEADERS = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
SHEET = "185admjQyu_X2kFW7ISxq6FHZJspUnNdAwkkNIAEl_Rs"


def rpc(method, params=None, rid=1):
    body = {"jsonrpc": "2.0", "id": rid, "method": method}
    if params is not None:
        body["params"] = params
    req = urllib.request.Request(URL, method="POST", headers=HEADERS, data=json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
    for line in raw.splitlines():
        if line.strip().startswith("data:"):
            return json.loads(line.strip()[5:])
    try:
        return json.loads(raw)
    except Exception:
        return {"_raw": raw[:400]}


rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "v", "version": "1"}})


def call(name, args, rid):
    j = rpc("tools/call", {"name": name, "arguments": args}, rid)
    return (j.get("result", {}).get("content") or [{}])[0].get("text", json.dumps(j)[:300])


print("── sheets_manage get_metadata (골프 스코어카드) ──")
print(call("sheets_manage", {"action": "get_metadata", "spreadsheet_id": SHEET}, 10)[:900])

print("\n── sheets_values read (앞 8행) ──")
print(call("sheets_values", {"action": "read", "spreadsheet_id": SHEET, "range": "시트1!A1:J8"}, 11)[:1200])

print("\n── 오류경로: 없는 시트 ID ──")
print(call("sheets_values", {"action": "read", "spreadsheet_id": "존재하지않는ID", "range": "A1"}, 12)[:400])
