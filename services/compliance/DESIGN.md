# compliance (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #17 · §8 · **§9.3**.  
일정: [ROADMAP.md](../../ROADMAP.md) M4 — `aura.tasks.compliance.erase`.  
정본: [`deploy/docs/compliance-erase.md`](../../deploy/docs/compliance-erase.md).  
이미지: **`aura/compliance-erase`** (Rust).

**이 문서 범위:** erase planner/handler Rust crate · JetStream Deployment.  
**Non-goals:** live OpenBao · memory 파드에 erase 합치기 · PITR 키볼트 드릴.

## 모듈

| 경로 | 역할 |
|------|------|
| `rs/src/lib.rs` | kid 해석 · steps · envelope wire stub (`openbao-transit`) |
| `rs/src/main.rs` | JetStream worker (`aura-compliance-erase`) |

## Commands

```bash
cargo test -p aura-compliance-erase
bash deploy/scripts/check-compliance-erase.sh
docker build -f services/compliance/Dockerfile -t aura/compliance-erase:local .
```
