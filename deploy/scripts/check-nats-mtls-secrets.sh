#!/usr/bin/env bash
# M3 static gate: NATS mTLS + secret mask/TTL cache invalidate (ARCHITECTURE §9.2).
# Exit 0 on PASS. Ticket 012df201. Non-goals: live cert CI · F1 · NATS Account · OTel full.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/nats-mtls-secrets.md"
DESIGN="$ROOT/services/control/DESIGN.md"
MASK="$ROOT/services/control/secrets-mask.js"
CACHE="$ROOT/services/control/secrets-cache.js"
TLS="$ROOT/services/control/nats-tls.js"
MASK_T="$ROOT/services/control/secrets-mask.selftest.js"
CACHE_T="$ROOT/services/control/secrets-cache.selftest.js"
TLS_T="$ROOT/services/control/nats-tls.selftest.js"
CONF="$ROOT/deploy/k8s/nats-mtls/nats.conf"
CM="$ROOT/deploy/k8s/nats-mtls/configmap-nats-conf.yaml"
SEC="$ROOT/deploy/k8s/nats-mtls/secret-nats-mtls.yaml"
PATCH="$ROOT/deploy/k8s/nats-mtls/statefulset-patch.yaml"
KUST="$ROOT/deploy/k8s/nats-mtls/kustomization.yaml"
ARCH="$ROOT/ARCHITECTURE.md"
ROADMAP="$ROOT/ROADMAP.md"
SETUP="$ROOT/deploy/SETUP.md"
AGENTS="$ROOT/AGENTS.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$DESIGN" ]] || fail "missing $DESIGN"
[[ -f "$MASK" ]] || fail "missing $MASK"
[[ -f "$CACHE" ]] || fail "missing $CACHE"
[[ -f "$TLS" ]] || fail "missing $TLS"
[[ -f "$MASK_T" ]] || fail "missing $MASK_T"
[[ -f "$CACHE_T" ]] || fail "missing $CACHE_T"
[[ -f "$TLS_T" ]] || fail "missing $TLS_T"
[[ -f "$CONF" ]] || fail "missing $CONF"
[[ -f "$CM" ]] || fail "missing $CM"
[[ -f "$SEC" ]] || fail "missing $SEC"
[[ -f "$PATCH" ]] || fail "missing $PATCH"
[[ -f "$KUST" ]] || fail "missing $KUST"

# Server mTLS: verify true in conf + ConfigMap
grep -Eq 'verify:[[:space:]]*true' "$CONF" || fail "nats.conf must set verify: true"
grep -Eq 'verify:[[:space:]]*true' "$CM" || fail "ConfigMap must set verify: true"
grep -q 'ca_file' "$CONF" || fail "nats.conf must set ca_file"
grep -q 'cert_file' "$CONF" || fail "nats.conf must set cert_file"
grep -q 'key_file' "$CONF" || fail "nats.conf must set key_file"

# Secret keys present (values must not look like committed live PEMs of long base64)
grep -q 'ca.pem' "$SEC" || fail "Secret must declare ca.pem"
grep -q 'server-cert.pem' "$SEC" || fail "Secret must declare server-cert.pem"
grep -q 'server-key.pem' "$SEC" || fail "Secret must declare server-key.pem"
grep -q 'client-cert.pem' "$SEC" || fail "Secret must declare client-cert.pem"
if grep -Eq 'BEGIN (RSA |EC )?PRIVATE KEY' "$SEC"; then
  fail "Secret must not commit real private key PEM"
fi

# Patch mounts conf + certs; kustomize includes base
grep -q 'aura-nats-mtls-conf' "$PATCH" || fail "patch must mount aura-nats-mtls-conf"
grep -q 'aura-nats-mtls' "$PATCH" || fail "patch must mount aura-nats-mtls secret"
grep -q '../base/nats.yaml' "$KUST" || fail "kustomization must include base nats.yaml"

# Client helpers
grep -q 'buildNatsTlsOptions\|assertNatsMtlsConnect' "$TLS" \
  || fail "nats-tls.js must export build/assert helpers"
grep -q 'mtls_required' "$TLS" || fail "nats-tls.js must error mtls_required"

# Mask + cache
grep -q 'maskSecrets' "$MASK" || fail "secrets-mask.js must export maskSecrets"
grep -Eq 'authorization|api_key|token' "$MASK" || fail "mask must cover auth/token keys"
grep -q 'createSecretsCache' "$CACHE" || fail "secrets-cache.js must export createSecretsCache"
grep -q 'aura.events.control.secrets.rotated' "$CACHE" \
  || fail "cache must name rotate subject"
grep -Eq '60_000|60000' "$CACHE" || fail "cache TTL max must be 60s"
grep -q 'ttl_exceeds_max' "$CACHE" || fail "cache must reject TTL > 60s"
grep -q 'handleRotatedEvent' "$CACHE" || fail "cache must handleRotatedEvent"

# Docs
grep -Eqi 'Non-goals' "$DOC" || fail "doc must state Non-goals"
grep -q 'verify: true\|verify:    true\|mTLS' "$DOC" || fail "doc must require mTLS verify"
grep -q 'aura.events.control.secrets.rotated' "$DOC" || fail "doc must name rotate subject"
grep -Eq '60|TTL' "$DOC" || fail "doc must state TTL ≤ 60s"
grep -q 'nats-mtls-secrets.md' "$DESIGN" || fail "DESIGN must link nats-mtls-secrets.md"

# Cross-links + ROADMAP checkbox
grep -Eq 'nats-mtls-secrets\.md|nats-mtls' "$ARCH" \
  || fail "ARCHITECTURE must link nats-mtls-secrets"
grep -Eq '\[x\].*NATS mTLS|\[x\].*nats-mtls' "$ROADMAP" \
  || fail "ROADMAP NATS mTLS checkbox must be [x]"
grep -q 'check-nats-mtls-secrets' "$SETUP" || fail "SETUP must name check-nats-mtls-secrets.sh"
grep -Eqi 'NATS mTLS|nats-mtls' "$AGENTS" || fail "AGENTS must mention NATS mTLS"

node "$TLS_T" || fail "nats-tls.selftest.js failed"
node "$MASK_T" || fail "secrets-mask.selftest.js failed"
node "$CACHE_T" || fail "secrets-cache.selftest.js failed"

ok "NATS mTLS overlay + secret mask + TTL≤60s rotate invalidate"
echo "check-nats-mtls-secrets: PASS"
