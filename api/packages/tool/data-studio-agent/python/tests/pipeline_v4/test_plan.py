"""Step 4 with scripted specialists (no LLM): code templates per question type, which specialists run,
error routing and fix rounds."""

import asyncio
from datetime import date
from pathlib import Path
from typing import Any

from src.pipeline_v4.agents.base import AgentRun
from src.pipeline_v4.agents.keywords import KeyPhrase, Keywords
from src.pipeline_v4.agents.parts import (
    ConditionOut,
    FilterPick,
    GrainOut,
    GroupOut,
    GroupPick,
    IntentOut,
    KindOut,
    MeasureOut,
    PeriodPick,
    PerOut,
    RankOut,
    RelatedOut,
    RelatedPick,
    RowsOut,
    SetCondition,
    SetOut,
    TimeOut,
)
from src.pipeline_v4.catalog import add_row_counts
from src.pipeline_v4.compiler import SpecError, compile_spec
from src.pipeline_v4.context import AgentContext, Names
from src.pipeline_v4.plan import (
    PlanAgents,
    _per_problem,
    assemble,
    build_parts,
    needed,
    owner_agent,
    plan_query,
)
from src.pipeline_v4.retrieve import Retrieved
from tests.pipeline_v4.catalog_fixture import build_catalog

CAT = build_catalog()
add_row_counts(CAT)
H = Names(CAT)
GOLDEN = Path(__file__).parent / "golden"
AUG = PeriodPick(key="p1", start="2026-08-01", end="2026-09-01", label="tháng 8/2026")
JUL = PeriodPick(key="p2", start="2026-07-01", end="2026-08-01", label="tháng 7/2026")
R = Retrieved(question="q", tables=["orders", "branches"], lookups=["customers"])


def sql(intent: IntentOut, **answers: Any) -> str:
    m, d, f, errors = build_parts(intent, answers, R, CAT, H)
    assert errors == []
    spec, errors = asyncio.run(assemble(m, d, f, H, CAT))
    assert errors == [], errors
    return asyncio.run(compile_spec(spec, CAT)).sql


def golden(name: str) -> str:
    return (GOLDEN / f"{name}.sql").read_text().strip()


# ── code templates: same SQL as the hand-written specs ──

def test_total() -> None:
    assert sql(IntentOut(kind="total"), measure=MeasureOut(metrics=["net_revenue"]),
               time=TimeOut(periods=[AUG])) == golden("total_one_metric")


def test_top_n_groups_by_the_identifying_column_so_the_name_shows() -> None:
    # the grouping agent picked orders.branch_id; code moves it to branches.branch_id (which has a name)
    assert sql(IntentOut(kind="top_n", top_n=5), measure=MeasureOut(metrics=["net_revenue"]),
               time=TimeOut(periods=[AUG]), grouping=GroupOut(columns=["orders.branch_id"])) == golden("top5_branches_with_label")


def test_trend_groups_by_the_measured_table_time_column() -> None:
    ytd = PeriodPick(key="p1", start="2026-01-01", end="2026-10-01")
    assert sql(IntentOut(kind="trend", time_grain="month"), measure=MeasureOut(metrics=["order_count"]),
               time=TimeOut(periods=[ytd])) == golden("orders_by_month")


def test_compare_periods_makes_current_previous_and_growth() -> None:
    q = sql(IntentOut(kind="compare_periods"), measure=MeasureOut(metrics=["net_revenue"]),
            time=TimeOut(periods=[AUG, JUL]), grouping=GroupOut(columns=["branches.region"]))
    assert '"net_revenue_cur"' in q and '"net_revenue_prev"' in q and 'AS "net_revenue_growth_pct"' in q
    assert "TIMESTAMP '2026-07-31 17:00:00'" in q and "TIMESTAMP '2026-06-30 17:00:00'" in q


def test_rows_without_lists_rows_not_in_the_related_set() -> None:
    q = sql(IntentOut(kind="rows_without", listed_table="branches", related_table="orders"), time=TimeOut(periods=[AUG]))
    assert q.startswith('WITH "set_related" AS (SELECT DISTINCT "t0"."branch_id" AS "key" FROM "sales"."orders"')
    assert 'NOT IN (SELECT "key" FROM "set_related")' in q and "TIMESTAMP '2026-07-31 17:00:00'" in q
    assert '"t0"."branch_name" AS "branch_name"' in q                      # the listed rows show their name


def test_rows_with_a_count_condition_and_counting_them() -> None:
    q = sql(IntentOut(kind="rows_with", listed_table="customers", related_table="orders", count_rows=True),
            set=SetOut(conditions=[SetCondition(metric="order_count", op=">", value=5)]),
            condition=ConditionOut(filters=[FilterPick(column="orders.status", op="=", values=["DONE"])]))
    assert 'HAVING COUNT(*) > 5' in q and '"t0"."status" = \'DONE\'' in q.split("SELECT COUNT(*) AS")[0]  # filter inside the set
    assert 'COUNT(*) AS "count_customers"' in q and 'IN (SELECT "key" FROM "set_related")' in q


def test_list_rows_uses_default_columns_and_the_period() -> None:
    q = sql(IntentOut(kind="list_rows", listed_table="orders"), time=TimeOut(periods=[AUG]),
            condition=ConditionOut(filters=[FilterPick(column="orders.customer_id", op="=", values=["CUS-0001"])]))
    assert q.startswith('SELECT "t0"."order_id" AS "order_id", "t0"."order_date" AS "order_date"')
    assert "\"t0\".\"customer_id\" = 'CUS-0001'" in q and "ORDER BY \"t0\".\"order_date\" DESC" in q


def test_per_summary() -> None:
    q = sql(IntentOut(kind="per_summary"), measure=MeasureOut(metrics=["order_count"]),
            per=PerOut(column="orders.customer_id", summaries=["avg", "count"]))
    assert 'AVG("per"."order_count") AS "avg_order_count"' in q and 'COUNT(*) AS "count"' in q


def test_missing_pieces_go_back_to_their_owner() -> None:
    _, _, _, errors = build_parts(IntentOut(kind="compare_periods"), {"measure": MeasureOut(metrics=["net_revenue"]),
                                                                       "time": TimeOut(periods=[AUG])}, R, CAT, H)
    assert [owner_agent(e) for e in errors] == ["time"] and "exactly two time ranges" in errors[0].message
    _, _, _, errors = build_parts(IntentOut(kind="top_n"), {"measure": MeasureOut(metrics=["net_revenue"])}, R, CAT, H)
    assert sorted(owner_agent(e) for e in errors) == ["grouping", "router"]


# ── which specialists run ──

def kw(*roles: str, times: tuple[str, ...] = ()) -> Keywords:
    return Keywords(phrases=[KeyPhrase(text=r, english=r, role=r) for r in roles], time_phrases=list(times))  # type: ignore[arg-type]


def test_only_the_needed_specialists_run() -> None:
    bare = Retrieved(question="q", tables=["orders"])
    assert needed(IntentOut(kind="total"), kw("measure"), bare) == ["measure", "time", "condition"]
    assert needed(IntentOut(kind="top_n", top_n=5), kw("measure", "group", times=("tháng 8",)), bare) == ["measure", "time", "grouping", "condition"]
    assert needed(IntentOut(kind="rows_without"), kw("subject", "value"), bare) == ["time", "condition", "set"]
    assert needed(IntentOut(kind="per_summary"), kw("measure"), bare) == ["measure", "time", "condition", "per"]


def test_time_and_condition_agents_run_even_when_the_keywords_missed_them() -> None:
    bare = Retrieved(question="q", tables=["orders"])
    assert {"time", "condition"} <= set(needed(IntentOut(kind="grouped"), kw("subject", "group"), bare))
    assert {"time", "condition"} <= set(needed(IntentOut(kind="total"), None, bare))


# ── flow ──

class Scripted:
    def __init__(self, *answers: Any) -> None:
        self.answers, self.prompts, self.initials = list(answers), [], []

    async def run(self, prompt: str, on_event: Any = None, initial: Any = None, question: Any = None) -> Any:
        self.prompts.append(prompt)
        self.initials.append(initial)
        result = self.answers[min(len(self.prompts), len(self.answers)) - 1]
        return result if isinstance(result, AgentRun) else AgentRun(result=result, text="done")


class Router:
    """Plays the kind router and its readers from a list of planned readings (one per routing)."""

    def __init__(self, *intents: IntentOut) -> None:
        self.intents, self.prompts = list(intents), []

    def _now(self) -> IntentOut:
        return self.intents[min(len(self.prompts), len(self.intents)) - 1]

    async def run(self, prompt: str, on_event: Any = None) -> KindOut:
        self.prompts.append(prompt)
        return KindOut(kind=self._now().kind)

    def reader(self, make: Any) -> Any:
        router = self

        class Reader:
            async def run(self, prompt: str, on_event: Any = None) -> Any:
                return make(router._now())

        return Reader()


def plan(router: Router, keywords: Keywords | None = None, r: Retrieved = R, **specialists: Scripted) -> tuple[Any, PlanAgents]:
    unused = Scripted(None)
    agents = PlanAgents(
        router=router,  # type: ignore[arg-type]
        rank=router.reader(lambda i: RankOut.model_construct(top_n=i.top_n, direction=i.direction)),
        grain=router.reader(lambda i: GrainOut(time_grain=i.time_grain or "month")),
        rows=router.reader(lambda i: RowsOut(listed_table=i.listed_table or "", related_table=i.related_table or "",
                                             count_rows=i.count_rows)),
        **{n: specialists.get(n, unused) for n in ("measure", "grouping", "set", "per", "related")},  # type: ignore[arg-type]
        time=specialists.get("time", Scripted(TimeOut())),                 # these two run every time:
        condition=specialists.get("condition", Scripted(ConditionOut())))  # no period / condition by default
    ctx = AgentContext(text="(profile)", names=H)
    keywords = keywords or kw("measure", "group", times=("tháng 8",))
    result = asyncio.run(plan_query("doanh thu theo miền tháng 8", keywords, ctx, r, CAT, agents, date(2026, 10, 1)))
    return result, agents


def test_specialists_answers_compile_to_the_hand_written_sql() -> None:
    measure, time, grouping = Scripted(MeasureOut(metrics=["net_revenue"])), Scripted(TimeOut(periods=[AUG])), \
        Scripted(GroupOut(columns=["branches.region"]))
    r, _ = plan(Router(IntentOut(kind="grouped")), measure=measure, time=time, grouping=grouping)
    assert r.status == "ok" and r.rounds == 0
    assert r.compiled.sql == golden("by_region")
    assert "Today: 2026-10-01 (Thursday)" in time.prompts[0] and "# Question type: numbers split by a category" in time.prompts[0]


def test_clarify_from_the_measure_picker_stops() -> None:
    measure = Scripted(MeasureOut(status="clarify", message="Doanh thu gộp hay thuần?", options=["gộp", "thuần"]))
    r, _ = plan(Router(IntentOut(kind="total")), measure=measure, time=Scripted(TimeOut(periods=[AUG])))
    assert (r.status, r.message, r.options) == ("clarify", "Doanh thu gộp hay thuần?", ["gộp", "thuần"])


def test_an_error_goes_back_only_to_its_specialist_starting_from_its_answer() -> None:
    bad = GroupOut(columns=["customers.phone"])           # personal data: never named, so never resolves
    measure, time = Scripted(MeasureOut(metrics=["net_revenue"])), Scripted(TimeOut(periods=[AUG]))
    grouping = Scripted(bad, GroupOut(columns=["branches.region"]))
    r, _ = plan(Router(IntentOut(kind="grouped")), measure=measure, time=time, grouping=grouping)
    assert r.status == "ok" and r.rounds == 1
    assert (len(measure.prompts), len(time.prompts), len(grouping.prompts)) == (1, 1, 2)
    assert "'customers.phone' is not a known column" in grouping.prompts[1]
    assert grouping.initials[1] == bad


def test_a_router_mistake_reroutes() -> None:
    router = Router(IntentOut(kind="top_n"), IntentOut(kind="top_n", top_n=3))  # first reading forgot N
    r, _ = plan(router, measure=Scripted(MeasureOut(metrics=["net_revenue"])), time=Scripted(TimeOut(periods=[AUG])),
                grouping=Scripted(GroupOut(columns=["branches.region"])))
    assert r.status == "ok" and len(router.prompts) == 2 and "top_n needs N" in router.prompts[1]
    assert "LIMIT 3" in r.compiled.sql


def test_gives_up_after_the_fix_rounds() -> None:
    r, _ = plan(Router(IntentOut(kind="compare_periods")), keywords=kw("measure", times=("tháng 8",)),
                measure=Scripted(MeasureOut(metrics=["net_revenue"])),
                time=Scripted(TimeOut(periods=[AUG])))  # never gives the second range
    assert r.status == "failed" and r.rounds == 2 and "exactly two time ranges" in r.errors[0].message


def test_error_routing() -> None:
    def route(owner: str, fld: str) -> str:
        return owner_agent(SpecError(owner=owner, field=fld, message=""))  # type: ignore[arg-type]

    assert route("metric", "metrics[0]") == "measure"
    assert route("period", "net_revenue") == "time"
    assert route("dimension", "dimensions[0]") == "grouping"
    assert route("filter", "filters[1]") == "condition"
    assert route("filter", "sets.related.having") == "set"
    assert route("dimension", "per.column_id") == "per"
    assert route("rank", "rank") == "router"


def test_a_comparison_without_a_time_phrase_is_read_again() -> None:
    router = Router(IntentOut(kind="compare_periods"), IntentOut(kind="total"))
    measure = Scripted(MeasureOut(metrics=["order_count"]))
    r, _ = plan(router, keywords=kw("measure"), measure=measure)
    assert r.status == "ok" and len(router.prompts) == 2
    assert "names no time range, so it is not a comparison" in router.prompts[1]
    assert r.compiled.sql == 'SELECT COUNT(*) AS "order_count" FROM "sales"."orders" AS "t0" WHERE ("t0"."status" = \'DONE\')'


def test_top_n_within_each_group_partitions_the_rank() -> None:
    # "top 2 chi nhánh theo từng miền": the rank reader reads within = "miền"; the grouping named "theo từng miền"
    # is the partition, the other grouping is what is ranked
    grouping = GroupOut(columns=[GroupPick(column="orders.branch_id", phrase="chi nhánh"),
                                 GroupPick(column="branches.region", phrase="theo từng miền")])
    assert sql(IntentOut(kind="top_n", top_n=2, within="miền"), measure=MeasureOut(metrics=["net_revenue"]),
               time=TimeOut(periods=[AUG]), grouping=grouping) == golden("top2_branches_per_region")


def test_top_n_within_needs_a_grouping_for_the_group_and_one_for_the_ranked_thing() -> None:
    def errors(*picks: GroupPick) -> list[str]:
        _, _, _, errs = build_parts(IntentOut(kind="top_n", top_n=2, within="miền"),
                                    {"measure": MeasureOut(metrics=["net_revenue"]), "grouping": GroupOut(columns=list(picks))},
                                    R, CAT, H)
        return [f"{owner_agent(e)}: {e.message}" for e in errs]

    assert "grouping: the top N is taken inside each 'miền': add_grouping for it" in errors(
        GroupPick(column="orders.branch_id", phrase="chi nhánh"))[0]
    assert "also add_grouping the thing that is ranked" in errors(GroupPick(column="branches.region", phrase="mỗi miền"))[0]


def test_grouping_a_count_by_the_counted_rows_own_key_goes_back_to_grouping() -> None:
    _, _, _, errors = build_parts(IntentOut(kind="top_n", top_n=5), {"measure": MeasureOut(metrics=["order_count"]),
                                  "grouping": GroupOut(columns=["orders.order_id"])}, R, CAT, H)
    assert [owner_agent(e) for e in errors] == ["grouping"] and "every order_count is 1" in errors[0].message



# ── has related rows ──

def ran(answer: Any, *calls: tuple[str, dict[str, Any]]) -> AgentRun:
    """An agent run with its tool calls (all successful)."""
    return AgentRun(result=answer, text="", tool_calls=[{"tool": t, "args": a, "result": "ok: …"} for t, a in calls])


WITH_ITEMS = Retrieved(question="q", tables=["orders", "items"], lookups=["branches"])
ORDERS_WITH_ITEMS = Keywords(phrases=[KeyPhrase(text="order with items", english="order with item", role="measure")],
                             time_phrases=[])


def test_has_related_rows_becomes_an_in_set_filter() -> None:
    out = sql(IntentOut(kind="grouped"), measure=MeasureOut(metrics=["net_revenue"]), time=TimeOut(periods=[AUG]),
              grouping=GroupOut(columns=["branches.region"]),
              related=RelatedOut(related=[RelatedPick(table="order_items")]))
    assert 'WITH "set_has_order_items" AS (SELECT DISTINCT "t0"."order_id" AS "key" FROM "sales"."order_items"' in out
    assert '("t0"."order_id" IN (SELECT "key" FROM "set_has_order_items"))' in out
    out = sql(IntentOut(kind="total"), measure=MeasureOut(metrics=["order_count"]),
              related=RelatedOut(related=[RelatedPick(table="order_items", has=False)]))
    assert 'NOT IN (SELECT "key" FROM "set_has_order_items")' in out


def test_has_related_needs_a_direct_relationship() -> None:
    _, _, _, errors = build_parts(IntentOut(kind="total"), {"measure": MeasureOut(metrics=["order_count"]),
                                  "related": RelatedOut(related=[RelatedPick(table="stock_daily")])}, R, CAT, H)
    assert [owner_agent(e) for e in errors] == ["related"] and "no direct relationship" in errors[0].message


def test_the_related_agent_runs_when_a_phrase_names_another_found_table() -> None:
    assert "related" in needed(IntentOut(kind="total"), ORDERS_WITH_ITEMS, WITH_ITEMS, CAT, H)
    only_orders = Keywords(phrases=[KeyPhrase(text="order", english="order", role="measure"),
                                    KeyPhrase(text="branch", english="branch", role="group")], time_phrases=[])
    assert "related" not in needed(IntentOut(kind="total"), only_orders, WITH_ITEMS, CAT, H)  # a grouping is not a condition


def test_the_related_agent_answer_filters_the_rows() -> None:
    related = Scripted(RelatedOut(related=[RelatedPick(table="order_items")]))
    r, _ = plan(Router(IntentOut(kind="total")), keywords=ORDERS_WITH_ITEMS, r=WITH_ITEMS,
                measure=Scripted(MeasureOut(metrics=["order_count"])), related=related)
    assert r.status == "ok" and r.rounds == 0 and len(related.prompts) == 1
    assert '"t0"."order_id" IN (SELECT "key" FROM "set_has_order_items")' in r.compiled.sql


def test_has_related_on_a_table_already_in_the_query_is_left_out() -> None:
    # "top 5 chi nhánh có nhiều đơn hàng nhất": orders is what is counted, branches what it is split by
    answers = {"measure": MeasureOut(metrics=["order_count"]), "grouping": GroupOut(columns=["branches.branch_id"]),
               "related": RelatedOut(related=[RelatedPick(table="orders"), RelatedPick(table="branches")])}
    m, d, f, errors = build_parts(IntentOut(kind="top_n", top_n=5), answers, R, CAT, H)
    assert errors == [] and f.sets == [] and f.set_filters == []


# ── per column vs grouping ──

def test_per_column_that_is_the_grouping_goes_to_both_agents_with_other_choices() -> None:
    branch_id, o_branch = H.of("b_id"), H.of("o_branch")
    problem, grouping_too = _per_problem(o_branch, [branch_id], H, CAT)   # o_branch identifies a branch too
    assert "both the grouping and the per column" in problem and grouping_too   # code can't tell which is wrong
    assert H.of("b_region") in problem                                          # a category of branches instead
    assert f"finer inside each group ({o_branch}" not in problem                # never the same thing again


def test_per_and_grouping_swapped_is_sent_to_both() -> None:
    problem, grouping_too = _per_problem(H.of("b_region"), [H.of("b_id")], H, CAT)
    assert "one group per row" in problem and grouping_too


def test_per_inside_a_category_is_fine() -> None:
    assert _per_problem(H.of("o_branch"), [H.of("b_region")], H, CAT) is None


def test_rejected_answers_are_told_how_to_fix_them_with_their_tools() -> None:
    from src.pipeline_v4.plan import specialist_prompt

    err = SpecError(owner="dimension", field="dimensions", message="wrong grouping")
    first = specialist_prompt("base", IntentOut(kind="grouped"), [err], True, "grouping")
    assert "Next: add_grouping(phrase, column)" in first and "remove(part='columns'" in first
    assert "reported last round" not in first
    again = specialist_prompt("base", IntentOut(kind="grouped"), [err], True, "grouping", frozenset({"wrong grouping"}))
    assert "reported last round too" in again


# ── splits by time and by several things ──

def _kw(*groups: tuple[str, str]) -> Keywords:
    return Keywords(phrases=[KeyPhrase(text=t, english=e, role="group") for t, e in groups], time_phrases=[])


def test_a_split_by_time_makes_the_question_a_trend() -> None:
    from src.pipeline_v4.plan import check_intent

    kw = _kw(("theo tháng", "month"), ("từng chi nhánh", "branch"))
    errors = check_intent(IntentOut(kind="grouped"), kw)
    assert "kind is trend" in errors[0].message and "'từng chi nhánh'" in errors[0].message
    assert check_intent(IntentOut(kind="trend", time_grain="month"), kw) == []
    assert check_intent(IntentOut(kind="grouped"), _kw(("từng chi nhánh", "branch"))) == []


def test_one_grouping_phrase_for_two_splits_is_sent_back() -> None:
    from src.pipeline_v4.plan import _merged_splits

    splits = ["theo miền", "từng chi nhánh"]
    one = [GroupPick(column="branches.region", phrase="theo miền của từng chi nhánh")]
    assert "add_grouping once per split" in (_merged_splits(one, splits) or "")
    two = [*one, GroupPick(column="branches.branch_id", phrase="từng chi nhánh")]
    assert _merged_splits(two, splits) is None
    assert _merged_splits([GroupPick(column="branches.region", phrase="theo miền")], splits) is None
