# `aura.rpc.control.resolve` 브리지 — Warm Core RR (M3)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · #6 · #11 · §2 · §3.3 · §4 · §6.1 · §9.2.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — resolve sync **Deployment** + 공용 NATS 브리지 Warm.  
Wire/DDL 정본: [`svc-control-resolve.md`](svc-control-resolve.md) · [`../sql/control_meta.sql`](../sql/control_meta.sql).  
내부: [`../../services/control/DESIGN.md`](../../services/control/DESIGN.md).  
하드코드: [`memory-control-hardcode.md`](memory-control-hardcode.md).

**이 문서 범위:** NATS Core RR 브리지 **이름표** · Warm **Deployment Service** · stub/injectable 핸들러 경계.  
Pooler SELECT: `StubPooler` / injectable lookup (`aura-control` · live DSN=후속). 관리 HTTP: [`admin-ui.md`](admin-ui.md).  
**Non-goals:** tenants/ACL · 시크릿 스토어 · Streamable HTTP · sandbox/egress · F1 · live Pooler CI 필수 · Fission Function.

---

## 왜 Warm (§1 #2 · §3.3 · §4)

| 계급 | Subject | 스케일 | 이유 |
|------|---------|--------|------|
| **sync** Core RR | `aura.rpc.control.resolve` | **bridge replicas≥2** + resolve Deployment (lab `replicas: 1`; HA ≥2) | Core RR은 JetStream lag로 깨울 수 없음 → No Responders |

MQT·JetStream lag ScaledObject를 이 응답자에 연결하지 않는다. 매니페스트: [`../k8s/control-resolve/`](../k8s/control-resolve/).

---

## Sync RPC 이름표 (§3.3)

| 필드 | 값 |
|------|-----|
| subject | `aura.rpc.control.resolve` |
| queue-group | `aura-rpc-bridge` (브리지) |
| NATS | `aura-nats-rpc-bridge` · queue `aura-rpc-bridge` · **replicas ≥ 2** |
| Target | Deployment+Service `aura-control-resolve` · lab `replicas: 1` · ns `aura` |
| 금지 | MessageQueueTrigger · JetStream lag ScaledObject · Fission Function |
| PG | **Pooler** `aura-pg-pooler` + `set_config('app.tenant_id', $1, true)` — injectable lookup (M6) |

---

## Wire (요약 — 정본은 svc-control-resolve)

요청: `tenant_id` + `kind` + `name` + `version` + `principal` (식별자만).  
성공: `type=control.resolve.done` · `source` + `user?` + `cfg`(1-depth, user wins) + `secrets_ref` only.  
실패: `type=control.resolve.error`.

핸들러: [`../../services/control/src/lib.rs`](../../services/control/src/lib.rs) — `validate_resolve_request` / `resolve_with_pooler` · StubPooler 또는 injectable lookup.

---

## 검증

```bash
./deploy/scripts/check-control-resolve-bridge.sh
cargo test -p aura-control --lib
```

PASS = DESIGN·docs·Deployment Service + 공용 브리지(replicas≥2, no MQT)·Rust 테스트 일치.
