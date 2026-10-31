---
name: refund-policy
description: Use when the customer asks for a refund, cancellation, or payment reversal. Covers approval-card rules before calling the ops MCP refund tool.
---

# refund-policy

환불·결제 취소는 고위험이다. `refund` MCP를 바로 호출하지 말고 상담원 승인 카드를 낸다.

## Instructions

1. 금액과 사유를 메시지에서 읽는다. 없으면 고객에게 한 번만 확인한다.
2. `refund` 도구를 선택한다. 하네스가 승인 카드를 발행한다.
3. 승인 전에는 운영계 MCP를 치지 않는다.
4. 고객에게는 환불 검토 중이라고 약속하지 말고, 승인 카드만 남긴다.
