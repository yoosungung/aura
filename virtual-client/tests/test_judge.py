from types import SimpleNamespace

from virtual_client.judge import coerce_judge_tool_calls


DECISION_TOOLS = [
    {"type": "function", "function": {"name": "continue_test", "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "make_verdict", "parameters": {"type": "object", "properties": {}}}},
]

FINISH_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "finish_test",
            "parameters": {
                "type": "object",
                "properties": {
                    "criteria": {
                        "properties": {
                            "asks_order_id": {"description": "주문번호를 요청했는가?"},
                        }
                    }
                },
            },
        },
    }
]


def _resp(content: str = "", tool_calls=None):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=tool_calls))]
    )


def test_keeps_native_tool_calls():
    existing = [SimpleNamespace(function=SimpleNamespace(name="continue_test", arguments="{}"))]
    out = coerce_judge_tool_calls(_resp(tool_calls=existing), DECISION_TOOLS, "required")
    assert out.choices[0].message.tool_calls is existing


def test_echoed_transcript_becomes_continue_test():
    content = 'user: "취소"\nassistant: "지금은 상담원이 이어서 도와드리겠습니다."\n'
    out = coerce_judge_tool_calls(_resp(content), DECISION_TOOLS, "required")
    call = out.choices[0].message.tool_calls[0]
    assert call.function.name == "continue_test"


def test_json_name_is_honored():
    out = coerce_judge_tool_calls(_resp('{"name":"make_verdict"}'), DECISION_TOOLS, "required")
    assert out.choices[0].message.tool_calls[0].function.name == "make_verdict"


def test_pinned_finish_test_becomes_inconclusive():
    out = coerce_judge_tool_calls(
        _resp("ok"),
        FINISH_TOOLS,
        {"type": "function", "function": {"name": "finish_test"}},
    )
    call = out.choices[0].message.tool_calls[0]
    assert call.function.name == "finish_test"
    assert '"status": "inconclusive"' in call.function.arguments
    assert "asks_order_id" in call.function.arguments
