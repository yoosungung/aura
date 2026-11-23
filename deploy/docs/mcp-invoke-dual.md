# `mcp_invoke` 이원화 — task(MQT) + rpc(`aura.rpc.mcp.tool`) (M3)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · #10–#12 · §3.2 · §3.3 · §4 · §7 · §8.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.  
내부: [`../../services/mcp-invoke/DESIGN.md`](../../services/mcp-invoke/DESIGN.md).  
요청자(agent): [`agent-invoke-mqt.md`](agent-invoke-mqt.md) · resolve: [`svc-control-resolve.md`](svc-control-resolve.md).

**이 문서 범위:** 태스크/RPC payload · done/error envelope · MQT·sync 이름표 · **분리 배포** 불변.  
**Non-goals:** RuntimeClass/Egress **라이브 실측** · live LLM · F1 · python/rust env · 서비스별 `*-rr`/`rpc-worker.js`.  
**M3.5:** archive 패키징 · `tools/list`([`mcp-tools-list.md`](mcp-tools-list.md)) · sync는 공용 [`nats-rpc-bridge`](../../services/nats-rpc-bridge/DESIGN.md).  
격리 정책: [`mcp-bundle-isolation.md`](mcp-bundle-isolation.md).  
외부 Streamable HTTP: [`mcp-streamable-http.md`](mcp-streamable-http.md). (resolve: [`control-resolve-bridge.md`](control-resolve-bridge.md))

---

## 왜 이원화 (§1 #2 · §4)

| 계급 | Subject | 스케일 | 이유 |
|------|---------|--------|------|
| **async** MQT | `aura.tasks.mcp.invoke` | `minReplicaCount=0` | JetStream lag로 깨움 · idle scale-to-zero |
| **sync** Core RR | `aura.rpc.mcp.tool` | 공용 브리지 ≥2 + sync poolmgr | Core RR은 lag가 없어 0→1 불가 → No Responders |

동일 Deployment에 0과 Warm을 섞지 않는다. 매니페스트·ScaledObject를 **별 디렉터리**로 둔다.

| 경로 | 매니페스트 |
|------|-----------|
| async | [`../k8s/mcp-invoke/`](../k8s/mcp-invoke/) |
| sync | [`../k8s/mcp-invoke-rpc/`](../k8s/mcp-invoke-rpc/) |

---

## Async MQT 이름표 (§3.2)

| 필드 | 값 |
|------|-----|
| topic | `aura.tasks.mcp.invoke` |
| consumer | `aura_mcp_invoke` |
| stream | `AURA_TASKS` |
| respTopic | `aura.events.mcp.invoke.done` |
| errorTopic | `aura.events.mcp.invoke.error` |
| scale | `minReplicaCount=0` |

---

## Sync RPC 이름표 (§3.3)

| 필드 | 값 |
|------|-----|
| subject | `aura.rpc.mcp.tool` |
| NATS | `aura-nats-rpc-bridge` · queue `aura-rpc-bridge` · **replicas ≥ 2** |
| Function | `aura-mcp-invoke-rpc` · **poolmgr** · `aura-nodejs-sync` (`poolsize ≥ 2`) |
| 금지 | MessageQueueTrigger · JetStream lag ScaledObject |

---

## Payload (§7)

식별자만. `bundle` / `cfg` / `secrets` plaintext 금지.

```json
{
  "server": "demo-mcp",
  "version": "1.0.0",
  "tool": "echo",
  "arguments": { "x": 1 },
  "principal": { "id": "…", "tenant_id": "…" }
}
```

| 규칙 | 내용 |
|------|------|
| `principal.tenant_id` | 필수 — resolve·감사 테넌트 키 |
| resolve | injectable `aura.rpc.control.resolve` (kind=`mcp`) → `cfg` + `secrets_ref` only |
| factory | `(cfg, secrets_ref)` — stub 또는 Streamable HTTP ([`mcp-streamable-http.md`](mcp-streamable-http.md)) |
| 선택 `id` | async 멱등/이벤트 `id` (없으면 핸들러 생성) |

---

## Done envelopes (§8)

**Async** (`respTopic`):

```json
{
  "id": "<uuidv7>",
  "type": "mcp.invoke.done",
  "tenant_id": "…",
  "occurred_at": "…",
  "payload": {
    "server": "demo-mcp",
    "version": "1.0.0",
    "tool": "echo",
    "result": {}
  },
  "content_ref": null
}
```

실패 → 비-2xx → `errorTopic` (`type: mcp.invoke.error`).

**Sync** (Core reply):

```json
{
  "type": "mcp.tool.done",
  "ok": true,
  "server": "demo-mcp",
  "version": "1.0.0",
  "tool": "echo",
  "result": {},
  "subject": "aura.rpc.mcp.tool"
}
```

실패 → `type: mcp.tool.error` · `ok: false`.

---

## 코드·cfg 갈래 (§1 #12)

브리지 → Fission Function까지 온 뒤 handler가 고른다. Router는 외부 MCP URL을 호출하지 않는다.

| 갈래 | 조건 | 에러 |
|------|------|------|
| 제3자 HTTP | `cfg.mcp_endpoint` 또는 `transport=streamable_http` | 엔드포인트 없으면 `mcp_endpoint_required` |
| 서명 번들 | `entrypoint`=`module.path:attr` · `sig_uri` · checksum · 기본 `loadBundle`=Pod LRU→`GetObject` | `bundle_untrusted` · `bundle_checksum_mismatch` · `bundle_missing` |
| 없음 | 위가 아니고 주입된 list/call도 없음 | `mcp_backend_missing` |

절차는 [`../../services/mcp-invoke/DESIGN.md`](../../services/mcp-invoke/DESIGN.md). 바이트 리더·캐시는 [`../../services/object-store/DESIGN.md`](../../services/object-store/DESIGN.md). `factory(cfg, secrets_ref)`만 호출한다.

---

## 검증

```bash
./deploy/scripts/check-mcp-invoke.sh
node services/mcp-invoke/handler.selftest.js
```
