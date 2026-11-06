#!/usr/bin/env bash
set -euo pipefail

# Docker Desktop Kubernetes는 kind 노드라서 Service NodePort가
# macOS localhost에 붙지 않는다. kind 네트워크에서 노드 이름으로 넘긴다.
# kind 네트워크가 없으면(OrbStack) host.docker.internal의 NodePort로 넘긴다.
# 그 포트가 이미 호스트에 열려 있으면 프록시를 만들지 않는다.

if ! command -v docker >/dev/null 2>&1 || ! command -v kubectl >/dev/null 2>&1; then
  echo "docker와 kubectl이 필요합니다." >&2
  exit 1
fi

node="$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')"
if [[ -z "${node}" ]]; then
  echo "클러스터 노드가 없습니다." >&2
  exit 1
fi

if docker network inspect kind >/dev/null 2>&1; then
  network=kind
  target="${node}"
else
  network=bridge
  target=host.docker.internal
fi

port_open() {
  local port="$1"
  (echo >/dev/tcp/127.0.0.1/"${port}") >/dev/null 2>&1
}

publish() {
  local name="$1"
  local host_port="$2"
  local node_port="${3:-$host_port}"
  if port_open "${host_port}"; then
    docker rm -f "${name}" >/dev/null 2>&1 || true
    echo "localhost:${host_port} 이미 열려 있어 ${name}은 건너뜀"
    return 0
  fi
  docker rm -f "${name}" >/dev/null 2>&1 || true
  docker run -d --name "${name}" --restart unless-stopped --network "${network}" \
    -p "127.0.0.1:${host_port}:${host_port}" \
    alpine/socat "TCP-LISTEN:${host_port},fork,reuseaddr" "TCP:${target}:${node_port}" >/dev/null
}

publish aura-np-frontend 30080
publish aura-np-kakao 30081
publish aura-np-email 30025
publish aura-np-postgres 5432 30432
publish aura-np-nats 4222 30422
publish aura-np-nats-mon 8222 30822
publish aura-np-filer 8888 30888
