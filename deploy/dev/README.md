# deploy/dev — smoke / local harness (not production)

M0 검증용 매니페스트만 둔다. **프로덕션·제품 경로에 포함하지 않는다.**

| 경로 | 용도 |
|------|------|
| `k8s/async-smoke/` | async MQT echo (`aura.tasks.smoke`) |
| `k8s/sync-smoke/` | sync Warm Function + Core RR `aura-rpc-smoke-rr` |

제품 매니페스트는 [`../k8s/`](../k8s/) (`base`, `runtime-envs`, memory-*, gateway, …).  
제품 Fission env는 `runtime-envs`의 async/sync 2개만 사용한다(서비스별 Environment 없음).  
적용: `bash deploy/scripts/apply-split-deploy.sh` · 게이트: `check-split-deploy.sh` / `smoke-*.sh`.  
런북: [`../SETUP.md`](../SETUP.md).
