# `agent_checkpoints` 예외 테이블 DDL (M3 · Zero Direct Write)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #10 · §2.1 · §6.1 · §7 · §8.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 DDL · **M3.5 writer/resume**.  
DDL: [`../sql/agent_checkpoints.sql`](../sql/agent_checkpoints.sql).  
내부: [`../../services/agent-invoke/DESIGN.md`](../../services/agent-invoke/DESIGN.md) · [`../../services/agent-invoke/checkpoints.js`](../../services/agent-invoke/checkpoints.js).

**이 문서 범위:** `agent_checkpoints` **테이블·인덱스·RLS** · 쓰기 소유 · `state`/`content_ref` · **Pooler writer/resume**.  
**Non-goals:** TTL/partition GC · JetStream replay 소스 · `memory_*` 접근.

---

## Zero Direct Write 예외

| 항목 | 규칙 |
|------|------|
| 기본 | Function·Gateway·`svc-memory` 등은 PG **직접 쓰기 금지** (§1 #10) |
| 예외 테이블 | **`agent_checkpoints`만** — **`agent_invoke`만** INSERT (append-only 스냅샷) |
| 연결 | **Pooler(transaction)** + `set_config('app.tenant_id', $1, true)` — 세션 GUC만 허용 |
| RLS | `ENABLE` + **`FORCE ROW LEVEL SECURITY`** · `tenant_id::text = current_setting('app.tenant_id', true)` |
| MQT | 본 테이블에 대한 MQT/Fission 핸들러 **없음** (DDL·게이트만) |

다른 서비스·관리 경로가 `agent_checkpoints`에 쓰면 계약 위반이다.

---

## DDL 요약 (`agent_checkpoints.sql`)

| 컬럼 | 타입 | 규칙 |
|------|------|------|
| `id` | UUID PK | `gen_random_uuid()` |
| `tenant_id` | UUID NOT NULL | RLS 키 |
| `run_id` | TEXT NOT NULL | Gateway UUIDv7 문자열 (§7) |
| `session_id` | TEXT NOT NULL | 대화 스코프 |
| `principal_id` | TEXT NOT NULL | invoke 주체 |
| `seq` | BIGINT NOT NULL | `(tenant_id, run_id)` 내 단조 증가 |
| `parent_id` | UUID NULL | 동일 run 내 이전 체크포인트(선택 lineage) |
| `kind` | TEXT | `'turn'` \| `'tool'` \| `'final'` |
| `state_schema_version` | INTEGER | 기본 `1` |
| `state` | JSONB | **작은** 재개 스냅샷 — **plaintext 시크릿·API 키 금지** (`secrets_ref` 패턴만) |
| `content_ref` | TEXT NULL | **256KB** 초과·PII·대형 transcript → Object Store (§8); PG `state`에 덤프 금지 |
| `created_at` | TIMESTAMPTZ | append-only 타임스탬프 |

UNIQUE `(tenant_id, run_id, seq)`. 인덱스: `(tenant_id, run_id, seq DESC)`, `(tenant_id, session_id, created_at DESC)`.

`state`는 재개에 필요한 최소 메타만 둔다. 토큰 전문·번들·`user_meta` 시크릿 값·로그인 자격 증명은 **`content_ref`** 또는 외부 시크릿 스토어만 허용한다.

---

## 읽기 (후속)

resume/load SELECT도 동일 Pooler + `set_config(..., true)` · FORCE RLS 전제. 본 슬라이스는 DDL·정적 게이트만 고정한다.

---

## 검증

```bash
bash deploy/scripts/check-agent-checkpoints.sh   # DDL + doc + cross-links (no cluster)
```

Related: [`agent-invoke-mqt.md`](agent-invoke-mqt.md) · [`object-store-content-ref.md`](object-store-content-ref.md).