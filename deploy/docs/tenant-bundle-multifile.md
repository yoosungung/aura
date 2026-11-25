# Tenant bundle multi-file zip

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #11 · §7.  
워크플로·scaffold: [`tenant-bundle-scaffold.md`](tenant-bundle-scaffold.md).  
로더: [`services/object-store/bundle-zip.js`](../../services/object-store/bundle-zip.js) · agent/mcp `bundle-turn` / `bundle-factory`.

**이 문서 범위:** nodejs/python 테넌트 번들 **멀티파일 zip** 로드 계약.  
**Non-goals:** 테넌트 `npm install` into Garage · custom image · 플랫폼 Function archive 교체.

---

## 객체 형태

| 형태 | 판별 | 동작 |
|------|------|------|
| **zip** | magic `PK\x03\x04` (등) | 해제 → `entrypoint` 모듈 로드 · zip 내 상대 require/import |
| **단일 소스** | 그 외(하위호환) | 바이트 전체 = 한 모듈 · `entrypoint`의 **attr만** 사용 |

checksum / activate = **객체 바이트 전체** (zip이면 zip 파일 sha256).

## entrypoint

형식: `module/path:attr` (콜론 1개).

| 예 | zip 안 파일 (nodejs) | python |
|----|----------------------|--------|
| `main:factory` | `main.js` | `main.py` |
| `lib/agent:factory` | `lib/agent.js` | `lib/agent.py` |

확장자는 entrypoint에 넣지 않는다. `node_modules/`·`__pycache__/`·절대경로·`..` 세그먼트 → 거부.

## 의존성

- zip **안** 상대 모듈: 허용.
- `require('langchain')` / `import langchain` · `nats`/`nats-py` · `pg`/`psycopg`: **공유 Function** deps만 ([`scaffolds/ALLOWED_PACKAGES.md`](../../scaffolds/ALLOWED_PACKAGES.md)).
- zip에 `node_modules` / site-packages 포함 **금지**(업로드·로드 모두).

## 업로드 (Admin)

권장: scaffold 소스 트리(또는 Download scaffold zip에서 `node_modules` 제거)를 zip으로 Bundles 업로드.  
단일 `.js`/`.py` 업로드는 하위호환으로 유지.

## 검증

```bash
node services/object-store/bundle-zip.selftest.js
node services/agent-invoke/nodejs/handler.selftest.js
node services/mcp-invoke/nodejs/handler.selftest.js
```
