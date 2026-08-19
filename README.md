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
| `drive_file` | 메타데이터, 생성, 폴더 생성, **내용 교체(ID 유지)**, 이름변경, 이동, 복사, 휴지통, 완전삭제, 다운로드, export |
| `drive_comments` | 댓글 조회·작성·답글·해결·삭제 |
| `drive_revisions` | 버전 이력 조회, 과거 버전 내용 회수, 보존 고정 |
| `drive_permissions` | 공유 권한 점검·추가·변경·해제 |
| `drive_shared_drives` | 공유 드라이브 목록·상세 |
| `drive_changes` | 시작 토큰 발급 후 그 이후 변경분만 조회 |

모든 도구는 `max_chars`로 응답 길이 상한을 조절할 수 있고, `0`이면 자르지 않는다.

## 환경변수

| 이름 | 설명 |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 클라이언트 시크릿 |
| `GOOGLE_REFRESH_TOKEN` | `https://www.googleapis.com/auth/drive` 스코프를 포함한 refresh token |
| `MCP_GATE_KEYS` | 접근 게이트 허용 키 목록(쉼표 구분). 비어 있으면 게이트 비활성 |
| `MCP_GATE_MODE` | `enforce`면 키 없는 호출을 401로 차단 |

`drive` 스코프 하나로 Sheets·Docs·Slides·Forms API와 Drive API 전체가 커버된다
(각 API 공식 인증 스코프 목록에 `auth/drive`가 포함되어 있음).

## Google Cloud 프로젝트 준비

스코프와 별개로, 사용할 API를 프로젝트에서 **사용 설정(Enable)** 해야 한다.
켜지 않으면 403 `has not been used in project ... or it is disabled`가 난다.

- Google Sheets API / Google Docs API / Google Slides API / Google Forms API
- Google Drive API

## 호출

```
https://<배포도메인>/api/mcp?k=<게이트키>
```

## 로컬 스모크테스트

`scripts/.env.local.json`(gitignore됨)에 위 Google 자격증명 3개를 넣고:

```bash
npm install
npm test
```

실제 Google 계정에 테스트 파일을 만들었다가 마지막에 휴지통으로 정리한다.
