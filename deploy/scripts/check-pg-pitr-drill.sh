#!/usr/bin/env bash
# M4 static gate: PG PITR drill #1 RPO/RTO evidence (ARCHITECTURE §9.6).
# Exit 0 on PASS. Ticket 996b3f7e. Non-goals: live CNPG · Docker required in CI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/pg-pitr-drill.md"
TOPO="$ROOT/deploy/docs/pg-ha-pitr-topology.md"
DESIGN="$ROOT/services/ops/DESIGN.md"
MEASURE="$ROOT/services/ops/pitr-drill/measure.js"
SELFTEST="$ROOT/services/ops/pitr-drill/measure.selftest.js"
RECORD="$ROOT/services/ops/pitr-drill/drill-1.record.json"
LAB="$ROOT/deploy/scripts/run-pg-pitr-lab-drill.sh"
SMOKE="$ROOT/deploy/scripts/smoke-pg-pitr-drill.sh"
RESTORE="$ROOT/deploy/k8s/pg-pooler/cluster-pitr-restore.draft.yaml"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$TOPO" ]] || fail "missing $TOPO"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$MEASURE" ]] || fail "missing $MEASURE"
[[ -f "$SELFTEST" ]] || fail "missing $SELFTEST"
[[ -f "$RECORD" ]] || fail "missing $RECORD"
[[ -f "$LAB" ]] || fail "missing $LAB"
[[ -f "$SMOKE" ]] || fail "missing $SMOKE"
[[ -f "$RESTORE" ]] || fail "missing $RESTORE"

grep -q 'RPO_BUDGET_MS' "$MEASURE" || fail "measure must define RPO_BUDGET_MS"
grep -q 'RTO_BUDGET_MS' "$MEASURE" || fail "measure must define RTO_BUDGET_MS"
grep -q 'measureDrill' "$MEASURE" || fail "measure must export measureDrill"
grep -q '5 \* 60 \* 1000\|5\*60\*1000' "$MEASURE" || fail "RPO budget must be 5 minutes"
grep -q '60 \* 60 \* 1000\|60\*60\*1000' "$MEASURE" || fail "RTO budget must be 1 hour"

grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -q 'lab-1' "$DOC" || fail "doc must record drill lab-1"
grep -Eqi 'RPO|RTO' "$DOC" || fail "doc must discuss RPO/RTO"
grep -q 'cluster-pitr-restore' "$DOC" || fail "doc must link restore draft"
grep -q 'pg-pitr-drill.md' "$DESIGN" || fail "DESIGN must link pg-pitr-drill.md"
grep -Eqi 'drill|실측|M4' "$TOPO" || fail "topology doc must point at M4 drill"

# Restore draft shape: recovery bootstrap + barman external cluster + not in kustomization
grep -q 'bootstrap' "$RESTORE" || fail "restore draft must have bootstrap"
grep -q 'recoveryTarget\|targetTime' "$RESTORE" || fail "restore draft must set recoveryTarget/targetTime"
grep -q 'barmanObjectStore\|externalClusters' "$RESTORE" || fail "restore draft must reference barman externalClusters"
grep -q 'aura-pg' "$RESTORE" || fail "restore draft must mention aura-pg path"
ruby - "$ROOT/deploy/k8s/pg-pooler" <<'RUBY' || fail "kustomization must exclude pitr restore draft"
require "yaml"
require "pathname"
dir = Pathname(ARGV[0])
kust = YAML.load_file(dir / "kustomization.yaml")
res = Array(kust["resources"]).map(&:to_s)
if res.any? { |r| r.include?("pitr-restore") || r.include?("cluster-pitr") }
  abort "FAIL: kustomization includes pitr restore draft"
end
puts "OK: kustomization excludes pitr restore draft"
RUBY

grep -Eq 'pg-pitr-drill\.md|PITR.*드릴|드릴.*PITR' "$ARCH" \
  || fail "ARCHITECTURE must link pg-pitr-drill"
grep -Eq '\[x\].*PITR|\[x\].*복구 드릴' "$ROADMAP" \
  || fail "ROADMAP PITR drill checkbox must be [x]"
grep -q 'check-pg-pitr-drill' "$SETUP" || fail "SETUP must name check-pg-pitr-drill.sh"
grep -Eqi 'pg-pitr-drill|PITR 드릴|pitr-drill' "$AGENTS" \
  || fail "AGENTS must mention PITR drill"


# Record must pass budgets (numbers may refresh if lab re-run)
node - <<NODE
const { measureDrill, loadDrillRecord, RPO_BUDGET_MS, RTO_BUDGET_MS } = require("$MEASURE");
const rec = loadDrillRecord();
const m = measureDrill(rec);
if (!m.pass) {
  console.error("FAIL: drill record exceeds budgets", m);
  process.exit(1);
}
if (m.rpo_ms > RPO_BUDGET_MS || m.rto_ms > RTO_BUDGET_MS) process.exit(1);
if (rec.mode !== "lab" && rec.mode !== "cluster") {
  console.error("FAIL: mode");
  process.exit(1);
}
console.log("record-ok", { rpo_ms: m.rpo_ms, rto_ms: m.rto_ms });
NODE

node "$SELFTEST" || fail "selftest failed"

ok "PG PITR drill #1 RPO/RTO evidence"
echo "check-pg-pitr-drill: PASS"
