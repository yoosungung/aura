#!/usr/bin/env bash
# M4 static gate: compliance.erase Rust binary + Deployment.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/compliance-erase.md"
DESIGN="$ROOT/services/compliance/DESIGN.md"
LIB="$ROOT/services/compliance/src/lib.rs"
DEP="$ROOT/deploy/k8s/compliance-erase/deployment.yaml"
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
[[ -f "$LIB" ]] || fail "missing compliance rs lib"
[[ -f "$DEP" ]] || fail "missing $DEP"
[[ -f "$KUST" ]] || fail "missing $KUST"
[[ ! -f "$ROOT/services/compliance/erase/handler.js" ]] || fail "Node erase handler must be removed"

grep -q 'openbao-transit' "$LIB" || fail "lib must lock openbao-transit"
grep -q 'shred_keys' "$LIB" || fail "lib steps must include shred_keys"
python3 - <<'PY' || fail "shred_keys must precede delete_objects in STEPS"
from pathlib import Path
import re
text = Path("services/compliance/src/lib.rs").read_text()
m = re.search(r"pub const STEPS: &\[&str\] = &\[([^\]]+)\]", text, re.S)
assert m, "STEPS missing"
steps = [s.strip().strip('"') for s in m.group(1).split(",") if s.strip()]
assert steps.index("shred_keys") < steps.index("pg_redact")
assert steps.index("shred_keys") < steps.index("delete_objects")
print("order-ok")
PY

grep -q 'kind: Deployment' "$DEP" || fail "deployment.yaml must be Deployment"
grep -q 'aura-compliance-erase' "$DEP" || fail "deployment name aura-compliance-erase"
grep -q 'aura.tasks.compliance.erase' "$DEP" || fail "TASK_SUBJECT"
grep -q 'aura/compliance-erase' "$DEP" || fail "deployment image must be aura/compliance-erase"
grep -q 'aura.service: compliance' "$DEP" || fail "must label aura.service=compliance"
if grep -qE 'function\.yaml|mqt\.yaml|package\.yaml' "$KUST"; then
  fail "kustomization must not list Fission resources"
fi

grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -q 'aura.tasks.compliance.erase' "$DOC" || fail "doc must name task subject"
grep -Eq 'compliance-erase\.md|compliance\.erase' "$ARCH" || fail "ARCHITECTURE must link compliance-erase"
grep -Eq '\[x\].*compliance\.erase|\[x\].*erase' "$ROADMAP" || fail "ROADMAP erase checkbox must be [x]"
grep -q 'check-compliance-erase' "$SETUP" || fail "SETUP must name check-compliance-erase.sh"
grep -Eqi 'compliance\.erase|compliance-erase|services/compliance' "$AGENTS" \
  || fail "AGENTS must mention compliance erase"
grep -Eqi 'crypto-shred|enc\.kid|erase' "$CONTENT_REF" || fail "content-ref doc must mention erase"

(cd "$ROOT" && cargo test -p aura-compliance-erase --offline) || fail "aura-compliance-erase tests failed"

ok "compliance.erase Rust binary + Deployment"
echo "check-compliance-erase: PASS"
