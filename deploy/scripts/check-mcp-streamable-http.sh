#!/usr/bin/env bash
# M3 static gate: mcp_invoke Streamable HTTP client adapter (no live network).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCS="$ROOT/deploy/docs/mcp-streamable-http.md"
DESIGN="$ROOT/services/mcp-invoke/DESIGN.md"
SVC="$ROOT/services/mcp-invoke"
SH="$SVC/streamable-http.js"
HANDLER="$SVC/handler.js"
INVOKE="$ROOT/deploy/k8s/mcp-invoke/invoke.js"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
DUAL="$ROOT/deploy/docs/mcp-invoke-dual.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOCS" ]] || fail "missing $DOCS"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$SH" ]] || fail "missing $SH"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"
[[ -f "$INVOKE" ]] || fail "missing $INVOKE"

grep -q 'mcp_invoke' "$DOCS" || fail "docs must scope mcp_invoke boundary"
grep -Eqi 'NATS|§1 #12' "$DOCS" || fail "docs must state NATS inside / boundary"
grep -Eqi 'Non-goals' "$DOCS" || fail "docs must state Non-goals"
grep -Eqi 'streamable_http|mcp_endpoint' "$DOCS" || fail "docs must name cfg transport"
grep -Eqi 'tools/call|MCP-Protocol-Version' "$DOCS" || fail "docs must name MCP HTTP contract"

grep -q 'streamable-http' "$DESIGN" || fail "DESIGN must link streamable-http"
grep -Eqi 'Non-goals' "$DESIGN" || fail "DESIGN must state Non-goals"
grep -q 'check-mcp-streamable-http' "$DESIGN" || fail "DESIGN Commands must name check script"

grep -q 'buildToolsCallRequest' "$SH" || fail "streamable-http must export buildToolsCallRequest"
grep -q 'parseJsonOrSseResponse' "$SH" || fail "streamable-http must export parseJsonOrSseResponse"
grep -q 'callToolViaStreamableHttp' "$SH" || fail "streamable-http must export callToolViaStreamableHttp"
grep -q 'Mcp-Session-Id' "$SH" || fail "streamable-http must set Mcp-Session-Id"
if grep -Eqi 'console\.(log|info|debug)|Authorization' "$SH"; then
  fail "streamable-http must not console-log or embed Authorization"
fi

grep -q 'callToolViaStreamableHttp\|streamable_http' "$HANDLER" || fail "handler must wire streamable HTTP"
grep -q 'fetchImpl' "$HANDLER" || fail "handler must accept fetchImpl"
if grep -Eq "require\(['\"]pg['\"]\)|set_config|AURA_DATABASE_HOST" "$HANDLER" "$SH"; then
  fail "mcp-invoke streamable sources must not use PG"
fi

grep -q 'callToolViaStreamableHttp' "$INVOKE" || fail "invoke.js bundle must include adapter"
if grep -q "require('./streamable-http')" "$INVOKE"; then
  fail "invoke.js must not require sibling modules"
fi

node "$SVC/streamable-http.selftest.js" || fail "streamable-http.selftest.js failed"
node "$SVC/handler.selftest.js" || fail "handler.selftest.js failed"

PKG="$ROOT/deploy/k8s/mcp-invoke/package.yaml"
python3 - "$PKG" "$INVOKE" <<'PY' || fail "mcp-invoke package literal != invoke.js"
import base64, pathlib, re, sys
pkg, js = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
m = re.search(r"literal:\s*(\S+)", pkg.read_text())
assert m, "no literal in package.yaml"
assert base64.b64decode(m.group(1)) == js.read_bytes(), "literal mismatch"
print("OK: mcp-invoke package literal matches invoke.js")
PY

[[ -f "$ARCH" ]] || fail "missing $ARCH"
grep -q 'mcp-streamable-http.md' "$ARCH" || fail "ARCHITECTURE must link mcp-streamable-http.md"

[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq '\[x\].*Streamable HTTP' "$ROADMAP" \
  || fail "ROADMAP Streamable HTTP checkbox must be [x]"

grep -q 'mcp-streamable-http' "$DUAL" || fail "mcp-invoke-dual must point at streamable doc"

ok "mcp_invoke Streamable HTTP adapter + selftests"
echo "check-mcp-streamable-http: PASS"