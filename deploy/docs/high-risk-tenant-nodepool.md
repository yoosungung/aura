# 고위험 테넌트 전용 RuntimeClass / 노드풀 정책 (M5 · §9.1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §9.1.  
기반(M3): [`mcp-bundle-isolation.md`](mcp-bundle-isolation.md) · Egress: [`egress-block-verify.md`](egress-block-verify.md).  
매니페스트: [`../k8s/sandbox-egress/`](../k8s/sandbox-egress/).

**이 문서 범위:** 고위험 테넌트 분류 · RuntimeClass=`kata` **전용 노드풀** 스케줄링(label/taint/`nodeSelector`/`tolerations`) · 오프라인 배치 규칙.  
**Non-goals:** 라이브 노드풀 provision · Kata/handler 노드 설치 CI · 테넌트당 exclusive 노드(풀은 고위험끼리 공유) · F1 subject 샤딩 · gVisor 기본 티어 변경.

---

## 분류 (`risk_tier`)

| 값 | 정의 | RuntimeClass | 노드풀 |
|----|------|--------------|--------|
| `standard` (기본) | 일반 테넌트 · 커스텀/미서명 포함(샌드박스 필수) | `gvisor` (`runsc`) | 기본 샌드박스 풀(Kata taint **없음**) |
| `high` | 장기·적대적·컴플라이언스 플래그 · ops 명시 승격 | **`kata` 필수** | **전용** `aura.sandbox/pool=kata` |

- SoR: control-plane tenant meta / resolve `cfg.risk_tier` (에이전트 자기신고 **금지**).
- 라벨 동등: `aura.swfactory.io/risk-tier: high`.
- `high`인데 `runtimeClassName` 생략·`gvisor`/`runc` → **거부**(배치 평가기 + admission 의도).

M3 신뢰 경계(서명 vs 커스텀)는 그대로다. 본 문서는 **고위험만** 전용 풀로 올린다.

---

## 노드풀 · 테인트 (고정 이름)

| 항목 | 값 |
|------|-----|
| Node label | `aura.sandbox/pool: kata` |
| Taint | `aura.sandbox/pool=kata:NoSchedule` |
| RuntimeClass | `kata` · handler `kata-qemu`(클러스터 설치 시 DESIGN에 고정) |
| scheduling | RuntimeClass `nodeSelector` + `tolerations`가 위 label/taint와 **일치** |

효과:

1. `runtimeClassName: kata` 파드만 Kata 풀에 스케줄( admission이 RuntimeClass scheduling merge).
2. 일반/`gvisor` 파드는 taint를 tolerate하지 않아 **Kata 풀에 못 들어감**.
3. 컨트롤 플레인(Gateway·Pooler·NATS·LLM Gateway)은 샌드박스 대상 아님 — Kata 풀에 올리지 않음.

초안 주석: [`../k8s/sandbox-egress/nodepool-high-risk.draft.yaml`](../k8s/sandbox-egress/nodepool-high-risk.draft.yaml).

---

## 배치 매트릭스 (오프라인)

| risk_tier | 요청 RuntimeClass | 결과 |
|-----------|-------------------|------|
| `high` | `kata` | **allow** → pool `kata` |
| `high` | `gvisor` / 생략 / `runc` | **deny** |
| `standard` | `gvisor` | **allow** → default pool |
| `standard` | `kata` | **deny**(승격 없이 Kata 풀 점유 금지) |
| any | `runc` (커스텀 코드) | **deny** ([`mcp-bundle-isolation.md`](mcp-bundle-isolation.md)) |

구현: [`../../services/sandbox-egress/high-risk-placement.js`](../../services/sandbox-egress/high-risk-placement.js).

---

## Commands

```bash
bash deploy/scripts/check-high-risk-tenant-nodepool.sh
node services/sandbox-egress/high-risk-placement.selftest.js
```

### 선택: 라이브 (`AURA_NODEPOOL_LIVE=1`)

노드에 label/taint 적용·Kata handler 설치 후 `kubectl apply -k deploy/k8s/sandbox-egress/`. CI PASS 조건 **아님**.
