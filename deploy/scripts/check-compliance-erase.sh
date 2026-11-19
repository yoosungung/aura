#!/usr/bin/env bash
# M4 static gate: aura.tasks.compliance.erase draft — crypto-shred + content_ref (ARCHITECTURE §9.3).
# Exit 0 on PASS. Ticket b355e99f. Non-goals: live OpenBao · PITR · full-tenant wipe CI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/compliance-erase.md"
DESIGN="$ROOT/services/compliance/DESIGN.md"
PLAN="$ROOT/services/compliance/erase/plan.js"
HANDLER="$ROOT/services/compliance/erase/handler.js"
PLAN_T="$ROOT/services/compliance/erase/plan.selftest.js"
HANDLER_T="$ROOT/services/compliance/erase/handler.selftest.js"
PKG_JS="$ROOT/deploy/k8s/compliance-erase/erase.js"
MQT="$ROOT/deploy/k8s/compliance-erase/mqt.yaml"
PKG="$ROOT/deploy/k8s/compliance-erase/package.yaml"
KUST="$ROOT/deploy/k8s/compliance-erase/kustomization.yaml"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"
CONTENT_REF="$ROOT/deploy/docs/object-store-content-ref.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$PLAN" ]] || fail "missing $PLAN"
[[ -f "$HANDLER" ]] || fail "missing $HANDLER"
[[ -f "$PLAN_T" ]] || fail "missing $PLAN_T"
[[ -f "$HANDLER_T" ]] || fail "missing $HANDLER_T"
[[ -f "$PKG_JS" ]] || fail "missing $PKG_JS"
[[ -f "$MQT" ]] || fail "missing $MQT"
[[ -f "$PKG" ]] || fail "missing $PKG"
[[ -f "$KUST" ]] || fail "missing $KUST"

# Crypto-shred + KMS product
grep -q 'openbao-transit' "$PLAN" || fail "plan must lock KMS_PRODUCT=openbao-transit"
grep -q 'shred_keys' "$PLAN" || fail "plan steps must include shred_keys"
grep -q 'runEraseOnce\|assertNoDecryptableCiphertext' "$HANDLER" \
  || fail "handler must runEraseOnce + assertNoDecryptableCiphertext"
# shred before delete
python3 - <<'PY' || fail "shred_keys must precede pg_redact/delete_objects in STEPS"
from pathlib import Path
text = Path("services/compliance/erase/plan.js").read_text()
# crude: find STEPS array order
import re
m = re.search(r"const STEPS = \[([^\]]+)\]", text, re.S)
assert m, "STEPS missing"
steps = [s.strip().strip("'\"") for s in m.group(1).split(",") if s.strip()]
assert steps.index("shred_keys") < steps.index("pg_redact")
assert steps.index("shred_keys") < steps.index("delete_objects")
print("order-ok")
PY

# MQT wire
grep -q 'aura.tasks.compliance.erase' "$MQT" || fail "MQT topic must be aura.tasks.compliance.erase"
grep -q 'aura.events.compliance.erase.done' "$MQT" || fail "MQT respTopic done"
grep -q 'aura.events.compliance.erase.error' "$MQT" || fail "MQT errorTopic"
grep -q 'aura_compliance_erase' "$MQT" || fail "MQT consumer aura_compliance_erase"
grep -Eq 'minReplicaCount:[[:space:]]*0' "$MQT" || fail "MQT minReplicaCount must be 0"

# Package literal matches erase.js
python3 - <<'PY' || fail "package literal must match erase.js"
import base64, re
from pathlib import Path
js = Path("deploy/k8s/compliance-erase/erase.js").read_bytes()
pkg = Path("deploy/k8s/compliance-erase/package.yaml").read_text()
m = re.search(r"literal:\s*(\S+)", pkg)
assert m, "literal missing"
got = base64.b64decode(m.group(1))
assert got == js, "literal mismatch"
print("literal-ok")
PY

# Docs
grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -q 'openbao-transit\|OpenBao' "$DOC" || fail "doc must name OpenBao Transit"
grep -q 'crypto-shred\|shred_keys\|키 파기' "$DOC" || fail "doc must describe crypto-shred"
grep -q 'aura.tasks.compliance.erase' "$DOC" || fail "doc must name task subject"
grep -q 'content_ref\|enc.kid\|refs/' "$DOC" || fail "doc must cover content_ref/refs"
grep -q 'compliance-erase.md' "$DESIGN" || fail "DESIGN must link compliance-erase.md"
grep -Eqi 'crypto-shred|enc\.kid|erase' "$CONTENT_REF" || fail "content-ref doc must mention erase/crypto-shred"

# Cross-links
grep -Eq 'compliance-erase\.md|compliance\.erase' "$ARCH" \
  || fail "ARCHITECTURE must link compliance-erase"
grep -Eq '\[x\].*compliance\.erase|\[x\].*erase' "$ROADMAP" \
  || fail "ROADMAP erase checkbox must be [x]"
grep -q 'check-compliance-erase' "$SETUP" || fail "SETUP must name check-compliance-erase.sh"
grep -Eqi 'compliance\.erase|compliance-erase|services/compliance' "$AGENTS" \
  || fail "AGENTS must mention compliance erase"

node "$PLAN_T" || fail "plan.selftest.js failed"
node "$HANDLER_T" || fail "handler.selftest.js failed"

ok "compliance.erase crypto-shred + content_ref draft"
echo "check-compliance-erase: PASS"
