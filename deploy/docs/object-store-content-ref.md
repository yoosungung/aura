# Object Store 제품 · `content_ref` 스키마·권한 (M2 / V2.1 · M4 경로 봉인)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #17 · §3.3 · **§8** · §9.1 · §9.3.  
일정: [ROADMAP.md](../../ROADMAP.md) M2 (제품·스키마) · M4 (공유 버킷/`bundles/` 경로 봉인) · 고아 GC=[`object-store-orphan-gc.md`](object-store-orphan-gc.md).  
전제: NATS envelope §8 · CNPG Barman 초안 [`pg-ha-pitr-topology.md`](pg-ha-pitr-topology.md).

**이 문서 범위:** Object Store **제품명** · S3 클라이언트 계약 · **버킷/경로(번들 공유 포함)** · `content_ref` JSON · 권한/암호화 · **256KB 초과 시 ref-only**.  
**Non-goals:** 라이브 버킷·Garage 클러스터 **provision** · SDK 업로드 본구현 · Barman 자격증명 실값. GC 본구현=[`memory-object-gc.md`](memory-object-gc.md) · Parquet=[`memory-archive.md`](memory-archive.md).

수치·제품 출처: ARCHITECTURE §8 256KB · ROADMAP V2.1. 운영 endpoint/비용 교체는 결정 로그 1행 + 이 문서·§8을 **같이** 고친다 — 여기서 새 스키마를 발명하지 않는다.

---

## 후보 비교 (요약)

| 후보 | 적합성 | 비고 |
|------|--------|------|
| **Garage** | **채택 (in-cluster 기준)** | 경량 S3 코어 · k8s 친화 · Put/Get/Delete/Head 충분. 버전닝·S3 ACL/bucket policy **미구현** → Aura는 앱 ACL+키 prefix로 보완 |
| NCP Object Storage | 운영 대안 (managed) | S3-compatible · 동일 클라이언트·스키마로 endpoint만 교체. **비용/리전은 `@eric` escalate** |
| AWS S3 | 운영 대안 (managed) | 기능 최다. 동일 스키마. 클라우드 종속·비용은 별도 승인 |
| MinIO CE | **비채택** | Community Edition 아카이브(유지보수 중단) — 신규 기준선 금지 |

**결정 (2026-11-19):** Aura `content_ref` / (예정) episodic 아카이브 Object Store 제품 = **Garage** (S3-compatible / SigV4).  
클라이언트는 **AWS S3 API 부분집합**만 사용하므로 이후 NCP·AWS로 endpoint 스왑 가능. **라이브 provision·유료 클라우드 택일은 보류** — 인프라/디스크/비용은 티켓 escalate `@eric`.

---

## 클라이언트 계약

| 항목 | 값 |
|------|-----|
| API | **S3-compatible** · **SigV4** |
| 필수 연산 | `PutObject` · `GetObject` · `DeleteObject` · `HeadObject` (multipart는 >5MiB 후속) |
| Endpoint | env `AURA_S3_ENDPOINT` (Garage/NCP/AWS). path-style 허용 |
| Region | env `AURA_S3_REGION` (Garage dummy `garage` 가능) |
| Creds | K8s Secret `aura-object-store-creds` (`ACCESS_KEY_ID` / `ACCESS_SECRET_KEY`) — **git 금지** |
| SDK | 구현 시 AWS SDK v3 또는 동등 (본 슬라이스 Non-goal) |

---

## 버킷 · 경로

| 용도 | 버킷 (가정) | 키 prefix | 공유 |
|------|-------------|-----------|------|
| `content_ref` 본문 | **`aura-content`** | `tenants/{tenant_id}/refs/{yyyy}/{mm}/{content_id}` | — |
| 콜드 episodic Parquet (M4) | **`aura-content`** (동일 버킷) | `tenants/{tenant_id}/archive/episodic/{yyyy}/{mm}/…` | content_ref와 **버킷 공유**, prefix 분리 |
| 번들 스토어 (`source_meta.bundle_uri`) | **`aura-content`** | `tenants/{tenant_id}/bundles/{kind}/{name}/{version}/…` | content_ref와 **버킷 공유**; resolve 계약 [`svc-control-resolve.md`](svc-control-resolve.md) |
| PG Barman WAL/base | **`aura-pg`** (별도) | `aura-pg/…` ([`cluster-ha.draft.yaml`](../k8s/pg-pooler/cluster-ha.draft.yaml)) | **자격증명·버킷 비공유** — 앱 content 키로 백업 버킷 접근 금지 |

`s3://aura-content/tenants/{tenant_id}/refs/…` 가 정본 경로 가정이다.

### M4 계약 봉인 (공유 버킷 · prefix 격리)

**결정 (2026-11-19, M4):** 앱 Object Store는 **단일 버킷 `aura-content`** 를 content_ref · archive Parquet · **번들 스토어**가 **공유**한다. 격리는 **키 prefix만** (`refs/` · `archive/` · `bundles/`). 용도별 별도 버킷 **비채택**(Garage grant·Egress allowlist·자격증명 단순화).  
**불변:** Barman/`aura-pg` 는 content와 **버킷·자격증명 비공유**. `object_gc` 는 `refs/` only — `archive/`·`bundles/` 미나열([`object-store-orphan-gc.md`](object-store-orphan-gc.md)).  
**대안 기각:** 번들 전용 버킷 — Egress/시크릿 이중화 대비 이득 없음(샌드박스 격리는 RuntimeClass·NP, 버킷 분리가 아님).

---

## `content_ref` 스키마

NATS envelope `content_ref` 필드(§8). `null` = 인라인 `payload`만 사용.

```json
{
  "scheme": "s3",
  "bucket": "aura-content",
  "key": "tenants/{tenant_id}/refs/{yyyy}/{mm}/{content_id}",
  "size_bytes": 400000,
  "content_type": "application/octet-stream",
  "enc": {
    "alg": "AES-256-GCM",
    "kid": "tenant:{tenant_id}:v1"
  }
}
```

| 필드 | 필수 | 규칙 |
|------|------|------|
| `scheme` | Y | 고정 `"s3"` |
| `bucket` | Y | 기본 `aura-content` |
| `key` | Y | 반드시 `tenants/{tenant_id}/…` 로 시작. 테넌트 교차 키 금지 |
| `size_bytes` | Y | 암호문 바이트(헤더 제외 시 구현 DESIGN에 명시) |
| `content_type` | N | 기본 `application/octet-stream` |
| `enc` | Y (핫 PII/본문) | `alg`+`kid`. 평문 업로드 금지(§9.3). erase=키 파기(crypto-shred) |
| URI 단축 | — | 로그용 `s3://{bucket}/{key}` 허용. SoR은 위 JSON |

**256KB 규칙 (V2.1)**

- NATS 메시지(또는 RPC 요청/응답)에서 **본문 UTF-8 바이트 > 256KB**(262144) 이거나 PII 원문 정책이면: object에 업로드 후 envelope에 **`content_ref`만** 두고 **`payload`에 원문 금지**(stub/메타만).
- ≤256KB 비-PII는 `payload` 인라인 + `content_ref: null` 허용.
- Agent/프롬프트는 recall `items[]`만 — `content_ref` 본문 덤프 금지([`agent-inject-contract.md`](agent-inject-contract.md)).

---

## 권한 · 격리

| 규칙 | 내용 |
|------|------|
| 공개 ACL | **금지** — 버킷 public-read / 익명 Get **없음** |
| Garage 권한 | key → bucket grant (write/read/delete). S3 bucket policy 미사용 |
| 쓰기 | `svc-memory`(store·후속 archive) 및 capture/에이전트가 256KB 초과 시 **업로드 후 ref만 publish**. 런타임 Zero Direct Write는 PG에만 적용(§1 #10) |
| 읽기 | `svc-memory` · (필요 시) compliance erase. Agent는 recall 응답만 |
| 네트워크 | Pod **Egress NetworkPolicy deny-default**; 허용 object store endpoint(`AURA_S3_ENDPOINT`)만 allow (§9.1) |
| 시크릿 | access key는 Secret+짧은 프로세스 캐시. 로그/OTel/NATS에 평문 키·본문 금지 |
| 테넌트 | 키 prefix `tenants/{tenant_id}/` + `enc.kid` 테넌트 키. 교차 테넌트 Get은 앱에서 거부 |

---

## 구현 보류 (명시)

| 항목 | 상태 |
|------|------|
| Garage Helm/StatefulSet · 실 버킷 생성 | **보류** — 설계만 고정 |
| NCP vs AWS vs self-host 디스크 비용 | **`@eric` escalate** |
| SDK Put/Get 본구현 · 업로드 헬퍼 | 후속 티켓 (store/capture 경로) |
| 고아 GC 알고리즘 | **고정** — [`object-store-orphan-gc.md`](object-store-orphan-gc.md) (V2.2 · 구현=M4) |
| Parquet archive job | M4 |

---

## 검증

```bash
bash deploy/scripts/check-object-store-content-ref.sh
```

PASS = 본 문서에 Garage · S3/SigV4 · 256KB ref-only · schema/권한 · ARCHITECTURE 링크 존재.

---

## 참고

- §8 envelope · §9.3 crypto-shred · ROADMAP 결정 로그 (2026-11-19 Object Store = Garage)
- Barman 버킷 분리: [`pg-ha-pitr-topology.md`](pg-ha-pitr-topology.md)
- wiki: Aura Object Store 제품 페이지 없음(2026-11-19 검색) — 본 L0가 정본
