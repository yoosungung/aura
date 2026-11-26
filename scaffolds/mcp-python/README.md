# mcp · python — Open-Meteo weather

이 zip만으로 로컬 테스트 → Admin 등록 → (선택) agent tools에 연결할 수 있다.

실질 MCP 예: tool `weather` → [Open-Meteo](https://open-meteo.com/en/docs) (API 키 없음).

## 로컬

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q
```

업로드 zip: **`.venv` / site-packages 제외**. zip **루트**에 `main.py` · `lib/` 가 오게 묶는다. entrypoint=`main:factory`.

## 계약

| | |
|--|--|
| factory | `(cfg, secrets) → { listTools, runTool }` — `secrets` 미사용(자리만) |
| cfg | `forecast_days` 기본 1 · `timezone` 기본 `auto` · 테스트만 `fetch_impl`(Admin에 넣지 말 것) |
| entrypoint | `main:factory` |
| HTTP | stdlib `urllib` — **`httpx` 미사용**(공유 Function 핀 확대 보류) |

## 도구

- **weather** — `latitude`/`longitude` 필수 · `forecast_days`(1–16) · `timezone`

## 제약

| 주제 | 규칙 |
|------|------|
| **시크릿** | 이 샘플은 키 없음. Overlay를 쓰더라도 **`secrets_ref`만** · plaintext 금지. |
| **Egress** | 샌드박스 deny-default. 클러스터 실호출 전 allowlist에 **`api.open-meteo.com`** 등록. |
| **격리** | 커스텀/미서명 → RuntimeClass **`gvisor`**. 서명되어도 Egress 완화 없음. |
| **번들** | 소스 zip만 · `.venv` 금지 · 공유 Function deps만 (`fastapi` · `nats-py`). |
| **PG** | `mcp_invoke` **PG 금지**. |
| **프로토콜** | agent↔mcp = NATS RR. 제3자 HTTP는 Function 안에서만. |

## Admin UI에 등록하기

전제: Admin에서 **Tenant** 선택 · Bundles / Sources 메뉴 사용 가능.

### 1) zip 준비

1. Admin → **Bundles** → Kind=`mcp` · Runtime=`python` → **Download scaffold (.zip)** (또는 이 폴더).
2. 로컬에서 `pytest` 통과 확인.
3. 업로드용으로 다시 zip: 루트=`main.py`+`lib/` · **`.venv` 제외**.

### 2) Bundles 폼

| 필드 | 값 |
|------|-----|
| Kind | `mcp` |
| Runtime | `python` |
| Name | `weather` |
| Version | `1` |
| Entrypoint | `main:factory` |
| Bundle file | 위 zip |
| Config (선택) | key `forecast_days` = `1` · key `timezone` = `auto` |

- Config에 `runtime` / `function` 키 **금지**.
- **Upload & create pending** → checksum·bundle_uri 채워짐.
- **Activate now** (또는 Sources에서 Activate) → `active`.
- 수정이 필요하면 **새 Version**으로 다시 등록.

### 3) Overlays

API 키 없음 → **Overlay 생략 가능**.

### 4) 라이브 호출 전

1. Egress allowlist에 **`api.open-meteo.com`** 등록.
2. 공유 Function 로드용 **플랫폼 서명(`sig_uri`)** — 없으면 invoke 시 `bundle_untrusted` 가능.
3. agent의 `cfg.tools`에서 이 MCP를 쓰려면 server=`weather`, version=`1`, name=`weather` 로 가리킨다 (agent zip에는 이 코드를 복사하지 말 것).
