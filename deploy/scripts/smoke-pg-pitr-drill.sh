#!/usr/bin/env bash
# PITR drill smoke: static by default; live optional when Barman is provisioned.
#   SMOKE_PITR_STATIC=1 bash deploy/scripts/smoke-pg-pitr-drill.sh
#   AURA_PITR_LIVE=1 bash deploy/scripts/smoke-pg-pitr-drill.sh   # requires backup
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

echo "== static =="
bash "$ROOT/deploy/scripts/check-pg-pitr-drill.sh"
bash "$ROOT/deploy/scripts/check-pg-ha.sh"
ok "static gates"

if [[ "${AURA_PITR_LIVE:-}" != "1" ]]; then
  echo "smoke-pg-pitr-drill: PASS (static only; set AURA_PITR_LIVE=1 for live restore)"
  exit 0
fi

echo "== live =="
command -v kubectl >/dev/null || fail "kubectl required for live"
NS="${AURA_PITR_NS:-aura}"
SRC="${AURA_PITR_SOURCE:-aura-pg}"

backup_json="$(kubectl -n "$NS" get cluster "$SRC" -o json 2>/dev/null || true)"
[[ -n "$backup_json" ]] || fail "cluster $SRC not found in $NS"

python3 - "$backup_json" <<'PY' || fail "source cluster has no spec.backup.barmanObjectStore — provision Barman first"
import json, sys
c = json.loads(sys.argv[1])
b = (c.get("spec") or {}).get("backup") or {}
if not isinstance(b.get("barmanObjectStore"), dict):
    sys.exit(1)
print("OK: source has barmanObjectStore")
PY

echo "LIVE: follow deploy/docs/pg-pitr-drill.md — fill cluster-pitr-restore.draft.yaml targetTime, apply, measure RTO/RPO, then delete restore cluster."
echo "Refusing automatic DROP/apply in smoke (destructive). Manual steps + log template required."
ok "live preflight only"
echo "smoke-pg-pitr-drill: PASS (live preflight; measure manually per doc)"
