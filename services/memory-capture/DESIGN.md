# memory_capture (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #10 · §2 · §3.2 · §5 · §8 · §9.4.  
일정: [ROADMAP.md](../../ROADMAP.md) M2 (첫 항목).  
`svc-memory` store와 **별 컴포넌트** — PG 읽기·쓰기 금지.

**이 문서 범위:** Fission MQT(`aura.tasks.memory.capture`) → HTTP 2xx 본문이 MQT `respTopic`으로 `aura.events.memory.candidates` 발행.  
**Non-goals (본 슬라이스):** 라이브 LLM Gateway 호출(§9.4는 M3 게이트웨이 도입 시) · Object Store/`content_ref` 업로드(V2.1) · store/embed/recall · live 클러스터 apply 필수(정적 게이트만).

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | 턴 텍스트 → 메모리 **후보** envelope (§5: 기본 `short_term`/`episodic` 태깅) |
| 실행 계급 | **async** MQT · `minReplicaCount=0` |
| PG | **금지** — `pg` 드라이버·`query`·`set_config`·Pooler DSN 미사용 |
| LLM | 생산 경로 = LLM Gateway만(§9.4). M2 스켈레톤은 **주입 가능 extractor**(기본=결정적 휴리스틱); Gateway HTTP는 Non-goal |
| 금지 | `memory_*` 테이블 접근 · NATS 외 SoR에 후보 적재 |

---

## Capture MQT (§3.2)

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.memory.capture` |
| consumer | `aura_memory_capture` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.memory.candidates` |
| errorTopic | `aura.events.memory.capture.error` |
| mqtype / kind | `nats-jetstream` / `keda` |
| 매니페스트 | [`deploy/k8s/memory-capture/`](../../deploy/k8s/memory-capture/) |

입력: §8 envelope (`id` 멱등 키 · `tenant_id` · `payload`에 `text` 또는 `messages`).  
성공 응답 본문: `type: memory.candidates` · `payload.candidates[]` (`memory_type` ∈ `short_term`|`episodic`, `content`).  
실패(비-2xx) → MQT 재시도 후 `errorTopic`.

---

## Commands

```bash
bash deploy/scripts/check-memory-capture.sh   # DESIGN + MQT + PG-금지 selftest (no cluster)
node services/memory-capture/handler.selftest.js
```

---

## 관련 링크

- §3.2 capture subject · §5 파이프라인 1–2 · store 입력은 [`services/memory/DESIGN.md`](../memory/DESIGN.md)
