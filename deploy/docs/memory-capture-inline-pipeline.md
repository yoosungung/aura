# Memory capture inline pipeline — 통합 계획

계약 현행: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #9 · §3.2 · §5 · [MESSAGE-FLOW.md](../../MESSAGE-FLOW.md) §5.  
현황 스냅샷: capture/store/embed가 **별도** JetStream Deployment · subject 왕복 · agent→capture publish·candidates→store 배선 **미완** · store/embed PG 쓰기는 스텁.

**이 문서 범위:** capture **한 프로세스** 안에서 순차 실행(후보 추출 → 임베딩 → PG 저장)으로 통합하는 **계획만**.  
**Non-goals:** 본 문서에서 코드·매니페스트 변경 · consolidate/ttl/archive/object_gc **본구현** · recall RPC 변경 · compliance.erase.  
배치 스케줄·이미지는 교차 참조만: [`memory-batch-cronjobs.md`](memory-batch-cronjobs.md).

사용자 방향(채택):

- 캡처가 **플로우 오케스트레이터** (함수/모듈 조합)
- **store만 DB 쓰기** 담당 (라이브러리·모듈로 호출; NATS 중간 hop 없음)
- **한 프로세스 순차** — JetStream으로 capture↔store↔embed 왕복하지 않음
- **이미지 분리** — 캡처 이미지에는 **capture만**; consolidate/TTL/archive/object_gc는 **전용 배치 이미지** + **K8s CronJob**([`memory-batch-cronjobs.md`](memory-batch-cronjobs.md))

---

## 1. 목표 런타임 모양

```
publisher (agent_invoke 후속 / 수동 nats pub)
    │  JetStream 1회
    ▼
aura.tasks.memory.capture
    │
aura-memory-capture Deployment (replicas=1 · 로컬)
    │  in-process:
    │  1) extract candidates     (memory-capture)
    │  2) embed (Gateway HTTP)   (memory/embed 모듈 · short_term 스킵)
    │  3) store → Pooler/PG      (memory/store 모듈 · 유일 쓰기)
    ▼
aura.events.memory.capture.done  (또는 기존 candidates+stored+embedded 요약 이벤트 — §3)
```

| 유지 (별도 Deployment) | 비고 |
|------------------------|------|
| `aura-memory-recall` | sync RPC · replicas=1 |
| consolidate / ttl / archive / object_gc | 배치 계급 · **캡처와 다른 `aura/memory-batch` 이미지** · UTC 일 1회 **CronJob** publish · replicas=1 · 상세 [`memory-batch-cronjobs.md`](memory-batch-cronjobs.md) |
| compliance-erase | 별도 이미지·파드 유지 |

| 축소·폐기 후보 | 비고 |
|----------------|------|
| `aura-memory-store` Deployment | in-process store 모듈로 흡수 후 JetStream consumer 퇴역 |
| `aura-memory-embed` Deployment | 동상 |

**외부 JetStream 입력은 `aura.tasks.memory.capture` 하나**만 남기는 것이 목표.  
`aura.tasks.memory.store` / `aura.tasks.memory.embed`는 **퇴역**(또는 임시 dual-run 후 삭제).

---

## 2. 결정 항목 (채택)

### (1) store — DB 쓰기만 분리 유지 (**채택: 모듈 분리 · Deployment 병합**)

| 옵션 | 내용 | 판정 |
|------|------|------|
| A. store Deployment 유지 + capture가 NATS로 store 호출 | 중간 왕복 남음 | **비채택** |
| B. store를 capture 프로세스 **라이브러리**로 호출 (`storeOnce` / 실 INSERT) · **유일 PG 쓰기 경계는 store 모듈** | NATS hop 없음 · §1 #5 쓰기 소유 문구는 “store 모듈”로 재서술 | **채택** |
| C. capture 파일에 SQL 인라인 | 쓰기 경계 붕괴 | **금지** |

결과:

- 코드: `services/memory` store handlers (실 DDL INSERT 후속)
- 배포: `deploy/k8s/memory-store/` Deployment는 Phase 완료 후 **제거**
- capture Deployment 이미지 = **`aura/memory-capture`** (store(+embed client) 포함) · **배치 네 핸들러는 포함하지 않음** (`aura/memory-batch`)

### (2) embed — llm-gateway 호출 (**채택: 프로세스 내 동기 HTTP**)

| 옵션 | 내용 | 판정 |
|------|------|------|
| 동기 `await` Gateway `/v1/embeddings` | 순차 보장 · 실패 시 태스크 NAK/errorTopic · 재시도=JetStream MaxDeliver | **채택** (캡처 플로우 안) |
| embed만 다시 JetStream | 중간 NATS 왕복 · 사용자 방향과 충돌 | **비채택** |
| store 성공 후 fire-and-forget | 순서(추출→임베딩→PG)와 불일치 · orphan 임베딩 위험 | **비채택** |

순서 고정: **extract → embed(해당 타입만) → store(벡터 포함 UPSERT 가능)**.  
`short_term`은 현 계약대로 **embed 스킵** 후 store만.

타임아웃: Gateway/ captur AckWait와 맞춤(현 워커 ack_wait·에이전트 체감과 ROADMAP 콜드 SLA 별개). 실패 시 부분 store 금지(트랜잭션 또는 all-or-nothing 정책은 구현 DESIGN에 수치 기입).

### (3) 계약 문서 정리 범위

구현 착수 시 **코드와 함께** 갱신 (본 계획만으로 ARCHITECTURE §1을 미리 바꾸지 않음 — 착수 PR에서 일괄).

| 문서 | 변경 요지 |
|------|-----------|
| `ARCHITECTURE.md` §1 #9 · §3.2 · §5 파이프라인 | capture 단일 태스크 · in-process store/embed · store/embed subject 퇴역 |
| `ARCHITECTURE.md` §3.2 표 | `aura.tasks.memory.store` / `.embed` 행 삭제 또는 deprecated |
| `MESSAGE-FLOW.md` §5 | 다이어그램을 in-process 순차로 교체 · “후보 관찰 후 store” 노트 삭제 |
| `services/memory/DESIGN.md` | Capture Deployment 절 · PG 쓰기는 store 모듈 경유 |
| `services/memory/DESIGN.md` | store/embed = 모듈(+선택 CLI) · 단독 Deployment Non-goal |
| `deploy/docs/memory-control-hardcode.md` | store/embed Deployment 축소 |
| `AGENTS.md` 표 | memory-store/embed k8s 행 갱신 |
| `ROADMAP.md` | 본 계획 체크박스 · M2 쓰기 본구현과 연계 |
| check 스크립트 | store/embed MQT/Deployment 게이트 → capture 통합 게이트 |

**이벤트:**

- 최소: `aura.events.memory.capture.done` (candidates+store+embed 요약) + `aura.events.memory.capture.error`
- 호환이 필요하면 당분간 `candidates` / `stored` / `embedded`를 **같은 프로세스에서 연속 publish**(외부 구독자용) 후 폐기 — dual-run 절 §5

### (4) 롤백

1. **이미지/Deployment:** 이전 캡처/배치 이미지 + 분리 store/embed Deployment 매니페스트 재 apply  
2. **JetStream:** `aura_memory_store` / `aura_memory_embed` durable이 삭제됐으면 ensure 스크립트로 pull consumer 재생성  
3. **문서:** git revert로 ARCHITECTURE/MESSAGE-FLOW 복구  
4. **데이터:** in-process 실패는 미커밋 전제 → 부분 행이 생겼다면 tenant 단위 수동 정리(본구현 INSERT 이후 runbook에 한 줄)

로컬 랩이므로 롤백 우선순위는 **매니페스트+이미지** > 스트림 durable.

### (5) 단계별 전환 순서

| Phase | 내용 | 검증 |
|-------|------|------|
| **P0** | 본 계획 문서 고정 · ROADMAP 항목 · ARCHITECTURE 미변경 | 리뷰 |
| **P1** | capture 핸들러가 **in-process `storeOnce`** 호출 (실 INSERT 또는 기존 stub) · **아직 별도 embed Deployment 유지 가능**하나 capture→store **NATS 제거** | `check-memory-capture` 확장 · 수동 `nats pub` capture → PG/stub |
| **P2** | capture 안에 **동기 embed** 삽입 · short_term 스킵 · Gateway 가드 재사용 | embed selftest + capture 통합 selftest |
| **P3** | `aura-memory-store` / `aura-memory-embed` Deployment 스케일 0→삭제 · subject 표 deprecate · apply-product/prune | 클러스터에 store/embed deploy 없음 |
| **P4** | agent_invoke 턴 종료 → `aura.tasks.memory.capture` publish 배선 | E2E 스모크 1건 |
| **P5** | ARCHITECTURE §5 · MESSAGE-FLOW §5 · DESIGN 일괄 갱신 · 호환 이벤트 정리 | 문서 게이트 |

권장 순서 요약: **store 흡수(P1) → embed 동기 편입(P2) → 단독 Deployment 제거(P3) → agent 발행(P4) → 계약 문서 확정(P5)**.

---

## 3. 로컬 Kubernetes 리플리카 정책 (**제약**)

이 클러스터는 **로컬 개발용**이다.

| 규칙 | 내용 |
|------|------|
| 기본 | 로컬 aura Deployment는 **`replicas: 1` 고정** (memory/compliance · recall · 플랫폼 포함) |
| 금지 | 로컬에서 replicas>1 임의 상향 |

통합 후 `aura-memory-capture` · `aura-memory-recall` 모두 **replicas: 1**.

---

## 4. 배포·이미지 (로컬)

| 이미지 | 역할 |
|--------|------|
| **`aura/memory-capture`** | **capture만** + inline store/embed 모듈 + llm-gateway client · 배치 핸들러 **제외** |
| **`aura/memory-recall`** | recall sync RPC · replicas=1 |
| **`aura/memory-batch`** | consolidate · ttl · archive · object_gc 핸들러 + CronJob publish 엔트리 · 캡처 **비포함** |
| `aura/compliance-erase` | 변경 없음 · replicas=1 |

빌드: **`aura/memory-capture`** / **`aura/memory-recall`** / **`aura/memory-batch`** 타깃 분리. CronJob·배치 Deployment는 **`aura/memory-batch`만** — [`memory-batch-cronjobs.md`](memory-batch-cronjobs.md).

---

## 5. 위험·완화

| 위험 | 완화 |
|------|------|
| capture 파드가 Pooler·Gateway 의존 → 실패 면 확대 | 타임아웃·에러 Topic · 재시도 멱등 키(`envelope.id`) |
| §1 “capture PG 금지”와 충돌 | 착수 시 계약을 “capture **오케스트레이션**; PG는 **store 모듈만**”으로 개정 |
| 긴 embed RTT가 JetStream ack를 넘김 | AckWait/working 연장 또는 청크 배치 상한 DESIGN에 수치 |
| store/embed 단독 subject 외부 의존 | dual-run 기간 이벤트 호환 publish 후 폐기 |

---

## 6. 성공 기준

- [x] 단일 capture 태스크로 extract + embed + store 경로 (selftest)
- [x] capture→store/embed **NATS 요청 없음** (in-process 모듈)
- [x] 로컬 `aura-memory-capture` · `aura-memory-recall` **replicas=1**
- [x] 이미지 `aura/memory-capture` ≠ `aura/memory-batch`
- [x] store/embed 단독 Deployment 제거 (`apply-product` · k8s yaml)
- [x] ARCHITECTURE §3.2·§5 갱신 · agent publishCapture
- [x] `check-memory-capture.sh` · store/embed retirement checks

---

## 관련 경로

- `services/memory/src/capture.rs` · `services/memory/` · `crates/aura-js-worker`
- `deploy/k8s/memory-capture/` · `memory-recall/` · `memory-{consolidate,ttl,archive,object-gc}/`
- 배치 CronJob·이미지: [`memory-batch-cronjobs.md`](memory-batch-cronjobs.md)
