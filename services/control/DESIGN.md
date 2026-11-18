# svc-control (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #6 · #11 · §2 · §3.3 · §6.1 · §9.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — 최소 resolve API/스키마.  
스키마·wire 정본: [`deploy/docs/svc-control-resolve.md`](../../deploy/docs/svc-control-resolve.md) · DDL [`deploy/sql/control_meta.sql`](../../deploy/sql/control_meta.sql).

**이 문서 범위:** 컨트롤 메타 쓰기 경계 · resolve 읽기 헬퍼 · Pooler/GUC 전제.  
**Non-goals (본 슬라이스):** NATS `aura.rpc.control.resolve` 브리지 Deployment · HTTP admin 서버 · tenants/ACL · 시크릿 스토어 구현 · 번들 업로드. (`agent_invoke` MQT는 [`../agent-invoke/DESIGN.md`](../agent-invoke/DESIGN.md).)

---

## 경계

| 항목 | 값 |
|------|-----|
| 유일 쓰기 | `svc-control`만 `source_meta`/`user_meta` INSERT/UPDATE/DELETE |
| 런타임 | Function은 resolve **read**만 (`aura.rpc.control.resolve`) |
| PG | **CloudNativePG Pooler** · `set_config('app.tenant_id', $1, true)` 매 트랜잭션 |
| 금지 | 세션 GUC · Function→PG 직접 · plaintext 시크릿 컬럼 · invoke payload에 번들/config 실어 보내기 |

---

## Resolve 헬퍼 (본 슬라이스)

| 파일 | 역할 |
|------|------|
| `resolve.js` | `validateResolveRequest` · `mergeConfigs` · `buildResolveResponse` |
| `resolve.selftest.js` | wire·merge·active-only·secrets_ref-only 게이트 |

`cfg` = 1-depth section merge, user wins. 응답에 `secrets` 객체 없음.

---

## 후속 (별 티켓)

1. `aura.rpc.control.resolve` 브리지 — Core RR · minReplicas ≥ 2 · Pooler SELECT  
2. 관리 HTTP — source 등록·user_meta upsert  
3. 시크릿 resolve + TTL 캐시 무효화 이벤트

---

## Commands

```bash
bash deploy/scripts/check-svc-control-resolve.sh
node services/control/resolve.selftest.js
```
