#!/usr/bin/env bash
# M3.6: python env + layout + parity pytest + nodejs path still present.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -f "$ROOT/deploy/k8s/runtime-envs/aura-python-async.yaml" ]] || fail "missing aura-python-async"
[[ -f "$ROOT/deploy/k8s/runtime-envs/aura-python-sync.yaml" ]] || fail "missing aura-python-sync"
grep -q 'poolsize: 2' "$ROOT/deploy/k8s/runtime-envs/aura-python-sync.yaml" \
  || fail "python-sync poolsize must be 2"
[[ -d "$ROOT/services/agent-invoke/nodejs" ]] || fail "missing agent-invoke/nodejs"
[[ -d "$ROOT/services/agent-invoke/python" ]] || fail "missing agent-invoke/python"
[[ -d "$ROOT/services/mcp-invoke/nodejs" ]] || fail "missing mcp-invoke/nodejs"
[[ -d "$ROOT/services/mcp-invoke/python" ]] || fail "missing mcp-invoke/python"
[[ -f "$ROOT/deploy/sql/control_meta.sql" ]] || fail "missing control_meta.sql"
grep -q "runtime" "$ROOT/deploy/sql/control_meta.sql" || fail "source_meta.runtime missing"
grep -q "chk_source_meta_runtime" "$ROOT/deploy/sql/control_meta.sql" || fail "runtime CHECK missing"

bash "$ROOT/deploy/scripts/build-agent-invoke-python-archive.sh" || fail "agent py archive"
bash "$ROOT/deploy/scripts/build-mcp-invoke-python-archive.sh" || fail "mcp py archive"
[[ -f "$ROOT/deploy/k8s/agent-invoke-py/archive.zip" ]] || fail "missing agent-invoke-py zip"
[[ -f "$ROOT/deploy/k8s/mcp-invoke-py/archive.zip" ]] || fail "missing mcp-invoke-py zip"

# Node regression paths
node "$ROOT/services/control/resolve.selftest.js" || fail "resolve.selftest"
node "$ROOT/services/agent-invoke/nodejs/handler.selftest.js" || fail "agent nodejs selftest"
node "$ROOT/services/mcp-invoke/nodejs/handler.selftest.js" || fail "mcp nodejs selftest"
bash "$ROOT/deploy/scripts/check-nats-task-bridge.sh" || fail "task-bridge check"

# Python parity via .venv
VENV="$ROOT/services/agent-invoke/python/.venv"
if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q pytest pytest-asyncio
fi
"$VENV/bin/pip" install -q pytest pytest-asyncio >/dev/null
(
  cd "$ROOT/services/agent-invoke/python"
  "$VENV/bin/pytest" -q
)
MCP_VENV="$ROOT/services/mcp-invoke/python/.venv"
if [[ ! -d "$MCP_VENV" ]]; then
  python3 -m venv "$MCP_VENV"
fi
"$MCP_VENV/bin/pip" install -q pytest pytest-asyncio >/dev/null
(
  cd "$ROOT/services/mcp-invoke/python"
  "$MCP_VENV/bin/pytest" -q
)

echo "check-python-env-parity: PASS"
