#!/usr/bin/env bash
# Apply control-admin + Admin UI images to ns aura (Pooler + baked nginx).
# Prerequisites: aura ns · aura-pg-pooler · aura-pg-dsn · aura-pg-app · docker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL="$ROOT/deploy/sql/control_meta.sql"

need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need kubectl
need python3
need docker

echo "== ensure control_meta DDL =="
PASS="$(kubectl -n aura get secret aura-pg-app -o jsonpath='{.data.password}' | python3 -c 'import sys,base64; print(base64.b64decode(sys.stdin.read()).decode())')"
HOST="$(kubectl -n aura get cm aura-pg-dsn -o jsonpath='{.data.AURA_DATABASE_HOST}')"
DB="$(kubectl -n aura get cm aura-pg-dsn -o jsonpath='{.data.AURA_DATABASE_NAME}')"
USER="$(kubectl -n aura get cm aura-pg-dsn -o jsonpath='{.data.AURA_DATABASE_USER}')"
kubectl -n aura delete pod aura-admin-ddl --ignore-not-found --wait=true >/dev/null 2>&1 || true
kubectl -n aura run aura-admin-ddl --restart=Never --image=postgres:16-alpine \
  --env="PGPASSWORD=${PASS}" --command -- \
  sleep 120 >/dev/null
kubectl -n aura wait --for=condition=Ready pod/aura-admin-ddl --timeout=90s >/dev/null
kubectl -n aura cp "$SQL" aura-admin-ddl:/tmp/control_meta.sql
kubectl -n aura exec aura-admin-ddl -- \
  psql -h "$HOST" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 -f /tmp/control_meta.sql
kubectl -n aura delete pod aura-admin-ddl --wait=false >/dev/null 2>&1 || true
echo "OK: control_meta DDL"

echo "== images =="
bash "$ROOT/deploy/scripts/build-admin-images.sh"

echo "== retire code ConfigMaps =="
kubectl -n aura delete configmap \
  aura-control-admin-app aura-admin-ui-dist aura-admin-ui-nginx \
  --ignore-not-found

echo "== apply kustomize =="
kubectl apply -k "$ROOT/deploy/k8s/control-admin"
kubectl apply -k "$ROOT/deploy/k8s/admin-ui"

echo "== rollout =="
kubectl -n aura rollout restart deploy/aura-control-admin deploy/aura-admin-ui
kubectl -n aura rollout status deploy/aura-control-admin --timeout=180s
kubectl -n aura rollout status deploy/aura-admin-ui --timeout=120s

echo
echo "apply-admin-ui: PASS"
echo "  port-forward: kubectl -n aura port-forward svc/aura-admin-ui 18080:8080"
echo "  open http://localhost:18080  Bearer=ops-dev-token"
