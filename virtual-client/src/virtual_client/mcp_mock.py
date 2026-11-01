from __future__ import annotations

from copy import deepcopy

from fastmcp import FastMCP

from virtual_client.scenarios import get_scenario


class FixtureStore:
    def __init__(self, name: str = "cancel-in-transit") -> None:
        spec = get_scenario(name)
        self.name = spec.name
        self.data = deepcopy(spec.fixture)


_store = FixtureStore("cancel-in-transit")


def set_scenario(name: str) -> FixtureStore:
    global _store
    _store = FixtureStore(name)
    return _store


def lookup_order(store: FixtureStore, order_id: str = "", phone: str = "", name: str = "") -> dict:
    row = store.data
    if order_id and order_id != row["order_id"]:
        if phone and phone == row["customer"]["phone"]:
            return deepcopy(row)
        if name and name == row["customer"]["name"]:
            return deepcopy(row)
        return deepcopy(row)
    if phone and phone != row["customer"]["phone"] and not order_id:
        if name and name == row["customer"]["name"]:
            return deepcopy(row)
        return deepcopy(row)
    return deepcopy(row)


def lookup_shipping(store: FixtureStore, order_id: str = "") -> dict:
    row = lookup_order(store, order_id=order_id)
    ship = dict(row.get("shipping") or {})
    ship["order_id"] = row["order_id"]
    return ship


def refund(store: FixtureStore, amount: float, reason: str = "") -> dict:
    return {"executed": True, "amount": amount, "reason": reason, "order_id": store.data["order_id"]}


def build_mcp(store: FixtureStore | None = None) -> FastMCP:
    target = store if store is not None else _store
    mcp = FastMCP("ops")

    @mcp.tool(name="lookup_order")
    def tool_lookup_order(order_id: str = "", phone: str = "", name: str = "") -> dict:
        """주문 상태를 조회한다. 주문번호가 없으면 전화·이름으로 찾는다."""
        return lookup_order(target, order_id=order_id, phone=phone, name=name)

    @mcp.tool(name="lookup_shipping")
    def tool_lookup_shipping(order_id: str = "") -> dict:
        """배송 위치를 조회한다."""
        return lookup_shipping(target, order_id=order_id)

    @mcp.tool(name="refund")
    def tool_refund(amount: float, reason: str = "") -> dict:
        """환불. 고위험. 상담원 승인 필요."""
        return refund(target, amount, reason)

    return mcp


def mcp_url(host: str = "127.0.0.1", port: int = 18082) -> str:
    return f"http://{host}:{port}/mcp"


def start_mcp(store: FixtureStore | None = None, host: str = "127.0.0.1", port: int = 18082) -> str:
    import threading

    mcp = build_mcp(store)

    def run() -> None:
        try:
            mcp.run(transport="http", host=host, port=port, path="/mcp", show_banner=False)
        except TypeError:
            mcp.run(transport="http", host=host, port=port)

    threading.Thread(target=run, daemon=True).start()
    return mcp_url(host, port)
