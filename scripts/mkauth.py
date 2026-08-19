import base64, re, pathlib

candidates = [
    pathlib.Path("/home/claude/.git-credentials"),
    pathlib.Path("~/.git-credentials").expanduser(),
]
cred = None
for c in candidates:
    if c.exists():
        cred = c.read_text().strip()
        break
if not cred:
    raise SystemExit("git-credentials 파일을 찾지 못했습니다: " + ", ".join(str(c) for c in candidates))

userpass = re.match(r"https://([^@]+)@github\.com", cred).group(1)
b64 = base64.b64encode(userpass.encode()).decode()
cfg = pathlib.Path(".git/config")
t = cfg.read_text()
if "extraheader" not in t:
    cfg.write_text(t + "[http]\n\textraheader = Authorization: Basic %s\n" % b64)
    print("extraheader 기록 완료")
else:
    print("이미 있음")
