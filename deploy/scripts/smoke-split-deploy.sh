#!/usr/bin/env bash
# Cluster gate for V0.1: async-smoke MQT vs sync-smoke Warm are separate units.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }
need kubectl
need python3

echo "== Functions labels + executor =="
python3 - <<'PY' || fail "function class mismatch"
import json, subprocess, sys

def get(name):
    return json.loads(subprocess.check_output(
        ["kubectl", "get", "function.fission.io", name, "-n", "default", "-o", "json"], text=True))

async_fn, sync_fn = get("aura-tasks-smoke"), get("aura-rpc-smoke")

def cls(fn):
    return (fn.get("metadata") or {}).get("labels", {}).get("aura.runtime/class")

def strat(fn):
    return (((fn.get("spec") or {}).get("InvokeStrategy") or {}).get("ExecutionStrategy") or {})

a, s = strat(async_fn), strat(sync_fn)
if cls(async_fn) != "async" or cls(sync_fn) != "sync":
    print(f"labels async={cls(async_fn)} sync={cls(sync_fn)}", file=sys.stderr); sys.exit(1)
if (a.get("ExecutorType") or "").lower() != "poolmgr":
    print(f"async executor want poolmgr got {a.get('ExecutorType')}", file=sys.stderr); sys.exit(1)
if (s.get("ExecutorType") or "").lower() != "newdeploy":
    print(f"sync executor want newdeploy got {s.get('ExecutorType')}", file=sys.stderr); sys.exit(1)
mins = int(s.get("MinScale") or 0)
if mins < 2:
    print(f"sync MinScale want >=2 got {mins}", file=sys.stderr); sys.exit(1)
print(f"OK: async=poolmgr; sync=newdeploy MinScale={mins}")
PY

echo "== MQT async scale-to-zero =="
python3 - <<'PY' || fail "mqt mismatch"
import json, subprocess, sys
m = json.loads(subprocess.check_output(
    ["kubectl", "get", "messagequeuetrigger.fission.io", "aura-tasks-smoke", "-n", "default", "-o", "json"],
    text=True))
spec = m.get("spec") or {}
labels = (m.get("metadata") or {}).get("labels") or {}
if labels.get("aura.runtime/class") != "async":
    print("mqt label want async", file=sys.stderr); sys.exit(1)
if (spec.get("mqtkind") or "").lower() != "keda" or spec.get("messageQueueType") != "nats-jetstream":
    print("want keda/nats-jetstream", file=sys.stderr); sys.exit(1)
min_r = spec.get("minReplicaCount")
if min_r is None or int(min_r) != 0:
    print(f"minReplicaCount want 0 got {min_r!r}", file=sys.stderr); sys.exit(1)
if ((spec.get("functionref") or {}).get("name")) != "aura-tasks-smoke":
    print("functionref mismatch", file=sys.stderr); sys.exit(1)
print("OK: MQT aura-tasks-smoke minReplicaCount=0")
PY

echo "== ScaledObject: async only =="
python3 - <<'PY' || fail "scaledobject mismatch"
import json, subprocess, sys
items = json.loads(subprocess.check_output(["kubectl", "get", "scaledobject", "-A", "-o", "json"], text=True)).get("items") or []
async_hit = None
for so in items:
    name = so["metadata"]["name"]
    types = [t.get("type") for t in (so.get("spec", {}).get("triggers") or [])]
    min_r = so.get("spec", {}).get("minReplicaCount")
    target = (so.get("spec", {}).get("scaleTargetRef") or {}).get("name", "")
    if name == "aura-tasks-smoke" or "nats-jetstream" in types and "aura-tasks-smoke" in (name + target):
        async_hit = (name, min_r, types, target)
    if "aura-rpc-smoke" in name or "aura-rpc-smoke" in target:
        if "nats-jetstream" in types:
            print(f"sync has nats-jetstream ScaledObject: {name}", file=sys.stderr); sys.exit(1)
if not async_hit:
    print("missing ScaledObject for async MQT", file=sys.stderr); sys.exit(1)
name, min_r, types, target = async_hit
if min_r is None or int(min_r) != 0:
    print(f"async ScaledObject min want 0 got {min_r!r}", file=sys.stderr); sys.exit(1)
print(f"OK: ScaledObject {name} min={min_r} triggers={types}")
print("OK: sync has no JetStream ScaledObject")
PY

echo "== sync Warm replicas >= 2 =="
python3 - <<'PY' || fail "sync replicas"
import json, subprocess, sys
items = json.loads(subprocess.check_output(["kubectl", "get", "deploy", "-n", "default", "-o", "json"], text=True)).get("items") or []
dep = next((d for d in items if "aura-rpc-smoke" in d["metadata"]["name"]), None)
if not dep:
    print("sync deployment missing", file=sys.stderr); sys.exit(1)
ready = int(dep.get("status", {}).get("readyReplicas") or 0)
desired = int(dep.get("spec", {}).get("replicas") or 0)
if ready < 2 or desired < 2:
    print(f"sync replicas ready={ready} desired={desired}", file=sys.stderr); sys.exit(1)
print(f"OK: sync deploy {dep['metadata']['name']} readyReplicas={ready}")
PY

echo
echo "smoke-split-deploy: PASS (V0.1 separation)"
