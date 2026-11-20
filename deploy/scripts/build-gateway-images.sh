#!/usr/bin/env bash
# Bake gateway + llm-gateway images (real handlers; no node -e stubs).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
docker build -t aura/gateway:local "$ROOT/services/gateway"
docker build -t aura/llm-gateway:local "$ROOT/services/llm-gateway"
echo "OK: aura/gateway:local · aura/llm-gateway:local"
