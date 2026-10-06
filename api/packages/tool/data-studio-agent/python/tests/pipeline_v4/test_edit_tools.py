"""Edit tools of the specialist agents (no LLM): every call checks its input, changes the answer only
when valid, and returns ok/error followed by the current answer as JSON."""

import asyncio
import inspect
import json
from datetime import date
from typing import Any

import pytest

from src.pipeline_v4.agents.base import Draft, ToolAgent
from src.pipeline_v4.agents.specialists import (
    condition_agent,
    grouping_agent,
    measure_picker,
    per_agent,
    related_agent,
    set_agent,
    table_picker,
    term_matcher,
    time_agent,
    value_matcher,
)
from src.pipeline_v4.catalog import add_row_counts, row_count_id
from src.pipeline_v4.compiler import CompileError, compile_spec
from src.pipeline_v4.context import Names
from src.pipeline_v4.plan import check_metric_tables
from src.pipeline_v4.spec import QuerySpec
from src.settings import get_settings
from tests.pipeline_v4.catalog_fixture import build_catalog

CAT = build_catalog()
H = Names(CAT)
S = get_settings()

AGENTS: dict[str, ToolAgent] = {
    "tables": table_picker(S, CAT, H, None), "terms": term_matcher(S, CAT, H), "values": value_matcher(S, CAT, H, None),
    "measure": measure_picker(S, H), "time": time_agent(S), "grouping": grouping_agent(S, CAT, H, None),
    "condition": condition_agent(S, CAT, H, None), "set": set_agent(S, H), "per": per_agent(S, CAT, H, None),
    "related": related_agent(S, CAT, H, None),
}


def edit_toolkit(agent: ToolAgent, d: Draft) -> Any:
    return agent.toolkits(d)[-1]


def tools(name: str, question: str | None = None) -> tuple[Draft, dict[str, Any]]:
    """The edit tools of a specialist, as the bound async methods agno would call."""
    agent = AGENTS[name]
    d = Draft(agent.output_schema(), question)
    return d, {n: f.entrypoint for n, f in edit_toolkit(agent, d).get_async_functions().items()}


def call(fn: Any, **kw: Any) -> str:
    return asyncio.run(fn(**kw))


def current(result: str) -> dict:
    return json.loads(result.split("current answer: ", 1)[1])


# ── every specialist is small ──

def test_each_specialist_is_a_small_toolkit() -> None:
    for name, agent in AGENTS.items():
        kits = agent.toolkits(Draft(agent.output_schema()))
        edit = kits[-1].get_async_functions()
        decisions = [n for n in edit if n not in ("remove", "done", "search_phrase", "set_status", "add_assumption")]
        assert 1 <= len(decisions) <= 2, (name, decisions)
        assert "done" in edit and edit["done"].stop_after_tool_call, name     # done ends the turn
        read = kits[0].get_async_functions() if len(kits) == 2 else {}
        assert len(read) <= 2, (name, list(read))                             # include_tools keeps it small
        assert not kits[-1].get_functions(), name                              # every tool is async
        for n, f in {**read, **edit}.items():
            assert inspect.iscoroutinefunction(f.entrypoint), (name, n)
            assert n == "done" or "Args:" in (f.entrypoint.__doc__ or ""), (name, n)


# ── shared behaviour ──

def test_every_reply_shows_the_current_answer_and_errors_change_nothing() -> None:
    d, t = tools("tables")
    ok = call(t["add_table"], table="ORDERS", reason="counted")
    assert ok.startswith("ok: table orders")
    assert current(ok)["tables"] == [{"table": "orders", "reason": "counted"}]   # canonical name stored
    bad = call(t["add_table"], table="order", reason="x")
    assert bad.startswith("error: 'order' is not a known table; did you mean orders, order_items? (nothing changed)")
    assert current(bad) == current(ok)
    assert call(t["add_table"], table="orders", reason="again").startswith("error: orders is already in your answer")
    assert call(t["remove"], part="tables", item="nope").startswith("error: no tables item 'nope' (nothing changed). Next: send item as written in your current answer: orders")


# ── step 3 ──

def test_term_and_value_matchers() -> None:
    d, t = tools("terms")
    assert call(t["add_term"], term="đơn online").startswith("ok")
    assert "is not a known term" in call(t["add_term"], term="khách VIP")
    d, t = tools("values")
    assert "not its stored code (nothing changed). Next: send the stored code 'MN'" in call(t["add_value"], phrase="miền Nam", column="branches.region", value="Miền Nam")
    assert "is not a stored value of branches.region (nothing changed). Next: Run list_values(column='branches.region', contains='MT') — or use one of its stored codes: MB, MN" in \
        call(t["add_value"], phrase="x", column="branches.region", value="MT")
    assert call(t["add_value"], phrase="test", column="orders.is_test", value=1.0).startswith("ok")
    assert d.value.values[0].value == "1"                                       # JSON numbers become stored text


# ── step 4 ──

def test_measure_picker_and_clarify() -> None:
    d, t = tools("measure")
    assert "did you mean net_revenue" in call(t["add_metric"], phrase="x", metric="net_revenu")
    assert call(t["add_metric"], phrase="doanh thu", metric="net_revenue").startswith("ok")
    assert call(t["set_status"], status="clarify").startswith("error: clarify needs a message")
    call(t["set_status"], status="clarify", message="Gộp hay thuần?", options=["gộp", "thuần"])
    assert (d.value.status, d.value.options) == ("clarify", ["gộp", "thuần"])


def test_time_agent_checks_dates_and_keeps_order() -> None:
    d, t = tools("time", "doanh thu tháng 8 so với tháng 7")
    assert "is not before end" in call(t["add_period"], phrase="tháng 8", start="2026-09-01", end="2026-08-01")
    assert "YYYY-MM-DD" in call(t["add_period"], phrase="tháng 8", start="1/8/2026", end="1/9/2026")
    assert call(t["add_period"], phrase="năm nay", start="2026-01-01", end="2027-01-01").startswith("error:")  # not asked
    call(t["add_period"], phrase="tháng 8", start="2026-08-01", end="2026-09-01", label="tháng 8")
    call(t["add_period"], phrase="tháng 7", start="2026-07-01", end="2026-08-01", label="tháng 7")
    assert [p.label for p in d.value.periods] == ["tháng 8", "tháng 7"]


def test_grouping_and_condition_agents() -> None:
    d, t = tools("grouping")
    assert call(t["add_grouping"], phrase="theo miền", column="branches.region").startswith("ok: group by branches.region")
    assert "is not a known column" in call(t["add_grouping"], phrase="theo miền", column="region")
    d, t = tools("condition")
    assert "Next: send the stored code 'MN'" in call(t["add_filter"], phrase="miền Nam", column="branches.region", op="=", values=["Miền Nam"])
    assert "takes no value" in call(t["add_filter"], phrase="x", column="orders.status", op="is_null", values=["x"])
    assert call(t["add_filter"], phrase="online", column="orders.config.is_online", op="=", values=[True]).startswith("ok")
    assert d.value.filters[0].values == ["true"]
    assert call(t["add_segment"], phrase="đơn online", term="đơn online").startswith("ok")
    assert "not a segment (a set of rows)" in call(t["add_segment"], phrase="tăng trưởng", term="tăng trưởng")


def test_set_and_per_agents() -> None:
    d, t = tools("set")
    assert call(t["add_condition"], phrase="hơn 5 đơn", metric="order_count", op=">", value=5).startswith("ok: order_count > 5")
    assert "op" in call(t["add_condition"], phrase="hơn 5 đơn", metric="order_count", op="more", value=5)
    d, t = tools("per")
    call(t["set_per"], phrase="mỗi khách", column="orders.customer_id")
    assert call(t["add_summary"], agg="average").startswith("error")
    call(t["add_summary"], agg="avg")
    assert (d.value.column, d.value.summaries) == ("orders.customer_id", ["avg"])


# ── built-in row counts, checks ──

def test_every_table_gets_a_row_count_metric() -> None:
    cat = build_catalog()
    cat.metrics["clash"] = {"_id": "clash", "name": "count_orders", "kind": "aggregate", "entity_id": "orders",
                            "aggregation": "count"}
    add_row_counts(cat)
    names = {m["name"] for m in cat.metrics.values() if m.get("builtin")}
    assert {"count_branches", "count_customers", "count_order_items", "count_stock_daily"} <= names
    assert cat.metrics[row_count_id("orders")]["name"] == "count_sales_orders"   # a saved metric took count_orders
    spec = QuerySpec.model_validate({"metrics": [{"name": "n", "metric_id": row_count_id("branches")}]})
    assert asyncio.run(compile_spec(spec, cat)).sql == 'SELECT COUNT(*) AS "n" FROM "sales"."branches" AS "t0"'


def test_metric_from_an_unrelated_table_is_rejected() -> None:
    spec = QuerySpec.model_validate({"metrics": [{"name": "n", "metric_id": "m_stock"}]})
    errors = check_metric_tables(spec, CAT, H, ["orders", "branches"])
    assert errors[0].field == "metrics[0]"
    assert errors[0].message.startswith("closing_stock is computed from stock_daily, but this question is about orders, branches")
    assert check_metric_tables(spec, CAT, H, ["stock"]) == []


def test_detail_period_is_only_for_row_lists() -> None:
    spec = QuerySpec.model_validate({"metrics": [{"name": "n", "metric_id": "m_orders"}], "detail_period": "cur",
                                     "periods": {"cur": {"start": date(2026, 8, 1), "end": date(2026, 9, 1)}}})
    with pytest.raises(CompileError) as info:
        asyncio.run(compile_spec(spec, CAT))
    assert info.value.errors[0].field == "detail_period"


def test_picks_must_come_from_the_question_words() -> None:
    q = "Agent nào không có hội thoại nào trong 6 tháng đầu năm 2026?"
    d, t = tools("condition", q)
    bad = call(t["add_filter"], phrase="đang hoạt động", column="orders.status", op="=", values=["DONE"])
    assert bad.startswith("error: 'đang hoạt động' is not in the question (missing: dang, hoat, dong)")
    d, t = tools("values", "doanh thu mien nam")                      # accents and case don't matter
    assert call(t["add_value"], phrase="Miền Nam", column="branches.region", value="MN").startswith("ok")


def test_zero_conditions_and_time_groupings_are_refused() -> None:
    d, t = tools("set", "agent nào không có hội thoại")
    assert "the question type already says" in call(t["add_condition"], phrase="không có hội thoại", metric="order_count", op="=", value=0)
    d, t = tools("grouping")
    assert "splitting by time steps is handled by another step" in call(t["add_grouping"], phrase="theo tháng", column="orders.order_date")
    d, t = tools("grouping", "Số cuộc hội thoại theo tháng năm 2026")
    assert "'theo agent' is not in the question" in call(t["add_grouping"], phrase="theo agent", column="agents.agent_id")
    d, t = tools("condition")
    assert "time ranges are handled by another step" in call(t["add_filter"], phrase="x", column="orders.order_date", op=">=", values=["2026-01-01"])


def test_related_agent() -> None:
    d, t = tools("related", "đơn hàng có sản phẩm theo miền")
    assert call(t["add_has_related"], phrase="có sản phẩm", table="order_items").startswith("ok: rows with related order_items")
    assert "already in your answer" in call(t["add_has_related"], phrase="có sản phẩm", table="order_items")
    assert "not in the question" in call(t["add_has_related"], phrase="khuyến mãi", table="order_items")
    assert [(x.table, x.has) for x in d.value.related] == [("order_items", True)]


# ── finding the question's words and the terms ──

def test_search_phrase_shows_the_questions_own_words() -> None:
    from src.pipeline_v4.tools.common import question_spans

    q = "xin top 5 Chi nhánh có nhiều đơn hàng nhất"
    spans = question_spans(q, "chi nhanh")                # accents and case ignored, spans as written
    assert spans[0] == "Chi" and "Chi nhánh" in spans and "top 5 Chi" in spans
    assert "đơn hàng" in question_spans(q, "don hang")
    assert question_spans(q, "region") == []


def test_every_toolkit_taking_a_phrase_can_search_it() -> None:
    d, t = tools("grouping", "xin top 5 chi nhánh có nhiều đơn hàng nhất")
    assert "search_phrase" in t
    out = call(t["search_phrase"], pattern="chi nhánh")
    assert out.startswith("exact words of the question") and '- "chi nhánh"' in out
    assert "the question is: xin top 5" in call(t["search_phrase"], pattern="region")
    # a made-up phrase: the error says which search to run, with the words that are in the question
    assert "Run search_phrase(pattern='chi nhánh')" in call(t["add_grouping"], phrase="theo chi nhánh", column="branches.region")
    for name in ("measure", "time", "grouping", "condition", "related", "set", "per", "values"):
        assert "search_phrase" in tools(name, "q")[1], name


def test_search_term_lists_real_term_names() -> None:
    from src.pipeline_v4.tools.profile import ProfileTools

    p = ProfileTools(CAT, H, None)
    assert '“đơn online” [segment]' in asyncio.run(p.search_term("online"))
    everything = asyncio.run(p.search_term(""))
    assert "đơn online" in everything and "tăng trưởng" in everything
    assert "if the question uses no term, add none" in asyncio.run(p.search_term("workflow"))
    d, t = tools("terms")
    assert "Run search_term(pattern='workflow')" in call(t["add_term"], term="workflow")
    _, c = tools("condition")
    assert "Next: use one of: đơn online — or Run search_term(pattern='online x')" in call(c["add_segment"], phrase="x", term="online x")
    kits = AGENTS["terms"].toolkits(Draft(AGENTS["terms"].output_schema()))
    assert list(kits[0].get_async_functions()) == ["search_term"]       # the term matcher's read tool
