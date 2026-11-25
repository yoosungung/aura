"""Tenant bundle zip load (ARCHITECTURE §1 #11 · tenant-bundle-multifile.md)."""

from __future__ import annotations

import importlib
import io
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable


def is_zip(body: bytes) -> bool:
    return len(body) >= 4 and body[0:2] == b"PK"


def _fail(code: str) -> RuntimeError:
    return RuntimeError(code)


def split_entrypoint(entrypoint: str) -> tuple[str, str]:
    if not isinstance(entrypoint, str) or entrypoint.count(":") != 1:
        raise _fail("entrypoint_invalid")
    mod, attr = entrypoint.split(":", 1)
    if not mod or mod.startswith("aura") or not attr or not attr.isidentifier():
        raise _fail("entrypoint_invalid")
    if any(p in ("", "..") for p in mod.replace(".", "/").split("/")):
        raise _fail("entrypoint_invalid")
    return mod, attr


def _safe_members(zf: zipfile.ZipFile) -> None:
    for info in zf.infolist():
        name = info.filename.replace("\\", "/")
        if name.endswith("/"):
            continue
        parts = Path(name).parts
        if ".." in parts or name.startswith("/"):
            raise _fail("bundle_zip_unsafe_path")
        if "node_modules" in parts or "__pycache__" in parts or name.endswith(".pyc"):
            raise _fail("bundle_zip_node_modules_forbidden")


def load_factory_from_bytes(body: bytes, entrypoint: str) -> Callable[..., Any]:
    mod, attr = split_entrypoint(entrypoint)
    if not is_zip(body):
        ns: dict[str, Any] = {}
        exec(body.decode("utf-8"), ns, ns)  # noqa: S102
        factory = ns.get(attr)
        if not callable(factory):
            raise _fail("factory_export_missing")
        return factory

    with tempfile.TemporaryDirectory(prefix="aura-bundle-") as tmp:
        tmp_path = Path(tmp)
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            _safe_members(zf)
            zf.extractall(tmp_path)
        children = [p for p in tmp_path.iterdir()]
        if len(children) == 1 and children[0].is_dir():
            tmp_path = children[0]
        if (tmp_path / "node_modules").exists():
            raise _fail("bundle_zip_node_modules_forbidden")
        import_name = mod.replace("/", ".")
        sys.path.insert(0, str(tmp_path))
        try:
            module = importlib.import_module(import_name)
            factory = getattr(module, attr, None)
            if not callable(factory):
                raise _fail("factory_export_missing")
            return factory
        finally:
            sys.path.pop(0)
            if import_name in sys.modules:
                del sys.modules[import_name]
            prefix = import_name + "."
            for k in list(sys.modules):
                if k.startswith(prefix):
                    del sys.modules[k]
