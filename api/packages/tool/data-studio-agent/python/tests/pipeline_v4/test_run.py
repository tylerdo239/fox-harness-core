"""Step 5 without Dremio: the sanity checks, and the check → run flow with a fake client."""

import asyncio
from datetime import date
from typing import Any

from src.pipeline_v4.compiler import compile_spec
from src.pipeline_v4.dremio import DremioError
from src.pipeline_v4.run import RunResult, run_query, sanity
from src.pipeline_v4.spec import QuerySpec
from tests.pipeline_v4.catalog_fixture import build_catalog

CAT = build_catalog()
AUG = {"start": date(2026, 8, 1), "end": date(2026, 9, 1), "label": "tháng 8/2026"}


def compiled(spec: dict) -> tuple[Any, QuerySpec]:
    s = QuerySpec.model_validate(spec)
    return asyncio.run(compile_spec(s, CAT)), s


TOTAL = {"metrics": [{"name": "net_revenue", "metric_id": "m_rev", "period": "aug"}], "periods": {"aug": AUG}}
BY_BRANCH = {"dimensions": [{"column_id": "b_id"}], "metrics": [{"name": "net_revenue", "metric_id": "m_rev"}]}


def warn(spec: dict, rows: list[dict], total: int | None = None, cat: Any = CAT) -> list[str]:
    c, s = compiled(spec)
    return sanity(c, s, rows, len(rows) if total is None else total, cat)


# ── sanity checks ──

def test_a_normal_result_has_no_warning() -> None:
    assert warn(TOTAL, [{"net_revenue": 1250.5}]) == []


def test_no_rows_and_zero_totals() -> None:
    assert warn(BY_BRANCH, []) == ["no rows matched: check the conditions and the period"]
    assert warn(TOTAL, [{"net_revenue": None}]) == ["the result is 0 or empty: no rows matched the conditions and the period"]


def test_a_metric_column_without_values() -> None:
    rows = [{"branch_id": "B1", "branch_id_label": "Q1", "net_revenue": None},
            {"branch_id": "B2", "branch_id_label": "Q2", "net_revenue": None}]
    assert warn(BY_BRANCH, rows) == ["net_revenue has no value in any row"]


def test_ids_without_a_name() -> None:
    rows = [{"branch_id": "B1", "branch_id_label": None, "net_revenue": 5},
            {"branch_id": None, "branch_id_label": None, "net_revenue": 2}]   # a NULL id is not "missing a name"
    assert warn(BY_BRANCH, rows) == ["1 branch_id value(s) have no name in their table"]


def test_a_list_cut_by_the_default_limit_but_not_by_a_requested_top() -> None:
    rows = [{"branch_id": f"B{i}", "branch_id_label": "x", "net_revenue": i} for i in range(1000)]
    assert warn(BY_BRANCH, rows) == ["only the first 1000 rows are shown; narrow the question to see the rest"]
    top5 = {**BY_BRANCH, "rank": {"by": "net_revenue", "top": 5}}
    assert warn(top5, rows[:5]) == []


def test_a_period_outside_the_data_a_table_holds() -> None:
    cat = build_catalog()
    p = cat.tables["orders"].profile
    p.coverage_start, p.coverage_end, p.coverage_gaps = "2026-08-10", "2026-08-25", "no data on 15/08 (holiday)"
    assert warn(TOTAL, [{"net_revenue": 7}], cat=cat) == [
        "orders has data from 2026-08-10; tháng 8/2026 starts before that",
        "orders has data until 2026-08-25; tháng 8/2026 ends after that",
        "orders: no data on 15/08 (holiday)",
    ]


def test_a_total_far_from_a_recorded_value() -> None:
    cat = build_catalog()
    cat.metrics["m_rev"]["reference_values"] = [{"period": "2026-08", "value": 1000, "source": "finance report"}]
    assert warn(TOTAL, [{"net_revenue": 1005}], cat=cat) == []                     # within 1%
    assert warn(TOTAL, [{"net_revenue": 1300}], cat=cat) == [
        "net_revenue = 1300 differs by 30.0% from the value recorded for 2026-08: 1000 (finance report)"]


# ── check → run ──

class FakeDremio:
    def __init__(self, explain_error: str | None = None, run_error: str | None = None,
                 rows: list[dict] | None = None) -> None:
        self.explain_error, self.run_error, self.rows, self.calls = explain_error, run_error, rows or [], []

    async def explain(self, sql: str) -> None:
        self.calls.append("explain")
        if self.explain_error:
            raise DremioError(self.explain_error)

    async def run(self, sql: str, max_rows: int, timeout_sec: float = 60) -> tuple[list[dict], int, list]:
        self.calls.append(f"run≤{max_rows}")
        if self.run_error:
            raise DremioError(self.run_error)
        return self.rows, len(self.rows), []


def go(dremio: FakeDremio, spec: dict = TOTAL) -> RunResult:
    c, s = compiled(spec)
    return asyncio.run(run_query(c, s, CAT, dremio))  # type: ignore[arg-type]


def test_planning_errors_stop_before_running() -> None:
    d = FakeDremio(explain_error="Error during planning the query.")
    r = go(d)
    assert (r.status, r.stage, r.error) == ("failed", "check", "Error during planning the query.")
    assert d.calls == ["explain"]


def test_run_errors_and_results() -> None:
    r = go(FakeDremio(run_error="the query took longer than 60s and was stopped"))
    assert (r.status, r.stage) == ("failed", "run")
    d = FakeDremio(rows=[{"net_revenue": 1250.5}])
    r = go(d)
    assert (r.status, r.rows, r.row_count, r.warnings) == ("ok", [{"net_revenue": 1250.5}], 1, [])
    assert d.calls == ["explain", "run≤1000"] and [c.name for c in r.columns] == ["net_revenue"]
    r = go(FakeDremio(rows=[]), BY_BRANCH)
    assert r.status == "empty" and r.warnings == ["no rows matched: check the conditions and the period"]


def test_coverage_is_checked_on_the_table_the_period_filters() -> None:
    cat = build_catalog()
    cat.tables["orders"].profile.coverage_start = "2026-08-15"
    cat.tables["branches"].profile.coverage_start = "2026-08-20"
    spec = {"shape": "detail", "entity_id": "branches", "columns": ["b_id"], "periods": {"aug": AUG},
            "sets": {"ordered": {"key_column_id": "o_branch", "period": "aug"}},
            "set_filters": [{"column_id": "b_id", "op": "not_in_set", "set": "ordered"}]}
    # the period limits the orders the set is built from, not the listed branches
    assert warn(spec, [{"branch_id": "B9"}], cat=cat) == ["orders has data from 2026-08-15; tháng 8/2026 starts before that"]
