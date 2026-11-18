# 고아 `content_ref` 객체 GC 설계 (M2 / V2.2)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §3.1–§3.2 · §6.2.2 · **§8** · §9.3.  
제품·키 경로: [`object-store-content-ref.md`](object-store-content-ref.md) (Garage · `aura-content` · `tenants/{tenant_id}/refs/…`).  
일정: [ROADMAP.md](../../ROADMAP.md) M2 (알고리즘 고정) · **구현 = M4** (`aura.tasks.memory.object_gc`).

**이 문서 범위:** 고아 객체 **판정·유예·배치·멱등 키·안전장치(참조 존재 시 스킵)** 를 수치와 함께 고정.  
**Non-goals:** Function/스케줄 CR 본구현 · 라이브 Garage Delete · SDK 업로드 · Parquet `archive/` GC · `bundles/` GC · `aura.tasks.compliance.erase`(즉시 파기·crypto-shred는 별 경로).

수치 출처: ARCHITECTURE §3.1 `AURA_EVENTS` **90일** · ROADMAP V2.2. 운영 튜닝은 M4 부하 후 결정 로그 1행 + 이 문서·§3.2를 **같이** 고친다.

---

## 고정 수치 (M2)

| 항목 | 값 |
|------|-----|
| 대상 버킷 | **`aura-content`** (Garage / S3-compatible) |
| 대상 prefix | **`tenants/{tenant_id}/refs/`** 만 |
| 유예(grace) | 객체 `LastModified` 기준 **`now() - interval '90 days'`** 이전만 후보 |
| 주기 | **`aura.tasks.memory.object_gc` 발행 일 1회**(UTC) |
| 배치 | 테넌트당 **최대 100** 키/실행 (초과는 다음 일 배치로 이월) |
| 제외 prefix | `tenants/{tenant_id}/archive/` · `tenants/{tenant_id}/bundles/` · `aura-pg` 전체 |

유예 **90일**은 `AURA_EVENTS` Limits retention(§3.1)과 맞춘다 — 이벤트 스트림에 아직 실릴 수 있는 `content_ref`를 성급히 지우지 않는다. 메모리 파티션 TTL(14일/24개월/12개월)과 **별개**; 파티션 DROP 후에도 ref 객체가 남으면 이 GC가 회수한다.

---

## 참조 SoR (live)

고아 = **유예 경과** AND **아래 어느 경로에도 `(bucket, key)` 참조가 없음**.

| 소스 | 규칙 (M2 고정 · 스키마는 store 구현 시 준수) |
|------|-----------------------------------------------|
| `memory_items` | `metadata->'content_ref'->>'bucket'` + `->>'key'` 가 객체와 일치하면 **live** (전 파티션·`valid_until` 무관 — soft-delete만으로 객체 삭제 금지) |
| `memory_audit` | 동일 JSON 경로가 있으면 **live** |
| 업로드 레이스 | store 전 PutObject는 유예 창 안에서만 보호 — 90일 후에도 PG 참조 없으면 고아 |

전용 `content_ref` 컬럼이 나중에 추가되면 이 문서·게이트를 **같이** 갱신한다. M2는 **metadata JSON 경로**를 정본으로 고정한다.

**금지:** S3만 보고 삭제 · PG 없이 나이만으로 삭제 · `archive/`/`bundles/`를 refs GC에 포함.

---

## 알고리즘 (배치)

담당: `svc-memory` object_gc (MQT · scale-to-zero OK). 의사코드:

```
for each tenant_id (또는 태스크 payload.tenant_id):
  keys = ListObjects(bucket=aura-content,
                     prefix=tenants/{tenant_id}/refs/,
                     LastModified < now() - 90 days)
                     LIMIT 100
  for key in keys:
    if EXISTS live_ref(tenant_id, bucket, key):   -- 위 SoR
      SKIP                                         -- 안전장치
      continue
    DeleteObject(bucket, key)                       -- 404 = 성공(멱등)
  emit done|error with {scanned, deleted, skipped}
```

| 단계 | 동작 |
|------|------|
| 1. 후보 | `refs/` prefix ListObjects + **90일** 필터. archive/bundles **미나열** |
| 2. 참조 검사 | 테넌트 GUC/`set_config(..., true)` 후 EXISTS (또는 동등 파라미터 쿼리). 히트 → **스킵** |
| 3. 삭제 | `DeleteObject` 단건(또는 ≤100 키 배치 API). 실패는 errorTopic · 부분 성공 허용 |
| 4. 완료 | `aura.events.memory.object_gc.done` / `.error` |

### 참조 검사 쿼리 (초안 · 구현=M4)

```sql
-- 매 키: live면 SKIP. RLS/GUC는 store와 동일 계약.
SELECT 1
FROM memory_items
WHERE tenant_id = $1
  AND metadata #>> '{content_ref,bucket}' = $2
  AND metadata #>> '{content_ref,key}' = $3
LIMIT 1
UNION ALL
SELECT 1
FROM memory_audit
WHERE tenant_id = $1
  AND metadata #>> '{content_ref,bucket}' = $2
  AND metadata #>> '{content_ref,key}' = $3
LIMIT 1;
```

(`memory_audit`에 `metadata`/`content_ref`가 없으면 구현 시 해당 분기를 no-op으로 두고 이 문서를 갱신한다.)

---

## 담당 태스크 · 멱등 키

| Subject | Consumer / Function | 역할 (M4 구현) | 완료 이벤트 |
|---------|---------------------|----------------|-------------|
| `aura.tasks.memory.object_gc` | `aura_memory_object_gc` / `svc-memory` object_gc | 유예 경과 미참조 `refs/` 삭제 배치 | `aura.events.memory.object_gc.done` / `.error` |

**멱등**

| 계층 | 키 | 규칙 |
|------|-----|------|
| 태스크 envelope `id` | `object-gc:{tenant_id\|all}:{yyyy-mm-dd}` | 동일 UTC 일자 재발행은 같은 작업으로 취급(중복 실행 OK — Delete 멱등) |
| 객체 삭제 | `(bucket, key)` | `DeleteObject` 재시도·404 = 성공. 별도 tombstone 테이블 불필요(M2) |

MQT·`MaxDeliver`·DLQ는 §3.2 공통. 스케줄 CR·Function 본문은 M4.

---

## 안전장치 요약

1. **참조 존재 → 무조건 스킵** (나이 무관).
2. **90일 미만 객체 비후보** (업로드→store 레이스 · `AURA_EVENTS` 잔존).
3. **prefix 화이트리스트** = `refs/` only.
4. **버킷** = `aura-content` only — Barman `aura-pg` 접근 금지([`object-store-content-ref.md`](object-store-content-ref.md)).
5. **erase ≠ GC** — GDPR 즉시 파기는 `aura.tasks.compliance.erase`(§9.3).

---

## V2.2 매핑

ROADMAP M2 V2.2: *90일(또는 정책일) 고아 GC 설계* → **이 문서** (쿼리·태스크·스킵·배치·멱등).  
실 Delete/List 스모크는 M4.

---

## 검증

```bash
bash deploy/scripts/check-object-store-orphan-gc.sh
```

PASS = 본 문서에 90일 · `aura.tasks.memory.object_gc` · 참조 스킵 · 배치 · ARCHITECTURE 링크 존재.

---

## 참고

- [`object-store-content-ref.md`](object-store-content-ref.md) · [`memory-ttl-policy.md`](memory-ttl-policy.md)
- §3.1 `AURA_EVENTS` 90일 · §8 envelope · ROADMAP 결정 로그 (고아 GC V2.2)
- wiki: Aura orphan GC 페이지 없음(2026-11-19 검색) — 본 L0가 정본
