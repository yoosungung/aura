#!/usr/bin/env bash
# M1+M4 gate: TTL policy + CronJob one-shot (no always-on Deployment).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
POLICY="$ROOT/deploy/docs/memory-ttl-policy.md"
DOC="$ROOT/deploy/docs/memory-ttl-drop.md"
HANDLERS="$ROOT/services/memory/src/handlers.rs"
BATCH="$ROOT/services/memory/src/batch_payload.rs"
K8S_DIR="$ROOT/deploy/k8s/memory-ttl"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"
ARCH="$ROOT/ARCHITECTURE.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$POLICY" ]] || fail "missing $POLICY"
[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$HANDLERS" ]] || fail "missing handlers.rs"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

grep -q "14일\|14 days\|interval '14 days'" "$POLICY" || fail "policy must fix short_term hot = 14 days"
grep -q "24개월\|24 months\|interval '24 months'" "$POLICY" || fail "policy must fix episodic hot = 24 months"
grep -q "12개월\|12 months\|interval '12 months'" "$POLICY" || fail "policy must fix audit hot = 12 months"
grep -q 'aura.tasks.memory.ttl' "$POLICY" || fail "policy must name aura.tasks.memory.ttl"
grep -qi 'DROP' "$POLICY" || fail "policy must state partition DROP"

grep -q 'handle_ttl_request' "$HANDLERS" || fail "handlers.rs must include handle_ttl_request"
grep -q 'hot_days: Option\|hot_days' "$BATCH" || grep -q '14' "$BATCH" || fail "batch_payload must encode hot window days"
grep -Eq 'memory-ttl-drop\.md|aura\.tasks\.memory\.ttl' "$DESIGN" || fail "DESIGN must cover ttl"
grep -Eq 'memory-ttl-policy\.md' "$ARCH" || fail "ARCHITECTURE must link memory-ttl-policy.md"
grep -Eq '\[x\].*aura\.tasks\.memory\.ttl' "$ROADMAP" || fail "ROADMAP M4 ttl checkbox must be [x]"

(cd "$ROOT" && cargo test -p aura-memory --lib batch_payload --offline) || fail "batch_payload tests failed"

CJ="$K8S_DIR/cronjob.yaml"
[[ -f "$CJ" ]] || fail "missing cronjob.yaml"
[[ ! -f "$K8S_DIR/deployment.yaml" ]] || fail "batch Deployment must be removed (CronJob-only)"
grep -q 'aura/memory-batch' "$CJ" || fail "cronjob image aura/memory-batch"
grep -q '/aura-memory-ttl' "$CJ" || fail "cronjob must run /aura-memory-ttl"
grep -q 'cronjob.yaml' "$K8S_DIR/kustomization.yaml" || fail "kustomization must list cronjob"

ok "memory ttl policy + CronJob one-shot"
echo "check-memory-ttl: PASS"
