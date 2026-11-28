#!/usr/bin/env bash
# M4 static gate: archive task docs + Rust Deployment (DETACH/DROP live SQL = follow-up).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$ROOT/deploy/docs/memory-archive.md"
OBJ="$ROOT/deploy/docs/object-store-content-ref.md"
TTL="$ROOT/deploy/docs/memory-ttl-drop.md"
HANDLERS="$ROOT/services/memory/src/handlers.rs"
K8S_DIR="$ROOT/deploy/k8s/memory-archive"
DESIGN="$ROOT/services/memory/DESIGN.md"
ROADMAP="$ROOT/ROADMAP.md"
ARCH="$ROOT/ARCHITECTURE.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$DOC" ]] || fail "missing $DOC"
[[ -f "$HANDLERS" ]] || fail "missing handlers.rs"
[[ -d "$K8S_DIR" ]] || fail "missing $K8S_DIR"

grep -q 'aura.tasks.memory.archive' "$DOC" || fail "doc must name archive task"
grep -Eqi 'Parquet|parquet' "$DOC" || fail "doc must require Parquet"
grep -Eqi 'DETACH' "$DOC" || fail "doc must require DETACH"
grep -Eq 'archive/episodic|archive/' "$DOC" || fail "doc must use archive/ prefix"
grep -Eqi 'needs_archive' "$TTL" || fail "ttl-drop doc must keep needs_archive handoff"
grep -Eq 'archive/episodic|archive/' "$OBJ" || fail "object-store doc must define archive/ prefix"
grep -q 'handle_archive_request' "$HANDLERS" || fail "handlers.rs must include handle_archive_request"
grep -q 'DETACH PARTITION' "$HANDLERS" || fail "archive stub must mention DETACH order"
grep -Eq 'aura\.tasks\.memory\.archive' "$ARCH" || fail "ARCHITECTURE must name archive task"
grep -Eq '\[x\].*aura\.tasks\.memory\.archive' "$ROADMAP" || fail "ROADMAP M4 archive checkbox must be [x]"

(cd "$ROOT" && cargo test -p aura-memory --lib wire_handlers --offline) || fail "handler wire tests failed"

CJ="$K8S_DIR/cronjob.yaml"
[[ -f "$CJ" ]] || fail "missing cronjob.yaml"
[[ ! -f "$K8S_DIR/deployment.yaml" ]] || fail "batch Deployment must be removed (CronJob-only)"
grep -q '/aura-memory-archive' "$CJ" || fail "cronjob must run /aura-memory-archive"
grep -q 'aura/memory-batch' "$CJ" || fail "image aura/memory-batch"

ok "memory archive docs + CronJob one-shot"
echo "check-memory-archive: PASS"
