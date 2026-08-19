import json, pathlib, urllib.request, urllib.error

CFG = json.loads((pathlib.Path(__file__).parent / ".vercel.json").read_text())
TOKEN = CFG["VERCEL_TOKEN"]


def call(path):
    req = urllib.request.Request(
        "https://api.vercel.com" + path, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {"raw": e.read().decode()[:400]}


st, d = call("/v6/deployments?projectId=prj_xAFeLN0Kq4UUAZhV5QyF48SH1cXw&limit=1")
dep = d["deployments"][0]
print("deployment id:", dep["uid"], dep["state"])

st, a = call(f"/v2/deployments/{dep['uid']}/aliases")
print("aliases:", [x.get("alias") for x in a.get("aliases", [])])

st, dm = call("/v9/projects/google-workspace-mcp/domains")
print("project domains:", [x.get("name") for x in dm.get("domains", [])])
