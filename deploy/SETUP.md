# Aura deploy setup (M0 bootstrap)

로컬/개발 클러스터에 **NATS JetStream · KEDA · Fission**을 올린다. 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md) §3–§4, 일정은 [ROADMAP.md](../ROADMAP.md) M0.

**이 문서 범위:** 컨트롤 플레인 설치·스모크 + JetStream 스트림 사전 생성 + async/sync 분리(V0.1) + async MQT echo + V0.3 poison→errorTopic + **V0.2 sync Core RR**.  
**후속 M0 슬라이스:** MaxDeliver→`AURA_DLQ` Term/Advisory 택일(`1632b9ee`) · (권장) PG 스모크 계획(M1).

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
bash deploy/scripts/smoke-async-mqt.sh
bash deploy/scripts/smoke-async-poison.sh
bash deploy/scripts/smoke-sync-rpc.sh
```

| 단계 | 구현 |
|------|------|
| NATS JetStream + monitor `:8222` | Kustomize [`deploy/k8s/base`](k8s/base/) → ns `aura`, NodePort `30422`/`30822` |
| KEDA | Helm `kedacore/keda` `2.20.2` → ns `keda` |
| Fission | CRDs(`kubectl create` 또는 **server-side apply**) + Helm `fission-charts/fission-all` `1.27.0`, **`mqt_keda.enabled=true`**, **`internalAuth.enabled=false`** (stock KEDA connector는 HMAC 미서명 → router-internal 401) → ns `fission` |
| Streams | `ensure-streams.sh` (nats-box) — `AURA_TASKS` WorkQueue · `AURA_EVENTS` Limits 90d · `AURA_DLQ` Limits |
| Split deploy (V0.1) | [`k8s/async-smoke`](k8s/async-smoke/) MQT `minReplicaCount=0` · [`k8s/sync-smoke`](k8s/sync-smoke/) `newdeploy` `MinScale≥2` (MQT/ScaledObject 없음) |
| Async echo | Package `echo.js` · topic `aura.tasks.smoke` → `respTopic`/`errorTopic` · `smoke-async-mqt.sh` |
| Async poison (V0.3) | `maxRetries`→`errorTopic` + consumer `MaxDeliver=5` · `ensure-async-consumer.sh` · `smoke-async-poison.sh` |
| Sync Core RR (V0.2) | Deployment `aura-rpc-smoke-rr` replicas≥2 · subject `aura.rpc.smoke` · queue `aura-rpc-smoke` · `smoke-sync-rpc.sh` |

Fission CRD OpenAPI가 커서 client-side `kubectl apply`의 `last-applied-configuration` 한도(262144)에 걸릴 수 있다. `install-runtime.sh`는 create 실패 시 `--server-side --force-conflicts`로 재시도한다.

## 분리 배포 이름 (V0.1)

두 계급을 **별 디렉터리·별 라벨**로 둔다. 동일 Deployment/Function에 scale-to-zero(0)와 Warm(≥2)을 섞지 않는다.

| 계급 | 경로 | Function | 스케일 | 라벨 |
|------|------|----------|--------|------|
| async MQT | `deploy/k8s/async-smoke/` | `aura-tasks-smoke` | MQT `minReplicaCount=0` (Fission가 KEDA ScaledObject 생성) | `aura.runtime/class=async` |
| sync Warm | `deploy/k8s/sync-smoke/` | `aura-rpc-smoke` (+ RR `aura-rpc-smoke-rr`) | Function `newdeploy` `MinScale=2` · **Core RR Deployment replicas≥2** (§4.3) | `aura.runtime/class=sync` |

| 이름 | 값 | 비고 |
|------|-----|------|
| pull consumer | `aura_tasks_smoke` | MQT `metadata.consumer` · stream `AURA_TASKS` · topic `aura.tasks.smoke` |
| resp / error | `aura.events.tasks.smoke.done` / `aura.events.tasks.smoke.error` | MQT `respTopic` / `errorTopic` |
| DLQ subject (예약) | `aura.dlq.tasks.smoke` | 스트림 `AURA_DLQ` (`aura.dlq.>`); Term/Advisory 택일·적재는 `1632b9ee` |
| MaxDeliver | `5` | durable `aura_tasks_smoke` — `ensure-async-consumer.sh` (V0.3) |
| RPC subject | `aura.rpc.smoke` | Core Request-Reply — **스트림/MQT 없음** |
| RPC queue-group | `aura-rpc-smoke` | Deployment `aura-rpc-smoke-rr` 기동 시 `nats reply -q` |
| RPC responder | `aura-rpc-smoke-rr` | replicas **≥2**; body `{type:rpc.smoke.done,echo:Request}` |

정적 게이트(클러스터 불필요) + 클러스터 관측:

```bash
bash deploy/scripts/check-split-deploy.sh   # MQT 이름표 + echo.js == Package literal
bash deploy/scripts/apply-split-deploy.sh
bash deploy/scripts/smoke-split-deploy.sh
bash deploy/scripts/smoke-async-mqt.sh      # live: pub → done / fail → error
bash deploy/scripts/smoke-async-poison.sh   # V0.3: fail+bad JSON → errorTopic; MaxDeliver; settle
bash deploy/scripts/smoke-sync-rpc.sh       # V0.2: Core RR Warm + scale-0 No Responders
```

`aura.tasks.smoke` echo: 성공 JSON은 `aura.events.tasks.smoke.done`에 `{id,type:tasks.smoke.done,echo}`; `{"aura_smoke":"fail"}` 또는 잘못된 JSON은 MQT `maxRetries` 후 `aura.events.tasks.smoke.error`에 잔존하고 consumer는 settle(acks/redelivered/unprocessed=0).  
`aura.rpc.smoke` Core RR: Warm 응답 `{type:rpc.smoke.done,echo}`; responders `replicas=0`이면 즉시 No Responders.  
`AURA_DLQ` 적재 경로는 후속(`1632b9ee`).

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

### Async MQT echo (`aura.tasks.smoke`)

```bash
bash deploy/scripts/apply-split-deploy.sh   # (재)적용 — Package literal = echo.js
bash deploy/scripts/smoke-async-mqt.sh      # publish → resptopic echo
```

| 항목 | 값 |
|------|-----|
| 본문 | `deploy/k8s/async-smoke/echo.js` — request body echo (2xx → `respTopic`) |
| in | `aura.tasks.smoke` (`AURA_TASKS`) |
| out | `aura.events.tasks.smoke.done` (`AURA_EVENTS`) |
| error | `aura.events.tasks.smoke.error` |

### Async poison / V0.3 (`errortopic` 우선)

```bash
bash deploy/scripts/ensure-async-consumer.sh   # consumer MaxDeliver=5
bash deploy/scripts/smoke-async-poison.sh      # bad JSON + fail → errorTopic; settle
```

| 항목 | 값 |
|------|-----|
| JetStream | consumer `aura_tasks_smoke` **MaxDeliver=5** (무한 재전달 금지) |
| MQT | `maxRetries: 3` 후 `errorTopic` |
| 증거 | `aura.events.tasks.smoke.error` 잔존 + consumer unprocessed/acks=0 |
| `AURA_DLQ` | **미적재가 정상** — Term vs Advisory 택일은 티켓 `1632b9ee` |

### Sync Core RR / V0.2 (`aura.rpc.smoke`)

```bash
bash deploy/scripts/apply-split-deploy.sh   # includes aura-rpc-smoke-rr
bash deploy/scripts/smoke-sync-rpc.sh       # Warm RR · scale-0 No Responders · HA
```

| 항목 | 값 |
|------|-----|
| 응답자 | Deployment `aura-rpc-smoke-rr` (nats-box `nats reply -q aura-rpc-smoke`) |
| subject / queue | `aura.rpc.smoke` / `aura-rpc-smoke` |
| Warm | replicas **≥2**; 응답 `{type:rpc.smoke.done,echo:<request>}` |
| 회귀 | replicas→0 → **No Responders**; 복구 후 RR 재성공 |
| Fission Function | `aura-rpc-smoke` newdeploy MinScale≥2 — Warm Pool 불변(V0.1); NATS 구독은 Deployment |
| MQT / lag | **미연결** |

**하지 않음(후속):** `AURA_DLQ` Term/Advisory 택일·적재(`1632b9ee`).

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
- Internal auth + KEDA gap: https://fission.io/docs/installation/internal-auth/ (`internalAuth.enabled=false` until signing-aware connectors)
