#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
cd "$DIR"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

if [[ ! -x .venv/bin/python ]]; then
  python3.12 -m venv .venv
fi
# shellcheck disable=SC1091
. .venv/bin/activate

if ! python -c "import virtual_client" >/dev/null 2>&1; then
  pip install -e '.[dev]'
fi

load_cluster_llm() {
  if [[ -n "${AURA_LLM_API_KEY:-}" || -n "${OPENAI_API_KEY:-}" ]]; then
    return 0
  fi
  if ! command -v kubectl >/dev/null 2>&1; then
    return 0
  fi
  if ! kubectl -n aura get secret aura-secrets >/dev/null 2>&1; then
    return 0
  fi
  if [[ -z "${AURA_LLM_API_KEY:-}" ]]; then
    AURA_LLM_API_KEY="$(kubectl -n aura get secret aura-secrets -o jsonpath='{.data.AURA_LLM_API_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)"
    export AURA_LLM_API_KEY
  fi
  if [[ -z "${AURA_LLM_BASE_URL:-}" ]]; then
    AURA_LLM_BASE_URL="$(kubectl -n aura get configmap aura-config -o jsonpath='{.data.AURA_LLM_BASE_URL}' 2>/dev/null || true)"
    export AURA_LLM_BASE_URL
  fi
  if [[ -z "${AURA_LLM_MODEL:-}" ]]; then
    AURA_LLM_MODEL="$(kubectl -n aura get configmap aura-config -o jsonpath='{.data.AURA_LLM_MODEL}' 2>/dev/null || true)"
    export AURA_LLM_MODEL
  fi
}
load_cluster_llm

base="${AURA_GATEWAY_URL:-http://127.0.0.1:30080}"
kakao="${AURA_KAKAO_URL:-http://127.0.0.1:30081}"
smtp_host="${AURA_SMTP_HOST:-127.0.0.1}"
smtp_port="${AURA_SMTP_PORT:-30025}"
channel=web
skip_check=0

i=1
while [[ $i -le $# ]]; do
  arg="${!i}"
  next=""
  if [[ $i -lt $# ]]; then
    j=$((i + 1))
    next="${!j}"
  fi
  case "$arg" in
    -h|--help) skip_check=1 ;;
    --channel) channel="$next"; i=$((i + 1)) ;;
    --channel=*) channel="${arg#*=}" ;;
    --base) base="$next"; i=$((i + 1)) ;;
    --base=*) base="${arg#*=}" ;;
    --kakao-base) kakao="$next"; i=$((i + 1)) ;;
    --kakao-base=*) kakao="${arg#*=}" ;;
    --smtp-host) smtp_host="$next"; i=$((i + 1)) ;;
    --smtp-host=*) smtp_host="${arg#*=}" ;;
    --smtp-port) smtp_port="$next"; i=$((i + 1)) ;;
    --smtp-port=*) smtp_port="${arg#*=}" ;;
  esac
  i=$((i + 1))
done

publish_nodeports() {
  local script="$ROOT/deploy/k8s/nodeport-proxy.sh"
  if [[ "${AURA_NODEPORT_PROXY_DONE:-0}" -eq 1 || ! -x "$script" ]]; then
    return 1
  fi
  AURA_NODEPORT_PROXY_DONE=1
  "$script"
}

is_cluster_http() {
  case "$1" in
    http://127.0.0.1:30080|http://127.0.0.1:30080/*|http://localhost:30080|http://localhost:30080/*) return 0 ;;
    http://127.0.0.1:30081|http://127.0.0.1:30081/*|http://localhost:30081|http://localhost:30081/*) return 0 ;;
    *) return 1 ;;
  esac
}

check_http() {
  local url="$1"
  local name="$2"
  if curl -sS --connect-timeout 2 --max-time 3 -o /dev/null "$url" 2>/dev/null; then
    return 0
  fi
  if is_cluster_http "$url" && publish_nodeports; then
    if curl -sS --connect-timeout 2 --max-time 3 -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
  fi
  echo "${name}이(가) ${url} 에서 응답하지 않습니다. Docker Desktop NodePort는 localhost에 안 열립니다. sh deploy/k8s/nodeport-proxy.sh (deploy/k8s/README.md)." >&2
  exit 1
}

check_tcp() {
  local host="$1"
  local port="$2"
  local name="$3"
  if python -c "import socket; socket.create_connection(('${host}', int('${port}')), 2).close()" 2>/dev/null; then
    return 0
  fi
  if [[ "$port" == "30025" && ( "$host" == "127.0.0.1" || "$host" == "localhost" ) ]] && publish_nodeports; then
    if python -c "import socket; socket.create_connection(('${host}', int('${port}')), 2).close()" 2>/dev/null; then
      return 0
    fi
  fi
  echo "${name}이(가) ${host}:${port} 에서 응답하지 않습니다. Docker Desktop NodePort는 localhost에 안 열립니다. sh deploy/k8s/nodeport-proxy.sh (deploy/k8s/README.md)." >&2
  exit 1
}

if [[ "$skip_check" -eq 0 ]]; then
  check_http "$base" "gateway-web"
  if [[ "$channel" == "kakao" || "$channel" == "all" ]]; then
    check_http "$kakao" "gateway-kakao"
  fi
  if [[ "$channel" == "email" || "$channel" == "all" ]]; then
    check_tcp "$smtp_host" "$smtp_port" "gateway-email"
  fi
fi

exec python -m virtual_client "$@"
