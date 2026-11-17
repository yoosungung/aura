# Aura deploy setup (M0 bootstrap)

로컬/개발 클러스터에 **NATS JetStream · KEDA · Fission**을 올린다. 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md) §3–§4, 일정은 [ROADMAP.md](../ROADMAP.md) M0.

**이 문서 범위:** 컨트롤 플레인 설치·스모크 + JetStream 스트림 사전 생성 + **async/sync 분리 배포 골격**(V0.1).  
**후속 M0 슬라이스:** 샘플 Function 본문(echo / Core RR), MaxDeliver→`AURA_DLQ` 경로 확정.

## 전제

| 항목 | 값 |
|------|-----|
| Kubernetes | ≥ 1.32 (Fission 1.27) |
| Helm | v3+ (`kubectl` 포함) |
| 클러스터 권한 | cluster-admin (CRD·NS 생성) |
| 핀 버전 | NATS image `nats:2.10-alpine` · KEDA chart `2.20.2` · Fission `1.27.0` |

KEDA는 Fission 1.27이 빌드·검증한 **2.20.x**를 쓴다(2.21로 올리지 말 것).  
[Compatibility](https://fission.io/docs/installation/compatibility/).

## 한 방에 설치 + 스모크

```bash
bash deploy/scripts/install-runtime.sh
bash deploy/scripts/smoke-runtime.sh
bash deploy/scripts/smoke-streams.sh
bash deploy/scripts/apply-split-deploy.sh
bash deploy/scripts/smoke-split-deploy.sh
```

| 단계 | 구현 |
|------|------|
| NATS JetStream + monitor `:8222` | Kustomize [`deploy/k8s/base`](k8s/base/) → ns `aura`, NodePort `30422`/`30822` |
| KEDA | Helm `kedacore/keda` `2.20.2` → ns `keda` |
| Fission | CRDs(`kubectl create` 또는 **server-side apply**) + Helm `fission-charts/fission-all` `1.27.0`, **`mqt_keda.enabled=true`** → ns `fission` |
| Streams | `ensure-streams.sh` (nats-box) — `AURA_TASKS` WorkQueue · `AURA_EVENTS` Limits 90d · `AURA_DLQ` Limits |
| Split deploy (V0.1) | [`deploy/k8s/functions`](k8s/functions/) — async MQT min=0 vs sync newdeploy MinScale≥2 (**별 매니페스트**) |
| Split deploy (V0.1) | [`k8s/async-smoke`](k8s/async-smoke/) MQT `minReplicaCount=0` · [`k8s/sync-smoke`](k8s/sync-smoke/) `newdeploy` `MinScale≥2` (별 ScaledObject/MQT 없음) |

Fission CRD OpenAPI가 커서 client-side `kubectl apply`의 `last-applied-configuration` 한도(262144)에 걸릴 수 있다. `install-runtime.sh`는 create 실패 시 `--server-side --force-conflicts`로 재시도한다.

## 분리 배포 이름 (V0.1)

두 계급을 **별 디렉터리·별 라벨**로 둔다. 동일 Deployment/Function에 scale-to-zero(0)와 Warm(≥2)을 섞지 않는다.

| 계급 | 경로 | Function | 스케일 | 라벨 |
|------|------|----------|--------|------|
| async MQT | `deploy/k8s/async-smoke/` | `aura-tasks-smoke` | MQT `minReplicaCount=0` (Fission가 KEDA ScaledObject 생성) | `aura.runtime/class=async` |
| sync Warm | `deploy/k8s/sync-smoke/` | `aura-rpc-smoke` | Function `ExecutorType=newdeploy`, `MinScale=2` | `aura.runtime/class=sync` |

| 이름 | 값 | 비고 |
|------|-----|------|
| pull consumer | `aura_tasks_smoke` | MQT `metadata.consumer` · stream `AURA_TASKS` · topic `aura.tasks.smoke` |
| resp / error | `aura.events.tasks.smoke.done` / `aura.events.tasks.smoke.error` | MQT `respTopic` / `errorTopic` |
| DLQ subject (예약) | `aura.dlq.tasks.smoke` | 스트림 `AURA_DLQ` (`aura.dlq.>`); MaxDeliver→적재 경로는 후속 택일 |
| RPC subject | `aura.rpc.smoke` | Core Request-Reply — **스트림/MQT 없음** |
| RPC queue-group | `aura-rpc-smoke` | 응답자 프로세스 기동 시 subscribe (본문 후속) |

정적 게이트(클러스터 불필요):

```bash
bash deploy/scripts/check-split-deploy.sh
```

패키지 아카이브(echo / Core subscribe 본문)가 생긴 뒤:

```bash
kubectl apply -k deploy/k8s/async-smoke
kubectl apply -k deploy/k8s/sync-smoke
# sync에 ScaledObject·MessageQueueTrigger가 없는지 확인
kubectl get scaledobject,mqtrigger -A -l aura.runtime/class=sync   # 기대: No resources
kubectl get mqtrigger -n default aura-tasks-smoke -o jsonpath='{.spec.minReplicaCount}{"\n"}'  # 기대: 0
kubectl get function -n default aura-rpc-smoke -o jsonpath='{.spec.InvokeStrategy.ExecutionStrategy.MinScale}{"\n"}'  # 기대: 2
```

## 엔드포인트 (클러스터)

| 용도 | 주소 |
|------|------|
| NATS client | `nats://nats.aura.svc.cluster.local:4222` (호스트 NodePort `30422`) |
| NATS monitor (`/jsz`, KEDA scaler) | `nats.aura.svc.cluster.local:8222` (호스트 `30822`) |
| Fission | ns `fission` (router/executor/storagesvc/`mqtrigger-keda`) |

후속 MQT metadata 예:

- `natsServer=nats://nats.aura.svc.cluster.local:4222`
- `natsServerMonitoringEndpoint=nats.aura.svc.cluster.local:8222`

## 스모크 합격 기준

`smoke-runtime.sh` exit 0:

- `aura/nats` StatefulSet Ready, `/healthz`·`/jsz` OK
- `keda` operator·metrics-apiserver Ready, `scaledobjects.keda.sh` CRD
- `fission` router·executor·storagesvc·**mqtrigger-keda** Ready

`smoke-streams.sh` exit 0 (ARCHITECTURE §3):

| 스트림 | retention | subjects |
|--------|-----------|----------|
| `AURA_TASKS` | WorkQueue | `aura.tasks.>` |
| `AURA_EVENTS` | Limits, max-age 90d | `aura.events.>` |
| `AURA_DLQ` | Limits | `aura.dlq.>` |

스트림만 재생성·검증:

```bash
bash deploy/scripts/ensure-streams.sh   # idempotent
bash deploy/scripts/smoke-streams.sh
```

**하지 않음(후속):** `aura.tasks.smoke` echo 본문·live MQT 스모크, `aura.rpc.smoke` Core RR 본문·No Responders 관측, MaxDeliver→`AURA_DLQ` 택일·적재 경로.

## 제거 (개발 클러스터만)

```bash
helm uninstall fission -n fission || true
helm uninstall keda -n keda || true
kubectl delete -k deploy/k8s/base || true
# CRD·PVC는 필요 시 수동 삭제
```

## 참고

- Fission install: https://fission.io/docs/installation/
- Fission × KEDA MQT / NATS JetStream: https://fission.io/docs/usage/triggers/message-queue-trigger-kind-keda/nats-jetstream/
