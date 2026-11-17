#!/usr/bin/env bash
# V0.1 static gate: async MQT (scale-to-zero) vs sync Warm (minScale>=2) are separate.
# No cluster required. Exit 0 only when invariants hold.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ASYNC_DIR="$ROOT/deploy/k8s/async-smoke"
SYNC_DIR="$ROOT/deploy/k8s/sync-smoke"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -d "$ASYNC_DIR" ]] || fail "missing $ASYNC_DIR"
[[ -d "$SYNC_DIR" ]] || fail "missing $SYNC_DIR"
[[ -n "$(ls -A "$ASYNC_DIR"/*.yaml 2>/dev/null || true)" ]] || fail "async-smoke has no yaml"
[[ -n "$(ls -A "$SYNC_DIR"/*.yaml 2>/dev/null || true)" ]] || fail "sync-smoke has no yaml"

ruby - "$ASYNC_DIR" "$SYNC_DIR" <<'RUBY'
require "yaml"
require "pathname"

async_dir, sync_dir = ARGV.map { |p| Pathname(p) }

def load_docs(dir)
  dir.glob("*.yaml").flat_map do |path|
    YAML.load_stream(path.read).compact.map { |doc| [path.basename.to_s, doc] }
  end
end

def kinds(docs, kind)
  docs.select { |_n, d| d.is_a?(Hash) && d["kind"] == kind }
end

errors = []
async_docs = load_docs(async_dir)
sync_docs = load_docs(sync_dir)

# --- async: MQT owns scale-to-zero; no hand-rolled ScaledObject ---
mqts = kinds(async_docs, "MessageQueueTrigger")
errors << "async-smoke: MessageQueueTrigger required" if mqts.empty?
mqts.each do |name, doc|
  labels = (doc.dig("metadata", "labels") || {})
  spec = doc["spec"] || {}
  meta = spec["metadata"] || {}
  errors << "#{name}: label aura.runtime/class=async required" unless labels["aura.runtime/class"] == "async"
  errors << "#{name}: messageQueueType must be nats-jetstream" unless spec["messageQueueType"] == "nats-jetstream"
  errors << "#{name}: mqtkind must be keda" unless spec["mqtkind"].to_s.downcase == "keda"
  errors << "#{name}: minReplicaCount must be 0 (scale-to-zero)" unless spec["minReplicaCount"] == 0
  errors << "#{name}: metadata.stream must be AURA_TASKS" unless meta["stream"] == "AURA_TASKS"
  errors << "#{name}: metadata.consumer required" if meta["consumer"].to_s.empty?
  errors << "#{name}: topic must be aura.tasks.smoke" unless spec["topic"] == "aura.tasks.smoke"
  errors << "#{name}: respTopic must be aura.events.tasks.smoke.done" unless spec["respTopic"] == "aura.events.tasks.smoke.done"
  errors << "#{name}: errorTopic must be aura.events.tasks.smoke.error" unless spec["errorTopic"] == "aura.events.tasks.smoke.error"
  errors << "#{name}: metadata.consumer must be aura_tasks_smoke" unless meta["consumer"] == "aura_tasks_smoke"
  retries = spec["maxRetries"]
  if retries.nil? || retries.to_i < 1 || retries.to_i > 10
    errors << "#{name}: maxRetries must be finite 1..10 (got #{retries.inspect}) — V0.3 poison isolation"
  end
end
errors << "async-smoke: do not hand-roll ScaledObject (Fission MQT creates it)" unless kinds(async_docs, "ScaledObject").empty?

# --- async Package literal must match echo.js (not skeleton) ---
echo_path = async_dir.join("echo.js")
errors << "async-smoke: echo.js required" unless echo_path.file?
echo_src = echo_path.file? ? echo_path.read : ""
errors << "async-smoke: echo.js missing tasks.smoke.done marker" unless echo_src.include?("tasks.smoke.done")
errors << "async-smoke: echo.js missing aura_smoke fail path" unless echo_src.include?("aura_smoke")
pkgs = kinds(async_docs, "Package")
errors << "async-smoke: Package required" if pkgs.empty?
pkgs.each do |name, doc|
  lit = doc.dig("spec", "deployment", "literal").to_s
  errors << "#{name}: deployment.literal required" if lit.empty?
  next if lit.empty?
  require "base64"
  begin
    decoded = Base64.decode64(lit)
  rescue StandardError => e
    errors << "#{name}: literal base64 decode failed: #{e}"
    next
  end
  # Compare as binary — echo.js may contain UTF-8 (e.g. em dash) while Base64.decode64 is ASCII-8BIT.
  errors << "#{name}: literal must equal echo.js" unless decoded.b == echo_src.b
  errors << "#{name}: skeleton body forbidden" if decoded.include?("aura-skeleton")
end

afns = kinds(async_docs, "Function")
errors << "async-smoke: Function required" if afns.empty?
afns.each do |name, doc|
  labels = (doc.dig("metadata", "labels") || {})
  errors << "#{name}: label aura.runtime/class=async required" unless labels["aura.runtime/class"] == "async"
  strat = doc.dig("spec", "InvokeStrategy", "ExecutionStrategy") ||
          doc.dig("spec", "invokeStrategy", "executionStrategy") || {}
  mins = strat.key?("MinScale") ? strat["MinScale"] : strat["minScale"]
  if !mins.nil? && mins.to_i >= 2
    errors << "#{name}: async Function must not set MinScale>=2 (scale lives on MQT)"
  end
end

# --- sync: newdeploy Warm Pool; no JetStream MQT / ScaledObject ---
errors << "sync-smoke: MessageQueueTrigger forbidden (no JetStream MQT)" unless kinds(sync_docs, "MessageQueueTrigger").empty?
errors << "sync-smoke: ScaledObject forbidden (no JetStream lag scaler)" unless kinds(sync_docs, "ScaledObject").empty?

fns = kinds(sync_docs, "Function")
errors << "sync-smoke: Function required" if fns.empty?
fns.each do |name, doc|
  labels = (doc.dig("metadata", "labels") || {})
  errors << "#{name}: label aura.runtime/class=sync required" unless labels["aura.runtime/class"] == "sync"
  strat = doc.dig("spec", "InvokeStrategy", "ExecutionStrategy") ||
          doc.dig("spec", "invokeStrategy", "executionStrategy") || {}
  et = strat["ExecutorType"] || strat["executorType"]
  mins = strat.key?("MinScale") ? strat["MinScale"] : strat["minScale"]
  errors << "#{name}: ExecutorType must be newdeploy (got #{et.inspect})" unless et.to_s.downcase == "newdeploy"
  errors << "#{name}: MinScale must be >= 2 (got #{mins.inspect})" if mins.nil? || mins.to_i < 2
end

# --- sync Core RR responder (ARCHITECTURE §4.3 explicit Deployment) ---
rr = kinds(sync_docs, "Deployment").select { |_n, d| d.dig("metadata", "name") == "aura-rpc-smoke-rr" }
errors << "sync-smoke: Deployment aura-rpc-smoke-rr required (Core RR)" if rr.empty?
rr.each do |name, doc|
  labels = (doc.dig("metadata", "labels") || {})
  errors << "#{name}: label aura.runtime/class=sync required" unless labels["aura.runtime/class"] == "sync"
  replicas = doc.dig("spec", "replicas")
  errors << "#{name}: replicas must be >= 2 (got #{replicas.inspect})" if replicas.nil? || replicas.to_i < 2
  containers = doc.dig("spec", "template", "spec", "containers") || []
  reply = containers.find { |c| c["name"] == "reply" } || containers.first || {}
  args = Array(reply["args"]).join(" ")
  cmd = Array(reply["command"]).join(" ") + " " + args
  errors << "#{name}: must nats-reply subject aura.rpc.smoke" unless cmd.include?("aura.rpc.smoke") || Array(reply.dig("env")).any? { |e| e["name"] == "RPC_SUBJECT" && e["value"] == "aura.rpc.smoke" }
  q_ok = cmd.include?("aura-rpc-smoke") || Array(reply.dig("env")).any? { |e| e["name"] == "RPC_QUEUE" && e["value"] == "aura-rpc-smoke" }
  errors << "#{name}: must use queue-group aura-rpc-smoke" unless q_ok
  errors << "#{name}: reply body must mark rpc.smoke.done" unless cmd.include?("rpc.smoke.done")
end

if errors.any?
  errors.each { |e| warn "FAIL: #{e}" }
  exit 1
end
puts "invariants-ok"
RUBY

ok "V0.1/V0.2 split-deploy invariants (async MQT min=0 · sync newdeploy min≥2 · aura-rpc-smoke-rr · no shared scaler)"
echo
echo "check-split-deploy: PASS"
