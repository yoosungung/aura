"""Bundle GetObject for aura-content. Fetch is injectable."""

from __future__ import annotations

import hashlib
import hmac
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import quote, urlsplit, urlunsplit

BUNDLE_CACHE_MAX_BYTES = 32 * 1024 * 1024
_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


class BundleError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def sha256_prefixed(body: bytes) -> str:
    return "sha256:" + hashlib.sha256(body).hexdigest()


def assert_bundle_uri(uri: Any, tenant_id: Any) -> str:
    if not isinstance(uri, str) or not uri.startswith("s3://aura-content/"):
        raise BundleError("bundle_uri_tenant_mismatch")
    if "?" in uri or ".." in uri:
        raise BundleError("bundle_uri_tenant_mismatch")
    if not isinstance(tenant_id, str) or not tenant_id:
        raise BundleError("bundle_uri_tenant_mismatch")
    key = uri[len("s3://aura-content/") :]
    if f"/tenants/{tenant_id}/bundles/" not in "/" + key:
        raise BundleError("bundle_uri_tenant_mismatch")
    return key


def _sign(url: str, region: str, access_key: str, secret: str) -> dict[str, str]:
    parts = urlsplit(url)
    amz = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    day = amz[:8]
    canonical_headers = (
        f"host:{parts.netloc}\n"
        f"x-amz-content-sha256:{_EMPTY}\n"
        f"x-amz-date:{amz}\n"
    )
    signed = "host;x-amz-content-sha256;x-amz-date"
    canonical = "\n".join(["GET", parts.path, "", canonical_headers, signed, _EMPTY])
    scope = f"{day}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz,
            scope,
            hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        ]
    )
    key = ("AWS4" + secret).encode("utf-8")
    for part in (day, region, "s3", "aws4_request"):
        key = hmac.new(key, part.encode("utf-8"), hashlib.sha256).digest()
    signature = hmac.new(key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    return {
        "x-amz-content-sha256": _EMPTY,
        "x-amz-date": amz,
        "Authorization": (
            f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
            f"SignedHeaders={signed}, Signature={signature}"
        ),
    }


def _encode_key(key: str) -> str:
    return "/".join(quote(part, safe="") for part in key.split("/"))


async def _default_fetch(url: str, headers: dict[str, str]) -> dict[str, Any]:
    import asyncio

    def run() -> dict[str, Any]:
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return {"status": resp.status, "body": resp.read()}
        except urllib.error.HTTPError as err:
            return {"status": err.code, "body": err.read()}

    return await asyncio.to_thread(run)


async def get_object(uri: str, opts: dict[str, Any] | None = None) -> bytes:
    o = opts or {}
    env = o["env"] if isinstance(o.get("env"), dict) else os.environ
    key = assert_bundle_uri(uri, o.get("tenant_id") or o.get("tenantId"))
    endpoint = o.get("endpoint") or env.get("AURA_S3_ENDPOINT") or ""
    region = o.get("region") or env.get("AURA_S3_REGION") or ""
    access = o.get("access_key_id") or o.get("accessKeyId") or env.get("ACCESS_KEY_ID") or ""
    secret = o.get("secret_access_key") or o.get("secretAccessKey") or env.get("ACCESS_SECRET_KEY") or ""
    if not endpoint or not region or not access or not secret:
        raise BundleError("object_store_unconfigured")
    fetch = o.get("fetch") or o.get("fetch_impl") or o.get("fetchImpl")
    base = str(endpoint).rstrip("/")
    path = "/aura-content/" + _encode_key(key)
    parts = urlsplit(base)
    url = urlunsplit((parts.scheme, parts.netloc, path, "", ""))
    headers = _sign(url, region, access, secret)
    try:
        if callable(fetch):
            res = await fetch(url, headers)
        else:
            res = await _default_fetch(url, headers)
    except BundleError:
        raise
    except Exception as err:
        raise BundleError("bundle_missing") from err
    status = 200
    body = b""
    if isinstance(res, dict):
        status = int(res.get("status") or 200)
        raw = res.get("body")
        body = raw if isinstance(raw, (bytes, bytearray)) else str(raw or "").encode("utf-8")
    elif isinstance(res, (bytes, bytearray)):
        body = bytes(res)
    else:
        raise BundleError("bundle_missing")
    if status >= 300:
        raise BundleError("bundle_missing")
    return bytes(body)
