#!/usr/bin/env bash
# Build local images for rpc/task bridges (nats deps baked — no initContainer npm).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
docker build -t aura/nats-rpc-bridge:local "$ROOT/services/nats-rpc-bridge"
docker build -t aura/nats-task-bridge:local "$ROOT/services/nats-task-bridge"
echo "OK: aura/nats-rpc-bridge:local · aura/nats-task-bridge:local"
