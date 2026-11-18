# PG + Pooler 스모크 계획 (M0 권장 · 본문 M1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #3–#4 · §2.1.  
일정: [ROADMAP.md](../../ROADMAP.md) M0(계획) · M1 V1.1(설치·실행).

**이 문서 범위:** 스모크 케이스·매핑 + (설치) CNPG Cluster/Pooler 매니페스트·DSN 계약 + V1.1 실측 스크립트.  
**Non-goals:** 전체 `memory_*` DDL · `services/memory` 코드 · Multi-AZ(`f320c964`).  
**제품 확정 (2026-11-18):** **CloudNativePG `Pooler`** — ROADMAP 결정 로그 · [`../k8s/pg-pooler`](../k8s/pg-pooler/).

---

## Pooler 제품 (확정)

| 후보 | 요약 | 상태 |
|------|------|------|
| **CloudNativePG `Pooler`** | CNPG `Pooler` CR → PgBouncer Deployment; `spec.pgbouncer.poolMode: transaction` | **채택** — 앱 DSN = pooler Service only |
| standalone PgBouncer | Deployment + ConfigMap; `pool_mode = transaction` | CNPG 미도입 폴백만; 계약상 동등이나 M1 기본 경로 아님 |

### 앱 DSN 계약

- ConfigMap `aura-pg-dsn` / Secret URL 호스트 = **`aura-pg-pooler.aura.svc.cluster.local`만**.
- PG Pod IP · CNPG **`aura-pg-rw` / `-r` / `-ro`** · NodePort 직접 연결 **금지** (ARCHITECTURE §1 #3 · §2.1).
- `services/memory` DESIGN이 생길 때 동일 규칙을 복사하지 말고 이 절·§2.1·`aura-pg-dsn`을 참조한다.

**설치:** [`../k8s/pg-pooler`](../k8s/pg-pooler/) · `install-pg-pooler.sh` · 정적 게이트 `check-pg-pooler.sh`.  
**실측 (V1.1 / `92cccf21`):** `rls-smoke-fixture.sql` + `smoke-pg-pooler.sh` (`SMOKE_PG_POOLER_STATIC=1` = 클러스터 없이 (d)+매니페스트).

---

## 스모크 케이스 표 → V1.1

실행 주체: **`svc-memory` store** (메모리 PG 유일 쓰기). recall은 동일 DSN 규칙·`set_config(..., true)`를 따르되, V1.1 합격의 쓰기 경로는 store.

정적 게이트: `deploy/scripts/check-pg-pooler.sh` (클러스터 불필요).  
실측 스크립트(V1.1에 신설): `deploy/scripts/smoke-pg-pooler.sh`

| ID | 케이스 | 기대 | V1.1 |
|----|--------|------|------|
| (a) | 앱 DSN 호스트 = **pooler Service only** | PG Pod IP/직접 포트로 붙는 클라이언트 없음; NetworkPolicy·DSN 검사로 회귀 | Pooler + RLS 경로의 전제 |
| (b) | Pooler **transaction pooling** | `poolMode`/`pool_mode` = `transaction` (session 아님) | 모드 불변 |
| (c) | 테넌트 A → COMMIT → 동일 풀 커넥션으로 테넌트 B | B가 A 행을 RLS로 **미노출**; `set_config('app.tenant_id', $1, true)` 매 트랜잭션 | 풀 재사용 후 테넌트 오염 없음 |
| (d) | 회귀 가드 | `set_config(..., false)` / 세션 `SET app.tenant_id` / Function→PG 직접 연결 **경로 없음**(코드·DSN·정책 스캔 또는 의도적 실패 픽스처) | `set_config(..., false)` 경로 없음 |

합격 문구(ROADMAP V1.1): *풀 재사용 후 테넌트 오염 없음; `set_config(..., false)` 경로 없음.*

---

## M1 실행 체크리스트 (이 계획의 소비자)

1. ~~Pooler 제품 택일 → ROADMAP 결정 로그에 **제품명** 기입.~~ **완료** — CloudNativePG `Pooler`.
2. ~~PG + CNPG Pooler 설치 매니페스트; 앱 DSN = pooler only.~~ **완료** — `deploy/k8s/pg-pooler` · `install-pg-pooler.sh`.
3. ~~최소 RLS 픽스처(테넌트 A/B + `app.tenant_id` GUC).~~ **완료** — `rls-smoke-fixture.sql` (프로덕션 DDL은 `services/memory` 후속).
4. ~~`deploy/scripts/smoke-pg-pooler.sh` 구현·PASS.~~ **완료** — 정적 + 라이브(pooler 경유 A→COMMIT→B).
5. store MQT 경로가 매 트랜잭션 `set_config(..., true)` 호출 — `services/memory` 코드 진입 시.

---

## 관련 링크

- 런타임 부트스트랩: [../SETUP.md](../SETUP.md) (NATS/KEDA/Fission; PG는 M1)
- 위키 런타임 핀(PG 없음): org-wiki `wiki/Engineering/AI-Native-Engineering/Aura-M0-Runtime-Nats-Keda-Fission.md`
