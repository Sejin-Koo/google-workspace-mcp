import json, pathlib, urllib.request, urllib.error

CFG = json.loads((pathlib.Path(__file__).parent / ".vercel.json").read_text())
TOKEN = CFG["VERCEL_TOKEN"]


def call(method, path, body=None):
    req = urllib.request.Request(
        "https://api.vercel.com" + path,
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
            return e.code, {"raw": raw[:400]}


st, p = call("GET", "/v9/projects/google-workspace-mcp")
print("project status:", st)
print("link:", json.dumps(p.get("link"), ensure_ascii=False, indent=2))
print("latestDeployments:", [(d.get("readyState"), d.get("url")) for d in (p.get("latestDeployments") or [])])
print("targets:", json.dumps({k: {"url": v.get("url"), "state": v.get("readyState")} for k, v in (p.get("targets") or {}).items()}, ensure_ascii=False))

st, d = call("GET", "/v6/deployments?projectId=" + (p.get("id") or "") + "&limit=5")
print("\ndeployments:", st)
for x in d.get("deployments", []):
    print(" ", x.get("state"), x.get("url"), x.get("target"), x.get("meta", {}).get("githubCommitRef"))
