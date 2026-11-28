# Memory batch CronJobs — 스케줄

계약 현행: [ARCHITECTURE.md](../../ARCHITECTURE.md) §3.2 · §6.2.2 · [ROADMAP.md](../../ROADMAP.md) M4.  
관련: [`memory-ttl-policy.md`](memory-ttl-policy.md) · [`memory-ttl-drop.md`](memory-ttl-drop.md) · [`object-store-orphan-gc.md`](object-store-orphan-gc.md) · [`memory-archive.md`](memory-archive.md) · [`memory-consolidate-promotion.md`](memory-consolidate-promotion.md).

**이 문서 범위:** consolidate / TTL / archive / object_gc를 **Kubernetes CronJob이 하루 1회 핸들러를 직접 실행**하는 형태.  
**Non-goals:** NATS JetStream native schedule · 상시 Deployment consumer · Fission MQT.

**결정:** 배치 = **CronJob only**. NATS 스케줄러 비채택. **상시 파드 없음** — Job이 `aura/memory-batch` 바이너리를 돌리고 종료한다.

| 이미지 | 역할 |
|--------|------|
| **`aura/memory-capture`** | capture만 (상시 Deployment) |
| **`aura/memory-recall`** | recall sync (상시 Deployment) |
| **`aura/memory-batch`** | consolidate · ttl · archive · object_gc **one-shot** 바이너리 |

---

## 모양

```
CronJob (UTC 일 1회)
    │  command: /aura-memory-{ttl|consolidate|archive|object-gc}
    ▼
Job Pod (수명=실행 시간만) → handler stub/실배선 → 종료
```

| CronJob | command |
|---------|---------|
| `aura-memory-consolidate-cron` | `/aura-memory-consolidate` |
| `aura-memory-ttl-cron` | `/aura-memory-ttl` |
| `aura-memory-archive-cron` | `/aura-memory-archive` |
| `aura-memory-object-gc-cron` | `/aura-memory-object-gc` |

---

## 스케줄·정책

| 항목 | 값 |
|------|-----|
| 주기 | **일 1회** · **UTC** `0 0 * * *` |
| `concurrencyPolicy` | **`Forbid`** |
| 네임스페이스 | **`aura`** |
| 역할 | CronJob = **handler 실행** · Deployment consumer **없음** |
| 비채택 | NATS publish→상시 consumer · NATS KV/JetStream 스케줄 |

멱등: envelope `id`는 일자·테넌트 기반 (`batch_payload`).

---

## 매니페스트

| 경로 | 내용 |
|------|------|
| `deploy/k8s/memory-{consolidate,ttl,archive,object-gc}/cronjob.yaml` | one-shot CronJob |
| 각 `kustomization.yaml` | **cronjob만** (deployment.yaml 없음) |

---

## 검증

```bash
bash deploy/scripts/check-memory-ttl.sh
bash deploy/scripts/check-memory-consolidate.sh
kubectl -n aura get cronjob | grep aura-memory
kubectl -n aura get deploy | grep -E 'ttl|consolidate|archive|object-gc' || echo '(none — expected)'
```

---

## 체크리스트

- [x] 스케줄 정본 = **K8s CronJob** · UTC 일 1회 · handler 직접 실행
- [x] 배치 **상시 Deployment 없음**
- [x] 이미지 `aura/memory-batch` on CronJob only
