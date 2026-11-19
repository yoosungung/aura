#!/usr/bin/env bash
# M4 lab PITR drill — local Docker Postgres + WAL archive (no CNPG/Barman Cloud).
# Writes services/ops/pitr-drill/drill-1.record.json with measured RPO/RTO.
# Non-goals: live Multi-AZ · aura-pg Garage · production cutover.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/services/ops/pitr-drill/drill-1.record.json"
WORK="${TMPDIR:-/tmp}/aura-pitr-lab-$$"
IMG="${AURA_PITR_PG_IMAGE:-postgres:16-alpine}"
NAME="aura-pitr-lab-$$"
PGUID=70 # postgres user in alpine image

fail() { echo "FAIL: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || fail "need $1"; }

need docker
need node
need python3

cleanup() {
  docker rm -f "$NAME" "${NAME}-restore" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/archive" "$WORK/backup" "$WORK/restore" "$WORK/data"
chmod 777 "$WORK/archive" "$WORK/backup" "$WORK/restore" "$WORK/data"

fix_archive() {
  # bind-mount files must be readable by container UID 70
  chmod -R a+rX "$WORK/archive" 2>/dev/null || true
}

echo "lab: start primary ($IMG)"
docker run -d --name "$NAME" \
  -e POSTGRES_PASSWORD=aura \
  -e POSTGRES_USER=aura \
  -e POSTGRES_DB=aura \
  -v "$WORK/archive:/archive" \
  -v "$WORK/data:/var/lib/postgresql/data" \
  "$IMG" \
  postgres \
    -c wal_level=replica \
    -c archive_mode=on \
    -c "archive_command=test ! -f /archive/%f && cp %p /archive/%f && chmod a+r /archive/%f" \
    -c max_wal_senders=3 \
    >/dev/null

for i in $(seq 1 60); do
  if docker exec -u postgres "$NAME" pg_isready -U aura -d aura >/dev/null 2>&1 \
    && docker exec -u postgres "$NAME" psql -U aura -d aura -Atc "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  [[ "$i" -eq 60 ]] && fail "primary not ready"
done

psql_aura() {
  docker exec -i -u postgres "$NAME" psql -U aura -d aura -v ON_ERROR_STOP=1 "$@"
}

psql_aura <<'SQL'
CREATE TABLE IF NOT EXISTS drill_markers (
  id serial PRIMARY KEY,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO drill_markers(label) VALUES ('seed');
CHECKPOINT;
SELECT pg_switch_wal();
SQL
fix_archive

COUNT=$(psql_aura -Atc "SELECT count(*) FROM drill_markers")
[[ "$COUNT" -ge 1 ]] || fail "seed row missing after create"

echo "lab: base backup"
docker exec -u postgres "$NAME" \
  pg_basebackup -U aura -D /tmp/basebackup -Fp -X none -c fast
docker cp "$NAME:/tmp/basebackup/." "$WORK/backup/"

psql_aura <<'SQL'
INSERT INTO drill_markers(label) VALUES ('pre_incident');
CHECKPOINT;
SELECT pg_switch_wal();
SQL
fix_archive
sleep 2
fix_archive

# Target must be AFTER the pre_incident commit (created_at is statement-start, not commit).
PRE_TS=$(psql_aura -Atc "SELECT clock_timestamp()")
[[ -n "$PRE_TS" ]] || fail "post-commit target timestamp empty"
NEWEST_PRE=$(psql_aura -Atc "SELECT created_at FROM drill_markers WHERE label='pre_incident'")
[[ -n "$NEWEST_PRE" ]] || fail "pre_incident row missing"

utc_now() {
  python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]+"Z")'
}

sleep 1
INCIDENT_AT=$(utc_now)
psql_aura <<'SQL'
INSERT INTO drill_markers(label) VALUES ('lost_after_incident');
CHECKPOINT;
SELECT pg_switch_wal();
SQL
fix_archive
sleep 1
fix_archive

TARGET_TIME="$PRE_TS"
export PRE_TS
TARGET_ISO=$(python3 - <<'PY'
from datetime import datetime, timezone
import os, re
s = os.environ["PRE_TS"].strip().replace(" ", "T")
s = re.sub(r"\+00$", "+00:00", s)
# pad fractional seconds to 6 digits for fromisoformat
s = re.sub(
    r"\.(\d+)([+-]\d{2}:\d{2}|Z)$",
    lambda m: "." + m.group(1).ljust(6, "0")[:6] + m.group(2),
    s,
)
dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
print(dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z")
PY
)

echo "lab: restore start (targetTime=$TARGET_ISO)"
RESTORE_START=$(utc_now)
rm -rf "$WORK/restore"
mkdir -p "$WORK/restore"
cp -a "$WORK/backup/." "$WORK/restore/"
# recovery_target_inclusive=true so pre_incident commit is kept
cat > "$WORK/restore/postgresql.auto.conf" <<EOF
restore_command = 'cp /archive/%f %p'
recovery_target_time = '$TARGET_TIME'
recovery_target_inclusive = true
recovery_target_action = 'promote'
EOF
touch "$WORK/restore/recovery.signal"
fix_archive
# postgres alpine UID/GID
docker run --rm -v "$WORK/restore:/data" -v "$WORK/archive:/archive" alpine \
  sh -c "chown -R ${PGUID}:${PGUID} /data /archive && chmod -R u+rwX,a+rX /archive /data"

docker run -d --name "${NAME}-restore" \
  -e POSTGRES_PASSWORD=aura \
  -e POSTGRES_USER=aura \
  -e POSTGRES_DB=aura \
  -v "$WORK/restore:/var/lib/postgresql/data" \
  -v "$WORK/archive:/archive" \
  "$IMG" \
  postgres \
    -c wal_level=replica \
    >/dev/null

for i in $(seq 1 90); do
  if docker exec -u postgres "${NAME}-restore" pg_isready -U aura -d aura >/dev/null 2>&1; then
    IN_REC=$(docker exec -u postgres "${NAME}-restore" psql -U aura -d aura -Atc "SELECT pg_is_in_recovery()" 2>/dev/null || echo t)
    if [[ "$IN_REC" == "f" ]]; then
      break
    fi
  fi
  sleep 1
  [[ "$i" -eq 90 ]] && {
    docker logs "${NAME}-restore" 2>&1 | tail -50 >&2
    fail "restore not ready"
  }
done
REPLAY_END=$(utc_now)

VERIFY=$(docker exec -u postgres "${NAME}-restore" psql -U aura -d aura -Atc \
  "SELECT label FROM drill_markers ORDER BY id")
echo "$VERIFY" | grep -qx 'seed' || fail "missing seed (got: $VERIFY)"
echo "$VERIFY" | grep -qx 'pre_incident' || fail "missing pre_incident (got: $VERIFY)"
echo "$VERIFY" | grep -q 'lost_after_incident' && fail "should not recover post-incident row"
NEWEST=$(docker exec -u postgres "${NAME}-restore" psql -U aura -d aura -Atc \
  "SELECT max(created_at) FROM drill_markers")
VERIFY_END=$(utc_now)

sleep 1
CUTOVER_END=$(utc_now)

export NEWEST
NEWEST_ISO=$(python3 - <<'PY'
from datetime import datetime, timezone
import os, re
s = os.environ["NEWEST"].strip().replace(" ", "T")
s = re.sub(r"\+00$", "+00:00", s)
s = re.sub(
    r"\.(\d+)([+-]\d{2}:\d{2}|Z)$",
    lambda m: "." + m.group(1).ljust(6, "0")[:6] + m.group(2),
    s,
)
dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
print(dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z")
PY
)

python3 - <<PY
import json
from pathlib import Path
rec = {
  "drill_id": "lab-1",
  "mode": "lab",
  "ticket": "996b3f7e",
  "bucket": "aura-pg",
  "method": "postgres-16-wal-archive-pitr",
  "incident_at": "$INCIDENT_AT",
  "newest_verified_at": "$NEWEST_ISO",
  "recovery_target_time": "$TARGET_ISO",
  "phases": {
    "restore_start": "$RESTORE_START",
    "replay_end": "$REPLAY_END",
    "verify_end": "$VERIFY_END",
    "dsn_cutover_end": "$CUTOVER_END",
  },
  "notes": "Local Docker Postgres WAL archive PITR (CNPG Barman Cloud path stand-in). Production cutover = Pooler DSN flip on recovered Cluster.",
}
Path("$OUT").write_text(json.dumps(rec, indent=2) + "\n")
print("wrote", "$OUT")
PY

node - <<NODE
const { measureDrill, loadDrillRecord } = require("$ROOT/services/ops/pitr-drill/measure.js");
const m = measureDrill(loadDrillRecord());
if (!m.pass) {
  console.error("FAIL budgets", m);
  process.exit(1);
}
console.log(JSON.stringify({ rpo_ms: m.rpo_ms, rto_ms: m.rto_ms, pass: m.pass, phase_ms: m.phase_ms }, null, 2));
NODE

echo "run-pg-pitr-lab-drill: PASS"
