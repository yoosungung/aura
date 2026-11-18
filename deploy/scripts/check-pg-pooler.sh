#!/usr/bin/env bash
# M1 static gate: CloudNativePG Pooler = transaction; app DSN host = pooler Service only.
# No cluster required. Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG_DIR="$ROOT/deploy/k8s/pg-pooler"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -d "$PG_DIR" ]] || fail "missing $PG_DIR"
[[ -n "$(ls -A "$PG_DIR"/*.yaml 2>/dev/null || true)" ]] || fail "pg-pooler has no yaml"

ruby - "$PG_DIR" <<'RUBY'
require "yaml"
require "pathname"

dir = Pathname(ARGV[0])

def load_docs(dir)
  # *.draft.yaml = HA/PITR reference only (not applied; not gate invariants)
  dir.glob("*.yaml").reject { |p| p.basename.to_s.end_with?(".draft.yaml") }.flat_map do |path|
    YAML.load_stream(path.read).compact.map { |doc| [path.basename.to_s, doc] }
  end
end

errors = []
docs = load_docs(dir)

def kinds(docs, kind)
  docs.select { |_n, d| d.is_a?(Hash) && d["kind"] == kind }
end

clusters = kinds(docs, "Cluster").select { |_n, d| d.dig("metadata", "name") == "aura-pg" }
errors << "pg-pooler: Cluster aura-pg required (Pooler target)" if clusters.empty?
clusters.each do |name, doc|
  api = doc["apiVersion"].to_s
  errors << "#{name}: apiVersion must be postgresql.cnpg.io/* (got #{api})" unless api.start_with?("postgresql.cnpg.io/")
  ns = doc.dig("metadata", "namespace").to_s
  errors << "#{name}: namespace must be aura (got #{ns.inspect})" unless ns.empty? || ns == "aura"
  instances = doc.dig("spec", "instances")
  errors << "#{name}: instances must be >= 1 (got #{instances.inspect})" if instances.nil? || instances.to_i < 1
end

poolers = kinds(docs, "Pooler")
errors << "pg-pooler: Pooler CR required (product = CloudNativePG Pooler)" if poolers.empty?
poolers.each do |name, doc|
  api = doc["apiVersion"].to_s
  errors << "#{name}: apiVersion must be postgresql.cnpg.io/* (got #{api})" unless api.start_with?("postgresql.cnpg.io/")
  pname = doc.dig("metadata", "name").to_s
  errors << "#{name}: metadata.name must be aura-pg-pooler (got #{pname.inspect})" unless pname == "aura-pg-pooler"
  ns = doc.dig("metadata", "namespace").to_s
  errors << "#{name}: namespace must be aura (got #{ns.inspect})" unless ns.empty? || ns == "aura"
  cluster = doc.dig("spec", "cluster", "name").to_s
  errors << "#{name}: spec.cluster.name must be aura-pg (got #{cluster.inspect})" unless cluster == "aura-pg"
  ptype = doc.dig("spec", "type").to_s
  errors << "#{name}: spec.type must be rw (got #{ptype.inspect})" unless ptype == "rw"
  mode = doc.dig("spec", "pgbouncer", "poolMode").to_s
  errors << "#{name}: pgbouncer.poolMode must be transaction (got #{mode.inspect})" unless mode == "transaction"
  instances = doc.dig("spec", "instances")
  errors << "#{name}: instances must be >= 1 (got #{instances.inspect})" if instances.nil? || instances.to_i < 1
end

# App DSN contract: host = pooler Service only (never Cluster -rw / Pod IP).
cms = kinds(docs, "ConfigMap").select { |_n, d| d.dig("metadata", "name") == "aura-pg-dsn" }
errors << "pg-pooler: ConfigMap aura-pg-dsn required (app DSN = pooler only)" if cms.empty?
cms.each do |name, doc|
  data = doc["data"] || {}
  host = data["AURA_DATABASE_HOST"].to_s
  errors << "#{name}: AURA_DATABASE_HOST required" if host.empty?
  unless host.empty?
    errors << "#{name}: AURA_DATABASE_HOST must be pooler Service (got #{host})" unless host.include?("aura-pg-pooler")
    %w[aura-pg-rw aura-pg-r aura-pg-ro].each do |forbidden|
      errors << "#{name}: AURA_DATABASE_HOST must not be Cluster service #{forbidden}" if host.include?(forbidden)
    end
    errors << "#{name}: AURA_DATABASE_HOST must not be a raw Pod IP" if host.match?(/\A\d+\.\d+\.\d+\.\d+\z/)
  end
  port = data["AURA_DATABASE_PORT"].to_s
  errors << "#{name}: AURA_DATABASE_PORT must be 5432 (got #{port.inspect})" unless port == "5432"
  labels = doc.dig("metadata", "labels") || {}
  errors << "#{name}: label aura.db/role=pooler-dsn required" unless labels["aura.db/role"] == "pooler-dsn"
end

# Forbid standalone PgBouncer Deployment in this slice (product = CNPG Pooler).
kinds(docs, "Deployment").each do |name, doc|
  containers = doc.dig("spec", "template", "spec", "containers") || []
  if containers.any? { |c| Array(c["args"]).join(" ").include?("pgbouncer") || c["image"].to_s.include?("pgbouncer") }
    errors << "#{name}: standalone PgBouncer Deployment forbidden — use CNPG Pooler CR"
  end
end

if errors.any?
  errors.each { |e| warn "FAIL: #{e}" }
  exit 1
end
puts "invariants-ok"
RUBY

ok "CNPG Pooler transaction + aura-pg-dsn pooler-only host"
echo
echo "check-pg-pooler: PASS"
