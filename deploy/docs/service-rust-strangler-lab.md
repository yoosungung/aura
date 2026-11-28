# Service Rust Strangler · lab canary (후속 트랙)

계약 불변: subject · envelope · Function 이름 · queue-group/durable.  
코드 패리티(Phase 0–5)는 workspace `cargo test`/`clippy`로 게이트. **이 문서는 클러스터 canary→cutover만.**

Object Store Garage→RustFS 어플라이언스는 **별 트랙** ([`object-store-rustfs-migration.md`](object-store-rustfs-migration.md)). Phase 4 `object_gc`는 svc-memory 태스크.

## Strangler 단계 (컴포넌트마다)

| 단계 | 내용 |
|------|------|
| shadow | Rust 이미지 빌드·오프라인 패리티만 (트래픽 없음) |
| canary | 동일 Service/queue-group/durable에 Rust 레플리카 병행 · subject 변경 금지 |
| cutover | 트래픽 전부 Rust · 헬스/`check-*.sh` 통과 |
| Node deprecate | Node replicas → 0 · 기본 이미지 태그 Rust |
| 롤백 | 이전 이미지 태그(`:local` / `sha-<short>`)로 Deployment 되돌림 |

## Phase별 canary 게이트

| Phase | canary 시 돌릴 게이트 |
|-------|----------------------|
| 1 (잔여) | `check-control-resolve-bridge.sh` · task-bridge 관련 check |
| 2 | `check-gateway-sse-ws.sh` · `check-gateway-fair-queue.sh` · `check-gateway-inflight-release.sh` · `check-llm-gateway.sh` · `check-llm-gateway-router.sh` |
| 3 | `check-svc-control-resolve.sh` · `check-control-resolve-bridge.sh` · admin-ui 관련 check(HTTP `/v1`만) |
| 4 | `check-memory-capture.sh` · `check-memory-store.sh` · `check-memory-embed.sh` · `check-memory-recall.sh` · consolidate/ttl/archive/object_gc checks |
| 5 | `check-agent-invoke.sh` · `check-mcp-invoke-dual.sh` · `check-agent-checkpoints.sh` |

live NATS/PG/provider assert는 **canary 창에서만** 필수. 즉시 트랙은 Node selftest 패리티 + `cargo test --workspace`.

## 이미지 빌드 (shadow)

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
docker build -f services/gateway/Dockerfile -t aura/gateway:local .
docker build -f services/llm-gateway/Dockerfile -t aura/llm-gateway:local .
docker build -f services/control/Dockerfile -t aura/control-admin:local .
```

## 롤백 (Deployment · 계획 종료)

Deployment cutover 롤백 스크립트·side-by-side canary 매니페스트는 **제거됨**(2026-11-28).  
필요 시 일반 복구: 이전 이미지 digest/`sha-<short>`로 `kubectl set image` → `rollout status` → 해당 Phase `check-*.sh`.

## Lab 실측 (2026-11-28 · orbstack `aura`)

| 항목 | 결과 |
|------|------|
| 전략 | side-by-side canary → **prod cutover** 후 canary/롤백 아티팩트 삭제 |
| 이미지(현재) | `aura/{gateway,llm-gateway,control-admin,nats-rpc-bridge,nats-task-bridge}:local` (Rust · OrbStack logo LABEL) |
| Phase 4–5 | Function 이미지 미배선 → **check-*.sh 정적 게이트만** (Fission custom cutover 후속) |
| check-*.sh | Phase 1–5 목록 **전부 PASS** (18) |

### Cutover 실측 (2026-11-28 · 승인 후)

| Deploy | 이미지 | 비고 |
|--------|--------|------|
| `aura-nats-rpc-bridge` | `aura/nats-rpc-bridge:local` ×2 | Rust · Node deprecate |
| `aura-nats-task-bridge` | `aura/nats-task-bridge:local` ×2 | Rust · Node deprecate |
| `aura-gateway` | `aura/gateway:local` ×2 | Rust · Node deprecate |
| `aura-llm-gateway` | `aura/llm-gateway:local` ×2 | Rust · Node deprecate |
| `aura-control-admin` | `aura/control-admin:local` ×2 | Rust · StubPooler · Node deprecate |

- Annotate: `aura.runtime/image-flavor=rust` · `aura.runtime/node-deprecated=true`
- Phase 4–5 Function cutover **미실시** (이미지 없음)
- Deployment 롤백 스크립트·`deploy/dev/k8s/rust-canary/` **삭제 완료**
