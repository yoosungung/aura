#!/usr/bin/env bash
# M2 static gate: Agent prompt inject slots + token budgets (doc + ARCHITECTURE).
# Exit 0 on PASS. Ticket e9ef0dd8. Non-goal: agent_invoke packing impl (M3).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/agent-inject-contract.md"
ARCH="$ROOT/ARCHITECTURE.md"
DESIGN="$ROOT/services/memory/DESIGN.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"

# Source of truth: recall RPC only; no raw dump.
grep -q 'aura.rpc.memory.recall' "$DOC" || fail "doc must require aura.rpc.memory.recall"
grep -Eqi '원문|dump|덤프' "$DOC" || fail "doc must ban full-text dump"
grep -qi 'Non-goals\|본구현\|M3' "$DOC" || fail "doc must state Non-goals / M3 impl"

# Slot separation (ARCHITECTURE §6.3 step 6).
grep -qi 'short_term' "$DOC" || fail "doc must name short_term slot"
grep -qi 'episodic' "$DOC" || fail "doc must name episodic slot"
grep -Eqi 'long_term.*semantic|semantic.*long_term' "$DOC" \
  || fail "doc must name long_term+semantic slot"

# Fixed token budgets (M2 lock).
grep -qE 'total[^0-9]*2048|\*\*2048\*\*|2048.*token' "$DOC" \
  || fail "doc must fix total memory inject = 2048 tokens"
grep -qE 'short_term[^0-9]*512|\*\*512\*\*.*short_term|short_term.*\*\*512\*\*' "$DOC" \
  || fail "doc must fix short_term slot = 512 tokens"
grep -qE 'episodic[^0-9]*768|\*\*768\*\*.*episodic|episodic.*\*\*768\*\*' "$DOC" \
  || fail "doc must fix episodic slot = 768 tokens"
grep -qE 'long_term[^0-9]*768|semantic[^0-9]*768|\*\*768\*\*.*long_term|long_term.*\*\*768\*\*' "$DOC" \
  || fail "doc must fix long_term+semantic slot = 768 tokens"

# Item-count alignment with recall defaults.
grep -qE 'short_term[^0-9]*4|\*\*4\*\*.*short_term|슬롯[^0-9]*4|budget[^0-9]*4' "$DOC" \
  || fail "doc must align short_term item budget = 4"
grep -qE 'top_k[^0-9]*12|\*\*12\*\*|default.*12' "$DOC" \
  || fail "doc must align default top_k = 12"

# ARCHITECTURE must cite the locked numbers (not placeholder-only).
grep -q '2048' "$ARCH" || fail "ARCHITECTURE must lock total inject 2048"
grep -qE '512' "$ARCH" || fail "ARCHITECTURE must lock short_term 512"
grep -Eq 'agent-inject-contract\.md' "$ARCH" \
  || fail "ARCHITECTURE §6.3 must link deploy/docs/agent-inject-contract.md"

# DESIGN pointer (recall is only injectable surface).
grep -Eqi 'inject|주입' "$DESIGN" || fail "services/memory/DESIGN.md must point at Agent inject contract"

ok "agent-inject-contract.md slots + token budgets + ARCHITECTURE link"
echo "check-agent-inject-contract: PASS"
