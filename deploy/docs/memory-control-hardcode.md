# Memory · control-resolve · compliance-erase — Fission → hardcode

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · §3 · §4 · §9.3.  
배치 스케줄: [`memory-batch-cronjobs.md`](memory-batch-cronjobs.md).  
캡처 통합: [`memory-capture-inline-pipeline.md`](memory-capture-inline-pipeline.md).

**이 문서 범위:** memory · `aura-control-resolve` · `aura-compliance-erase`를 Fission에서 분리한 **현행 실행 형태**.  
**Non-goals:** agent/mcp Function 유지 · erase를 memory 파드에 합치기 · subject 이름 변경.

---

## 잔여 Fission Function (제품)

| Function | 비고 |
|----------|------|
| `aura-agent-invoke` · `aura-agent-invoke-py` | task-bridge |
| `aura-mcp-invoke` · `aura-mcp-invoke-py` | task-bridge |
| `aura-mcp-invoke-rpc` · `aura-mcp-invoke-rpc-py` | rpc-bridge → Fission |

dev smoke는 `deploy/dev/`만.

---

## 현행 실행 형태

| 워크로드 | 형태 | 이미지 / NATS |
|----------|------|----------------|
| `aura-control-resolve` | Deployment+Service · lab replicas=1 | `aura/control-resolve` · rpc-bridge → Service HTTP |
| `aura-memory-recall` | Deployment+Service · lab replicas=1 | `aura/memory-recall` · rpc-bridge → Service HTTP |
| `aura-memory-capture` | Deployment · replicas=1 | `aura/memory-capture` · JetStream durable `aura_memory_capture` |
| consolidate / ttl / archive / object_gc | **CronJob only** (상시 파드 없음) | `aura/memory-batch` one-shot · UTC 일 1회 |
| `aura-compliance-erase` | **별도** Deployment (memory 파드 비포함) | `aura/compliance-erase` · durable `aura_compliance_erase` |

store/embed 단독 Deployment **퇴역**(capture in-process).  
**erase ≠ object_gc** — 코드 `services/compliance/` · subject `aura.tasks.compliance.erase` · memory 파드 비포함.

---

## Cutover / 운영

1. `bash deploy/scripts/build-hardcoded-memory-images.sh`
2. `kubectl apply -k deploy/k8s/<name>` (capture/recall/resolve/erase=Deployment · batch=CronJob)
3. 배치 상시 Deployment가 남아 있으면 삭제: `apply-product.sh` prune 또는  
   `kubectl -n aura delete deploy/aura-memory-{ttl,consolidate,archive,object-gc}`
4. Fission memory/control/compliance Function·MQT는 제품 경로에 두지 않음.

## 롤백

이전 이미지/`sha-<short>`로 Deployment·CronJob 되돌림.

---

## 검증

```bash
bash deploy/scripts/check-memory-control-hardcode.sh
bash deploy/scripts/check-memory-capture.sh
bash deploy/scripts/check-memory-ttl.sh
cargo test -p aura-nats-rpc-bridge
```
