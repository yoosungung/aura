# Memory · control-resolve · compliance-erase — Fission → Deployment hardcode

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · §3 · §4 · §9.3.  
계획: Function hardcode inventory (agent/MCP만 Fission 잔여).

**이 문서 범위:** memory_* · `aura-control-resolve` · `aura-compliance-erase`를 Fission Function/Package/MQT에서 **ns `aura` Deployment(+Service)** 로 옮기는 cutover·롤백.  
**Non-goals:** agent/mcp Function 유지 · erase를 `svc-memory` 파드에 합치기 · subject/durable 이름 변경.

---

## 잔여 Fission Function (제품)

| Function | 비고 |
|----------|------|
| `aura-agent-invoke` · `aura-agent-invoke-py` | task-bridge |
| `aura-mcp-invoke` · `aura-mcp-invoke-py` | task-bridge |
| `aura-mcp-invoke-rpc` · `aura-mcp-invoke-rpc-py` | rpc-bridge → Fission |

dev smoke Function은 `deploy/dev/`만.

---

## Deployment 대상

| 이전 Function | Deployment / Service | NATS |
|---------------|----------------------|------|
| `aura-control-resolve` | `aura-control-resolve` replicas≥2 | rpc-bridge → `http://aura-control-resolve.aura.svc:8080` |
| `aura-memory-recall` | `aura-memory-recall` replicas≥2 | rpc-bridge → `http://aura-memory-recall.aura.svc:8080` |
| memory async 7 | `aura-memory-{store,capture,embed,consolidate,ttl,archive,object-gc}` | JetStream pull · durable 기존 consumer 이름 |
| `aura-compliance-erase` | `aura-compliance-erase` (**별도** · memory 파드 비포함) | durable `aura_compliance_erase` |

**erase ≠ object_gc** — 코드 `services/compliance/` · subject `aura.tasks.compliance.erase` 유지.

---

## Cutover

1. 이미지 빌드: `deploy/scripts/build-hardcoded-memory-images.sh` (Rust · `aura/memory-capture` · `aura/memory-batch` · `aura/memory-recall` · `aura/compliance-erase` · `aura/control-resolve`).
2. `kubectl apply -k deploy/k8s/<name>` (Deployment 매니페스트).
3. rpc-bridge env `RPC_SERVICE_URLS` (또는 기본 Service DNS) 확인 · 롤아웃.
4. Fission Function/Package/MQT 삭제 (`apply-product.sh`가 더 이상 생성하지 않음).
5. `check-control-resolve-bridge.sh` · `check-memory-*.sh` · `check-compliance-erase.sh`.

## 롤백

이전 이미지/`sha-<short>`로 Deployment 되돌림 · 필요 시 Fission Package/MQT 재적용 · rpc-bridge를 Fission Router만 쓰도록 env 복구.

---

## 검증

```bash
bash deploy/scripts/check-memory-control-hardcode.sh
cargo test -p aura-nats-rpc-bridge
cargo test -p aura-nats-rpc-bridge
```
