#!/usr/bin/env bash
# M3 static gate: agent_checkpoints exception-table DDL (§6.1 / §1 #10).
# Exit 0 on PASS. Ticket 24e94cd4. Non-goal: live Pooler writer · resume API · TTL GC.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/agent-checkpoints.md"
SQL="$ROOT/deploy/sql/agent_checkpoints.sql"
ARCH="$ROOT/ARCHITECTURE.md"
DESIGN="$ROOT/services/agent-invoke/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$SQL" ]] || fail "missing $SQL"
[[ -f "$ARCH" ]] || fail "missing $ARCH"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$ROADMAP" ]] || fail "missing $ROADMAP"

# DDL: table + FORCE RLS + tenant GUC + uniqueness
grep -q 'CREATE TABLE agent_checkpoints' "$SQL" || fail "SQL must create agent_checkpoints"
grep -q 'FORCE ROW LEVEL SECURITY' "$SQL" || fail "SQL must FORCE ROW LEVEL SECURITY"
grep -q "current_setting('app.tenant_id'" "$SQL" || fail "RLS must use app.tenant_id GUC"
grep -Eq 'UNIQUE[[:space:]]*\([[:space:]]*tenant_id[[:space:]]*,[[:space:]]*run_id[[:space:]]*,[[:space:]]*seq[[:space:]]*\)' "$SQL" \
  || fail "UNIQUE (tenant_id, run_id, seq) required"
grep -Eqi 'tenant_id|run_id|session_id|principal_id|seq|state|content_ref' "$SQL" \
  || fail "SQL must carry tenant/run/session/principal/seq/state/content_ref columns"
if grep -Eqi '^[[:space:]]*(secret_value|api_key|secret_plain|secrets)[[:space:]]+' "$SQL"; then
  fail "SQL must not store plaintext secret columns"
fi
if grep -Eq "set_config\(\s*'app\.tenant_id'\s*,[^,]+,\s*false\s*\)|SET[[:space:]]+app\.tenant_id" "$SQL"; then
  fail "session-scoped tenant GUC forbidden in DDL"
fi
grep -Eqi "chk_agent_checkpoints_kind|kind[[:space:]].*IN|CHECK \(kind" "$SQL" \
  || fail "SQL must CHECK kind enum-like values"

# Doc: ownership + Pooler + Non-goals
grep -Eqi 'agent_checkpoints' "$DOC" || fail "doc must name agent_checkpoints"
grep -Eqi 'agent_invoke' "$DOC" || fail "doc must name agent_invoke write owner"
grep -Eqi 'Pooler|set_config' "$DOC" || fail "doc must require Pooler + set_config(..., true)"
grep -Eqi 'FORCE RLS|ROW LEVEL SECURITY|app\.tenant_id' "$DOC" \
  || fail "doc must lock FORCE RLS / app.tenant_id"
grep -Eqi 'Zero Direct Write|예외' "$DOC" || fail "doc must frame Zero Direct Write exception"
grep -Eqi 'Non-goals|본구현|후속' "$DOC" || fail "doc must state Non-goals (writer/resume deferred)"
grep -Eqi 'content_ref|256KB|PII' "$DOC" || fail "doc must route large/PII state via content_ref"
grep -Eqi 'plaintext|secrets_ref|시크릿' "$DOC" || fail "doc must forbid plaintext secrets in state"

# Cross-links
grep -Eq 'agent-checkpoints\.md|agent_checkpoints\.sql' "$ARCH" \
  || fail "ARCHITECTURE must link agent-checkpoints.md or agent_checkpoints.sql"
grep -Eqi 'agent_checkpoints' "$ARCH" || fail "ARCHITECTURE must keep agent_checkpoints name"
grep -Eqi '이름 확정은 M3' "$ARCH" && fail "ARCHITECTURE must drop '이름 확정은 M3' once locked"
grep -Eqi 'agent-checkpoints|agent_checkpoints' "$ROADMAP" \
  || fail "ROADMAP must cite agent_checkpoints / agent-checkpoints"
grep -Eqi 'agent-checkpoints|agent_checkpoints' "$DESIGN" \
  || fail "services/agent-invoke/DESIGN.md must point at checkpoints DDL"
grep -Eqi 'agent-checkpoints|agent_checkpoints' "$SETUP" \
  || fail "deploy/SETUP.md must mention agent_checkpoints gate"
grep -Eqi 'agent_checkpoints|agent-checkpoints' "$AGENTS" \
  || fail "AGENTS.md deploy/sql|docs table must mention agent_checkpoints"

ok "agent_checkpoints.sql + agent-checkpoints.md + cross-links"
echo "check-agent-checkpoints: PASS"
