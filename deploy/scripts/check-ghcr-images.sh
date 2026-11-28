#!/usr/bin/env bash
# Static gate: GHCR image publish policy (latest + sha-<short>, retain 3).
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

for img in gateway llm-gateway control-admin control-resolve admin-ui \
  nats-rpc-bridge nats-task-bridge memory-capture memory-recall memory-batch \
  compliance-erase; do
  grep -q "$img" "$DOC" || fail "doc must list $img"
  grep -q "aura-$img\|aura-${img}" "$WF" || fail "workflow must build aura-$img"
done

grep -q 'ghcr.io' "$WF" || fail "workflow must push to ghcr.io"
grep -q 'latest' "$WF" || fail "workflow must tag latest"
grep -Eq 'sha-|type=sha' "$WF" || fail "workflow must tag sha-<short>"
grep -Eq 'keep-n-tagged:\s*['\''\"]?3['\''\"]?' "$WF" \
  || fail "workflow cleanup must keep-n-tagged: 3"

grep -q 'services/control/Dockerfile.resolve' "$WF" || fail "workflow must build control-resolve"
grep -q 'services/memory/Dockerfile.capture' "$WF" || fail "workflow must build memory-capture"
grep -q 'services/memory/Dockerfile.recall' "$WF" || fail "workflow must build memory-recall"
grep -q 'services/memory/Dockerfile.batch' "$WF" || fail "workflow must build memory-batch"
grep -q 'services/compliance/Dockerfile' "$WF" || fail "workflow must build compliance-erase"
grep -q 'services/gateway/Dockerfile' "$WF" || fail "gateway must use services/gateway/Dockerfile"
grep -q 'services/admin-ui/Dockerfile' "$WF" || fail "admin-ui must use root context Dockerfile"

grep -q 'ghcr-images.md' "$AGENTS" || fail "AGENTS §1 must list ghcr-images.md"
grep -q 'images.yml' "$AGENTS" || fail "AGENTS must name .github/workflows/images.yml"
grep -q 'ghcr-images' "$ROADMAP" || fail "ROADMAP must record ghcr-images decision"

for dep in \
  "$ROOT/deploy/k8s/gateway/deployment.yaml" \
  "$ROOT/deploy/k8s/llm-gateway/deployment.yaml" \
  "$ROOT/deploy/k8s/control-admin/deployment.yaml" \
  "$ROOT/deploy/k8s/control-resolve/deployment.yaml" \
  "$ROOT/deploy/k8s/admin-ui/deployment.yaml" \
  "$ROOT/deploy/k8s/nats-rpc-bridge/deployment.yaml" \
  "$ROOT/deploy/k8s/nats-task-bridge/deployment.yaml" \
  "$ROOT/deploy/k8s/memory-capture/deployment.yaml" \
  "$ROOT/deploy/k8s/memory-recall/deployment.yaml" \
  "$ROOT/deploy/k8s/compliance-erase/deployment.yaml" \
  "$ROOT/deploy/k8s/memory-ttl/cronjob.yaml"
do
  grep -q ':local' "$dep" || fail "$(basename "$(dirname "$dep")")/$(basename "$dep") must remain :local"
done

ok "ghcr-images policy + workflow + :local lab pin"
echo "check-ghcr-images: PASS"
