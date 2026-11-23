"""Process LRU in front of GetObject. Key is checksum. Value is verified bytes."""

from __future__ import annotations

from collections import OrderedDict
from typing import Any

from get_object import (
    BUNDLE_CACHE_MAX_BYTES,
    BundleError,
    assert_bundle_uri,
    get_object,
    sha256_prefixed,
)


class BundleCache:
    def __init__(self, max_bytes: int = BUNDLE_CACHE_MAX_BYTES) -> None:
        self.max_bytes = max_bytes
        self._items: OrderedDict[str, bytes] = OrderedDict()
        self._used = 0

    def get(self, key: str) -> bytes | None:
        if key not in self._items:
            return None
        self._items.move_to_end(key)
        return self._items[key]

    def set(self, key: str, body: bytes) -> None:
        if not key:
            return
        size = len(body)
        if size > self.max_bytes:
            return
        if key in self._items:
            self._used -= len(self._items.pop(key))
        while self._items and self._used + size > self.max_bytes:
            _, old = self._items.popitem(last=False)
            self._used -= len(old)
        self._items[key] = body
        self._used += size

    def reset(self) -> None:
        self._items.clear()
        self._used = 0


_PROCESS = BundleCache()


async def load_cached_bundle(source: dict | None, opts: dict[str, Any] | None = None) -> bytes:
    o = dict(opts or {})
    src = source if isinstance(source, dict) else {}
    tenant = o.get("tenant_id") or o.get("tenantId")
    assert_bundle_uri(src.get("bundle_uri"), tenant)
    cache = o.get("cache") if isinstance(o.get("cache"), BundleCache) else _PROCESS
    checksum = src.get("checksum") if isinstance(src.get("checksum"), str) else ""
    if checksum:
        hit = cache.get(checksum)
        if hit is not None:
            return hit
    o["tenant_id"] = tenant
    body = await get_object(src.get("bundle_uri"), o)
    if checksum:
        if sha256_prefixed(body) != checksum:
            raise BundleError("bundle_checksum_mismatch")
        cache.set(checksum, body)
    return body


def reset_process_bundle_cache() -> None:
    _PROCESS.reset()
