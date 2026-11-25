#!/usr/bin/env bash
# Bake control-admin and Admin UI images (source/dist stay out of ConfigMaps).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
docker build -f "$ROOT/services/control/Dockerfile" -t aura/control-admin:local "$ROOT"
docker build -f "$ROOT/services/admin-ui/Dockerfile" -t aura/admin-ui:local "$ROOT"
echo "OK: aura/control-admin:local · aura/admin-ui:local"
