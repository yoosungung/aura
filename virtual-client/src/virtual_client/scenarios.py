from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ScenarioSpec:
    name: str
    title: str
    persona: str
    goal: str
    criteria: tuple[str, ...]


SCENARIOS: dict[str, ScenarioSpec] = {
    "cancel-in-transit": ScenarioSpec(
        name="cancel-in-transit",
        title="배송 중 취소 불가 안내 및 접수",
        persona="주문번호는 없지만 방금 주문한 물건을 즉시 취소하고 싶어하는 성격 급한 고객",
        goal="주문 취소 또는 반품 처리 방법을 최종 안내받는 것",
        criteria=(
            "에이전트가 배송 및 주문 상태 확인을 위해 주문번호 또는 고객 정보를 요청했는가?",
            "배송 시작 후에는 단순 취소가 불가능하고 반품 절차를 밟아야 함을 안내했는가?",
            "고객의 재촉에 정중하게 안내를 완료했는가?",
        ),
    ),
    "lost-package": ScenarioSpec(
        name="lost-package",
        title="배송 조회 및 오도착 분쟁",
        persona="외부 이동 중 모바일로 문의하여 주문번호를 모른 채, 어제 도착했어야 할 옷이 안 왔다며 다짜고짜 화를 내는 조급한 고객",
        goal="내 주문 상태(배송 완료 여부)를 파악하고, 물건이 문 앞에 없음을 알려 분실 확인 또는 재배송/환불 접수를 받아내는 것",
        criteria=(
            "에이전트가 주문번호 부재 시 휴대폰 번호 또는 이름 등 대체 식별 정보를 요청해 주문을 특정했는가?",
            "시스템 상 '배송 완료' 상태임을 명확히 안내하고, 고객 미수령 주장에 맞춰 배송 기사 확인 또는 분실 사고 접수를 진행했는가?",
            "고객의 일방적인 재촉에도 절차(확인 후 처리)를 차분하고 명확하게 설명했는가?",
        ),
    ),
    "return-fee": ScenarioSpec(
        name="return-fee",
        title="반품 배송비 분쟁",
        persona="신발 사이즈 미스로 반품하려다 왕복 배송비 6천 원 차감 안내를 보고 '무료배송 사기'라며 소비자원 고발을 운운하는 공격적인 고객",
        goal="배송비 차감에 대해 강력히 항의하다가, 사이즈 교환 시 배송비 조건을 확인한 후 교환 접수로 변경 완료하는 것",
        criteria=(
            "에이전트가 단순 변심 반품 시 왕복 배송비 발생 정책을 약관 근거와 함께 정중히 설명했는가?",
            "고객의 법적 대응/신고 위협 발언에 감정적으로 맞서지 않고 공감 및 완화 화법을 구사했는가?",
            "고객이 '교환'으로 의도를 바꿨을 때 이를 정확히 포착하여 교환 배송비 및 맞교환 절차를 안내했는가?",
        ),
    ),
    "damaged-exchange": ScenarioSpec(
        name="damaged-exchange",
        title="파손품 맞교환 및 품절 대안",
        persona="배송받은 유리 디퓨저가 깨져 상자까지 젖은 상태라 즉각 동일 제품 맞교환을 원하는 차분하지만 단호한 고객",
        goal="파손 사진 증빙을 제출하고 교환을 요청했으나, 해당 향 품절 시 타 제품 변경 대신 즉시 취소/환불 확정을 받는 것",
        criteria=(
            "에이전트가 파손에 대해 사과하고 안전 주의를 당부하며 파손 사진 증빙을 명확히 요청했는가?",
            "사진 확인 후 재고 부족(품절) 상황을 투명하게 안내하고 대체 선택지(타 향 변경 vs 전액 환불)를 제시했는가?",
            "고객의 환불 선택 시 깨진 제품의 폐기 안내(회수 생략)와 함께 결제 취소 접수를 완료했는가?",
        ),
    ),
    "coupon-retro": ScenarioSpec(
        name="coupon-retro",
        title="프로모션 쿠폰 소급 적용",
        persona="주문 완료 직후 10% 신규 할인 쿠폰(WELCOME10)을 누락한 것을 발견하고 결제 차액(15,000원)만 부분 환급받고 싶어 하는 알뜰한 고객",
        goal="카드 부분 취소 가능 여부를 확인하고, 불가능할 경우 포인트/적립금 대체 지급 또는 주문 취소 후 재주문 경로를 안내받는 것",
        criteria=(
            "에이전트가 고객의 주문 ID, 결제 수단, 쿠폰 코드 정보를 누락 없이 식별했는가?",
            "결제 후 쿠폰 사후 적용(PG 부분 취소) 가능 여부 정책을 명확히 안내했는가?",
            "단순 거절에 그치지 않고 대안(재주문 안내 또는 적립금 수동 지급 접수)을 제시했는가?",
        ),
    ),
}


def get_scenario(name: str) -> ScenarioSpec:
    if name not in SCENARIOS:
        raise KeyError(name)
    return SCENARIOS[name]
