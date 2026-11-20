# Fission Python Package — archive (M3.6)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #2 · §4.  
일정: [ROADMAP.md](../../ROADMAP.md) M3.6.  
대칭: [`fission-node-archive.md`](fission-node-archive.md).  
multi-env: [`multi-env-followup.md`](multi-env-followup.md).

**이 문서 범위:** Python deployment archive + `python-env` · 빌드 스크립트 · check.  
**Non-goals:** 클러스터 source-build 필수 · Node 교체 · custom-env.

---

## 결정

| 항목 | 값 |
|------|-----|
| Runtime image | `ghcr.io/fission/python-env` |
| Builder image | `ghcr.io/fission/python-builder` (Environment에 부착; CI는 deployment zip) |
| Package | **deployment archive** zip — CI에서 `pip install -r requirements.txt -t <vendor>` |
| 소스 | `services/agent-invoke/python/` · `services/mcp-invoke/python/` |
| Functions | `aura-agent-invoke-py` · `aura-mcp-invoke-py` · `aura-mcp-invoke-rpc-py` |
| Environment | async=`aura-python-async` · sync=`aura-python-sync` |
| MQT | **없음** — task/rpc 브리지만 |

---

## 레이아웃

| 경로 | 역할 |
|------|------|
| `services/*/python/` | 소스 정본 + `requirements.txt` |
| `deploy/scripts/build-*-python-archive.sh` | zip → `deploy/k8s/*-py/archive.zip` |
| `deploy/k8s/*-py/package.yaml` | `type: archive` · env `aura-python-*` |

---

## 검증

```bash
bash deploy/scripts/check-python-env-parity.sh
bash deploy/scripts/build-agent-invoke-python-archive.sh
bash deploy/scripts/build-mcp-invoke-python-archive.sh
```
