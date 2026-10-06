"""Step 3 (retrieval + agent context) on the hand-built catalog; search is faked, no network."""

import asyncio
from typing import Any

import pytest

from src.data_profile import search_index as ix
from src.pipeline_v4.agents.base import AgentFailed
from src.pipeline_v4.agents.keywords import KeyPhrase, Keywords
from src.pipeline_v4.context import Names, UnknownName, build_context
from src.pipeline_v4.find import FindAgents, find_profile
from src.pipeline_v4.retrieve import SearchQuery, normalize, phrase_in, retrieve, words
from tests.pipeline_v4.catalog_fixture import build_catalog


def retrieve_now(*args: Any, **kwargs: Any) -> Any:
    return asyncio.run(retrieve(*args, **kwargs))


def context_now(*args: Any) -> Any:
    return asyncio.run(build_context(*args))


def kw(*phrases: tuple[str, str, str], times: tuple[str, ...] = ()) -> Keywords:
    """What the keyword agent would return: (text, english, role) per phrase."""
    return Keywords(phrases=[KeyPhrase(text=t, english=e, role=r) for t, e, r in phrases], time_phrases=list(times))


class FakeSearch:
    def __init__(self, hits: dict[str, dict[str, list[tuple[dict[str, Any], float]]]]) -> None:
        self.hits = hits  # query text → index → hits
        self.calls: list[tuple[list[str], list[str] | None]] = []

    async def search(self, queries: list[SearchQuery], data_source_ids: list[str] | None) -> list[dict[str, list[tuple[dict[str, Any], float]]]]:
        self.calls.append(([q.text for q in queries], data_source_ids))
        return [self.hits.get(q.text, {}) for q in queries]


class BrokenSearch:
    async def search(self, queries: list[SearchQuery], data_source_ids: list[str] | None) -> list[dict[str, list[tuple[dict[str, Any], float]]]]:
        raise ConnectionError("meilisearch down")


def test_normalize_drops_accents_case_and_punctuation() -> None:
    assert normalize("Doanh thu Miền Nam, tháng 8!") == "doanh thu mien nam thang 8"
    assert normalize("Đơn_hàng") == "don hang"


def test_phrase_match_is_whole_words_and_ignores_plural() -> None:
    assert phrase_in("agent", words("top agents"))
    assert not phrase_in("age", words("top agents"))


def test_value_phrase_without_accents_finds_the_code() -> None:
    r = retrieve_now("doanh thu mien nam", kw(("doanh thu", "revenue", "measure"), ("mien nam", "mien nam", "value")),
                 build_catalog())
    assert [(v.column_id, v.value, v.exact) for v in r.values] == [("b_region", "MN", True)]
    assert r.tables[0] == "orders"             # the metric points there
    assert "branches" in r.all_tables           # the value lives there
    assert r.metrics[0] == "m_rev"


def test_value_found_even_when_the_agent_gives_another_role() -> None:
    r = retrieve_now("doanh thu miền Nam", kw(("doanh thu", "revenue", "measure"), ("miền Nam", "region", "group")),
                 build_catalog())
    assert [(v.value, v.exact) for v in r.values] == [("MN", True)]


def test_partial_value_only_for_value_phrases() -> None:
    cat = build_catalog()
    r = retrieve_now("đơn ở Nam", kw(("đơn", "order", "subject"), ("Nam", "Nam", "value")), cat)
    assert [(v.value, v.exact) for v in r.values] == [("MN", False)]
    r = retrieve_now("đơn ở Nam", kw(("đơn", "order", "subject"), ("Nam", "south", "filter")), cat)
    assert r.values == []


def test_lookup_tables_are_added_without_repeating_rows() -> None:
    r = retrieve_now("số đơn hàng", kw(("đơn hàng", "order", "subject")), build_catalog())
    assert r.tables[0] == "orders"
    # branches and customers are on the 'one' side of orders: joining them never repeats rows
    assert {"branches", "customers"} <= set(r.lookups)
    assert "items" not in r.lookups             # order_items is on the 'many' side


def test_ratio_metric_brings_its_parts() -> None:
    cat = build_catalog()
    cat.metrics["m_aov"]["synonyms"] = ["giá trị đơn trung bình"]
    r = retrieve_now("giá trị đơn trung bình theo miền",
                 kw(("giá trị đơn trung bình", "average order value", "measure"), ("miền", "region", "group")), cat)
    assert r.metrics[0] == "m_aov"
    assert {"m_rev", "m_orders"} <= set(r.metrics)


def test_every_phrase_variant_is_searched_once_and_hits_are_merged() -> None:
    fake = FakeSearch({
        "stock": {ix.TABLES: [({"entity_id": "stock"}, 0.82), ({"entity_id": "items"}, 0.3)],
                  ix.METRICS: [({"id": "m_stock"}, 0.9)]},
    })
    r = retrieve_now("hàng còn trong kho", kw(("hàng còn trong kho", "stock", "measure")), build_catalog(), fake,
                 data_source_ids=["src_sales"])
    assert fake.calls == [(["hàng còn trong kho", "stock"], ["src_sales"])]
    assert r.tables[0] == "stock"
    assert "items" not in r.tables              # below the minimum search score
    assert r.metrics[0] == "m_stock"


def test_search_failure_falls_back_to_names() -> None:
    r = retrieve_now("doanh thu theo chi nhánh", kw(("doanh thu", "revenue", "measure"), ("chi nhánh", "branch", "group")),
                 build_catalog(), BrokenSearch())
    assert {"orders", "branches"} <= set(r.all_tables)
    assert any("search unavailable" in n for n in r.notes)


def test_without_keywords_the_whole_question_is_used() -> None:
    r = retrieve_now("chi nhánh", None, build_catalog())
    assert r.tables == ["branches"]
    assert r.notes == ["no key phrases: searched the whole question"]


def test_scope_limits_tables_to_the_chosen_sources() -> None:
    r = retrieve_now("khách hàng", kw(("khách hàng", "customer", "subject")), build_catalog(), data_source_ids=["src_sales"])
    assert "customers" not in r.all_tables


def test_nothing_matched_is_reported() -> None:
    r = retrieve_now("thời tiết", kw(("thời tiết", "weather", "subject")), build_catalog())
    assert r.tables == []
    assert r.notes == ["nothing in the profile matched the question"]


def test_find_profile_survives_a_failing_keyword_agent() -> None:
    class Failing:
        async def run(self, prompt: str, on_event: Any = None) -> Keywords:
            raise AgentFailed("keywords: model down")

    cat = build_catalog()
    agents = FindAgents(keywords=Failing(), tables=None, terms=None, values=None)  # type: ignore[arg-type]
    r = asyncio.run(find_profile("chi nhánh", cat, Names(cat), agents, None))
    assert r.tables == ["branches"]
    assert r.notes[0].startswith("keyword agent failed")


def test_context_uses_real_names_and_hides_personal_data() -> None:
    cat = build_catalog()
    ctx = context_now(retrieve_now("doanh thu mien nam theo khach hang", kw(
        ("doanh thu", "revenue", "measure"), ("mien nam", "mien nam", "value"), ("khach hang", "customer", "group")), cat), cat)
    h = ctx.names
    # every name maps back to its id and back again, per kind; quotes and case don't matter
    assert h.resolve("orders", "table") == "orders" and h.resolve("`Orders`") == "orders"
    assert h.resolve("orders.net_amount", "column") == "o_amount"
    assert h.resolve("orders.config.is_online", "column") == "o_config#is_online"   # JSON field
    assert h.resolve("net_revenue", "metric") == "m_rev" and h.resolve("đơn online", "term") == "g_online"
    assert all(h.resolve(name) == real for real, name in h.name_of.items())
    assert "c_phone" not in h.name_of                         # PII never gets a name
    assert "phone" not in ctx.text                          # PII column of customers
    assert "“Miền Nam” → " in ctx.text and "region = MN (Miền Nam)" in ctx.text
    assert "always applied: status = DONE" in ctx.text
    with pytest.raises(UnknownName):
        ctx.resolve("orders", "metric")                       # right name, wrong kind
    assert "net_revenue — “net_revenue”: sum(net_amount) of orders" in ctx.text


def test_context_shows_complete_value_lists_and_links() -> None:
    cat = build_catalog()
    ctx = context_now(retrieve_now("số đơn theo miền", kw(("số đơn", "order count", "measure"), ("miền", "region", "group"))
                                 , cat), cat)
    region = next(line for line in ctx.text.splitlines() if "branches.region " in line)
    assert "all values: MB=Miền Bắc, MN=Miền Nam" in region
    assert "## Links" in ctx.text and "1:N" in ctx.text
