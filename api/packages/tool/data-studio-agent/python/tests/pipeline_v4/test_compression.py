"""Context compression of tool agents: code rules for edit results and short results, the model for
profile lookups (fake model), the 20k-token trigger."""

import asyncio
from typing import Any

from agno.models.message import Message

from src.pipeline_v4.agents.compression import (
    COMPRESS_AT_TOKENS,
    KEEP_UNDER_CHARS,
    PROMPT,
    PipelineCompression,
    strip_descriptions,
)


class FakeModel:
    def __init__(self, reply: str, tokens: int = 0) -> None:
        self.reply, self.tokens, self.calls = reply, tokens, []

    async def aresponse(self, messages: list[Message]) -> Any:
        self.calls.append(messages)
        return type("R", (), {"content": self.reply})()

    async def acount_tokens(self, messages: Any, tools: Any = None, response_format: Any = None) -> int:
        return self.tokens


def tool(content: str, name: str = "describe_table") -> Message:
    return Message(role="tool", content=content, tool_name=name)


LONG_LOOKUP = "orders — “Đơn hàng” [fact]\n" + "\n".join(f"orders.col_{i} VARCHAR dimension “Cột {i}”" for i in range(120))


def run(manager: PipelineCompression, messages: list[Message]) -> None:
    asyncio.run(manager.acompress(messages))


def test_edit_results_keep_only_the_newest_answer_whole() -> None:
    first = tool('ok: table orders\ncurrent answer: {"tables": ["orders"]}', "add_table")
    second = tool('error: x is not a known table (nothing changed)\ncurrent answer: {"tables": ["orders"]}', "add_table")
    m = PipelineCompression(FakeModel("unused"))  # type: ignore[arg-type]
    run(m, [first, second])
    assert first.compressed_content == "ok: table orders"
    assert second.compressed_content == second.content            # the current answer, exactly
    third = tool('ok: table branches\ncurrent answer: {"tables": ["orders", "branches"]}', "add_table")
    run(m, [first, second, third])
    assert second.compressed_content == "error: x is not a known table (nothing changed)"   # superseded now
    assert third.compressed_content == third.content


def test_short_results_are_kept_and_lookups_are_summarized_with_the_question() -> None:
    model = FakeModel("orders — one row = one order\norders.col_1 VARCHAR")
    m = PipelineCompression(model, question="top 5 <A>")  # type: ignore[arg-type]
    short, lookup = tool("table orders — Đơn hàng"), tool(LONG_LOOKUP)
    seen: list[dict] = []

    async def note(stats: dict) -> None:
        seen.append(stats)

    m.on_compress = note
    run(m, [short, lookup])
    assert len(short.content) < KEEP_UNDER_CHARS and short.compressed_content == short.content
    assert lookup.compressed_content == model.reply and len(model.calls) == 1
    system, user = model.calls[0]
    assert system.content == PROMPT and "Question the agent is working on: top 5 <A>" in user.content
    assert "Tool: describe_table" in user.content
    assert seen[0]["shortened"] == 1 and seen[0]["chars_after"] < seen[0]["chars_before"]


def test_a_summary_no_shorter_than_the_original_is_not_used() -> None:
    lookup = tool(LONG_LOOKUP)
    run(PipelineCompression(FakeModel(LONG_LOOKUP + " and more")), [lookup])  # type: ignore[arg-type]
    assert lookup.compressed_content == lookup.content


def test_compression_starts_at_20000_tokens() -> None:
    m = PipelineCompression(FakeModel("x"))  # type: ignore[arg-type]
    assert COMPRESS_AT_TOKENS == 20_000 and m.compress_token_limit == 20_000 and m.compress_tool_results_limit is None
    msgs = [tool("x")]
    assert not asyncio.run(m.ashould_compress(msgs, model=FakeModel("", tokens=19_999)))  # type: ignore[arg-type]
    assert asyncio.run(m.ashould_compress(msgs, model=FakeModel("", tokens=20_000)))  # type: ignore[arg-type]


def test_the_prompt_names_nothing_of_one_database() -> None:
    for word in ("conversation", "workflow", "intent", "branch", "revenue"):  # "agent" = the pipeline's agent
        assert word not in PROMPT.lower()


DESCRIBED = """conversations — “Cuộc hội thoại” [fact]
   one row = 1 dòng = 1 cuộc hội thoại.
   Bảng lưu trữ thông tin chi tiết của từng cuộc hội thoại.
   main time column: conversations.created_at (business time Asia/Ho_Chi_Minh)
   always applied: deleted_at is empty
   columns:
     conversations.agent_id VARCHAR key id “Mã Agent” (links to agents.agent_id) — Mã định danh duy nhất của Agent
     conversations.is_active BOOLEAN key boolean “Trạng thái” — Trạng thái hoạt động · all values: 0=Đã kết thúc, 1=Đang hoạt động
metric dem_x — “Đếm x”: count(*) of x where is_active = 1 [cái]"""


def test_code_drops_only_free_text_descriptions() -> None:
    assert strip_descriptions(DESCRIBED) == """conversations — “Cuộc hội thoại” [fact]
   one row = 1 dòng = 1 cuộc hội thoại.
   main time column: conversations.created_at (business time Asia/Ho_Chi_Minh)
   always applied: deleted_at is empty
   columns:
     conversations.agent_id VARCHAR key id “Mã Agent” (links to agents.agent_id)
     conversations.is_active BOOLEAN key boolean “Trạng thái” · all values: 0=Đã kết thúc, 1=Đang hoạt động
metric dem_x — “Đếm x”: count(*) of x where is_active = 1 [cái]"""


def test_a_result_short_after_stripping_needs_no_model_call() -> None:
    model = FakeModel("unused")
    lookup = tool(DESCRIBED * 3)                       # long, but short once descriptions are gone
    run(PipelineCompression(model), [lookup])  # type: ignore[arg-type]
    assert model.calls == [] and lookup.compressed_content == strip_descriptions(DESCRIBED * 3)
