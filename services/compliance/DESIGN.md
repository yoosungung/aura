# compliance (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #17 · §8 · **§9.3**.  
일정: [ROADMAP.md](../../ROADMAP.md) M4 — `aura.tasks.compliance.erase` 초안.  
정본: [`deploy/docs/compliance-erase.md`](../../deploy/docs/compliance-erase.md).

**이 문서 범위:** erase planner/handler 모듈 · injectable KMS/PG/object deps · selftest.  
**Non-goals:** live OpenBao/Garage · k8s MQT 매니페스트(본구현=M5 운영화 직전) · PITR 키볼트 드릴.

---

## 모듈

| 경로 | 역할 |
|------|------|
| `erase/plan.js` | kid 해석 · 24h pending · refs/ 대상 필터 · 멱등 id · `kms_product=openbao-transit` |
| `erase/handler.js` | shred → cache invalidate → PG redact → DeleteObject → 복호 불가 검증 |
| `erase/*.selftest.js` | 순서·prefix 스킵·복호 실패 스모크 |

호출자는 OpenBao Transit `destroy`·Pooler redact·S3 DeleteObject를 inject한다. Handler는 키 파기를 SoR로 두고 객체/행 삭제는 방어적이다.

---

## Commands

```bash
node services/compliance/erase/plan.selftest.js
node services/compliance/erase/handler.selftest.js
bash deploy/scripts/check-compliance-erase.sh
```
