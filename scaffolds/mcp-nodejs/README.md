# mcp · nodejs — Naver Search

이 zip만으로 로컬 테스트 → Admin 등록 → (선택) agent tools에 연결할 수 있다.

실질 MCP 예: tool `naver_search` → [Naver Search API](https://developers.naver.com/docs/serviceapi/search/web/web.md).

## 로컬

```bash
npm install
npm test
```

업로드 zip: **`node_modules` 제외**. zip **루트**에 `main.js` · `lib/` 가 오게 묶는다. entrypoint=`main:factory`.

## 계약

| | |
|--|--|
| factory | `(cfg, secrets) → { listTools, runTool }` |
| secrets (로컬/테스트) | `{ client_id, client_secret }` |
| secrets (live 로컬) | env `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` (ref 문자열만 올 때) |
| cfg | `service` 기본 `webkr` · `display` · 테스트만 `fetchImpl`(Admin에 넣지 말 것) |
| entrypoint | `main:factory` |

## 도구

- **naver_search** — `query`(필수), `service`, `display`, `start`, `sort`
- `service` 예: `webkr` · `news` · `blog` · `book` · `shop` · …

## 제약

| 주제 | 규칙 |
|------|------|
| **시크릿** | Admin / Overlay에는 **`secrets_ref`만**. Client Id/Secret을 cfg·번들·로그에 넣지 말 것. 값 없으면 `secrets_unresolved`. |
| **Egress** | 샌드박스 deny-default. 클러스터 실호출 전 테넌트 MCP allowlist(+프록시/`toFQDNs`)에 **`openapi.naver.com`** 등록. |
| **격리** | 커스텀/미서명 → RuntimeClass **`gvisor`**. 서명되어도 Egress 완화 없음. |
| **번들** | 소스 zip만 · `node_modules` 금지 · 공유 Function deps만 (`nats`). |
| **PG** | `mcp_invoke` **PG 금지**. |
| **프로토콜** | agent↔mcp = NATS RR. 제3자 HTTP는 Function 안에서만. |

## Admin UI에 등록하기

전제: Admin에서 **Tenant** 선택 · Bundles / Sources / Overlays 메뉴 사용 가능.

### 1) zip 준비

1. Admin → **Bundles** → Kind=`mcp` · Runtime=`nodejs` → **Download scaffold (.zip)** (또는 이 폴더).
2. 로컬에서 `npm test` 통과 확인.
3. 업로드용으로 다시 zip: 루트=`main.js`+`lib/` · **`node_modules` 제외**.

### 2) Bundles 폼

| 필드 | 값 |
|------|-----|
| Kind | `mcp` |
| Runtime | `nodejs` |
| Name | `naver-search` |
| Version | `1` |
| Entrypoint | `main:factory` |
| Bundle file | 위 zip |
| Config (선택) | key `service` = `webkr` · key `display` = `10` |

- Config에 `runtime` / `function` 키 **금지**.
- **Upload & create pending** → checksum·bundle_uri 채워짐.
- **Activate now** (또는 Sources에서 Activate) → `active`.
- 수정이 필요하면 기존 행을 고치지 말고 **새 Version**으로 다시 등록.

### 3) Overlays (필수 · 시크릿)

1. **Sources** → kind=`mcp` · name=`naver-search` · version=`1`.
2. **Overlays** → principal 선택/입력.
3. **`secrets_ref`만** 넣는다 (예: 시크릿 스토어 참조 문자열). Client Id/Secret 평문 입력 칸이 있어도 **쓰지 않는다**.
4. 저장.

### 4) 라이브 호출 전

1. Egress allowlist에 **`openapi.naver.com`** 등록.
2. 공유 Function 로드용 **플랫폼 서명(`sig_uri`)** — 없으면 invoke 시 `bundle_untrusted` 가능. Admin 폼이 `sig_uri`를 비우면 서명 절차를 따로 맞춘다.
3. agent의 `cfg.tools`에서 이 MCP를 쓰려면 server=`naver-search`, version=`1`, name=`naver_search` 로 가리킨다 (agent zip에는 이 코드를 복사하지 말 것).
