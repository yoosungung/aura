#!/usr/bin/env bash
# Bake gateway + llm-gateway images (Rust distroless; repo-root context).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
docker build -f "$ROOT/services/gateway/rs/Dockerfile" -t aura/gateway:local "$ROOT"
docker build -f "$ROOT/services/llm-gateway/rs/Dockerfile" -t aura/llm-gateway:local "$ROOT"
echo "OK: aura/gateway:local · aura/llm-gateway:local"
