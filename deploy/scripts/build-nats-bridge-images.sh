#!/usr/bin/env bash
# Bake NATS rpc/task bridge images (Rust distroless; repo-root context).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
docker build -f "$ROOT/services/nats-rpc-bridge/Dockerfile" -t aura/nats-rpc-bridge:local "$ROOT"
docker build -f "$ROOT/services/nats-task-bridge/Dockerfile" -t aura/nats-task-bridge:local "$ROOT"
echo "OK: aura/nats-rpc-bridge:local · aura/nats-task-bridge:local"
