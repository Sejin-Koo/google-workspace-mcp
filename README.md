# google-workspace-mcp

Google Workspace(Sheets / Docs / Slides / Forms)와 Google Drive를 다루는 MCP 서버.

Cowork에 기본 연결된 공식 "Google Drive" 커넥터는 **검색·읽기·파일 생성·휴지통 이동**만
지원하고 **기존 파일의 내용을 수정할 수 없다.** 그래서 시트에 행 하나를 추가하려 해도
전체 데이터를 새 파일로 다시 만들어 기존 파일을 버리는 방식밖에 없었다. 이 서버는 그
공백을 메운다 — 파일 ID를 유지한 채 시트에 행을 덧붙이고, 문서 본문을 고치고, 슬라이드를
추가한다.

## 제공 도구

| 도구 | 하는 일 |
|---|---|
| `sheets_values` | 셀 값 read / **append(행 추가)** / update / clear |
| `sheets_manage` | 스프레드시트 생성, 탭 추가·삭제·이름변경, 메타데이터 조회, batchUpdate |
| `docs_read` | 문서를 텍스트(표 포함) 또는 원본 구조로 읽기 |
| `docs_write` | 문서 생성, 끝에 덧붙이기, 위치 삽입, 찾아 바꾸기, batchUpdate |
| `slides_read` | 슬라이드별 텍스트·발표자노트 조회 |
| `slides_write` | 프레젠테이션 생성, 슬라이드 추가(제목·본문 채우기), 삭제, 찾아 바꾸기 |
| `forms_tool` | 설문 생성·조회, 응답 목록·단건 조회, batchUpdate |
| `drive_search` | 파일명·**내용 전문검색**·MIME·폴더 조건 검색 |
| `drive_file` | 메타데이터, 생성, 폴더 생성, **내용 교체(ID 유지)**, 이름변경, 이동, 복사, 휴지통, 완전삭제, 다운로드, **이진 파일 조각 다운로드 주소 발급(`download_link`)**, **이진 파일 업로드 세션 발급(`upload_link`)**, export |
| `drive_comments` | 댓글 조회·작성·답글·해결·삭제 |
| `drive_revisions` | 버전 이력 조회, 과거 버전 내용 회수, 보존 고정 |
| `drive_permissions` | 공유 권한 점검·추가·변경·해제 |
| `drive_shared_drives` | 공유 드라이브 목록·상세 |
| `drive_changes` | 시작 토큰 발급 후 그 이후 변경분만 조회 |

모든 도구는 `max_chars`로 응답 길이 상한을 조절할 수 있고, `0`이면 자르지 않는다.

## 이진 파일 내려받기 (`download_link` + `/api/raw`)

`drive_file`의 `download`는 내용을 `res.text()`로 읽으므로 글꼴(.ttf/.ttc)·이미지·압축파일 같은
**이진 파일은 바이트가 깨진다.** 또 12~14MB짜리 파일을 MCP 응답 본문에 실을 수도 없다.
그래서 파일을 바이트 구간으로 쪼갠 다운로드 주소 목록을 돌려주고, 실제 바이트는 별도
엔드포인트가 원본 그대로 흘려보낸다.

1. `drive_file`을 `action="download_link"`로 호출한다. 응답에 `name`·`size`·`md5Checksum`과
   조각 목록(`index`·`start`·`end`·`url`)이 들어 있다. 조각 크기는 기본 3MB이고
   `chunk_bytes`로 바꿀 수 있다(최대 4MB).
2. 각 `url`을 `index` 순서대로 받아 그대로 이어붙이면 원본 파일이 된다. 이어붙인 뒤
   MD5가 `md5Checksum`과 같은지 확인한다.

```
GET /api/raw?k=<게이트키>&f=<fileId>&s=<시작바이트>&e=<끝바이트>
→ 200 application/octet-stream (해당 구간의 원본 바이트)
```

한 요청의 구간은 **4MB 이하**여야 한다(Vercel 응답 본문 상한). 넘으면 400으로 거부한다.

### 보안 제한

| 제한 | 내용 |
|---|---|
| **허용 폴더** | 내려받기는 `DOWNLOAD_ALLOWED_FOLDER_ID`에 적힌 폴더들 **바로 아래의 파일**로만 제한된다(쉼표·공백으로 여러 개를 넣을 수 있고, **하위 폴더는 포함되지 않는다**). 현재 허용 목록은 `download_link` 응답의 `allowedFolders`로 확인한다. 요청한 파일의 `parents`에 이 폴더가 없으면 거부(`download_link`는 오류, `/api/raw`는 403). 검사는 주소를 발급할 때와 바이트를 내보낼 때 **양쪽에서 각각** 한다 — 발급된 주소의 `f=`만 바꿔치기해 다른 파일을 받을 수 없다. |
| **게이트키** | `/api/raw`에도 `/api/mcp`와 동일한 게이트키 검사(`MCP_GATE_KEYS`/`MCP_GATE_MODE`)가 걸린다. 차단 모드에서 키가 없거나 목록에 없으면 401. `download_link`가 돌려주는 조각 주소에는 그 호출에 쓰인 게이트키가 그대로 들어간다. |

게이트 검사 코드는 `lib/gate.js` 한 곳에 있고 `api/mcp.js`와 `api/raw.js`가 함께 쓴다.

## 이진 파일 올리기 (`upload_link`, `content_base64`)

워드(.docx)·엑셀(.xlsx)·파워포인트(.pptx)·PDF처럼 바이트가 깨지면 안 되는 파일을 드라이브에
올리는 경로는 둘이다. `content`(텍스트)로 보내면 UTF-8 문자열로 취급되어 파일이 깨지므로
이진 파일에는 쓰지 않는다.

### ① `upload_link` — 큰 파일, 권장

바이트가 **이 서버를 거치지 않고** 구글로 바로 가므로 Vercel의 요청 본문 상한(약 4.5MB)에
걸리지 않는다.

1. `drive_file`을 `action="upload_link"`로 호출한다(`name`, 필요하면 `parent_folder_id`).
   `mime_type`을 생략하면 `name`의 확장자로 추론한다.
2. 응답의 `upload_url`에 파일을 그대로 올린다.

   ```bash
   curl -s -X PUT --upload-file 보고서.docx "<upload_url>"
   ```

3. 성공하면 업로드된 파일의 메타데이터(JSON)가 돌아온다. `id`·`size`를 확인한다.

`file_id`를 함께 주면 **기존 파일의 내용을 교체**하는 세션이 열린다(파일 ID·공유 링크 유지).
`size_bytes`를 주면 구글이 세션을 더 정확히 잡는다. 발급된 주소는 그 한 파일의 업로드에만
쓰이고 일주일 안에 만료되지만, 인증이 내장돼 있으므로 로그·문서에 남기지 않는다.

### ② `content_base64` — 작은 파일

`create`·`update_content`에 base64 문자열로 본문을 실어 보낸다. 요청에 통째로 실리므로
**수백 KB 이하**에만 쓴다. 공백·줄바꿈과 `data:…;base64,` 접두어는 자동으로 걷어낸다.

MIME 타입은 `mime_type`을 주지 않으면 파일명 확장자로 추론한다(`.docx`/`.xlsx`/`.pptx`/
`.pdf`/`.hwp`/이미지/글꼴 등). 추론에 실패하면 이진은 `application/octet-stream`,
텍스트는 `text/plain`이 된다.

### 보안 제한

올리기는 기존 파일을 밖으로 내보내지 않으므로 허용 폴더를 기본으로 강제하지 않는다.
대상을 묶고 싶으면 `UPLOAD_ALLOWED_FOLDER_ID`에 폴더 ID를 넣는다 — 설정하면 그 폴더
**바로 아래로만** 새 파일을 만들 수 있고, 다른 위치는 거부한다(기존 파일 교체는 `file_id`로
대상을 직접 지정하므로 이 검사를 받지 않는다). 게이트키 검사는 `/api/mcp`와 동일하게 적용된다.

## 환경변수

| 이름 | 설명 |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 클라이언트 시크릿 |
| `GOOGLE_REFRESH_TOKEN` | `https://www.googleapis.com/auth/drive` 스코프를 포함한 refresh token |
| `MCP_GATE_KEYS` | 접근 게이트 허용 키 목록(쉼표 구분). 비어 있으면 게이트 비활성 |
| `MCP_GATE_MODE` | `enforce`면 키 없는 호출을 401로 차단 |
| `DOWNLOAD_ALLOWED_FOLDER_ID` | 내려받기를 허용할 Drive 폴더 ID. **쉼표·공백으로 여러 개** 지정 가능(예: `<글꼴폴더ID>,<Claude폴더ID>`). 미설정 시 코드 기본값은 내 드라이브 `글꼴`·`Claude` 두 폴더. 값 하나만 넣던 기존 설정도 그대로 동작한다 |
| `UPLOAD_ALLOWED_FOLDER_ID` | 새 파일을 만들 수 있는 Drive 폴더 ID. **미설정이 기본이며 그때는 제한이 없다** |
| `RAW_BASE_URL` | `download_link`가 만드는 조각 주소의 기준 도메인(예: `https://<배포도메인>`). 생략하면 호출에 쓰인 주소, 그다음 Vercel 시스템 변수를 쓴다 |

`drive` 스코프 하나로 Sheets·Docs·Slides·Forms API와 Drive API 전체가 커버된다
(각 API 공식 인증 스코프 목록에 `auth/drive`가 포함되어 있음).

## Google Cloud 프로젝트 준비

스코프와 별개로, 사용할 API를 프로젝트에서 **사용 설정(Enable)** 해야 한다.
켜지 않으면 403 `has not been used in project ... or it is disabled`가 난다.

- Google Sheets API / Google Docs API / Google Slides API / Google Forms API
- Google Drive API

## 호출

| 엔드포인트 | 용도 |
|---|---|
| `https://<배포도메인>/api/mcp?k=<게이트키>` | MCP 엔드포인트(커넥터 등록 주소) |
| `https://<배포도메인>/api/raw?k=<게이트키>&f=…&s=…&e=…` | 이진 파일 구간 다운로드(`download_link`가 주소를 만들어 준다) |

## 로컬 스모크테스트

`scripts/.env.local.json`(gitignore됨)에 위 Google 자격증명 3개를 넣고:

```bash
npm install
npm test
```

실제 Google 계정에 테스트 파일을 만들었다가 마지막에 휴지통으로 정리한다.
