# `aura.tasks.compliance.erase` 초안 — content_ref + crypto-shredding (M4 · §9.3)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #17 · §9.3.  
`content_ref`/`enc.kid`: [`object-store-content-ref.md`](object-store-content-ref.md).  
코드: [`services/compliance/`](../../services/compliance/) · 매니페스트: [`../k8s/compliance-erase/`](../k8s/compliance-erase/).

**이 문서 범위:** GDPR 잊힐 권리 **초안** — DEK **crypto-shred** → 핫 PG redact → `aura-content` `refs/` DeleteObject(방어) · MQT 와이어 · `test:` 게이트.  
**Non-goals:** live OpenBao/Transit apply CI 필수 · 전 테넌트 wipe 라이브 · PITR 드릴 · archive/bundles 물리 삭제 · OTel Collector · M5 운영화.

성공 기준(ROADMAP M4): erase 후 핫 데이터·**복호 가능 ciphertext 부재**.

---

## KMS · kid

| 항목 | 값 |
|------|-----|
| 제품 (M4 봉인) | **OpenBao Transit** (`kms_product=openbao-transit`) |
| tenant DEK | `tenant:{tenant_id}:v{N}` |
| user DEK | `tenant:{tenant_id}:user:{user_id}:v{N}` |
| 파기 | Transit key version destroy / soft-delete → **모든 복사본** (캐시 포함) |
| pending | 기본 **24h** 쿨다운 후 하드 파기(실 KMS API=후속); 플래너는 `pending_until` 기록 |

파생키(HKDF(MEK, subject))는 **금지** — MEK 생존 시 재유도 가능하므로 shred가 아님.

---

## 흐름 (순서 고정)

1. **validate** — `tenant_id` · scope(`tenant`\|`user`) · kids resolve  
2. **shred_keys** — DEK destroy (**먼저**; 복호 불능 SoR)  
3. **invalidate_secrets_cache** — Function TTL 캐시/`maskSecrets` 경로 무효화  
4. **pg_redact** — 핫 `memory_items` 등 행 삭제/비식별 (injectable; live SQL=후속)  
5. **delete_objects** — `aura-content` **`refs/` only** DeleteObject (archive/bundles는 shred만)  
6. **emit_done** — `aura.events.compliance.erase.done`

암호문 객체가 남아도 DEK 부재면 **복호 불가** = erase 충족. 객체 Delete는 심화 방어.
`assertNoDecryptableCiphertext` selftest가 sample ciphertext 복호 실패를 고정한다.

---

## erase ≠ object_gc

| | `compliance.erase` | `memory.object_gc` |
|--|--------------------|---------------------|
| 목적 | 잊힐 권리 · 즉시 복호 불가 | 고아 객체 회수 |
| 키 | **shred** (OpenBao Transit) | 만지지 않음 |
| 객체 | 스코프 `refs/` best-effort | 90일+미참조 `refs/` |
| 유예 | pending **24h**(발행 전) | grace **90d** |

고아 GC: [`object-store-orphan-gc.md`](object-store-orphan-gc.md).

---

## MQT

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.compliance.erase` |
| consumer | `aura_compliance_erase` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.compliance.erase.done` |
| errorTopic | `aura.events.compliance.erase.error` |
| minReplicaCount | **0** |

멱등 envelope id: `erase:{tenant}:tenant:{request_id}` 또는 `erase:{tenant}:user:{user_id}:{request_id}`.

---

## 검증

```bash
bash deploy/scripts/check-compliance-erase.sh
cargo test -p aura-compliance-erase
bash deploy/scripts/check-compliance-erase.sh
```
