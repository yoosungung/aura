"""MCP cfg/source branch parity with nodejs/factory.js."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

_ATTR = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def is_module_entrypoint(entrypoint: Any) -> bool:
    if not isinstance(entrypoint, str):
        return False
    if entrypoint.count(":") != 1:
        return False
    mod, attr = entrypoint.split(":", 1)
    if not mod or mod.startswith("aura") or not attr or not _ATTR.match(attr):
        return False
    return True


def sha256_prefixed(body: bytes) -> str:
    return "sha256:" + hashlib.sha256(body).hexdigest()


def uses_streamable_http(cfg: Any) -> bool:
    if not isinstance(cfg, dict):
        return False
    if cfg.get("transport") == "streamable_http":
        return True
    return isinstance(cfg.get("mcp_endpoint"), str) and bool(cfg.get("mcp_endpoint"))


def _endpoint(cfg: dict) -> str:
    ep = cfg.get("mcp_endpoint") or cfg.get("endpoint") or ""
    return ep if isinstance(ep, str) else ""


def _fail(message: str) -> RuntimeError:
    return RuntimeError(message)


def load_factory(source: str, entrypoint: str):
    attr = entrypoint.rsplit(":", 1)[-1]
    ns: dict[str, Any] = {}
    exec(source, ns, ns)  # noqa: S102 — signed checksummed bundle only
    factory = ns.get(attr)
    if not callable(factory):
        raise _fail("factory_export_missing")
    return factory


async def _read_json_or_sse(resp_text: str, content_type: str, want_id: Any) -> dict:
    if "text/event-stream" in content_type:
        last = None
        for line in resp_text.splitlines():
            if line.startswith("data:"):
                raw = line[5:].strip()
                if raw:
                    last = json.loads(raw)
        if not isinstance(last, dict):
            raise _fail("empty_response_body")
        msg = last
    else:
        msg = json.loads(resp_text) if resp_text.strip() else None
    if not isinstance(msg, dict):
        raise _fail("empty_response_body")
    if want_id is not None and msg.get("id") != want_id:
        raise _fail("jsonrpc_id_mismatch")
    if msg.get("error"):
        raise _fail("jsonrpc_error")
    return msg.get("result") if isinstance(msg.get("result"), dict) else {"value": msg.get("result")}


def http_factory(cfg: dict, deps: dict) -> dict:
    endpoint = _endpoint(cfg)
    if not endpoint:
        raise _fail("mcp_endpoint_required")
    fetch = deps.get("fetch") or deps.get("fetch_impl")
    session = cfg.get("mcp_session_id") or cfg.get("session_id")
    protocol = cfg.get("mcp_protocol_version") or "2025-06-18"

    async def _post(method: str, params: dict) -> dict:
        if not callable(fetch):
            raise _fail("fetch_unavailable")
        req_id = "mcp-py"
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": protocol,
        }
        if isinstance(session, str) and session:
            headers["Mcp-Session-Id"] = session
        body = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        resp = await fetch(endpoint, {"method": "POST", "headers": headers, "body": body})
        text = resp.get("text") if isinstance(resp, dict) else None
        if callable(text):
            text = await text()
        ctype = ""
        hdrs = resp.get("headers") if isinstance(resp, dict) else None
        if isinstance(hdrs, dict):
            ctype = str(hdrs.get("content-type") or hdrs.get("Content-Type") or "")
        return await _read_json_or_sse(text or "", ctype, req_id)

    async def list_tools(_ctx=None):
        result = await _post("tools/list", {})
        tools = result.get("tools") if isinstance(result, dict) else []
        return {"ok": True, "tools": tools or [], "mode": "streamable_http"}

    async def run_tool(ctx):
        result = await _post(
            "tools/call",
            {"name": (ctx or {}).get("tool"), "arguments": (ctx or {}).get("arguments") or {}},
        )
        payload = result if isinstance(result, dict) else {"value": result}
        return {"ok": True, "mode": "streamable_http", **payload}

    return {"listTools": list_tools, "runTool": run_tool}


async def open_bundle(source: dict, cfg: dict, deps: dict) -> dict:
    load = deps.get("load_bundle") or deps.get("loadBundle")
    if not callable(load):
        raise _fail("bundle_missing")
    raw = await load(source)
    if raw is None:
        raise _fail("bundle_missing")
    body = raw if isinstance(raw, (bytes, bytearray)) else str(raw).encode("utf-8")
    if sha256_prefixed(body) != source.get("checksum"):
        raise _fail("bundle_checksum_mismatch")
    text = body.decode("utf-8")
    factory = load_factory(text, source["entrypoint"])
    instance = factory(cfg, deps.get("secrets_ref"))
    if not isinstance(instance, dict):
        raise _fail("factory_instance_missing")
    return instance


async def open_factory(cfg: Any, deps: dict | None = None) -> dict:
    d = deps or {}
    cfg = cfg if isinstance(cfg, dict) else {}
    if uses_streamable_http(cfg):
        return http_factory(cfg, d)
    source = d.get("source") if isinstance(d.get("source"), dict) else {}
    if is_module_entrypoint(source.get("entrypoint")):
        if not isinstance(source.get("sig_uri"), str) or not source.get("sig_uri"):
            raise _fail("bundle_untrusted")
        return await open_bundle(source, cfg, d)
    if callable(d.get("list_tools")) or callable(d.get("run_tool")) or callable(d.get("listTools")) or callable(d.get("runTool")):
        return {
            "listTools": d.get("listTools") or d.get("list_tools"),
            "runTool": d.get("runTool") or d.get("run_tool"),
        }
    raise _fail("mcp_backend_missing")
