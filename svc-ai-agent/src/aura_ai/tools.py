from __future__ import annotations

HIGH_RISK = {"refund", "cancel_subscription", "change_plan"}
LOW_RISK = {"lookup_order", "lookup_shipping", "send_status"}

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "lookup_order",
            "description": "주문 상태를 조회한다.",
            "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lookup_shipping",
            "description": "배송 위치를 조회한다.",
            "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_status",
            "description": "고객에게 상태 안내를 보낸다. 저위험.",
            "parameters": {"type": "object", "properties": {"content": {"type": "string"}}, "required": ["content"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "refund",
            "description": "환불. 고위험. 상담원 승인 필요.",
            "parameters": {
                "type": "object",
                "properties": {"amount": {"type": "number"}, "reason": {"type": "string"}},
                "required": ["amount"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_subscription",
            "description": "구독 해지. 고위험.",
            "parameters": {"type": "object", "properties": {"reason": {"type": "string"}}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "change_plan",
            "description": "요금제 변경. 고위험.",
            "parameters": {"type": "object", "properties": {"plan": {"type": "string"}}, "required": ["plan"]},
        },
    },
]


def is_high_risk(name: str) -> bool:
    return name in HIGH_RISK


def run_low_risk(name: str, args: dict) -> dict:
    if name == "lookup_order":
        return {"order_id": args.get("order_id", ""), "status": "paid"}
    if name == "lookup_shipping":
        return {"order_id": args.get("order_id", ""), "location": "in_transit"}
    if name == "send_status":
        return {"sent": True, "content": args.get("content", "")}
    if name in HIGH_RISK:
        return {"pending_approval": True}
    return {"error": "unknown_tool"}
