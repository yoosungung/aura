from __future__ import annotations

from copy import deepcopy

from fastmcp import FastMCP

FIXTURES: dict[str, dict] = {
    "cancel-in-transit": {
        "order_id": "ORD-CANCEL",
        "status": "paid",
        "customer": {"phone": "010-5555-0000", "name": "김가상"},
        "shipping": {"status": "in_transit", "location": "in_transit"},
        "policy": {"cancel_after_ship": False, "return_ok": True},
    },
    "lost-package": {
        "order_id": "ORD-LOST",
        "status": "paid",
        "customer": {"phone": "010-5555-0001", "name": "이조급"},
        "shipping": {"status": "delivered", "location": "delivered"},
        "policy": {"lost_claim_ok": True},
    },
    "return-fee": {
        "order_id": "ORD-SHOE",
        "status": "paid",
        "customer": {"phone": "010-5555-0002", "name": "박신발"},
        "shipping": {"status": "delivered", "location": "delivered"},
        "policy": {
            "return_shipping_krw": 6000,
            "exchange_shipping_krw": 3000,
            "reason": "단순 변심 왕복 배송비",
        },
    },
    "damaged-exchange": {
        "order_id": "ORD-GLASS",
        "status": "paid",
        "customer": {"phone": "010-5555-0003", "name": "최파손"},
        "shipping": {"status": "delivered", "location": "delivered"},
        "sku": {"name": "유리 디퓨저", "stock": 0, "alt_scents": True},
        "policy": {"broken_no_return": True, "refund_ok": True},
    },
    "coupon-retro": {
        "order_id": "ORD-WELCOME",
        "status": "paid",
        "customer": {"phone": "010-5555-0004", "name": "정쿠폰"},
        "shipping": {"status": "preparing", "location": "warehouse"},
        "coupon": {
            "code": "WELCOME10",
            "pg_partial_cancel": False,
            "delta": 15000,
            "payment": "card",
        },
    },
}


class FixtureStore:
    def __init__(self, name: str = "cancel-in-transit") -> None:
        if name not in FIXTURES:
            raise KeyError(name)
        self.name = name
        self.data = deepcopy(FIXTURES[name])


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
    find_order = lookup_order
    find_shipping = lookup_shipping
    do_refund = refund
    mcp = FastMCP("ops")

    @mcp.tool
    def lookup_order(order_id: str = "", phone: str = "", name: str = "") -> dict:
        """주문 상태를 조회한다. 주문번호가 없으면 전화·이름으로 찾는다."""
        return find_order(target, order_id=order_id, phone=phone, name=name)

    @mcp.tool
    def lookup_shipping(order_id: str = "") -> dict:
        """배송 위치를 조회한다."""
        return find_shipping(target, order_id=order_id)

    @mcp.tool
    def refund(amount: float, reason: str = "") -> dict:
        """환불. 고위험. 상담원 승인 필요."""
        return do_refund(target, amount, reason)

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
