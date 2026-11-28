# mcp_invoke (내부 설계)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · #10 · #11 · #12 · §3.2 · §3.3 · §4 · §7 · §8.  
일정: [ROADMAP.md](../../ROADMAP.md) **M3.5–M3.6**.  
와이어: [`deploy/docs/mcp-invoke-dual.md`](../../deploy/docs/mcp-invoke-dual.md) · [`deploy/docs/multi-env-followup.md`](../../deploy/docs/multi-env-followup.md).  
패키징: [`deploy/docs/fission-node-archive.md`](../../deploy/docs/fission-node-archive.md) · [`deploy/docs/fission-python-archive.md`](../../deploy/docs/fission-python-archive.md).

**이 문서 범위:** `nodejs/`/`python/` · action=`list`\|`call` · task-bridge async · rpc-bridge sync · runtime 매핑.  
**Non-goals:** custom-env · full MCP initialize 서버 · CNI FQDN 라이브.

---

## 경계

| 항목 | 값 |
|------|-----|
| 역할 | MCP list/call: resolve → factory / Streamable HTTP |
| async | `aura.tasks.mcp.invoke` → `aura.events.mcp.invoke.done` / `aura.events.mcp.invoke.error` · **task-bridge** (MQT 폐기) |
| sync | `aura.rpc.mcp.tool` · **nats-rpc-bridge** → runtime→`aura-mcp-invoke-rpc` \| `-py` · **poolmgr** Warm (`aura-*-sync` poolsize ≥ 2) |
| Functions | nodejs: `aura-mcp-invoke` / `aura-mcp-invoke-rpc` · python: `*-py` |
| 패키징 | archive · `nodejs/` + `python/` |
| PG | **금지** |

---

## 레이아웃

| 경로 | 역할 |
|------|------|
| `DESIGN.md` | 공통 계약 |
| `nodejs/` | handler · streamable-http · factory |
| `python/` | 패리티 handler · pytest |
| `testdata/` | 공유 JSON (`mcp_identifiers_only` · `mcp_bundle`) |

Streamable HTTP: [`deploy/docs/mcp-streamable-http.md`](../../deploy/docs/mcp-streamable-http.md) · `nodejs/streamable-http.js`.

---

## 코드·cfg 갈래

resolve 한 번에 `source`(`entrypoint`·`bundle_uri`·`checksum`·`sig_uri`)와 `cfg`가 온다. 브리지와 Fission Router는 Function 이름만 고른다. 외부 URL은 Function 안에서만 연다.

| 순서 | 조건 | 결과 |
|------|------|------|
| 1 | `cfg.mcp_endpoint` 또는 `transport=streamable_http` | JSON-RPC `tools/list`·`tools/call`. 제3자 서버 |
| 2 | `entrypoint`가 `module.path:attr` | `sig_uri` 없음 → `bundle_untrusted`. checksum 불일치 → `bundle_checksum_mismatch`. 맞으면 `factory(cfg, secrets_ref)`의 `listTools`/`runTool` |
| 3 | 테스트가 `listTools`/`runTool`을 주입 | 그 함수 |
| 4 | 그 외 | `mcp_backend_missing` |

기본 `loadBundle`은 [`services/object-store/DESIGN.md`](../object-store/DESIGN.md)의 Pod LRU다. 미스가 `aura-content` `GetObject`다. 테스트가 `loadBundle`을 넘기면 캐시와 GetObject를 타지 않는다. sha256 대조는 `sha256:` + hex이며 activate와 같다. 커스텀 이미지 빌드·gVisor 설치·서명 알고리즘 검증은 하지 않는다. 미서명 서버는 `runtime=custom`으로 남는다.

---

## Commands

```bash
bash deploy/scripts/check-mcp-invoke-dual.sh
bash deploy/scripts/check-mcp-streamable-http.sh
bash deploy/scripts/check-python-env-parity.sh
bash deploy/scripts/build-mcp-invoke-archive.sh
bash deploy/scripts/build-mcp-invoke-python-archive.sh
node services/mcp-invoke/nodejs/handler.selftest.js
node services/mcp-invoke/nodejs/streamable-http.selftest.js
cargo test -p aura-mcp-invoke-orch   # Phase 5 orch · dual async/rpc · PG 금지
```
