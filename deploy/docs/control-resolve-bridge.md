# `aura.rpc.control.resolve` 브리지 — Warm Core RR (M3)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · #6 · #11 · §2 · §3.3 · §4 · §6.1 · §9.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — resolve 브리지 minReplicas ≥ 2.  
Wire/DDL 정본: [`svc-control-resolve.md`](svc-control-resolve.md) · [`../sql/control_meta.sql`](../sql/control_meta.sql).  
내부: [`../../services/control/DESIGN.md`](../../services/control/DESIGN.md).  
Warm 패턴 참고: [`mcp-invoke-dual.md`](mcp-invoke-dual.md) sync 절.

**이 문서 범위:** NATS Core RR 브리지 **이름표** · Warm Function + Deployment **분리** · stub/injectable 핸들러 경계.  
**Non-goals:** 라이브 Pooler SELECT 본배선 · HTTP admin 서버 · tenants/ACL · 시크릿 스토어 · Streamable HTTP · sandbox/egress · F1.

---

## 왜 Warm (§1 #2 · §3.3 · §4)

| 계급 | Subject | 스케일 | 이유 |
|------|---------|--------|------|
| **sync** Core RR | `aura.rpc.control.resolve` | **minReplicas ≥ 2** | Core RR은 JetStream lag로 깨울 수 없음 → No Responders |

MQT·JetStream lag ScaledObject를 이 응답자에 연결하지 않는다. 매니페스트: [`../k8s/control-resolve/`](../k8s/control-resolve/).

---

## Sync RPC 이름표 (§3.3)

| 필드 | 값 |
|------|-----|
| subject | `aura.rpc.control.resolve` |
| queue-group | `aura-control-resolve` |
| Deployment | `aura-control-resolve-rr` · **replicas ≥ 2** |
| Warm Function | `aura-control-resolve` · `newdeploy` · **MinScale ≥ 2** |
| 금지 | MessageQueueTrigger · JetStream lag ScaledObject |
| PG (의도) | **Pooler** `aura-pg-pooler` + `set_config('app.tenant_id', $1, true)` — **라이브 배선은 Non-goal** (injectable) |

---

## Wire (요약 — 정본은 svc-control-resolve)

요청: `tenant_id` + `kind` + `name` + `version` + `principal` (식별자만).  
성공: `type=control.resolve.done` · `source` + `user?` + `cfg`(1-depth, user wins) + `secrets_ref` only.  
실패: `type=control.resolve.error`.

핸들러: [`../../services/control/bridge.js`](../../services/control/bridge.js) — `validateResolveRequest` / `buildResolveResponse` 재사용 · `mode=stub` 또는 injectable lookup.

---

## 검증

```bash
./deploy/scripts/check-control-resolve-bridge.sh
node services/control/bridge.selftest.js
```

PASS = DESIGN·docs·Warm 매니페스트(MinScale/replicas≥2, no MQT)·selftest 일치.
