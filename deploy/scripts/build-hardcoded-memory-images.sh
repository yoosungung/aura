#!/usr/bin/env bash
# Build memory/control/compliance Deployment images (Rust).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

docker build -f services/control/Dockerfile.resolve -t aura/control-resolve:local .
docker build -f services/memory/Dockerfile.recall -t aura/memory-recall:local .
docker build -f services/memory/Dockerfile.capture -t aura/memory-capture:local .
docker build -f services/memory/Dockerfile.batch -t aura/memory-batch:local .
docker build -f services/compliance/Dockerfile -t aura/compliance-erase:local .

echo "OK: aura/control-resolve:local aura/memory-recall:local aura/memory-capture:local aura/memory-batch:local aura/compliance-erase:local"
