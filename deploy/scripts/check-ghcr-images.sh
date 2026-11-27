#!/usr/bin/env bash
# Static gate: GHCR image publish policy (latest + sha-<short>, retain 3 sha).
# Exit 0 on PASS. Non-goals: live GHCR push · k8s :local → ghcr cutover · multi-arch.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/ghcr-images.md"
WF="$ROOT/.github/workflows/images.yml"
AGENTS="$ROOT/AGENTS.md"
ROADMAP="$ROOT/ROADMAP.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$WF" ]] || fail "missing $WF"

grep -q 'latest' "$DOC" || fail "doc must name latest tag"
grep -q 'sha-' "$DOC" || fail "doc must name sha-<short> tag"
grep -Eq '최근 3|keep.?3|retain.?3|keep-n-tagged:\s*3' "$DOC" \
  || fail "doc must retain last 3 sha tags"
grep -q ':local' "$DOC" || fail "doc must keep k8s :local for lab"
grep -Eq 'gateway|llm-gateway|control-admin|admin-ui|nats-rpc-bridge|nats-task-bridge' "$DOC" \
  || fail "doc must list product images"

grep -q 'ghcr.io' "$WF" || fail "workflow must push to ghcr.io"
grep -q 'latest' "$WF" || fail "workflow must tag latest"
grep -Eq 'sha-|type=sha' "$WF" || fail "workflow must tag sha-<short>"
grep -Eq 'keep-n-tagged:\s*['\''\"]?3['\''\"]?' "$WF" \
  || fail "workflow cleanup must keep-n-tagged: 3"
grep -q 'aura-gateway' "$WF" || fail "workflow must build aura-gateway"
grep -q 'aura-llm-gateway' "$WF" || fail "workflow must build aura-llm-gateway"
grep -q 'aura-control-admin' "$WF" || fail "workflow must build aura-control-admin"
grep -q 'aura-admin-ui' "$WF" || fail "workflow must build aura-admin-ui"
grep -q 'aura-nats-rpc-bridge' "$WF" || fail "workflow must build aura-nats-rpc-bridge"
grep -q 'aura-nats-task-bridge' "$WF" || fail "workflow must build aura-nats-task-bridge"
grep -q 'services/control/Dockerfile' "$WF" || fail "control-admin must use root context Dockerfile"
grep -q 'services/admin-ui/Dockerfile' "$WF" || fail "admin-ui must use root context Dockerfile"

grep -q 'ghcr-images.md' "$AGENTS" || fail "AGENTS §1 must list ghcr-images.md"
grep -q 'images.yml' "$AGENTS" || fail "AGENTS must name .github/workflows/images.yml"
grep -q 'ghcr-images' "$ROADMAP" || fail "ROADMAP must record ghcr-images decision"

# Lab manifests stay on :local (cutover = follow-up)
for dep in \
  "$ROOT/deploy/k8s/gateway/deployment.yaml" \
  "$ROOT/deploy/k8s/llm-gateway/deployment.yaml" \
  "$ROOT/deploy/k8s/control-admin/deployment.yaml" \
  "$ROOT/deploy/k8s/admin-ui/deployment.yaml" \
  "$ROOT/deploy/k8s/nats-rpc-bridge/deployment.yaml" \
  "$ROOT/deploy/k8s/nats-task-bridge/deployment.yaml"
do
  grep -q ':local' "$dep" || fail "$(basename "$(dirname "$dep")") must remain :local"
done

ok "ghcr-images policy + workflow + :local lab pin"
