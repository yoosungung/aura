"""pytest — GetObject tenant prefix, checksum bytes, missing env, no secret logs."""

from __future__ import annotations

import hashlib
import logging

import pytest

from bundle_cache import BundleCache, load_cached_bundle
from get_object import BundleError, get_object, sha256_prefixed

TENANT = "11111111-1111-4111-8111-111111111111"
URI = f"s3://aura-content/tenants/{TENANT}/bundles/mcp/demo/1/mod.js"
SECRET = "lab-secret-not-for-logs"


def _opts(fetch, **extra):
    base = {
        "tenant_id": TENANT,
        "endpoint": "http://garage.aura.svc.cluster.local:3900",
        "region": "garage",
        "access_key_id": "lab-access",
        "secret_access_key": SECRET,
        "fetch": fetch,
    }
    base.update(extra)
    return base


@pytest.mark.asyncio
async def test_get_returns_bytes_and_hides_secret(caplog):
    blob = b"bundle-bytes"
    seen = {}

    async def fetch(url, headers):
        seen["url"] = url
        seen["auth"] = headers["Authorization"]
        return {"status": 200, "body": blob}

    with caplog.at_level(logging.DEBUG):
        got = await get_object(URI, _opts(fetch))
    assert got == blob
    assert sha256_prefixed(got) == "sha256:" + hashlib.sha256(blob).hexdigest()
    assert f"/tenants/{TENANT}/bundles/" in seen["url"]
    assert SECRET not in seen["url"]
    assert SECRET not in seen["auth"]
    assert SECRET not in caplog.text


@pytest.mark.asyncio
async def test_tenant_mismatch_skips_fetch():
    async def fetch(_url, _headers):
        raise AssertionError("fetch")

    with pytest.raises(BundleError, match="bundle_uri_tenant_mismatch"):
        await get_object(
            "s3://aura-content/tenants/other/bundles/mcp/demo/1/mod.js",
            _opts(fetch),
        )


@pytest.mark.asyncio
async def test_barman_bucket_rejected():
    async def fetch(_url, _headers):
        raise AssertionError("fetch")

    with pytest.raises(BundleError, match="bundle_uri_tenant_mismatch"):
        await get_object(f"s3://aura-pg/tenants/{TENANT}/bundles/mcp/demo/1/mod.js", _opts(fetch))


@pytest.mark.asyncio
async def test_missing_env():
    async def fetch(_url, _headers):
        raise AssertionError("fetch")

    with pytest.raises(BundleError, match="object_store_unconfigured"):
        await get_object(URI, {"tenant_id": TENANT, "fetch": fetch, "env": {}})


@pytest.mark.asyncio
async def test_cache_hit_and_checksum_miss():
    body = b"cached-bytes"
    checksum = sha256_prefixed(body)
    cache = BundleCache()
    calls = {"n": 0}

    async def fetch(_url, _headers):
        calls["n"] += 1
        return {"status": 200, "body": body}

    source = {"bundle_uri": URI, "checksum": checksum}
    first = await load_cached_bundle(source, _opts(fetch, cache=cache))
    second = await load_cached_bundle(source, _opts(fetch, cache=cache))
    assert first == second == body
    assert calls["n"] == 1

    bad = {"n": 0}

    async def bad_fetch(_url, _headers):
        bad["n"] += 1
        return {"status": 200, "body": b"nope"}

    fresh = BundleCache()
    with pytest.raises(BundleError, match="bundle_checksum_mismatch"):
        await load_cached_bundle(source, _opts(bad_fetch, cache=fresh))
    with pytest.raises(BundleError, match="bundle_checksum_mismatch"):
        await load_cached_bundle(source, _opts(bad_fetch, cache=fresh))
    assert bad["n"] == 2
