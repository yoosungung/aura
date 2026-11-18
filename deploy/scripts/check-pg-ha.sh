#!/usr/bin/env bash
# M1 static gate: Multi-AZ/PITR draft shape (no cluster required).
# Validates cluster-ha.draft.yaml + pg-ha-pitr-topology.md. Exit 0 on PASS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG_DIR="$ROOT/deploy/k8s/pg-pooler"
DRAFT="$PG_DIR/cluster-ha.draft.yaml"
DOC="$ROOT/deploy/docs/pg-ha-pitr-topology.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DRAFT" ]] || fail "missing $DRAFT"
[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$PG_DIR/cluster.yaml" ]] || fail "missing smoke cluster.yaml"
[[ -f "$PG_DIR/kustomization.yaml" ]] || fail "missing kustomization.yaml"

# Smoke default stays instances=1; draft must not be in kustomization.
ruby - "$PG_DIR" <<'RUBY'
require "yaml"
require "pathname"
dir = Pathname(ARGV[0])
smoke = YAML.load_stream((dir / "cluster.yaml").read).compact.first
inst = smoke.dig("spec", "instances")
abort "FAIL: smoke cluster.yaml instances must be 1 (got #{inst.inspect})" unless inst == 1
puts "OK: smoke cluster.yaml instances=1"

kust = YAML.load_file(dir / "kustomization.yaml")
res = Array(kust["resources"]).map(&:to_s)
if res.any? { |r| r.include?("cluster-ha") || r.include?("draft") }
  abort "FAIL: kustomization must not include HA draft (got #{res.inspect})"
end
puts "OK: kustomization excludes HA draft"
RUBY

ruby - "$DRAFT" <<'RUBY'
require "yaml"
docs = YAML.load_stream(File.read(ARGV[0])).compact
errors = []

clusters = docs.select { |d| d.is_a?(Hash) && d["kind"] == "Cluster" && d.dig("metadata", "name") == "aura-pg" }
errors << "draft: Cluster aura-pg required" if clusters.empty?

clusters.each do |doc|
  api = doc["apiVersion"].to_s
  errors << "Cluster: apiVersion postgresql.cnpg.io/* required" unless api.start_with?("postgresql.cnpg.io/")
  inst = doc.dig("spec", "instances").to_i
  errors << "Cluster: instances must be >= 3 (got #{inst})" if inst < 3

  aff = doc.dig("spec", "affinity") || {}
  topo = aff["topologyKey"].to_s
  spreads = doc.dig("spec", "topologySpreadConstraints")
  zone_ok = topo == "topology.kubernetes.io/zone" ||
            (spreads.is_a?(Array) && spreads.any? { |s| s["topologyKey"].to_s == "topology.kubernetes.io/zone" })
  errors << "Cluster: zone topologyKey (affinity or topologySpreadConstraints) required" unless zone_ok

  backup = doc.dig("spec", "backup")
  errors << "Cluster: spec.backup required" unless backup.is_a?(Hash)
  barman = backup.is_a?(Hash) ? backup["barmanObjectStore"] : nil
  errors << "Cluster: backup.barmanObjectStore required" unless barman.is_a?(Hash)
  dest = barman.is_a?(Hash) ? barman["destinationPath"].to_s : ""
  errors << "Cluster: barmanObjectStore.destinationPath required" if dest.empty?
end

ro = docs.select { |d| d.is_a?(Hash) && d["kind"] == "Pooler" && d.dig("metadata", "name") == "aura-pg-pooler-ro" }
errors << "draft: Pooler aura-pg-pooler-ro (type=ro) required for recall plan" if ro.empty?
ro.each do |doc|
  errors << "pooler-ro: type must be ro" unless doc.dig("spec", "type").to_s == "ro"
  mode = doc.dig("spec", "pgbouncer", "poolMode").to_s
  errors << "pooler-ro: poolMode must be transaction" unless mode == "transaction"
  errors << "pooler-ro: cluster.name must be aura-pg" unless doc.dig("spec", "cluster", "name").to_s == "aura-pg"
end

if errors.any?
  errors.each { |e| warn "FAIL: #{e}" }
  exit 1
end
puts "OK: HA draft instances>=3 + zone + barman + pooler-ro"
RUBY

grep -q 'RPO' "$DOC" && grep -q '≤ 5' "$DOC" || fail "doc must state RPO ≤ 5m"
grep -q 'RTO' "$DOC" && grep -q '≤ 1' "$DOC" || fail "doc must state RTO ≤ 1h"
grep -qi 'pooler-ro\|type: ro\|Read Replica' "$DOC" || fail "doc must include recall Read Replica / RO Pooler plan"
ok "pg-ha-pitr-topology.md RPO/RTO + Read Replica plan"

echo "check-pg-ha: PASS"
