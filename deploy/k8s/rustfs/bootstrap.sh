#!/usr/bin/env bash
# Lab only. Ensures rustfs-root, creates bucket aura-content, upserts app Secret,
# mirrors Garage→RustFS when Garage still has objects, then removes Garage.
# CI does not run this. kubectl apply -k this directory does not touch Secrets.
set -euo pipefail
NS="${AURA_NAMESPACE:-aura}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENDPOINT="http://rustfs.${NS}.svc.cluster.local:9000"
REGION="us-east-1"
BUCKET="aura-content"

ensure_root_secret() {
  if kubectl -n "$NS" get secret rustfs-root >/dev/null 2>&1; then
    echo "OK: rustfs-root already present"
    return
  fi
  local ak sk
  ak="$(openssl rand -hex 16)"
  sk="$(openssl rand -hex 32)"
  kubectl -n "$NS" create secret generic rustfs-root \
    --from-literal=RUSTFS_ACCESS_KEY="$ak" \
    --from-literal=RUSTFS_SECRET_KEY="$sk"
  echo "OK: created rustfs-root"
}

wait_ready() {
  kubectl -n "$NS" rollout status statefulset/rustfs --timeout=180s
  local i=0
  while (( i < 60 )); do
    if kubectl -n "$NS" exec sts/rustfs -- wget -qO- http://127.0.0.1:9000/health >/dev/null 2>&1 \
      || kubectl -n "$NS" exec sts/rustfs -- curl -sf http://127.0.0.1:9000/health >/dev/null 2>&1; then
      echo "OK: rustfs /health"
      return
    fi
    # Fallback: TCP via kubectl run
    if kubectl -n "$NS" get pod -l app.kubernetes.io/name=rustfs -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null | grep -q true; then
      echo "OK: rustfs pod Ready"
      return
    fi
    sleep 2
    i=$((i + 1))
  done
  echo "FAIL: rustfs not ready" >&2
  exit 1
}

root_keys() {
  AK="$(kubectl -n "$NS" get secret rustfs-root -o jsonpath='{.data.RUSTFS_ACCESS_KEY}' | base64 -d)"
  SK="$(kubectl -n "$NS" get secret rustfs-root -o jsonpath='{.data.RUSTFS_SECRET_KEY}' | base64 -d)"
  [[ -n "$AK" && -n "$SK" ]] || { echo "FAIL: rustfs-root empty" >&2; exit 1; }
}

# Create bucket + optional Garage mirror via ephemeral amazon/aws-cli pod.
# (minio/mc public tags are unavailable / require login in this lab.)
AWSCLI_IMAGE="${AURA_AWSCLI_IMAGE:-amazon/aws-cli:2.27.25}"
s3_bootstrap_and_mirror() {
  root_keys
  local garage_ak="" garage_sk=""
  if kubectl -n "$NS" get pod -l app.kubernetes.io/name=garage -o name 2>/dev/null | grep -q .; then
    garage_ak="$(kubectl -n "$NS" get secret aura-object-store-creds -o jsonpath='{.data.ACCESS_KEY_ID}' 2>/dev/null | base64 -d || true)"
    garage_sk="$(kubectl -n "$NS" get secret aura-object-store-creds -o jsonpath='{.data.ACCESS_SECRET_KEY}' 2>/dev/null | base64 -d || true)"
  fi

  kubectl -n "$NS" delete pod rustfs-bootstrap-s3 --ignore-not-found --wait=true 2>/dev/null || true
  cat <<EOF | kubectl -n "$NS" apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: rustfs-bootstrap-s3
  labels:
    app.kubernetes.io/part-of: aura
    app.kubernetes.io/name: rustfs-bootstrap
spec:
  restartPolicy: Never
  containers:
    - name: aws
      image: ${AWSCLI_IMAGE}
      command: ["sleep", "3600"]
      env:
        - name: AWS_ACCESS_KEY_ID
          value: "$AK"
        - name: AWS_SECRET_ACCESS_KEY
          value: "$SK"
        - name: AWS_DEFAULT_REGION
          value: "$REGION"
        - name: AWS_EC2_METADATA_DISABLED
          value: "true"
EOF
  kubectl -n "$NS" wait --for=condition=Ready pod/rustfs-bootstrap-s3 --timeout=180s

  # Path-style for in-cluster S3-compatible endpoints.
  kubectl -n "$NS" exec rustfs-bootstrap-s3 -- \
    aws configure set default.s3.addressing_style path
  kubectl -n "$NS" exec rustfs-bootstrap-s3 -- \
    aws --endpoint-url "$ENDPOINT" s3 mb "s3://$BUCKET" 2>/dev/null \
    || kubectl -n "$NS" exec rustfs-bootstrap-s3 -- \
      aws --endpoint-url "$ENDPOINT" s3api head-bucket --bucket "$BUCKET"

  if [[ -n "$garage_ak" && -n "$garage_sk" ]]; then
    echo "== mirror Garage → RustFS =="
    local garage_ep="http://garage.${NS}.svc.cluster.local:3900"
    kubectl -n "$NS" exec rustfs-bootstrap-s3 -- \
      sh -c "rm -rf /tmp/aura-mirror && mkdir -p /tmp/aura-mirror && \
        AWS_ACCESS_KEY_ID='$garage_ak' AWS_SECRET_ACCESS_KEY='$garage_sk' AWS_DEFAULT_REGION=garage \
        aws --endpoint-url '$garage_ep' s3 sync 's3://$BUCKET' /tmp/aura-mirror && \
        aws --endpoint-url '$ENDPOINT' s3 sync /tmp/aura-mirror 's3://$BUCKET' && \
        echo '--- garage ---' && \
        AWS_ACCESS_KEY_ID='$garage_ak' AWS_SECRET_ACCESS_KEY='$garage_sk' AWS_DEFAULT_REGION=garage \
        aws --endpoint-url '$garage_ep' s3 ls 's3://$BUCKET' --recursive && \
        echo '--- rustfs ---' && \
        aws --endpoint-url '$ENDPOINT' s3 ls 's3://$BUCKET' --recursive"
    echo "OK: mirror attempted"
  else
    echo "OK: no Garage source; empty bucket bootstrap"
  fi

  kubectl -n "$NS" delete pod rustfs-bootstrap-s3 --wait=true
}

upsert_app_secret_and_cm() {
  root_keys
  for dest in "$NS" default; do
    kubectl -n "$dest" create secret generic aura-object-store-creds \
      --from-literal=ACCESS_KEY_ID="$AK" \
      --from-literal=ACCESS_SECRET_KEY="$SK" \
      --dry-run=client -o yaml | kubectl apply -f -
  done
  # Fission Functions live in default and cannot mount aura-ns ConfigMaps.
  kubectl -n "$NS" get configmap aura-s3 -o json \
    | python3 -c 'import json,sys; o=json.load(sys.stdin); o["metadata"]={"name":"aura-s3","namespace":"default","labels":o["metadata"].get("labels",{})}; print(json.dumps(o))' \
    | kubectl apply -f -
  echo "OK: Secret aura-object-store-creds upserted in $NS and default; aura-s3 mirrored to default."
}

remove_garage() {
  echo "== remove Garage from cluster =="
  kubectl -n "$NS" delete statefulset garage --ignore-not-found --wait=true
  kubectl -n "$NS" delete service garage --ignore-not-found
  kubectl -n "$NS" delete configmap garage-config --ignore-not-found
  kubectl -n "$NS" delete pod -l app.kubernetes.io/name=garage --ignore-not-found --wait=true 2>/dev/null || true
  echo "OK: Garage resources deleted (if present)"
}

restart_consumers() {
  kubectl -n "$NS" rollout restart deployment/aura-control-admin 2>/dev/null || true
  kubectl -n "$NS" rollout status deployment/aura-control-admin --timeout=120s 2>/dev/null || true
}

DIR="$(cd "$(dirname "$0")" && pwd)"
echo "== ensure rustfs-root =="
ensure_root_secret
echo "== apply rustfs workload (endpoint cutover after mirror) =="
kubectl apply -f "$DIR/service.yaml" -f "$DIR/statefulset.yaml"
wait_ready
echo "== bucket + mirror =="
s3_bootstrap_and_mirror
echo "== cutover aura-s3 + app secret =="
kubectl apply -f "$DIR/configmap.yaml"
upsert_app_secret_and_cm
restart_consumers
remove_garage
echo "OK: RustFS bootstrap complete. Endpoint=$ENDPOINT region=$REGION bucket=$BUCKET"
echo "Restart any other consumers that mount aura-object-store-creds / aura-s3."
