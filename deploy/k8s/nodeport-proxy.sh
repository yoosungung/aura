#!/usr/bin/env bash
set -euo pipefail

# Docker Desktop Kubernetes는 kind 노드라서 Service NodePort가
# macOS localhost에 붙지 않는다. kind 네트워크에서 노드 이름으로 넘긴다.

if ! command -v docker >/dev/null 2>&1 || ! command -v kubectl >/dev/null 2>&1; then
  echo "docker와 kubectl이 필요합니다." >&2
  exit 1
fi

if ! docker network inspect kind >/dev/null 2>&1; then
  echo "docker network kind가 없습니다. Docker Desktop Kubernetes가 떠 있는지 확인하세요." >&2
  exit 1
fi

node="$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')"
if [[ -z "${node}" ]]; then
  echo "클러스터 노드가 없습니다." >&2
  exit 1
fi

publish() {
  local name="$1"
  local port="$2"
  docker rm -f "${name}" >/dev/null 2>&1 || true
  docker run -d --name "${name}" --restart unless-stopped --network kind \
    -p "127.0.0.1:${port}:${port}" \
    alpine/socat "TCP-LISTEN:${port},fork,reuseaddr" "TCP:${node}:${port}" >/dev/null
}

publish aura-np-frontend 30080
publish aura-np-kakao 30081
publish aura-np-email 30025
