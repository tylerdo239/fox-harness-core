"""Wide tables (more than WIDE_TABLE columns): the agents' context shows only the columns that matter
and names the others; describe_table pages them and filters them by words."""

import asyncio

from src.pipeline_v4.context import WIDE_TABLE, Names, render_table
from src.pipeline_v4.tools.profile import DESCRIBE_PAGE, ProfileTools
from tests.pipeline_v4.catalog_fixture import _col, build_catalog


def _wide() -> tuple[Names, str]:
    cat = build_catalog()
    tid = cat.columns["b_id"].entity_id
    for i in range(WIDE_TABLE + 20):
        cat.columns[f"w{i}"] = _col(f"w{i}", tid, f"extra_{i:02d}", "VARCHAR")
    cat.columns["w_note"] = _col("w_note", tid, "manager_note", "VARCHAR")
    cat.columns["w_note"].description = "ghi chú của quản lý chi nhánh"
    return Names(cat), tid


def test_the_context_keeps_essential_and_matched_columns_and_names_the_rest() -> None:
    h, tid = _wide()
    text = "\n".join(render_table(tid, h, extra_columns={"w5"}))
    assert h.of("b_id") in text                                  # the key is always there
    assert f"{h.of('w5')} VARCHAR" in text                        # a column the question matched, in full
    assert f"{h.of('w7')} VARCHAR" not in text                    # an unrelated one only by name
    assert "more columns" in text and "extra_07" in text


def test_describe_table_pages_and_filters_wide_tables() -> None:
    h, tid = _wide()
    describe = ProfileTools(h.cat, h, None).describe_table
    first = asyncio.run(describe(h.of(tid)))
    assert f"page 1 of 2: columns 1–{DESCRIBE_PAGE}" in first and "page=2" in first
    second = asyncio.run(describe(h.of(tid), page=2))
    assert "page 2 of 2" in second and f"{h.of('w_note')} VARCHAR" in second
    found = asyncio.run(describe(h.of(tid), contains="quản lý"))
    assert f"{h.of('w_note')} VARCHAR" in found and "1 of " in found and h.of("w7") + " VARCHAR" not in found
    none = asyncio.run(describe(h.of(tid), contains="zzz"))
    assert none.startswith(f"no column of {h.of(tid)} is about 'zzz'") and "Next:" in none
