#!/usr/bin/env bash
# Bake control-admin (Node live Pooler+RustFS) + admin-ui images (repo-root context).
# Rust resolve image: services/control/Dockerfile.resolve separately.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
docker build -f "$ROOT/services/control/Dockerfile" -t aura/control-admin:local "$ROOT"
docker build -f "$ROOT/services/admin-ui/Dockerfile" -t aura/admin-ui:local "$ROOT"
echo "OK: aura/control-admin:local · aura/admin-ui:local"
