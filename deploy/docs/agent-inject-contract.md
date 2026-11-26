# Agent 주입 계약 — 프롬프트 슬롯·토큰 예산 (M2)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #9 · **§6.3**.  
일정: [ROADMAP.md](../../ROADMAP.md) M2 (수치 고정) · M3 (`agent_invoke` 패킹 **구현**).  
전제: `aura.rpc.memory.recall` hybrid RRF ([`../services/memory/DESIGN.md`](../../services/memory/DESIGN.md)).

**이 문서 범위:** Agent가 recall 응답을 프롬프트에 넣는 **슬롯 분리·토큰 예산·금지 규칙**을 수치와 함께 고정.  
**Non-goals:** LLM Gateway 호출 · Object Store/`content_ref` 제품·GC · graph walk(M4) · tokenizer 제품 확정 · **온디맨드 memory tool**(유형 드릴·`item_id` 상세 — 턴 시작 inject와 별개; ARCHITECTURE §6.3 · ROADMAP 미결정).  
**패킹 구현:** M3 [`agent-invoke-mqt.md`](agent-invoke-mqt.md) · `services/agent-invoke` (`packRecallItems`, utf8/4 추정).

**갭:** inject = 요약 슬롯 패킹. Agent가 tool로 메모리를 더 깊게 보는 API는 아직 없다. 채울 때는 NATS recall/`memory.get`만 — 테넌트 MCP의 PG 직접 읽기 **금지**.

수치 출처: ARCHITECTURE §6.3 유형 예산 + recall 기본 `top_k=12` / short_term 슬롯 **4**. 운영 튜닝은 M3 부하 후 결정 로그 1행 + 이 문서·§6.3을 **같이** 고친다 — 여기서 새 숫자를 발명하지 않는다.

---

## 주입 소스 (정본)

| 규칙 | 내용 |
|------|------|
| 유일 소스 | **`aura.rpc.memory.recall` 응답 `items[]`만** 메모리 컨텍스트로 주입 |
| 순서 | 응답 배열 순서 유지(short_term 블록 앞 + hybrid RRF) |
| 추정기 | M2 계약 = `ceil(utf8_byte_length / 4)` ≈ tokens. M3는 제공자 tokenizer로 교체 가능(결정 로그) |

**금지 (원문 전량 덤프 · §1 #9)**

- `memory_items` / embeddings / audit에 Agent·`agent_invoke`가 **직접 SELECT**해 프롬프트에 붙이기
- `content_ref` Object Store 본문을 recall 우회해 프롬프트에 덤프
- 세션 전체 대화·capture candidates·NATS 이벤트 원문을 메모리 슬롯에 합치기
- 슬롯 예산을 초과한 항목을 다른 슬롯으로 **이월**(spill)하지 않음 — 버리면 됨

---

## 아이템 슬롯 (recall 정렬)

recall 기본과 동일. Agent는 이 상한을 넘긴 items를 추가로 요청·합성하지 않는다.

| 슬롯 | `memory_type` | 아이템 상한 (default) | 비고 |
|------|---------------|----------------------|------|
| short_term | `short_term` | **4** | HNSW 없음 · 최근순 · `min(4, top_k)` |
| episodic | `episodic` | hybrid 잔여 중 타입별 분리 | RRF 점수순 |
| long_term+semantic | `long_term`, `semantic` | hybrid 잔여 중 타입별 분리 | RRF 점수순 · 한 슬롯으로 합산 예산 |
| (전체) | — | `top_k` default **12** | short + hybrid ≤ 12 |

패킹 시 `items[]`를 `memory_type`으로 세 슬롯에 재분배한다. hybrid 혼합 순서는 보존하되 **토큰 절삭은 슬롯별**.

---

## 토큰 예산 (M2 고정 · 구현=M3)

한 턴 메모리 주입 **합계 상한**과 슬롯별 상한. 합 = 2048.

| 슬롯 | 토큰 상한 | 의미 |
|------|-----------|------|
| **합계** | **2048** | 시스템/유저/툴 프롬프트와 별도인 **메모리 블록만** |
| short_term | **512** | 세션 최근 · 우선 유지 |
| episodic | **768** | 사건·에피소드 |
| long_term+semantic | **768** | 장기 사실 + 의미 노드 요약 |

절삭 규칙:

1. 슬롯 내 앞에서부터(응답/RRF 순위) 누적 추정 토큰 ≤ 상한까지 포함.
2. 한 아이템이 슬롯 잔여보다 크면 **그 아이템만 truncate**(앞부분 유지) 후 슬롯 종료 — 다음 아이템으로 넘기지 않음.
3. 슬롯 합이 2048을 넘지 않게 이미 분해됨(512+768+768). 슬롯 미사용분은 **다른 슬롯에 재할당하지 않음**(M2 단순 계약).

---

## 프롬프트 골격 (M3 참고 · 비구속)

```
## Memory (recall)
### short_term
…
### episodic
…
### long_term+semantic
…
```

헤더·구분선 토큰도 해당 슬롯 예산에 포함한다.

---

## V2.3 매핑

ROADMAP M2 V2.3: *Agent 주입 슬롯·토큰 예산* → 이 문서 + ARCHITECTURE §6.3 수치.  
패킹 본구현=`services/agent-invoke` (`packRecallItems`) · 게이트 `check-agent-invoke.sh`.

---

## 관련 링크

- §1 #9 · §6.3 · recall DESIGN
- ROADMAP 결정 로그 (Agent 주입 계약 M2 고정)
- 정적 게이트: `bash deploy/scripts/check-agent-inject-contract.sh`
