#!/usr/bin/env bash
# M3 static gate: MCP/bundle isolation policy (doc-only; no live RuntimeClass/Egress).
# Validates deploy/docs/mcp-bundle-isolation.md + ARCHITECTURE §9.1 + ROADMAP.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/mcp-bundle-isolation.md"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
DESIGN="$ROOT/services/mcp-invoke/DESIGN.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"

grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -Eqi 'deny-default|deny default' "$DOC" || fail "doc must fix Egress deny-default"
grep -Eqi 'NetworkPolicy' "$DOC" || fail "doc must name NetworkPolicy"
grep -Eqi 'gVisor|runsc' "$DOC" || fail "doc must pin gVisor/runsc as M3 default RuntimeClass"
grep -Eqi 'Kata' "$DOC" || fail "doc must name Kata as high-risk tier"
grep -Eqi 'RuntimeClass' "$DOC" || fail "doc must name RuntimeClass"
grep -Eqi 'allowlist|허용' "$DOC" || fail "doc must define Egress allowlist"
grep -Eqi 'LLM Gateway|llm-gateway' "$DOC" || fail "doc allowlist must include LLM Gateway"
grep -Eqi 'Pooler|NATS' "$DOC" || fail "doc allowlist must include Pooler and NATS"
grep -Eqi 'object store|Garage|aura-content' "$DOC" || fail "doc allowlist must include object store"
grep -Eqi 'mcp.*(host|endpoint)|허용 MCP|Streamable' "$DOC" || fail "doc allowlist must cover allowed MCP hosts"
grep -Eqi '서명|signature|checksum' "$DOC" || fail "doc must define platform signature vs custom"
grep -Eqi '미서명|unsigned|커스텀' "$DOC" || fail "doc must forbid unsigned custom without sandbox"
grep -Eqi '실측|live|본구현' "$DOC" || fail "doc must mark live Egress/RuntimeClass as Non-goal or follow-up"

[[ -f "$ARCH" ]] || fail "missing $ARCH"
grep -q 'mcp-bundle-isolation.md' "$ARCH" || fail "ARCHITECTURE must link mcp-bundle-isolation.md"
grep -Eqi 'gVisor|runsc' "$ARCH" || fail "ARCHITECTURE §9.1 must name gVisor"

[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"
grep -Eq '\[x\].*격리 수준 정의|\[x\].*Egress deny-default|\[x\].*RuntimeClass' "$ROADMAP" \
  || fail "ROADMAP isolation policy checkbox must be [x]"
grep -Eqi 'gVisor|runsc' "$ROADMAP" || fail "ROADMAP decision log must pin gVisor"

[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
grep -q 'mcp-bundle-isolation' "$DESIGN" || fail "mcp-invoke DESIGN must link isolation policy"

[[ -f "$SETUP" ]] || fail "missing $SETUP"
grep -q 'check-mcp-bundle-isolation' "$SETUP" || fail "SETUP must name check-mcp-bundle-isolation.sh"

[[ -f "$AGENTS" ]] || fail "missing $AGENTS"
grep -q 'mcp-bundle-isolation' "$AGENTS" || fail "AGENTS must mention mcp-bundle-isolation"

ok "mcp-bundle-isolation policy + §9.1 + ROADMAP + DESIGN/SETUP/AGENTS"
echo "check-mcp-bundle-isolation: PASS"
