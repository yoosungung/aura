#!/usr/bin/env bash
set -euo pipefail

# Docker Desktop kind 노드는 compose_default에 붙어 있다. 앱 파드는
# ClusterIP postgres/nats/seaweedfs-filer 로 compose 컨테이너에 간다.
# compose가 재시작되면 컨테이너 IP가 바뀌므로 Endpoints를 다시 붙인다.

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
COMPOSE="$ROOT/deploy/compose/docker-compose.yml"
NS="${AURA_NAMESPACE:-aura}"

if ! command -v docker >/dev/null 2>&1 || ! command -v kubectl >/dev/null 2>&1; then
  echo "docker와 kubectl이 필요합니다." >&2
  exit 1
fi
if [[ ! -f "$COMPOSE" ]]; then
  echo "compose 파일이 없습니다: $COMPOSE" >&2
  exit 1
fi

compose_id() {
  local svc="$1"
  local id
  id="$(docker compose -f "$COMPOSE" ps -q "$svc")"
  if [[ -z "$id" ]]; then
    echo "compose 서비스 ${svc}가 없습니다. docker compose -f deploy/compose/docker-compose.yml up -d" >&2
    exit 1
  fi
  echo "$id"
}

container_ip() {
  local id="$1"
  local ip
  ip="$(docker inspect -f '{{range $n, $c := .NetworkSettings.Networks}}{{if eq $n "compose_default"}}{{$c.IPAddress}}{{end}}{{end}}' "$id")"
  if [[ -z "$ip" ]]; then
    ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{"\n"}}{{end}}' "$id" | awk 'NF { print; exit }')"
  fi
  if [[ -z "$ip" ]]; then
    echo "컨테이너 ${id}에 IP가 없습니다." >&2
    exit 1
  fi
  echo "$ip"
}

pg_id="$(compose_id postgres)"
nats_id="$(compose_id nats)"
filer_id="$(compose_id seaweedfs-filer)"
PG_IP="$(container_ip "$pg_id")"
NATS_IP="$(container_ip "$nats_id")"
FILER_IP="$(container_ip "$filer_id")"

kubectl apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: ${NS}
spec:
  ports:
  - name: pg
    port: 5432
    targetPort: 5432
---
apiVersion: v1
kind: Endpoints
metadata:
  name: postgres
  namespace: ${NS}
subsets:
- addresses:
  - ip: ${PG_IP}
  ports:
  - name: pg
    port: 5432
---
apiVersion: v1
kind: Service
metadata:
  name: nats
  namespace: ${NS}
spec:
  ports:
  - name: client
    port: 4222
    targetPort: 4222
  - name: monitor
    port: 8222
    targetPort: 8222
---
apiVersion: v1
kind: Endpoints
metadata:
  name: nats
  namespace: ${NS}
subsets:
- addresses:
  - ip: ${NATS_IP}
  ports:
  - name: client
    port: 4222
  - name: monitor
    port: 8222
---
apiVersion: v1
kind: Service
metadata:
  name: seaweedfs-filer
  namespace: ${NS}
spec:
  ports:
  - name: http
    port: 8888
    targetPort: 8888
---
apiVersion: v1
kind: Endpoints
metadata:
  name: seaweedfs-filer
  namespace: ${NS}
subsets:
- addresses:
  - ip: ${FILER_IP}
  ports:
  - name: http
    port: 8888
EOF

echo "compose Endpoints postgres=${PG_IP} nats=${NATS_IP} filer=${FILER_IP}"
