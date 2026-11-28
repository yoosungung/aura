# memory-embed · lab Ollama embeddings (via LLM Gateway)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §9.4 · §6.2.1.  
생산 핀(변경 없음): [`memory-embedding-active.md`](memory-embedding-active.md) (`BAAI/bge-m3:1` · 1024).  
Gateway: [`llm-gateway.md`](llm-gateway.md) · 내부 [`../../services/llm-gateway/DESIGN.md`](../../services/llm-gateway/DESIGN.md).  
embed: [`../../services/memory/DESIGN.md`](../../services/memory/DESIGN.md).

**이 문서 범위:** OrbStack lab에서 호스트 Ollama embedding 모델을 **Gateway만** 경유해 `aura-memory-embed`에 연결하는 오버레이.  
**Non-goals:** 생산 TEI/`BAAI/bge-m3` 교체 · `memory_embeddings` 실 halfvec UPSERT · Function→`host.orb.internal` 직접.

---

## Lab 핀

ConfigMap `aura-memory-embed-lab`을 embed Deployment에 붙이고, 핸들러가 env(또는 마운트 경로)로 키를 읽는다.

| Key | 값 |
|-----|-----|
| `AURA_EMBEDDING_MODEL` | `embeddinggemma-2:270m-mxfp8-text` |
| `AURA_EMBEDDING_VERSION` | `1` |
| `AURA_EMBEDDING_DIMS` | `768` |
| (파생) `model_key` | `embeddinggemma-2:270m-mxfp8-text:1` |
| `AURA_LLM_GATEWAY_URL` | `http://aura-llm-gateway.aura.svc.cluster.local:8080` |

매니페스트: [`../k8s/memory-embed/configmap-lab.yaml`](../k8s/memory-embed/configmap-lab.yaml) · [`../k8s/memory-embed/deployment.yaml`](../k8s/memory-embed/deployment.yaml).

---

## Gateway ConfigMap

[`../k8s/llm-gateway/providers-configmap.yaml`](../k8s/llm-gateway/providers-configmap.yaml) 키 `providers.json`:

- chat `providers[]`: host Ollama chat 모델
- `embeddings`: `kind=ollama` · `model=embeddinggemma-2:270m-mxfp8-text` · `baseUrl=http://host.orb.internal:11434/v1`

호스트에 해당 모델이 pull 되어 있어야 한다 (`ollama pull embeddinggemma-2:270m-mxfp8-text` 또는 동등 태그).

---

## 흐름

1. MQT `aura.tasks.memory.embed` → Function `aura-memory-embed`
2. Function → `POST {AURA_LLM_GATEWAY_URL}/v1/embeddings` (`X-Aura-Tenant-Id`, `model`=핀, `input`=content)
3. Gateway → `POST http://host.orb.internal:11434/v1/embeddings`
4. dims=768 검증 후 stub TX · 응답 `payload.via=llm_gateway`

---

## 검증

```bash
bash deploy/scripts/check-llm-gateway.sh
bash deploy/scripts/check-memory-embed.sh
# live (cluster): Gateway embeddings → memory-embed invoke
```
