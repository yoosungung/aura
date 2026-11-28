# Object Store: Garage 제거 · RustFS 단독 (요건 · Phase A)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §8 · 제품·스키마 정본 [`object-store-content-ref.md`](object-store-content-ref.md).  
일정: [ROADMAP.md](../../ROADMAP.md) — **서비스 코드 Rust 전환 트랙과 별개**.  
목표 매니페스트: [`../k8s/rustfs/`](../k8s/rustfs/). **`deploy/k8s/garage/` 는 이관 완료 시 저장소에서 삭제.**

**전제:** 정상 상태는 **RustFS만**. Garage와 병행 운영·롤백용 장기 잔존 **금지**. 이관 창에서만 Garage를 **읽기 소스**로 잠시 둔 뒤, 검증 통과 즉시 **중지·삭제·소스 제거**한다.

**이 문서 범위:** 요건(제거 목록 · RustFS 단독 구성 · 데이터 이관+Garage 철거 · 어플라이언스).  
**Non-goals:** Barman/`aura-pg` · 플랫폼 서비스 Rust 이식 · Garage 재도입.

---

## 1. 결정

| 항목 | 값 |
|------|-----|
| 동기 | Garage **AGPL-3.0** → 어플라이언스 재배포 부적합 |
| 목표 | **RustFS 단독** · **Apache-2.0** · S3/SigV4 · path-style |
| 금지 | Garage+RustFS 이중 endpoint · cutover 후 Garage replicas 유지 · 어플라이언스에 `dxflrs/garage` 잔존 |
| 앱 계약 | `scheme=s3` · `aura-content` · `refs/`·`archive/`·`bundles/` · Secret/env **키 이름** 불변 |
| 이미지 핀 (검증 전 후보) | `rustfs/rustfs:1.0.3` — `latest` 금지. lab PASS 태그만 ROADMAP 확정 |
| 롤백 | Garage로 되돌리지 **않음**. 실패 시 RustFS 볼륨/백업에서 복구하거나 창을 열어 **재mirror 후** 다시 철거 절차만 반복 |

---

## 2. 제거할 Garage As-Is (인벤토리)

이관 전 스냅샷용. 완료 후 아래는 **클러스터·git·이미지 번들에서 0건**.

| 종류 | 경로 / 이름 |
|------|-------------|
| 매니페스트 디렉터리 | `deploy/k8s/garage/` 전체 (`statefulset` · `service` · `configmap` · `secret` 템플릿 · `bootstrap.sh` · `kustomization`) |
| Workload / Service | `StatefulSet/garage` · `Service/garage` · ns `aura` |
| Config | ConfigMap `garage-config` · (교체 전) `aura-s3`의 `http://garage.aura.svc…:3900` / region `garage` |
| 이미지 | `dxflrs/garage:v1.0.1` — 어플라이언스/미러 레지스트리에서 purge |
| Egress | `garage.aura.svc.cluster.local:3900` allow · smoke `objectStoreHosts`/`dest` Garage 엔트리 |
| 문서·체크·표기 | `check-object-store-garage.sh` 개명 또는 RustFS 전용으로 교체 · AGENTS/SETUP/DESIGN의 Garage 제품 서술 · ROADMAP “Object Store = Garage” **역사 행은 유지**, 신규 결정 행으로 대체 |
| 런타임 설정 (참고) | S3 `:3900` · RPC `:3901` · admin `:3903` · `replication_factor=1` · `emptyDir` 데이터 |

**유지(이름만 · 백엔드 교체):** Secret `aura-object-store-creds` (`ACCESS_KEY_ID`/`ACCESS_SECRET_KEY`) · ConfigMap `aura-s3` (`AURA_S3_ENDPOINT`/`AURA_S3_REGION` 값만 RustFS로) · URI `s3://aura-content/…`.

**소비자(변경 없음 · endpoint만):** object-store GetObject · control activate/presign · memory archive/object_gc · sandbox Egress.

---

## 3. RustFS 단독 배포 구성 (To-Be)

| 항목 | 요건 |
|------|------|
| 디렉터리 | **`deploy/k8s/rustfs/`만** object-store in-cluster 정본. `garage/` 공존 금지 |
| Workload | standalone Deployment 또는 StatefulSet **1** · ns `aura` · 라벨 `app.kubernetes.io/name: rustfs` (Egress 셀렉터와 일치) |
| 이미지 | 핀된 `rustfs/rustfs:<tag>` · digest 권장 |
| Service | `rustfs.aura.svc.cluster.local` · S3 포트(문서화 시 **9000** 후보, 매니페스트에서 확정) |
| Endpoint | `AURA_S3_ENDPOINT=http://rustfs.aura.svc.cluster.local:<s3-port>` — **garage 호스트명 금지** |
| Region | `AURA_S3_REGION` = RustFS 설정과 서명 scope **일치** (더 이상 `garage` 문자열 의존 금지) |
| 볼륨 | 랩도 가능하면 PVC. 어플라이언스 **PVC/로컬 디스크 필수** (`emptyDir` 생산 금지) |
| Bootstrap | 버킷 `aura-content` 생성 · 랜덤 키 → Secret upsert(`aura`+`default`) · `aura-s3`를 `default` 미러 — Garage `layout assign`/`garage` CLI **호출 금지** |
| API 게이트 | `PutObject` · `GetObject` · `DeleteObject` · `HeadObject` · (검증 후) presigned PUT |
| Path style | `GET/PUT {endpoint}/aura-content/{key}` — 현 `get-object.js`와 동일 |
| 권한 | public ACL 금지 · 앱 prefix 인가 유지 · RustFS IAM/policy로 Aura ACL 대체 금지 |
| 콘솔 | 외부 노출 기본 거부 |
| Readiness | S3 포트 ready 프로브 (예: `/health/ready`) |
| apply 경로 | `apply-product`/SETUP은 **rustfs만** 언급. Garage apply 단계 삭제 |

---

## 4. 데이터 이관 + Garage 소스 철거 절차

**원칙:** on-disk 디렉터리 복사 금지. S3 mirror만. 이관 종료 조건 = **클라이언트가 RustFS만 보고 + Garage 리소스·git·이미지 없음**.

### 4.1 객체가 있는 환경 (어플라이언스·유지 랩)

| 순서 | 단계 | 완료 조건 |
|------|------|-----------|
| 1 | 유지보수 창 · 쓰기 중단(또는 짧게 freeze) | 신규 Put 없음 |
| 2 | **RustFS 단독** 기동(빈 볼륨) · 버킷·키·Secret 초안 | ready 200 · Garage와 **다른** Service |
| 3 | Garage를 **읽기 전용 소스**로만 사용해 `aura-content` 전체 mirror (`mc mirror` 등) | mirror exit 0 |
| 4 | `mc diff` + 번들/refs 샘플 sha256 (`source_meta.checksum` 등) | diff 무차이 · N건 일치 |
| 5 | `aura-s3` endpoint/region → **RustFS만** · 소비자 Pod restart | GetObject/activate 스모크 PASS |
| 6 | Garage **즉시** scale 0 → delete StatefulSet/Service/ConfigMap `garage-config` | `kubectl get` Garage 0 |
| 7 | Egress·스모크에서 garage 호스트 제거 · rustfs만 allow | NP/스크립트 grep garage = 0 (역사 문서 제외) |
| 8 | 저장소에서 `deploy/k8s/garage/` 삭제 · SETUP/AGENTS/check 개명 · 이미지 미러에서 `dxflrs/garage` 제거 | git·번들에 Garage 매니페스트/바이너리 없음 |
| 9 | (선택) Garage PVC/emptyDir 데이터 디스크 **파기** — 재마운트·재기동 경로 남기지 않음 | 디스크 wipe 기록 |

Mirror 중에도 **앱 traffic의 정상 endpoint는 cutover(5) 이후 RustFS 단일**. 이관 스크립트가 Garage를 “두 번째 스토어”로 ConfigMap에 넣지 않는다.

### 4.2 객체 없는 랩 (`emptyDir`·미사용)

Mirror 생략 가능. **순서: RustFS apply+bootstrap → endpoint를 RustFS로 고정 → Garage 리소스·`deploy/k8s/garage` 삭제 → 스모크.** Garage를 켜 둔 채 장기 병행하지 않는다.

### 4.3 실패 시

- endpoint를 Garage로 **복원하지 않음** (요건 위반).
- RustFS 데이터 삭제 후 **1→4 재실행**하거나, 사전 확보한 offline 덤프에서 RustFS로 재적재.
- 창이 끝나기 전에만 일시적으로 Garage Pod를 다시 올려 **재mirror 소스**로 쓸 수 있으나, 창 종료 시 §4.1 6–9를 반드시 완수.

### 4.4 범위 밖

`aura-pg` / Barman — content mirror·삭제 대상 아님.

---

## 5. 어플라이언스

| 주제 | 요건 |
|------|------|
| 구성 | 출고 이미지에 **RustFS만** 포함. Garage 패키지·레이어·SBOM 항목 제거 |
| 라이선스 | Apache-2.0 NOTICE 동봉. AGPL Garage 고지 **불필요**(바이너리 없음) |
| 내구성 | standalone EC:0 → 스냅샷/백업 또는 다디스크 정책을 제품에 명시 |
| 시크릿 | 설치 시 랜덤 키. 기본 `rustfsadmin` 금지 |
| 네트워크 | S3 내부만. Console 외부 기본 거부 |
| 업그레이드 | 핀 태그 · API 게이트 재실행 |
| 원격 | NCP/AWS는 endpoint 스왑 대안. 로컬 기본=RustFS |

---

## 6. Phase 게이트

| Phase | 내용 | Garage |
|-------|------|--------|
| **A 요건** | 본 문서 | 제거 대상으로만 기술 |
| **B 단독 배포** | `deploy/k8s/rustfs` + bootstrap · **garage 디렉터리 삭제 PR과 동일 마일스톤 또는 직후** | 소스에서 삭제 |
| **C 스모크** | check-object-store-* · activate · egress=rustfs only | 참조 0 |
| **D 이관** | §4.1 mirror + §4.1 6–9 철거 | 클러스터 0 |
| **E 봉인** | AGENTS 표·SETUP·이미지 번들 Garage 없음 | git 0 |
| **F 하드닝** | 백업·NOTICE·업그레이드 | — |

병행 canary(Phase “B 병행”) **폐기**. B = RustFS 단독 apply.

---

## 검증

```bash
bash deploy/scripts/check-object-store-content-ref.sh
```

PASS(Phase A) = 제품=RustFS · 본 문서에 **제거 인벤토리 · 단독 구성 · mirror 후 Garage 철거(소스 포함) · 어플라이언스** 요건 존재 · ROADMAP에 Garage 제거/RustFS 단독 결정 로그.
