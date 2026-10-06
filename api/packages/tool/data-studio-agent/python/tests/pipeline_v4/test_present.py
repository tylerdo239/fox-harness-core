"""Step 6 without an LLM: formatting, the number check, chart and follow-up toolkits, chart data and
the flow with scripted agents."""

import asyncio
from typing import Any

from src.pipeline_v4.agents.base import AgentRun, Draft
from src.pipeline_v4.agents.parts import ChartPick, ChartsOut, FollowUp, FollowUpsOut
from src.pipeline_v4.compiler import OutputColumn, compile_spec
from src.pipeline_v4.context import Names
from src.pipeline_v4.plan import PlanResult
from src.pipeline_v4.present import (
    PresentAgents,
    chart_payload,
    column_labels,
    data_table,
    follow_up_context,
    format_value,
    numbers_allowed,
    original_dataset,
    present,
    stat_cards,
    unknown_numbers,
    with_labels,
)
from src.pipeline_v4.retrieve import Retrieved
from src.pipeline_v4.run import RunResult
from src.pipeline_v4.spec import QuerySpec
from src.pipeline_v4.tools.step6 import ChartTools
from tests.pipeline_v4.catalog_fixture import build_catalog

CAT = build_catalog()
H = Names(CAT)
BY_BRANCH = QuerySpec.model_validate({"dimensions": [{"column_id": "b_id"}],
                                      "metrics": [{"name": "net_revenue", "metric_id": "m_rev"}]})
COMPILED = asyncio.run(compile_spec(BY_BRANCH, CAT))
COLS = COMPILED.columns                                  # branch_id, branch_id_label, net_revenue
ROWS = [{"branch_id": f"B{i}", "branch_id_label": f"Chi nhánh {i}", "net_revenue": 100.0 * i} for i in range(1, 5)]


def call(fn: Any, **kw: Any) -> str:
    return asyncio.run(fn(**kw))


# ── formatting and the number check ──

def test_time_steps_read_like_people_write_them() -> None:
    month = OutputColumn(name="m", kind="dimension", time_grain="month")
    quarter = OutputColumn(name="q", kind="dimension", time_grain="quarter")
    assert format_value("2026-02-01 00:00:00.000", month) == "2026-02"
    assert format_value("2026-04-01 00:00:00.000", quarter) == "2026-Q2"
    assert format_value(70.857142, None) == 70.86 and format_value(406.0, None) == 406


def test_numbers_must_come_from_the_result_or_the_notes() -> None:
    allowed = numbers_allowed("Top 5 agent tháng 8/2026", [{"n": 1250.5, "avg": 70.857142}], ["period: 2026-08-01"])
    assert unknown_numbers("Có 1.250,5 hội thoại, trung bình 70,86", allowed) == []   # Vietnamese formats
    assert unknown_numbers("tổng 1250.5 (tháng 8/2026)", allowed) == []
    assert unknown_numbers("chiếm 37,5% và tăng 420", allowed) == ["37,5", "420"]
    assert unknown_numbers("3 agent", allowed) == []                                     # small counts pass


def test_the_total_and_shares_of_an_additive_measure_may_be_quoted() -> None:
    rows = [{"rank": "1", "n": 17295, "avg": 2.5}, {"rank": "0", "n": 8354, "avg": 3.5}, {"rank": "2", "n": 2852, "avg": 1.0}]
    allowed = numbers_allowed("q", rows, [], {"n"})
    assert unknown_numbers("Tổng cộng 28.501 khách hàng, hạng 1 chiếm 60,7% (khoảng 61%)", allowed) == []
    assert unknown_numbers("tổng avg 7", allowed) == []            # small numbers pass anyway
    assert unknown_numbers("tổng 28.501", numbers_allowed("q", rows, [])) == ["28.501"]   # not additive: no total


# ── chart toolkit ──

def chart_tools(rows: list[dict] = ROWS, cols: list[OutputColumn] = COLS) -> tuple[Draft, dict]:
    d = Draft(ChartsOut())
    kit = ChartTools(d, original_dataset(rows, cols, CAT))
    return d, {n: f.entrypoint for n, f in kit.get_async_functions().items()}


def test_charts_are_checked_against_the_result() -> None:
    d, t = chart_tools()
    assert "Next: Run add_chart(type='bar', x='branch_id_label'" in call(t["add_chart"], type="bar", x="branch_id", y=["net_revenue"], title="t")
    assert "is a measure; x is what the values are split by (a name, category or time) (nothing changed). Next: Run add_chart(type='bar', x='branch_id_label'" in call(t["add_chart"], type="bar", x="net_revenue", y=["net_revenue"], title="t")
    assert "a line follows time" in call(t["add_chart"], type="line", x="branch_id_label", y=["net_revenue"], title="t")
    assert "not columns of dataset original: revenue" in call(t["add_chart"], type="bar", x="branch_id_label", y=["revenue"], title="t")
    assert call(t["add_chart"], type="bar", x="branch_id_label", y=["net_revenue"], title="Doanh thu").startswith("ok")
    assert "already in your answer" in call(t["add_chart"], type="bar", x="branch_id_label", y=["net_revenue"], title="again")
    assert call(t["add_chart"], type="pie", x="branch_id_label", y=["net_revenue"], title="Tỷ trọng", recommended=True).startswith("ok")
    assert [c.recommended for c in d.value.charts] == [False, True]


def test_pies_need_few_groups_and_no_negatives() -> None:
    many = [{"branch_id": f"B{i}", "branch_id_label": f"CN {i}", "net_revenue": i} for i in range(12)]
    _, t = chart_tools(many)
    assert "too many for a pie" in call(t["add_chart"], type="pie", x="branch_id_label", y=["net_revenue"], title="t")
    _, t = chart_tools([*ROWS, {"branch_id": "B9", "branch_id_label": "x", "net_revenue": -5}])
    assert "negative" in call(t["add_chart"], type="pie", x="branch_id_label", y=["net_revenue"], title="t")


def test_chart_data_is_built_by_code() -> None:
    pie = chart_payload(ChartPick(type="pie", x="branch_id_label", y=["net_revenue"], title="t"), ROWS, COLS)
    assert pie["y"] == ["net_revenue_share_pct"] and [r["net_revenue_share_pct"] for r in pie["rows"]] == [10.0, 20.0, 30.0, 40.0]
    assert pie["units"] == {"net_revenue": "VND"}
    assert stat_cards([{"net_revenue": 5}], [c for c in COLS if c.kind == "metric"])[0]["value"] == 5
    table = data_table(ROWS, COLS)
    assert table["columns"] == ["branch_id_label", "net_revenue"]                    # the id hides behind its name


# ── follow-up toolkit ──

def test_follow_ups_are_kept_only_when_grounded_new_and_in_the_question_language() -> None:
    from src.pipeline_v4.present import checked_follow_ups

    suggestions = [
        FollowUp(question="Doanh thu theo kênh?", based_on=["orders.channel"]),          # not in the profile
        FollowUp(question="Revenue by region?", based_on=["branches.region"]),           # wrong language
        FollowUp(question="Doanh thu theo chi nhánh?", based_on=["net_revenue"]),       # the question itself
        FollowUp(question="Doanh thu  theo miền?", based_on=["BRANCHES.REGION"]),
        FollowUp(question="doanh thu theo miền?", based_on=["branches.region"]),         # repeat
    ]
    kept, dropped = checked_follow_ups("Doanh thu theo chi nhánh?", suggestions, H)
    assert kept == [{"question": "Doanh thu theo miền?", "based_on": ["branches.region"]}]
    assert len(dropped) == 4


def test_follow_up_context_lists_what_the_query_did_not_use() -> None:
    r = Retrieved(question="q", tables=["orders"], lookups=["branches"])
    text = follow_up_context("Doanh thu theo chi nhánh?", BY_BRANCH, r, CAT, H)
    assert "Used by this answer: branches.branch_id, net_revenue" in text or "Used by this answer: net_revenue, branches.branch_id" in text
    assert "- branches.region" in text and "- orders.is_test" in text
    assert "Related tables:" in text and "- customers" in text


# ── flow ──

class FakeText:
    def __init__(self, *answers: str) -> None:
        self.answers, self.prompts = list(answers), []

    async def run(self, prompt: str, on_event: Any = None) -> str:
        self.prompts.append(prompt)
        return self.answers[min(len(self.prompts), len(self.answers)) - 1]


class FakeTool:
    def __init__(self, result: Any) -> None:
        self.result, self.prompts = result, []

    async def run(self, prompt: str, on_event: Any = None, initial: Any = None, question: Any = None) -> AgentRun:
        self.prompts.append(prompt)
        return AgentRun(result=self.result, text="done")


class FakeStructured:
    def __init__(self, result: Any) -> None:
        self.result = result

    async def run(self, prompt: str, on_event: Any = None) -> Any:
        return self.result


def agents(answer: FakeText, charts: ChartsOut | None = None) -> PresentAgents:
    a = PresentAgents(answer=answer, follow_ups=FakeStructured(FollowUpsOut(questions=[  # type: ignore[arg-type]
        FollowUp(question="Doanh thu theo miền?", based_on=["branches.region"])])), settings=None)  # type: ignore[arg-type]
    a.charts = lambda original: FakeTool(charts or ChartsOut())  # type: ignore[method-assign]
    return a


def ok_plan() -> PlanResult:
    return PlanResult(status="ok", spec=BY_BRANCH, compiled=COMPILED, assumptions=["orders: only rows where status = DONE"])


def test_a_full_answer_with_a_rewrite_for_an_invented_number() -> None:
    writer = FakeText("Chi nhánh 4 dẫn đầu với 400, gấp 4,5 lần.", "Chi nhánh 4 dẫn đầu với 400.")
    picks = ChartsOut(charts=[ChartPick(type="bar", x="branch_id_label", y=["net_revenue"], title="Doanh thu")])
    run = RunResult(status="ok", sql="", columns=COLS, rows=ROWS, row_count=4)
    p = asyncio.run(present("Doanh thu theo chi nhánh?", ok_plan(), run, Retrieved(question="q", tables=["orders"]),
                            CAT, H, agents(writer, picks)))
    assert p.answer_markdown == "Chi nhánh 4 dẫn đầu với 400." and len(writer.prompts) == 2
    assert "quoted numbers that are not in the result or notes: 4,5" in writer.prompts[1]
    assert "| branch_id_label | net_revenue |" in writer.prompts[0]                    # names, not ids
    assert "orders: only rows where status = DONE" in writer.prompts[0]
    assert [c["type"] for c in p.charts] == ["bar", "table"] and p.charts[0]["recommended"]
    assert p.follow_ups == [{"question": "Doanh thu theo miền?", "based_on": ["branches.region"]}]


def test_no_chart_from_the_agent_falls_back_to_a_bar_and_one_row_to_stat_cards() -> None:
    run = RunResult(status="ok", sql="", columns=COLS, rows=ROWS, row_count=4)
    p = asyncio.run(present("q", ok_plan(), run, Retrieved(question="q"), CAT, H, agents(FakeText("ok"))))
    assert [c["type"] for c in p.charts] == ["bar", "table"] and p.charts[0]["x"] == "branch_id_label"
    one = RunResult(status="ok", sql="", columns=COLS, rows=ROWS[:1], row_count=1)
    p = asyncio.run(present("q", ok_plan(), one, Retrieved(question="q"), CAT, H, agents(FakeText("ok"))))
    assert [c["type"] for c in p.charts] == ["stat", "table"]


def test_steps_that_stopped_get_a_reply_from_code() -> None:
    clarify = PlanResult(status="clarify", message="Doanh thu gộp hay thuần?", options=["gộp", "thuần"])
    p = asyncio.run(present("q", clarify, None, Retrieved(question="q"), CAT, H, agents(FakeText("unused"))))
    assert (p.status, p.answer_markdown, p.options) == ("clarify", "Doanh thu gộp hay thuần?\n\n- gộp\n- thuần", ["gộp", "thuần"])
    failed = RunResult(status="failed", stage="run", sql="", error="timeout")
    p = asyncio.run(present("q", ok_plan(), failed, Retrieved(question="q"), CAT, H, agents(FakeText("unused"))))
    assert p.status == "failed" and "timeout" in p.answer_markdown


def test_the_writer_is_told_what_the_rows_are() -> None:
    from src.pipeline_v4.agents.parts import IntentOut
    from src.pipeline_v4.present import rows_meaning

    plan = ok_plan()
    plan.intent = IntentOut(kind="rows_without", listed_table="branches", related_table="orders")
    assert rows_meaning(plan, H) == "Each row is a branches that has NO orders. These rows are the answer."
    plan.intent.count_rows = True
    assert rows_meaning(plan, H) == "There is one count: the number of branches that have NO orders."


def test_a_scatter_needs_two_different_measures() -> None:
    _, t = chart_tools()
    assert "two different numeric measures" in call(t["add_chart"], type="scatter", x="net_revenue", y=["net_revenue"], title="t")


def test_follow_up_context_leaves_out_what_is_always_applied() -> None:
    r = Retrieved(question="q", tables=["orders"])
    assert "- orders.status" not in follow_up_context("q", BY_BRANCH, r, CAT, H)   # orders always filter status = DONE


# ── several parts ──

def test_two_parts_get_one_answer_and_their_own_charts() -> None:
    from src.pipeline_v4.present import PartView, present_parts

    writer = FakeText("Phần 1: chi nhánh 4 có 400. Phần 2: không có dữ liệu.")
    run = RunResult(status="ok", sql="", columns=COLS, rows=ROWS, row_count=4)
    failed = PlanResult(status="failed", message="no metric")
    parts = [PartView("q1", "doanh thu theo chi nhánh", ok_plan(), run, Retrieved(question="q1")),
             PartView("q2", "số khách hàng", failed, None, Retrieved(question="q2"))]
    p = asyncio.run(present_parts("doanh thu theo chi nhánh và số khách hàng", parts, CAT, H, agents(writer)))
    prompt = writer.prompts[0]
    assert "answered in 2 parts" in prompt and "## Part q1: doanh thu theo chi nhánh" in prompt
    assert "## Part q2: số khách hàng\nNo result: Chưa tạo được truy vấn" in prompt   # the failed part's reply
    assert p.status == "answered" and len(writer.prompts) == 1                         # 400 is in q1's rows
    assert {c["part"] for c in p.charts} == {"q1"} and [c["type"] for c in p.charts] == ["bar", "table"]


def test_numbers_of_every_part_are_allowed_and_follow_ups_are_not_repeated() -> None:
    from src.pipeline_v4.present import PartView, present_parts

    writer = FakeText("400 và 7")
    seven = [{"branch_id": "B7", "branch_id_label": "Chi nhánh 7", "net_revenue": 700.0}]
    parts = [PartView("q1", "a", ok_plan(), RunResult(status="ok", sql="", columns=COLS, rows=ROWS, row_count=4),
                      Retrieved(question="a")),
             PartView("q2", "b", ok_plan(), RunResult(status="ok", sql="", columns=COLS, rows=seven, row_count=1),
                      Retrieved(question="b"))]
    p = asyncio.run(present_parts("a và b", parts, CAT, H, agents(writer)))
    assert len(writer.prompts) == 1                                     # 400 from q1 and 700 rows of q2: no rewrite
    assert [c["part"] for c in p.charts if c["type"] == "stat"] == ["q2"]   # one row → stat cards of q2
    assert len(p.follow_ups) == 1                                       # both parts suggested the same: kept once


# ── labels: what a chart shows for each field, from the profile's display names ──

def test_chart_fields_get_the_profile_names() -> None:
    labels = column_labels(COLS, CAT)
    branch = CAT.tables[CAT.columns["b_id"].entity_id].display_name
    metric = CAT.metrics["m_rev"].get("display_name") or CAT.metrics["m_rev"]["name"]
    assert labels["branch_id_label"] == branch and labels["branch_id"] == branch   # an id is named after its table
    assert labels["net_revenue"].startswith(metric)
    pie = with_labels(chart_payload(ChartPick(type="pie", x="branch_id_label", y=["net_revenue"], title="t"),
                                    ROWS, COLS), labels)
    assert pie["labels"]["branch_id_label"] == branch and pie["labels"]["net_revenue_share_pct"].endswith("(%)")
    assert stat_cards(ROWS[:1], COLS, labels)[0]["title"] == metric


# ── chart datasets: transforms by code, charts on them ──

MONTHS = [{"m": f"2026-0{i}", "region": r, "orders": i * k}
          for i in range(1, 5) for r, k in (("MB", 1), ("MN", 2))]
MCOLS = [OutputColumn(name="m", kind="dimension", time_grain="month"), OutputColumn(name="region", kind="dimension"),
         OutputColumn(name="orders", kind="metric", metric_id="m_orders")]


def test_transforms_make_datasets_that_charts_draw() -> None:
    d, t = chart_tools(MONTHS, MCOLS)
    out = call(t["pivot"], x="m", series="region", measure="orders")
    assert out.startswith("ok: dataset d1") and "| m | MB | MN |" in out and "| 2026-02 | 2 | 4 |" in out
    assert call(t["add_chart"], type="stacked_bar", x="m", y=["MB", "MN"], title="t", data="d1").startswith("ok")
    assert call(t["add_chart"], type="stacked_area", x="m", y=["MB", "MN"], title="t2", data="d1").startswith("ok")
    assert "— or pivot(x='region', series='m'" in call(t["add_chart"], type="stacked_bar", x="region", y=["orders"], title="t")
    out = call(t["running_total"], x="m", measure="MB", source="d1", label="lũy kế")
    assert "MB_running_total" in out and "| 2026-04 | 4 | 8 | 10 |" in out
    assert d.value.datasets[1].source == "d1"


def test_adding_up_only_additive_measures() -> None:
    cols = [*COLS[:2], OutputColumn(name="avg_x", kind="metric")]      # a summary without a summable metric
    rows = [{"branch_id": f"B{i}", "branch_id_label": f"CN {i}", "avg_x": i} for i in range(12)]
    _, t = chart_tools(rows, cols)
    assert "can't be added up" in call(t["top_n_other"], measure="avg_x", n=5, other_label="Khác")
    many = [{"branch_id": f"B{i}", "branch_id_label": f"CN {i}", "net_revenue": 10 + i} for i in range(12)]
    d, t = chart_tools(many)
    hint = call(t["add_chart"], type="pie", x="branch_id_label", y=["net_revenue"], title="t")
    assert "Next: Run top_n_other(measure='net_revenue', n=9" in hint
    out = call(t["top_n_other"], measure="net_revenue", n=9, other_label="Khác")
    assert "| Khác | Khác | 33 |" in out     # 10 + 11 + 12 added up
    assert call(t["add_chart"], type="donut", x="branch_id_label", y=["net_revenue"], title="t", data="d1").startswith("ok")


def test_bins_spread_a_measure() -> None:
    from src.pipeline_v4.agents.parts import DataStep
    from src.pipeline_v4.chart_data import apply

    rows = [{"branch_id": f"B{i}", "branch_id_label": f"CN {i}", "net_revenue": i} for i in range(1, 21)]
    ds = apply(DataStep(key="d1", op="bins", measure="net_revenue", bins=4, label="số chi nhánh"),
               {"original": original_dataset(rows, COLS, CAT)})
    assert [r["net_revenue_count"] for r in ds.rows] == [5, 5, 5, 5] and ds.rows[0]["net_revenue_range"] == "1-5"
    assert ds.labels["net_revenue_count"] == "số chi nhánh"


def test_charts_on_datasets_are_replayed_by_code() -> None:
    from src.pipeline_v4.agents.parts import DataStep

    picks = ChartsOut(datasets=[DataStep(key="d1", op="sort_rows", by="net_revenue", direction="desc", n=2)],
                      charts=[ChartPick(type="bar_horizontal", x="branch_id_label", y=["net_revenue"], title="Top 2",
                                        data="d1")])
    shown = asyncio.run(present("q", ok_plan(), RunResult(status="ok", sql="x", row_count=4, columns=COLS, rows=ROWS),
                                Retrieved(question="q"), CAT, H, agents(FakeText("Có 4 chi nhánh."), picks)))
    bar = next(c for c in shown.charts if c["type"] == "bar_horizontal")
    assert [r["branch_id_label"] for r in bar["rows"]] == ["Chi nhánh 4", "Chi nhánh 3"] and bar["data"] == "d1"


def test_an_x_that_repeats_must_be_regrouped_or_pivoted() -> None:
    _, t = chart_tools(MONTHS, MCOLS)
    out = call(t["add_chart"], type="bar", x="region", y=["orders"], title="t")
    assert "region repeats" in out and "Next: Run regroup(by='region', agg='sum', measure='orders'" in out
