---
name: shipping-status
description: Use when the customer asks where a shipment is, ETA, or tracking. Look up the order then send a status.
---

# shipping-status

배송 문의는 저위험이다. `lookup_shipping` 또는 `lookup_order` MCP를 호출한 뒤 `send_status`로 안내한다.

## Instructions

1. 주문 번호가 있으면 `lookup_shipping`을 먼저 쓴다.
2. 결과가 없으면 `lookup_order`로 결제 상태를 확인한다.
3. 고객 문구는 `send_status`로만 보낸다. 추측성 ETA를 만들지 않는다.
