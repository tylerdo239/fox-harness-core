"""Retrieval agent pieces without an LLM: async tools, YAML extraction, selection checks, flow."""

import asyncio
from typing import Any

from src.pipeline_v4.agents.base import AgentFailed, AgentRun
from src.pipeline_v4.agents.keywords import KeyPhrase, Keywords
from src.pipeline_v4.agents.parts import TablesOut, TermsOut, ValuesOut
from src.pipeline_v4.agents.retrieval import (
    NotFound,
    PickedTable,
    PickedValue,
    RetrievalOut,
    apply_selection,
)
from src.pipeline_v4.context import Names
from src.pipeline_v4.find import FindAgents, find_profile
from src.pipeline_v4.retrieve import retrieve
from src.pipeline_v4.tools.profile import ProfileTools
from tests.pipeline_v4.catalog_fixture import build_catalog

CAT = build_catalog()
H = Names(CAT)
_PROFILE = ProfileTools(CAT, H, None)
SEARCH, DESCRIBE, VALUES, JOIN = _PROFILE.search_profile, _PROFILE.describe_table, _PROFILE.list_values, _PROFILE.join_path
T = {tid: H.of(tid) for tid in CAT.tables}          # table id → handle
C = {cid: H.of(cid) for cid in CAT.columns}


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def out(**kw: Any) -> RetrievalOut:
    return RetrievalOut(**{"tables": [], "metrics": [], "terms": [], "columns": [], "values": [], "not_found": [], **kw})


# ── tools ──

def test_tools_are_async() -> None:
    assert all(asyncio.iscoroutinefunction(t) for t in (SEARCH, DESCRIBE, VALUES, JOIN))


def test_search_profile_finds_by_kind() -> None:
    text = run(SEARCH("chi nhánh", "table"))
    assert text.startswith("table branches — “branches”")
    values = run(SEARCH("Miền Nam", "value"))
    assert "value branches.region = MN (Miền Nam)" in values
    assert "nothing found" in run(SEARCH("thời tiết"))


def test_describe_table_shows_columns_and_links() -> None:
    text = run(DESCRIBE(T["branches"]))
    assert "all values: MB=Miền Bắc, MN=Miền Nam" in text
    assert "branches 1:N orders (branches.branch_id = orders.branch_id)" in text
    assert run(DESCRIBE("order")).startswith("'order' is not a known table; did you mean orders, order_items?. "
                                             "Next: Run search_profile(text='order', kind='table')")
    assert "is not a known table" in run(DESCRIBE("branches.region"))   # a column is not a table
    assert run(DESCRIBE("SALES.BRANCHES")).startswith("branches —")      # full path, any case


def test_list_values_filters_by_words() -> None:
    assert run(VALUES(C["b_region"], "nam")).splitlines()[1:] == ["MN = Miền Nam"]
    assert "no recorded value list" in run(VALUES(C["c_segment"]))


def test_join_path_tells_whether_rows_repeat() -> None:
    assert run(JOIN(T["orders"], T["branches"])).endswith("does not repeat rows: safe for grouping and filtering")
    assert "repeats rows of the first table" in run(JOIN(T["orders"], T["items"]))
    assert run(JOIN(T["orders"], T["orders"])).startswith("same table")


# ── selection ──

def _pre() -> Any:
    kw = Keywords(phrases=[KeyPhrase(text="doanh thu", english="revenue", role="measure")], time_phrases=[])
    return run(retrieve("doanh thu miền Nam", kw, CAT))


def test_selection_keeps_valid_picks_and_adds_missing_tables() -> None:
    r = run(apply_selection(out(
        tables=[PickedTable(table=T["orders"], reason="measured")],
        metrics=[H.of("m_aov")],
        values=[PickedValue(phrase="miền Nam", column=C["b_region"], value="Miền Nam")],  # label instead of code
        not_found=[NotFound(phrase="lợi nhuận", reason="no profit data")],
    ), _pre(), CAT, H))
    assert r.tables == ["orders", "branches"]          # branches added: the value lives there
    assert r.metrics[:3] == ["m_aov", "m_rev", "m_orders"]  # picks first, a ratio brings its parts
    assert {"m_branches", "m_cancelled", "m_customers"} <= set(r.metrics)  # then every metric of the chosen tables
    assert [(v.column_id, v.value, v.exact) for v in r.values] == [("b_region", "MN", True)]
    assert r.not_found == [("lợi nhuận", "no profit data")]
    assert "customers" in r.lookups


def test_selection_drops_invented_handles_and_values() -> None:
    r = run(apply_selection(out(
        tables=[PickedTable(table=T["orders"], reason="x"), PickedTable(table="sales_targets", reason="made up")],
        metrics=[T["orders"]],                                   # a table name is not a metric
        values=[PickedValue(phrase="miền Trung", column=C["b_region"], value="MT")],  # not in the complete list
    ), _pre(), CAT, H))
    assert r.tables == ["orders"]
    assert r.values == []                                    # the invented value is dropped
    assert r.notes[-1] == "ignored unknown picks: sales_targets, orders, branches.region=MT"


def test_selection_without_tables_falls_back_to_the_pre_search() -> None:
    pre = _pre()
    assert run(apply_selection(out(), pre, CAT, H)) is pre
    assert pre.notes[-1] == "the retrieval agent picked no table; using the pre-search"


# ── flow ──

class FakeKeywords:
    async def run(self, prompt: str, on_event: Any = None) -> Keywords:
        return Keywords(phrases=[KeyPhrase(text="doanh thu", english="revenue", role="measure"),
                                 KeyPhrase(text="miền Nam", english="south region", role="value")],
                        time_phrases=["tháng 8"])


class Scripted:
    """A specialist that answers a fixed result and records its prompts."""

    def __init__(self, result: Any = None, fail: bool = False) -> None:
        self.result, self.fail, self.prompts = result, fail, []

    async def run(self, prompt: str, on_event: Any = None, initial: Any = None, question: Any = None) -> AgentRun:
        self.prompts.append(prompt)
        if self.fail:
            raise AgentFailed("timeout")
        return AgentRun(result=self.result, text="done", tool_calls=[{"tool": "add_table", "args": {}}])


def agents(tables: Any, terms: Any = None, values: Any = None) -> FindAgents:
    return FindAgents(keywords=FakeKeywords(), tables=tables, terms=terms, values=values)  # type: ignore[arg-type]


def test_find_profile_runs_the_specialists_it_needs() -> None:
    tables = Scripted(TablesOut(tables=[PickedTable(table="orders", reason="revenue")]))
    values = Scripted(ValuesOut(values=[PickedValue(phrase="miền Nam", column="branches.region", value="MN")]))
    terms = Scripted(TermsOut())
    r = run(find_profile("doanh thu miền Nam tháng 8", CAT, H, agents(tables, terms, values), None))
    prompt = tables.prompts[0]
    assert "- miền Nam (english: south region; role: value)" in prompt
    assert "Time phrases (handled later): tháng 8" in prompt
    assert "# Pre-search result" in prompt and "= MN (Miền Nam)" in prompt
    assert values.prompts and not terms.prompts           # a value was named; the pre-search found no term
    assert r.tables == ["orders", "branches"]               # branches comes with the value
    assert "m_rev" in r.metrics                             # every metric of the chosen tables is an option
    assert set(r.trace["agents"]) == {"tables", "values"}


def test_find_profile_uses_the_pre_search_when_the_table_picker_fails() -> None:
    r = run(find_profile("doanh thu miền Nam", CAT, H, agents(Scripted(fail=True)), None))
    assert r.tables[0] == "orders"
    assert r.notes[-2].startswith("tables agent failed") and r.notes[-1] == "no table picked; using the pre-search"


def test_read_tools_accept_non_text_arguments() -> None:
    assert run(VALUES("branches.region", True)).startswith("no value of branches.region matches True. "
                                                          "Next: Run list_values(column='branches.region', contains='')")
    assert run(SEARCH(2026)).startswith("nothing found for '2026'")
