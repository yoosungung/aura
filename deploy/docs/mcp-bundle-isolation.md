# 외부/커스텀 MCP·번들 격리 수준 (M3 / V3.3 정책)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #11 · #12 · #17 · **§9.1** · §9.4.  
일정: [ROADMAP.md](../../ROADMAP.md) M3 — **문서+정책 고정**.  
관련: [`mcp-streamable-http.md`](mcp-streamable-http.md) · [`mcp-invoke-dual.md`](mcp-invoke-dual.md) · [`../services/mcp-invoke/DESIGN.md`](../../services/mcp-invoke/DESIGN.md).

**이 문서 범위:** RuntimeClass 선택 · Egress **deny-default allowlist** · 플랫폼 서명 vs 커스텀 차등을 **수치·이름과 함께 고정**.  
**Non-goals:** F1 테넌트 샤딩 · Streamable HTTP initialize 세션 서버 · gVisor `runsc` **노드 설치**. (NATS mTLS → [`nats-mtls-secrets.md`](nats-mtls-secrets.md).)  
LLM Gateway 최소: [`llm-gateway.md`](llm-gateway.md). Egress **매니페스트·오프라인 검증**: [`egress-block-verify.md`](egress-block-verify.md) · `check-egress-block-verify.sh` (live 클러스터는 Non-goal for CI PASS).

---

## 신뢰 경계

| 등급 | 정의 | 실행 |
|------|------|------|
| **플랫폼 서명** | Aura가 빌드·서명·checksum 한 agent/mcp 번들 | factory 로드 허용. **Egress NP는 동일 적용**. RuntimeClass=`gvisor`(기본) 또는 내부 trusted 노드풀(DESIGN 예외만) |
| **커스텀 / 외부** | 테넌트가 올린 번들 · 미서명 · 외부 Streamable HTTP MCP를 호출하는 어댑터 파드 | **비신뢰**. RuntimeClass **필수** (`gvisor` 기본; 고위험=`kata`). 샌드박스 없이 로드 **금지** |
| **플랫폼 컨트롤 플레인** | Gateway · Pooler · NATS · `svc-control` HTTP · LLM Gateway | 샌드박스 대상 아님. 테넌트 코드와 동일 파드에 섞지 않음 |

미서명 커스텀을 `runc` 기본 RuntimeClass로 돌리는 경로는 **계약 위반**.

---

## RuntimeClass (M3 고정)

| 티어 | RuntimeClass 이름 | handler | 적용 |
|------|-------------------|---------|------|
| **기본 (M3)** | `gvisor` | `runsc` | 커스텀/미서명 번들 · 외부 MCP를 호출하는 `mcp_invoke` Function · short-lived agent tool 샌드박스 |
| **고위험** | `kata` | Kata (`kata-qemu` 또는 동등; 클러스터 설치 시 DESIGN에 handler 고정) | 장기·적대적·고위험 테넌트/번들 · 전용 노드풀(§9.1 격리 강화 · M5) |
| **금지** | (default `runc`) | `runc` | 커스텀/미서명 테넌트 코드 |

**선택 근거 (결정 로그):** Fission/KEDA scale-to-zero·콜드 민감 → **gVisor(`runsc`)** 를 M3 기본. Kata는 하드웨어 격리 티어로 유지(고위험·M5). 동등 런타임 교체 시 이 문서·§9.1·결정 로그를 **같이** 고친다.

RuntimeClass 매니페스트: [`../k8s/sandbox-egress/`](../k8s/sandbox-egress/). 파드에 `runtimeClassName` 부착·노드 handler 설치는 클러스터 적용 시.

---

## Egress NetworkPolicy — deny-default allowlist

모든 테넌트 코드 파드(플랫폼 서명 포함)에 **Egress deny-default**를 건다. 허용은 아래만.

| # | 대상 | 목적 | 비고 |
|---|------|------|------|
| 1 | **NATS** (클러스터 내 Service) | `aura.tasks.*` / `aura.rpc.*` / `aura.stream.*` / KV | §1 #1 단일 백본 |
| 2 | **CloudNativePG Pooler** VIP | 체크포인트 등 허용된 PG만 (§1 #10 예외) | 앱→PG 직접 금지 |
| 3 | **LLM Gateway** (클러스터 내) | 모델 호출 유일 출구 (§9.4) | Function→공급자 API **직접 금지** |
| 4 | **Object Store** (`aura-content` Garage/S3 endpoint) | `content_ref` / 번들 아티팩트 | Barman `aura-pg`는 메모리 워커 전용 — 테넌트 샌드박스 allowlist에 **넣지 않음** |
| 5 | **허용 MCP 호스트** | resolve `cfg.mcp_endpoint` / 테넌트 allowlist에 **등록된** HTTPS 호스트만 | Streamable HTTP 경계([`mcp-streamable-http.md`](mcp-streamable-http.md)). 미등록 호스트 = 차단 |
| 6 | DNS (클러스터 DNS) | 이름 해석 | kube-dns/CoreDNS만 |

**금지 예:** 임의 인터넷 · 메타데이터 엔드포인트 · 타 테넌트 Service · PG primary 직접 · 공급자 LLM URL · 미등록 MCP.

Ingress는 본 정책 범위 밖(내부 NATS/Gateway만 호출). NetworkPolicy YAML: [`deploy/k8s/sandbox-egress/`](../k8s/sandbox-egress/) · 검증: [`egress-block-verify.md`](egress-block-verify.md).

---

## 플랫폼 서명 vs 커스텀 차등

| 항목 | 플랫폼 서명 | 커스텀 / 미서명 |
|------|-------------|-----------------|
| 게시 | `svc-control` + 서명·checksum 검증 필수 | 테넌트 업로드; checksum만으로는 신뢰 승격 **불가** |
| RuntimeClass | `gvisor` 기본(내부 trusted 예외는 DESIGN+결정 로그) | **`gvisor` 필수**; 고위험=`kata` |
| Egress NP | **동일 deny-default allowlist** | 동일 (+ MCP 호스트는 테넌트 allowlist 교집합) |
| secrets | `secrets_ref` only · plaintext 금지 | 동일 |
| 로드 실패 | 서명/checksum 불일치 → resolve/invoke 거부 | 샌드박스 RuntimeClass 미지정 → **거부** |

플랫폼 서명은 Egress를 완화하지 않는다 — «서명됐으니 인터넷 OK» 금지.

---

## V3.3 매핑

ROADMAP M3 V3.3: *커스텀/외부 MCP Egress·샌드박스* → **이 문서(정책)** + [`egress-block-verify.md`](egress-block-verify.md) 스모크 증거.  
본 슬라이스 합격 = 정책 문서 + `check-mcp-bundle-isolation.sh` PASS + 결정 로그(gVisor 기본).

---

## Commands

```bash
bash deploy/scripts/check-mcp-bundle-isolation.sh
bash deploy/scripts/check-egress-block-verify.sh
```
