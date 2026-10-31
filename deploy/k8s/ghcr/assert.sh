#!/bin/sh
set -eu
root="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
out="$(kubectl kustomize "${root}")"
echo "${out}" | grep -E '^[[:space:]]+image: aura/' && {
  echo "local aura/* image leaked from GHCR overlay" >&2
  exit 1
}
want="svc-core ingestion-worker gateway-web gateway-email gateway-kakao svc-sla-routing svc-automation event-archive seed svc-ai-agent frontend"
for name in ${want}; do
  echo "${out}" | grep -q "image: ghcr.io/yoosungung/aura/${name}:current" || {
    echo "missing ghcr.io/yoosungung/aura/${name}:current" >&2
    exit 1
  }
done
always="$(echo "${out}" | grep -c 'imagePullPolicy: Always' || true)"
if [ "${always}" -ne 11 ]; then
  echo "expected 11 imagePullPolicy Always, got ${always}" >&2
  exit 1
fi
