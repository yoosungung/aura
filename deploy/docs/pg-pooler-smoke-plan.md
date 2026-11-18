# PG + Pooler 스모크 계획 (M0 권장 · 본문 M1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #3–#4 · §2.1.  
일정: [ROADMAP.md](../../ROADMAP.md) M0(계획) · M1 V1.1(설치·실행).

**이 문서 범위:** M1에서 돌릴 스모크 케이스·매핑·스크립트 이름만 고정한다.  
**Non-goals (이 슬라이스·이 PR):** PG/Pooler 설치 · DDL · CNPG/PgBouncer 매니페스트 · 클러스터 실측 · `services/memory` 코드.

---

## Pooler 후보 (권장 · 미확정)

| 후보 | 요약 | M1 적합성 |
|------|------|-----------|
| **CloudNativePG Pooler** (권장) | CNPG `Pooler` CR → PgBouncer Deployment; `spec.pgbouncer.poolMode: transaction` | M1 PG HA/PITR과 동일 operator 표면; 앱 DSN = pooler Service only |
| standalone PgBouncer | Deployment + ConfigMap; `pool_mode = transaction` | CNPG 도입을 미룰 때의 폴백; 계약상 동등 |

제품명 확정·설치는 **M1** 결정 로그에 기입한다. 이 문서는 권장만 남긴다.

---

## 스모크 케이스 표 → V1.1

실행 주체: **`svc-memory` store** (메모리 PG 유일 쓰기). recall은 동일 DSN 규칙·`set_config(..., true)`를 따르되, V1.1 합격의 쓰기 경로는 store.

예상 스크립트(M1에 신설; **이 PR에 파일 없음**): `deploy/scripts/smoke-pg-pooler.sh`

| ID | 케이스 | 기대 | V1.1 |
|----|--------|------|------|
| (a) | 앱 DSN 호스트 = **pooler Service only** | PG Pod IP/직접 포트로 붙는 클라이언트 없음; NetworkPolicy·DSN 검사로 회귀 | Pooler + RLS 경로의 전제 |
| (b) | Pooler **transaction pooling** | `poolMode`/`pool_mode` = `transaction` (session 아님) | 모드 불변 |
| (c) | 테넌트 A → COMMIT → 동일 풀 커넥션으로 테넌트 B | B가 A 행을 RLS로 **미노출**; `set_config('app.tenant_id', $1, true)` 매 트랜잭션 | 풀 재사용 후 테넌트 오염 없음 |
| (d) | 회귀 가드 | `set_config(..., false)` / 세션 `SET app.tenant_id` / Function→PG 직접 연결 **경로 없음**(코드·DSN·정책 스캔 또는 의도적 실패 픽스처) | `set_config(..., false)` 경로 없음 |

합격 문구(ROADMAP V1.1): *풀 재사용 후 테넌트 오염 없음; `set_config(..., false)` 경로 없음.*

---

## M1 실행 체크리스트 (이 계획의 소비자)

1. Pooler 제품 택일(위 표) → ROADMAP 결정 로그에 **제품명** 기입.
2. PG + Pooler 설치; 앱 Secret/DSN = pooler only.
3. 최소 RLS 픽스처(테넌트 A/B + `app.tenant_id` GUC) — 스키마는 `services/memory/DESIGN.md`(M1 코드 진입 시).
4. `deploy/scripts/smoke-pg-pooler.sh` 구현·PASS 증거를 티켓에 남김.
5. store MQT 경로가 매 트랜잭션 `set_config(..., true)` 호출.

---

## 관련 링크

- 런타임 부트스트랩: [../SETUP.md](../SETUP.md) (NATS/KEDA/Fission; PG는 M1)
- 위키 런타임 핀(PG 없음): org-wiki `wiki/Engineering/AI-Native-Engineering/Aura-M0-Runtime-Nats-Keda-Fission.md`
