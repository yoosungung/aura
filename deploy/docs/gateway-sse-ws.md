# Gateway · `run_id` 발급 · SSE/WS 브리지 · principal 인가 (M3)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #1 · #13 · §2 · §3.5 · §7.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.  
내부: [`../../services/gateway/DESIGN.md`](../../services/gateway/DESIGN.md).  
프레임 업스트림: [`agent-invoke-mqt.md`](agent-invoke-mqt.md).

**이 문서 범위:** 제출 wire · `run_id`(UUIDv7) · 스트림 subject · SSE/WS 인가 · 브리지 규칙.  
**Non-goals:** Fair Queue / Token Bucket / max_inflight · NATS KV · live NATS SDK 배선 · live LLM Gateway · `mcp_invoke` 이원화. (resolve 브리지: [`control-resolve-bridge.md`](control-resolve-bridge.md))  
lab E2E (in-cluster DNS · authorize+202): [`gateway-agent-invoke-e2e.md`](gateway-agent-invoke-e2e.md) · `smoke-gateway-agent-invoke.sh`.

---

## 제출 (`POST /v1/agent/invoke`)

클라이언트가 Gateway에만 제출한다. Gateway가 `run_id`를 발급하고 JetStream 태스크를 publish한다.

요청 (identifiers only):

```json
{
  "agent": "demo",
  "version": "1.0.0",
  "input": { "text": "…" },
  "session_id": "…",
  "stream": true
}
```

| 규칙 | 내용 |
|------|------|
| `run_id` | Gateway가 **UUIDv7**로 발급. 클라이언트가 넣지 않음 |
| `principal` | 세션/토큰에서 추출 → 태스크 envelope에 실음 |
| `stream` | 기본 `true`. 대화형 경로 필수(§1 #13) |
| 금지 | `bundle` / `cfg` / `secrets` plaintext (§1 #11) |

응답 **202**:

```json
{
  "run_id": "<uuidv7>",
  "stream": true,
  "stream_subject": "aura.stream.<run_id>",
  "agent": "demo",
  "version": "1.0.0"
}
```

publish subject: **`aura.tasks.agent.invoke`** (MQT; 페이로드는 [`agent-invoke-mqt.md`](agent-invoke-mqt.md) §7).

---

## 스트림 브리지

| 채널 | 경로 | Content-Type / 프로토콜 |
|------|------|-------------------------|
| SSE | `GET /v1/runs/:run_id/events` | `text/event-stream` — `data: <frame-json>\n\n` |
| WebSocket | `GET /v1/runs/:run_id/ws` | 프레임 JSON 텍스트 메시지 |

NATS 구독: **exact** `aura.stream.<run_id>` 만. `aura.stream.*` / `>` 와일드카드 **금지**(§3.5).

프레임 `type` (중계만 — 생성은 `agent_invoke`):

| `type` | 비고 |
|--------|------|
| `run.started` | |
| `token` | V3.1: done/`run.completed` **이전** |
| `tool.started` / `tool.finished` | |
| `error` | UX 힌트; 정본은 events |
| `run.completed` | 스트림 종료 신호; **내구 완료는** `aura.events.agent.invoke.done` |

재연결 시 Gateway는 버퍼·replay를 **보장하지 않는다**(Core 유실 허용).

---

## Principal 인가

1. 제출 시 `run_id` → `{ principal_id, tenant_id }` 레지스트리 기록.
2. SSE/WS 연결 시 동일 principal만 허용.
3. 불일치 → **403** `principal_forbidden` (또는 tenant mismatch).
4. 미등록 `run_id` → **404** `run_not_found`.
5. 미인증 → **401**.

본 슬라이스 레지스트리는 Gateway 프로세스 로컬이다. 레플리카 공유(NATS KV) · Fair Queue는 후속 티켓.

---

## 배포

| 항목 | 값 |
|------|-----|
| 매니페스트 | [`../k8s/gateway/`](../k8s/gateway/) |
| replicas | **≥ 2** |
| MQT / ScaledObject | **없음** (Gateway ≠ Fission MQT) |
| PG | **없음** |
