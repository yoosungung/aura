# Egress 차단 검증 (V3.3 스모크)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §9.1 · 정책 정본: [`mcp-bundle-isolation.md`](mcp-bundle-isolation.md).  
매니페스트: [`deploy/k8s/sandbox-egress/`](../k8s/sandbox-egress/).

**범위:** 샌드박스 파드(`aura.swfactory.io/sandbox: "true"`)가 **허용 피어만** Egress 할 수 있음을 **오프라인 시뮬레이터**로 증명.  
**Non-goals:** NATS mTLS · F1 · **live 클러스터를 CI PASS 필수 조건으로 두지 않음** · gVisor `runsc` 노드 설치.  
LLM Gateway 최소 경로: [`llm-gateway.md`](llm-gateway.md) (본 문서는 NP peer/`aura-llm-gateway` allow만).

---

## 허용 / 차단 매트릭스

| 목적지 | 기대 | 계층 |
|--------|------|------|
| `nats.*:4222` | allow | NetworkPolicy → `app: nats` |
| Pooler VIP `:5432` | allow | NP → `aura.db/role: pooler` |
| `aura-llm-gateway.*` | allow | NP |
| `aura-content` / Garage | allow | NP → `app: aura-content` |
| `kube-dns` (kube-system) `:53` | allow | NP |
| `aura-mcp-proxy` `:443` | allow | NP (vanilla 경로) |
| 등록 MCP HTTPS FQDN | allow | **앱** [`egress-allowlist.js`](../../services/mcp-invoke/egress-allowlist.js) |
| `api.openai.com` 등 공급자 LLM | **deny** | NP+앱 |
| `169.254.169.254` / metadata | **deny** | 앱+시뮬레이터 |
| 임의 인터넷 | **deny** | NP (피어 없음) |
| 미등록 MCP 호스트 | **deny** | 앱 |
| PG **primary** 직접 | **deny** | NP (pooler 아님) |

Vanilla NetworkPolicy는 **FQDN MCP** 를 직접 열 수 없다. [`networkpolicy-sandbox-egress.yaml`](../k8s/sandbox-egress/networkpolicy-sandbox-egress.yaml) + `aura-mcp-egress-hosts` ConfigMap은 **프록시/`toFQDNs` 패턴**을 문서화한다.

---

## Commands (기본 = 오프라인 PASS)

```bash
bash deploy/scripts/check-egress-block-verify.sh
node services/sandbox-egress/evaluate-egress.selftest.js
node services/mcp-invoke/egress-allowlist.selftest.js
node deploy/k8s/sandbox-egress/smoke-probe.js
```

### 선택: 라이브 클러스터 (`AURA_EGRESS_LIVE=1`)

`kubectl` 사용 가능할 때만. CI 게이트 **아님**.

```bash
kubectl apply -k deploy/k8s/sandbox-egress/
# 라벨된 probe Pod에서 smoke-probe 매트릭스와 동일 대상 nc/curl 시도 — 실패=차단 증거.
AURA_EGRESS_LIVE=1 bash deploy/scripts/check-egress-block-verify.sh
```

---

## 구현 요소

| 파일 | 역할 |
|------|------|
| `networkpolicy-sandbox-egress.yaml` | deny-default allowlist (Egress only) |
| `runtimeclass-gvisor.yaml` | `gvisor` / `runsc` (manifest only) |
| `services/sandbox-egress/evaluate-egress.js` | NP YAML + 목적지 시뮬레이터 |
| `services/mcp-invoke/egress-allowlist.js` | 외부 MCP FQDN 앱 게이트 |

V3.3 스모크 합격 = 위 스크립트 **PASS** + 격리 정책 `check-mcp-bundle-isolation.sh` green.