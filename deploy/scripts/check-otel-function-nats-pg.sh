#!/usr/bin/env bash
# M4 static gate: OTel Function·NATS·PG attrs + secret masking (ARCHITECTURE §9.2).
# Exit 0 on PASS. Ticket f18e8206. Non-goals: live Collector CI · auto-instrumentation · query params.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/otel-function-nats-pg.md"
DESIGN="$ROOT/services/otel/DESIGN.md"
ATTR="$ROOT/services/otel/attributes.js"
SPANS="$ROOT/services/otel/spans.js"
ATTR_T="$ROOT/services/otel/attributes.selftest.js"
SPANS_T="$ROOT/services/otel/spans.selftest.js"
MASK="$ROOT/services/control/secrets-mask.js"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$ATTR" ]] || fail "missing $ATTR"
[[ -f "$SPANS" ]] || fail "missing $SPANS"
[[ -f "$ATTR_T" ]] || fail "missing $ATTR_T"
[[ -f "$SPANS_T" ]] || fail "missing $SPANS_T"
[[ -f "$MASK" ]] || fail "missing $MASK"

# Required correlation keys
grep -q 'aura.tenant_id' "$ATTR" || fail "attributes must require aura.tenant_id"
grep -q 'aura.session_id' "$ATTR" || fail "attributes must require aura.session_id"
grep -q 'aura.run_id' "$ATTR" || fail "attributes must require aura.run_id"
grep -q 'REQUIRED_CONTEXT_KEYS' "$ATTR" || fail "attributes must export REQUIRED_CONTEXT_KEYS"
grep -q 'sanitizeAttributes\|assertSafeAttributes' "$ATTR" \
  || fail "attributes must sanitize/assert"
grep -q 'maskSecrets' "$ATTR" || fail "attributes must reuse maskSecrets"
grep -q '../control/secrets-mask' "$ATTR" || fail "attributes must import control secrets-mask"

# Span builders
grep -q 'buildFunctionSpanAttributes' "$SPANS" || fail "spans must build Function attrs"
grep -q 'buildNatsSpanAttributes' "$SPANS" || fail "spans must build NATS attrs"
grep -q 'buildPgSpanAttributes' "$SPANS" || fail "spans must build PG attrs"
grep -q 'messaging.system.name' "$SPANS" || fail "NATS builder must set messaging.system.name"
grep -q 'postgresql' "$SPANS" || fail "PG builder must set db.system.name=postgresql"
# Must not emit query parameters / DSN as set attributes
if grep -E "\['db\.query\.parameter|\"db\.query\.parameter|connection_string'\s*:" "$SPANS"; then
  fail "spans must not set db.query.parameter.* or connection_string"
fi

# Docs
grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -q 'aura.tenant_id' "$DOC" || fail "doc must require aura.tenant_id"
grep -q 'aura.session_id' "$DOC" || fail "doc must require aura.session_id"
grep -q 'aura.run_id' "$DOC" || fail "doc must require aura.run_id"
grep -Eqi 'maskSecrets|마스킹|시크릿' "$DOC" || fail "doc must cover secret masking"
grep -Eqi 'Function|NATS|PG|PostgreSQL' "$DOC" || fail "doc must cover Function·NATS·PG"
grep -q 'otel-function-nats-pg.md' "$DESIGN" || fail "DESIGN must link otel-function-nats-pg.md"
grep -q 'secrets-mask' "$DESIGN" || fail "DESIGN must cite secrets-mask"

# Cross-links + ROADMAP checkbox
grep -Eq 'otel-function-nats-pg\.md|services/otel' "$ARCH" \
  || fail "ARCHITECTURE must link otel-function-nats-pg / services/otel"
grep -Eq '\[x\].*OTel|\[x\].*otel' "$ROADMAP" \
  || fail "ROADMAP OTel checkbox must be [x]"
grep -q 'check-otel-function-nats-pg' "$SETUP" || fail "SETUP must name check-otel-function-nats-pg.sh"
grep -Eqi 'OTel|otel-function-nats-pg|services/otel' "$AGENTS" \
  || fail "AGENTS must mention OTel / services/otel"

node "$ATTR_T" || fail "attributes.selftest.js failed"
node "$SPANS_T" || fail "spans.selftest.js failed"

ok "OTel Function·NATS·PG allowlist + secret mask verification"
echo "check-otel-function-nats-pg: PASS"
