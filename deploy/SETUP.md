# Aura deploy setup (M0 bootstrap)

로컬/개발 클러스터에 **NATS JetStream · KEDA · Fission**을 올린다. 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md) §3–§4, 일정은 [ROADMAP.md](../ROADMAP.md) M0.

**이 문서 범위:** 컨트롤 플레인 설치·스모크.  
**후속 M0 슬라이스:** `AURA_TASKS`/`AURA_EVENTS`/`AURA_DLQ` 스트림, async/sync 샘플 Function, DLQ 경로 확정.

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
```

| 단계 | 구현 |
|------|------|
| NATS JetStream + monitor `:8222` | Kustomize [`deploy/k8s/base`](k8s/base/) → ns `aura`, NodePort `30422`/`30822` |
| KEDA | Helm `kedacore/keda` `2.20.2` → ns `keda` |
| Fission | CRDs + Helm `fission-charts/fission-all` `1.27.0`, **`mqt_keda.enabled=true`** → ns `fission` |

## 엔드포인트 (클러스터)

| 용도 | 주소 |
|------|------|
| NATS client | `nats://nats.aura.svc.cluster.local:4222` (호스트 NodePort `30422`) |
| NATS monitor (`/jsz`, KEDA scaler) | `nats.aura.svc.cluster.local:8222` (호스트 `30822`) |
| Fission | ns `fission` (router/executor/storagesvc/`mqtrigger-keda`) |

후속 MQT metadata 예:

- `natsServer=nats://nats.aura.svc.cluster.local:4222`
- `natsServerMonitoringEndpoint=nats.aura.svc.cluster.local:8222`

## 스모크 합격 기준 (이 슬라이스)

`smoke-runtime.sh`가 exit 0:

- `aura/nats` StatefulSet Ready, `/healthz`·`/jsz` OK
- `keda` operator·metrics-apiserver Ready, `scaledobjects.keda.sh` CRD
- `fission` router·executor·storagesvc·**mqtrigger-keda** Ready

**하지 않음(후속):** 스트림 생성, `aura.tasks.smoke` MQT, `aura.rpc.smoke` Warm, MaxDeliver→`AURA_DLQ` 택일.

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
