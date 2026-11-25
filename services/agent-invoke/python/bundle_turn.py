"""Signed module entrypoint → factory(cfg, secrets_ref).runTurn. aura:createAgent skips GetObject."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Any


def _load_store():
    here = Path(__file__).resolve().parent
    for cand in (here, here.parent.parent / "object-store"):
        if (cand / "get_object.py").exists():
            p = str(cand)
            if p not in sys.path:
                sys.path.insert(0, p)
            break
    return importlib.import_module("get_object"), importlib.import_module("bundle_cache")


def is_module_entrypoint(entrypoint: Any) -> bool:
    if not isinstance(entrypoint, str) or entrypoint.count(":") != 1:
        return False
    mod, attr = entrypoint.split(":", 1)
    if not mod or mod.startswith("aura") or not attr:
        return False
    if not attr.isidentifier():
        return False
    return True


def load_factory(source: str | bytes, entrypoint: str):
    _load_store()
    from bundle_zip import load_factory_from_bytes  # type: ignore

    body = source.encode("utf-8") if isinstance(source, str) else source
    return load_factory_from_bytes(body, entrypoint)


async def open_agent_turn(resolved: dict | None, deps: dict | None, tenant_id: str):
    """Return an async run(ctx) or None when the cfg createAgent path should run."""
    d = deps or {}
    source = {}
    if isinstance(resolved, dict) and isinstance(resolved.get("source"), dict):
        source = resolved["source"]
    entry = source.get("entrypoint")
    if not is_module_entrypoint(entry):
        return None
    if not isinstance(source.get("sig_uri"), str) or not source.get("sig_uri"):
        raise RuntimeError("bundle_untrusted")
    get_object, bundle_cache = _load_store()
    load = d.get("load_bundle") or d.get("loadBundle")

    async def default_load(src):
        return await bundle_cache.load_cached_bundle(
            src,
            {
                "tenant_id": tenant_id,
                "fetch": d.get("object_fetch"),
                "endpoint": d.get("object_endpoint"),
                "region": d.get("object_region"),
                "access_key_id": d.get("object_access_key_id"),
                "secret_access_key": d.get("object_secret_access_key"),
                "cache": d.get("bundle_cache"),
                "env": d.get("object_env"),
            },
        )

    raw = await (load(source) if callable(load) else default_load(source))
    if raw is None:
        raise RuntimeError("bundle_missing")
    body = raw if isinstance(raw, (bytes, bytearray)) else str(raw).encode("utf-8")
    if get_object.sha256_prefixed(bytes(body)) != source.get("checksum"):
        raise RuntimeError("bundle_checksum_mismatch")
    factory = load_factory(bytes(body), entry)
    cfg = resolved.get("cfg") if isinstance(resolved, dict) else {}
    if not isinstance(cfg, dict):
        cfg = {}
    instance = factory(cfg, (resolved or {}).get("secrets_ref") if isinstance(resolved, dict) else None)
    if not isinstance(instance, dict):
        raise RuntimeError("factory_instance_missing")
    run = instance.get("runTurn") or instance.get("run_turn")
    if not callable(run):
        raise RuntimeError("factory_export_missing")

    async def turn(ctx):
        return await run(ctx)

    return turn
