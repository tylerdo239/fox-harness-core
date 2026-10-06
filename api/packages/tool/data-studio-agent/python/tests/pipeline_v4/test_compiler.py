"""Golden tests: each QuerySpec must compile to exactly the SQL stored in golden/<name>.sql.

To accept new output after an intended change:  UPDATE_GOLDEN=1 uv run pytest tests/pipeline_v4
Then read the diff of the .sql files before committing.
"""

import asyncio
import os
import re
from datetime import date
from pathlib import Path

import pytest
from sqlglot import exp, parse_one

from src.pipeline_v4.compiler import Compiled, CompileError, compile_spec
from src.pipeline_v4.spec import QuerySpec
from tests.pipeline_v4.catalog_fixture import build_catalog

GOLDEN = Path(__file__).parent / "golden"


def compile_now(spec: QuerySpec, cat) -> Compiled:
    return asyncio.run(compile_spec(spec, cat))
AUG = {"start": date(2026, 8, 1), "end": date(2026, 9, 1), "label": "tháng 8/2026"}
JUL = {"start": date(2026, 7, 1), "end": date(2026, 8, 1), "label": "tháng 7/2026"}

CASES: dict[str, dict] = {
    "total_one_metric": {
        "metrics": [{"name": "net_revenue", "metric_id": "m_rev", "period": "aug"}],
        "periods": {"aug": AUG},
    },
    "by_region": {
        "dimensions": [{"column_id": "b_region"}],
        "metrics": [{"name": "net_revenue", "metric_id": "m_rev", "period": "aug"}],
        "periods": {"aug": AUG},
    },
    "top5_branches_with_label": {
        "dimensions": [{"column_id": "b_id"}],
        "metrics": [{"name": "net_revenue", "metric_id": "m_rev", "period": "aug"}],
        "periods": {"aug": AUG},
        "rank": {"by": "net_revenue", "top": 5},
    },
    "orders_by_month": {
        "dimensions": [{"column_id": "o_date", "time_grain": "month"}],
        "metrics": [{"name": "order_count", "metric_id": "m_orders", "period": "ytd"}],
        "periods": {"ytd": {"start": date(2026, 1, 1), "end": date(2026, 10, 1)}},
    },
    "growth_two_periods_top3": {
        "dimensions": [{"column_id": "b_region"}],
        "metrics": [
            {"name": "rev_aug", "metric_id": "m_rev", "period": "aug"},
            {"name": "rev_jul", "metric_id": "m_rev", "period": "jul"},
        ],
        "periods": {"aug": AUG, "jul": JUL},
        "derived": [{"name": "growth_pct", "op": "growth", "args": ["rev_aug", "rev_jul"], "scale": 100}],
        "having": [{"field": "rev_jul", "op": ">", "value": 0}],
        "rank": {"by": "growth_pct", "top": 3},
    },
    "ratio_metric_by_region": {
        "dimensions": [{"column_id": "b_region"}],
        "metrics": [{"name": "aov", "metric_id": "m_aov", "period": "aug"}],
        "periods": {"aug": AUG},
    },
    "two_fact_tables_by_branch": {
        "dimensions": [{"column_id": "b_id"}],
        "metrics": [
            {"name": "net_revenue", "metric_id": "m_rev", "period": "aug"},
            {"name": "closing_stock", "metric_id": "m_stock", "period": "aug"},
        ],
        "periods": {"aug": AUG},
    },
    "segment_on_json_field": {
        "dimensions": [{"column_id": "b_region"}],
        "metrics": [{"name": "order_count", "metric_id": "m_orders"}],
        "segments": ["g_online"],
    },
    "filter_on_another_source": {
        "metrics": [{"name": "order_count", "metric_id": "m_orders", "period": "aug"}],
        "filters": [{"column_id": "c_segment", "op": "=", "values": ["VIP"]}],
        "periods": {"aug": AUG},
    },
    "top2_branches_per_region": {
        "dimensions": [{"column_id": "b_region"}, {"column_id": "b_id"}],
        "metrics": [{"name": "net_revenue", "metric_id": "m_rev", "period": "aug"}],
        "periods": {"aug": AUG},
        "rank": {"by": "net_revenue", "top": 2, "partition_by": ["b_region"]},
    },
    "metric_without_table_defaults": {
        "metrics": [{"name": "cancelled_orders", "metric_id": "m_cancelled", "period": "aug"}],
        "periods": {"aug": AUG},
    },
    "share_of_total": {
        "dimensions": [{"column_id": "b_region"}],
        "metrics": [{"name": "net_revenue", "metric_id": "m_rev", "period": "aug"}],
        "periods": {"aug": AUG},
        "derived": [{"name": "share_pct", "op": "share_of_total", "args": ["net_revenue"], "scale": 100}],
    },
    # ── sets (sub-questions) ──
    "set_revenue_by_region_of_orders_with_sku": {
        # a filter on order_items would repeat order rows; the set keeps one key per order
        "dimensions": [{"column_id": "b_region"}],
        "metrics": [{"name": "net_revenue", "metric_id": "m_rev", "period": "aug"}],
        "periods": {"aug": AUG},
        "sets": {"with_sku": {"key_column_id": "i_order",
                              "filters": [{"column_id": "i_sku", "op": "=", "values": ["SKU-1"]}]}},
        "set_filters": [{"column_id": "o_id", "op": "in_set", "set": "with_sku"}],
    },
    "set_branches_without_orders_in_aug": {
        "metrics": [{"name": "branches", "metric_id": "m_branches"}],
        "periods": {"aug": AUG},
        "sets": {"ordered": {"key_column_id": "o_branch", "period": "aug"}},
        "set_filters": [{"column_id": "b_id", "op": "not_in_set", "set": "ordered"}],
    },
    "set_list_customers_with_more_than_5_orders": {
        "shape": "detail",
        "entity_id": "customers",
        "columns": ["c_id", "c_name", "c_segment"],
        "periods": {"aug": AUG},
        "sets": {"loyal": {"key_column_id": "o_customer", "metric_id": "m_orders", "period": "aug",
                           "having": [{"op": ">", "value": 5}]}},
        "set_filters": [{"column_id": "c_id", "op": "in_set", "set": "loyal"}],
        "limit": 50,
    },
    # ── per (two-level aggregation) ──
    "per_avg_and_median_orders_per_customer": {
        "per": {"column_id": "o_customer", "metrics": [{"name": "orders", "metric_id": "m_orders", "period": "aug"}]},
        "summaries": [{"name": "customers", "agg": "count"},
                      {"name": "avg_orders", "agg": "avg", "of": "orders"},
                      {"name": "median_orders", "agg": "median", "of": "orders"}],
        "periods": {"aug": AUG},
    },
    "per_customers_by_order_count_range": {
        "per": {"column_id": "o_customer", "metrics": [{"name": "orders", "metric_id": "m_orders", "period": "aug"}]},
        "buckets": {"of": "orders", "edges": [2, 5]},
        "summaries": [{"name": "customers", "agg": "count"}],
        "periods": {"aug": AUG},
    },
    "per_branches_including_zero_orders": {
        "per": {"column_id": "b_id", "include_zero": True,
                "metrics": [{"name": "orders", "metric_id": "m_orders", "period": "aug"}]},
        "buckets": {"of": "orders", "edges": [1, 100]},
        "summaries": [{"name": "branches", "agg": "count"}],
        "periods": {"aug": AUG},
    },
    "per_median_next_to_max_is_split": {
        "per": {"column_id": "o_customer", "metrics": [{"name": "orders", "metric_id": "m_orders", "period": "aug"}]},
        "buckets": {"of": "orders", "edges": [3]},
        "summaries": [{"name": "customers", "agg": "count"},
                      {"name": "median_orders", "agg": "median", "of": "orders"},
                      {"name": "max_orders", "agg": "max", "of": "orders"}],
        "periods": {"aug": AUG},
    },
    "per_avg_revenue_per_branch_by_region": {
        "dimensions": [{"column_id": "b_region"}],
        "per": {"column_id": "b_id", "metrics": [{"name": "revenue", "metric_id": "m_rev", "period": "aug"}]},
        "summaries": [{"name": "avg_revenue_per_branch", "agg": "avg", "of": "revenue"},
                      {"name": "best_branch_revenue", "agg": "max", "of": "revenue"}],
        "periods": {"aug": AUG},
    },
    # ── window values ──
    "window_monthly_running_total_and_change": {
        "dimensions": [{"column_id": "o_date", "time_grain": "month"}],
        "metrics": [{"name": "orders", "metric_id": "m_orders", "period": "ytd"}],
        "periods": {"ytd": {"start": date(2026, 1, 1), "end": date(2026, 10, 1)}},
        "derived": [{"name": "orders_to_date", "op": "running_sum", "args": ["orders"]},
                    {"name": "mom_pct", "op": "pct_change", "args": ["orders"], "scale": 100},
                    {"name": "avg_3_months", "op": "moving_avg", "args": ["orders"], "window": 3}],
    },
    "window_previous_month_per_region": {
        "dimensions": [{"column_id": "o_date", "time_grain": "month"}, {"column_id": "b_region"}],
        "metrics": [{"name": "revenue", "metric_id": "m_rev", "period": "ytd"}],
        "periods": {"ytd": {"start": date(2026, 1, 1), "end": date(2026, 10, 1)}},
        "derived": [{"name": "prev_month", "op": "prev", "args": ["revenue"]},
                    {"name": "change", "op": "change", "args": ["revenue"]}],
    },
    "window_regions_above_average": {
        "dimensions": [{"column_id": "b_region"}],
        "metrics": [{"name": "revenue", "metric_id": "m_rev", "period": "aug"}],
        "periods": {"aug": AUG},
        "derived": [{"name": "vs_avg", "op": "vs_avg", "args": ["revenue"]}],
        "having": [{"field": "vs_avg", "op": ">", "value": 0}],
    },
    "list_latest_orders_of_customer": {
        "shape": "detail",
        "entity_id": "orders",
        "columns": ["o_id", "o_date", "o_status", "o_amount"],
        "filters": [{"column_id": "o_customer", "op": "=", "values": ["CUS-0001"]}],
        "limit": 20,
    },
}


@pytest.mark.parametrize("name", sorted(CASES))
def test_golden(name: str) -> None:
    compiled = compile_now(QuerySpec.model_validate(CASES[name]), build_catalog())
    path = GOLDEN / f"{name}.sql"
    if os.environ.get("UPDATE_GOLDEN") or not path.exists():
        path.write_text(compiled.sql + "\n")
    assert compiled.sql + "\n" == path.read_text(), f"SQL changed for {name}; see {path}"
    # every output must stay a single read-only SELECT (JSON fields are checked by the compiler itself)
    if "TRY_CONVERT_FROM" not in compiled.sql:
        assert isinstance(parse_one(compiled.sql, read="dremio"), exp.Query)


def _errors(spec: dict) -> list:
    with pytest.raises(CompileError) as info:
        compile_now(QuerySpec.model_validate(spec), build_catalog())
    return info.value.errors


def test_label_instead_of_value_suggests_the_code() -> None:
    errs = _errors({
        "metrics": [{"name": "n", "metric_id": "m_orders"}],
        "filters": [{"column_id": "b_region", "op": "=", "values": ["Miền Nam"]}],
    })
    assert errs[0].owner == "filter"
    assert errs[0].suggestions == ["MN (label: Miền Nam)"]


def test_dimension_that_repeats_rows_is_rejected() -> None:
    errs = _errors({"dimensions": [{"column_id": "i_sku"}], "metrics": [{"name": "rev", "metric_id": "m_rev"}]})
    assert errs[0].owner == "dimension"
    assert "repeats rows" in errs[0].message


def test_personal_data_cannot_be_a_dimension() -> None:
    errs = _errors({"dimensions": [{"column_id": "c_phone"}], "metrics": [{"name": "n", "metric_id": "m_orders"}]})
    assert errs[0].owner == "dimension"
    assert "personal data" in errs[0].message


def test_unknown_period_goes_back_to_the_period_owner() -> None:
    errs = _errors({"metrics": [{"name": "n", "metric_id": "m_orders", "period": "aug"}]})
    assert [e.owner for e in errs] == ["period"]


def test_unreachable_table_names_the_missing_relationship() -> None:
    cat = build_catalog()
    cat.joins = [j for j in cat.joins if j.id != "r2"]
    with pytest.raises(CompileError) as info:
        compile_now(QuerySpec.model_validate({
            "metrics": [{"name": "n", "metric_id": "m_orders"}],
            "filters": [{"column_id": "c_segment", "op": "=", "values": ["VIP"]}],
        }), cat)
    assert "add a relationship" in info.value.errors[0].message


def test_time_grain_on_text_column_is_rejected() -> None:
    errs = _errors({"dimensions": [{"column_id": "b_name", "time_grain": "month"}],
                    "metrics": [{"name": "n", "metric_id": "m_orders"}]})
    assert errs[0].owner == "dimension"


def test_metric_filter_that_contradicts_table_default_is_rejected() -> None:
    cat = build_catalog()
    cat.metrics["m_bad"] = {**cat.metrics["m_orders"], "_id": "m_bad", "name": "bad",
                            "filters": [{"column_id": "o_status", "op": "=", "values": ["CANCELLED"]}]}
    with pytest.raises(CompileError) as info:
        compile_now(QuerySpec.model_validate({"metrics": [{"name": "n", "metric_id": "m_bad"}]}), cat)
    err = info.value.errors[0]
    assert err.owner == "metric"
    assert "can never both be true" in err.message


def test_any_grain_key_shows_the_label() -> None:
    cat = build_catalog()
    cat.tables["branches"].profile.grain_key_column_ids = ["b_id", "b_name"]
    sql = compile_now(QuerySpec.model_validate({
        "dimensions": [{"column_id": "b_id"}], "metrics": [{"name": "n", "metric_id": "m_orders"}],
    }), cat).sql
    assert 'MAX("t1"."branch_name") AS "branch_id_label"' in sql


def test_row_list_without_list_filters_uses_default_filters() -> None:
    cat = build_catalog()
    cat.tables["orders"].profile.list_filters = []
    compiled = compile_now(QuerySpec.model_validate({
        "shape": "detail", "entity_id": "orders", "columns": ["o_id"], "limit": 5,
    }), cat)
    assert "\"t0\".\"status\" = 'DONE'" in compiled.sql
    assert compiled.assumptions == ["orders: only rows where status = DONE"]


# ── sets, per, windows: errors ──

def test_set_filter_must_name_a_known_set() -> None:
    errs = _errors({"metrics": [{"name": "n", "metric_id": "m_orders"}],
                    "set_filters": [{"column_id": "o_id", "op": "in_set", "set": "missing"}]})
    assert errs[0].field == "set_filters[0]"


def test_unused_set_is_reported() -> None:
    errs = _errors({"metrics": [{"name": "n", "metric_id": "m_orders"}],
                    "sets": {"lonely": {"key_column_id": "i_order"}}})
    assert "not used" in errs[0].message


def test_set_with_having_needs_a_metric() -> None:
    with pytest.raises(ValueError):
        QuerySpec.model_validate({"sets": {"s": {"key_column_id": "o_customer", "having": [{"op": ">", "value": 1}]}}})


def test_set_on_a_column_that_repeats_rows_is_still_rejected_inside_the_set() -> None:
    # set table = branches, filter on orders (one branch → many orders): the set itself would repeat
    errs = _errors({"metrics": [{"name": "n", "metric_id": "m_orders"}],
                    "sets": {"s": {"key_column_id": "b_id", "metric_id": "m_branches",
                                   "having": [{"op": ">", "value": 0}],
                                   "filters": [{"column_id": "o_status", "op": "=", "values": ["DONE"]}]}},
                    "set_filters": [{"column_id": "o_branch", "op": "in_set", "set": "s"}]})
    assert "repeats rows" in errs[0].message


def test_time_window_needs_a_time_dimension() -> None:
    errs = _errors({"dimensions": [{"column_id": "b_region"}],
                    "metrics": [{"name": "rev", "metric_id": "m_rev"}],
                    "derived": [{"name": "r", "op": "running_sum", "args": ["rev"]}]})
    assert "grouped by day" in errs[0].message


def test_window_of_a_window_is_rejected() -> None:
    errs = _errors({"dimensions": [{"column_id": "o_date", "time_grain": "month"}],
                    "metrics": [{"name": "rev", "metric_id": "m_rev"}],
                    "derived": [{"name": "r", "op": "running_sum", "args": ["rev"]},
                                {"name": "p", "op": "pct_change", "args": ["r"]}]})
    assert "computed across rows" in errs[0].message


def test_derived_cannot_refer_to_itself() -> None:
    errs = _errors({"metrics": [{"name": "rev", "metric_id": "m_rev"}],
                    "derived": [{"name": "d", "op": "diff", "args": ["rev", "d"]}]})
    assert "unknown argument" in errs[0].message


def test_per_rejects_top_level_metrics() -> None:
    errs = _errors({"metrics": [{"name": "n", "metric_id": "m_orders"}],
                    "per": {"column_id": "o_customer", "metrics": [{"name": "o", "metric_id": "m_orders"}]},
                    "summaries": [{"name": "c", "agg": "count"}]})
    assert errs[0].field == "metrics"


def test_per_include_zero_needs_a_key_column() -> None:
    errs = _errors({"per": {"column_id": "o_customer", "include_zero": True,
                            "metrics": [{"name": "o", "metric_id": "m_orders"}]},
                    "summaries": [{"name": "c", "agg": "count"}]})
    assert errs[0].field == "per.include_zero"


def test_bucket_must_use_a_per_metric() -> None:
    errs = _errors({"per": {"column_id": "o_customer", "metrics": [{"name": "o", "metric_id": "m_orders"}]},
                    "buckets": {"of": "revenue", "edges": [1]},
                    "summaries": [{"name": "c", "agg": "count"}]})
    assert errs[0].field == "buckets.of"
    assert errs[0].suggestions == ["o"]


def test_selected_text_is_ascii_only() -> None:
    # Dremio fails to plan a query that selects a non-ASCII literal
    for name, raw in CASES.items():
        sql = compile_now(QuerySpec.model_validate(raw), build_catalog()).sql
        for literal in re.findall(r"THEN '([^']*)'", sql):
            assert literal.isascii(), (name, literal)


def test_bucket_labels_read_naturally_for_counts() -> None:
    sql = compile_now(QuerySpec.model_validate(CASES["per_customers_by_order_count_range"]), build_catalog()).sql
    assert "'0-1'" in sql and "'2-4'" in sql and "'5+'" in sql


def test_join_path_prefers_a_path_that_does_not_repeat_rows() -> None:
    # items → stock (1:N, repeats) → branches sorts first; items → orders → branches is just as short and safe
    from src.pipeline_v4.compiler import _Compiler
    from tests.pipeline_v4.catalog_fixture import build_catalog as fresh

    cat = fresh()
    cat.joins.append(type(cat.joins[0])(id="r0", from_entity_id="items", to_entity_id="stock", cardinality="1:N",
                                        join_type_default="left", pairs=[("i_order", "s_branch")],
                                        profile=cat.joins[0].profile))
    c = _Compiler(QuerySpec.model_validate({"metrics": [{"name": "branch_count", "metric_id": "m_branches"}]}), cat)
    path = c.join_path("items", "branches")
    assert [(j.id, forward) for j, forward in path] == [("r3", False), ("r1", False)]
