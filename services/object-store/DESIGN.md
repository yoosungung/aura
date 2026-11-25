# object-store (번들 GetObject)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §8 · §1 #11 · #12.  
버킷·prefix: [`deploy/docs/object-store-content-ref.md`](../../deploy/docs/object-store-content-ref.md).  
매니페스트: [`deploy/k8s/garage/`](../../deploy/k8s/garage/).

**이 문서 범위:** `aura-content` 번들 `GetObject` · Function Pod LRU · **테넌트 zip 해제**(`bundle-zip`).  
**Non-goals:** `content_ref` 업로드 SDK · `PutObject` · 서명 알고리즘 검증 · Barman 버킷 `aura-pg` · NCP/AWS 전환 · CI 라이브 Garage.

---

## 리더

`get-object.js` / `get_object.py`. `GetObject`만. fetch는 주입하고, 없으면 env의 Garage로 읽는다.

| 조건 | 결과 |
|------|------|
| URI가 `s3://aura-content/`가 아니거나 경로에 `/tenants/{tenant_id}/bundles/`가 없음 | `bundle_uri_tenant_mismatch` |
| `AURA_S3_ENDPOINT` · `AURA_S3_REGION` · `ACCESS_KEY_ID` · `ACCESS_SECRET_KEY` 중 하나 없음 | `object_store_unconfigured` |
| 객체가 없음 | `bundle_missing` |

digest는 `sha256:` + hex. 비교는 호출한 Function과 activate가 한다. 시크릿·본문은 로그에 남기지 않는다. `sig_uri`가 있다는 사실만 게이트다.

## Pod LRU

기본 `loadBundle`은 이 프로세스의 LRU다. 키는 `source.checksum`. 값은 sha256이 맞은 바이트만. 바이트 상한 `BUNDLE_CACHE_MAX_BYTES` = **33554432** (32MiB). 그보다 큰 객체는 반환만 하고 저장하지 않는다.

불일치·checksum 실패·`object_store_unconfigured`는 저장하지 않는다. `factory(cfg, secrets_ref)` 인스턴스는 저장하지 않는다. `svc-control` activate는 이 캐시를 쓰지 않고 리더로 매번 `GetObject`한다. 테스트가 `loadBundle`을 넘기면 캐시와 GetObject를 타지 않는다.

---

## Tenant zip

`bundle-zip.js` / `bundle_zip.py` — PK zip → 파일 맵 · `entrypoint` 모듈 로드 · 상대 require/import · `node_modules`/`..` 거부.  
정본: [`deploy/docs/tenant-bundle-multifile.md`](../../deploy/docs/tenant-bundle-multifile.md).

## Commands

```bash
node services/object-store/get-object.selftest.js
node services/object-store/bundle-cache.selftest.js
node services/object-store/bundle-zip.selftest.js
python3 -m venv services/object-store/.venv
services/object-store/.venv/bin/pip install pytest
services/object-store/.venv/bin/python -m pytest services/object-store/test_get_object.py services/object-store/test_bundle_zip.py
bash deploy/scripts/check-object-store-garage.sh
```

랩 apply (CI 아님): `kubectl apply -k deploy/k8s/garage` → `bash deploy/k8s/garage/bootstrap.sh`(버킷·키·Secret upsert) → Secret을 마운트한 Deployment를 restart. `secret.yaml`은 템플릿만 — kustomization에 넣지 않는다(`apply -k`가 라이브 키를 덮어쓰지 않게). Secret·`aura-s3`는 `aura`(control-admin)와 `default`(Fission Function) 양쪽에 둔다 — Fission은 Function과 다른 ns의 Secret/ConfigMap을 거부한다. StatefulSet은 `command: ["/garage"]`, 단일 노드 `rpc_public_addr=127.0.0.1:3901`, bootstrap은 node-id hex prefix만 `layout assign`에 넘긴다. 데이터는 `emptyDir`(Pod 삭제 시 소실).
