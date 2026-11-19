# Fission Node Package — archive (M3.5)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · §4.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.5.  
대상: [`../k8s/agent-invoke/`](../k8s/agent-invoke/) · [`../k8s/mcp-invoke/`](../k8s/mcp-invoke/) · [`../k8s/mcp-invoke-rpc/`](../k8s/mcp-invoke-rpc/).

**이 문서 범위:** `type: literal` 폐기 이유 · **archive + node-builder** 결정 · check 게이트.  
**Non-goals:** esbuild 단일 literal로 langchain 번들 · python/rust env(본 슬라이스).

---

## 결정

| 항목 | 값 |
|------|-----|
| 이전 | `deployment.type: literal` + base64(`invoke.js`) · 외부 npm **0** |
| 이후 | **`deployment.type: archive`** (zip) + Environment **`node-builder`** |
| 이유 | `langchain` / `nats` / `pg` 등 의존성을 Function에 포함해야 함 |
| 비채택 | esbuild→단일 literal (langchain 번들·CJS/ESM 리스크) |

MQT **connector**는 Fission/KEDA 이미지이며 Package 언어와 무관하다. archive는 **Function** 소스만 담는다.

---

## 레이아웃

| 경로 | 역할 |
|------|------|
| `services/agent-invoke/` | 소스 정본 + `package.json` deps |
| `services/mcp-invoke/` | 소스 정본 + deps |
| `deploy/scripts/build-*-archive.sh` | zip 산출 (`deploy/k8s/*/archive.zip`) |
| `deploy/k8s/*/package.yaml` | `type: archive` · URL 또는 로컬 업로드 런북 |

체크: `check-agent-invoke.sh` / `check-mcp-invoke-dual.sh`는 literal 바이트 일치를 **하지 않고**, archive 타입·필수 소스·빌드 스크립트 존재를 게이트한다.

---

## 검증

```bash
bash deploy/scripts/check-agent-invoke.sh
bash deploy/scripts/check-mcp-invoke-dual.sh
bash deploy/scripts/build-agent-invoke-archive.sh
bash deploy/scripts/build-mcp-invoke-archive.sh
```
