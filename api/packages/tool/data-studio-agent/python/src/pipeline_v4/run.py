"""Step 5: check and run the compiled SQL on Dremio (read-only), then sanity-check the result.

  1. check   EXPLAIN PLAN FOR <sql>: Dremio plans the query without reading data, so planning
             errors (unknown functions, types Dremio can't plan) surface before any scan
  2. run     the query itself with a timeout, reading at most its own LIMIT (≤ 1000 rows)
  3. sanity  warnings that go into the answer, never a silent change of the numbers:
             no rows · a total that is 0 or empty · a metric column with no values · a list cut by
             the default row limit · ids without a name in their table · a period outside the
             data a table holds (from the profile) · a total far from a value recorded on the
             metric for the same period

The SQL was already checked read-only by the compiler; it is the question's own query, the only
kind of SQL the pipeline runs (no profiling).
"""

import time
from datetime import date, timedelta
from typing import Any, Literal

from pydantic import BaseModel, Field

from src.pipeline_v4.catalog import Catalog
from src.pipeline_v4.compiler import (
    DETAIL_DEFAULT_LIMIT,
    MAX_ROWS,
    Compiled,
    OutputColumn,
)
from src.pipeline_v4.dremio import QUERY_TIMEOUT_SEC, AsyncDremio, DremioError
from src.pipeline_v4.spec import QuerySpec
from src.pipeline_v4.timing import timed

REFERENCE_TOLERANCE_PCT = 1.0  # a total within 1% of a recorded value counts as matching


class RunResult(BaseModel):
    status: Literal["ok", "empty", "failed"]
    stage: Literal["check", "run"] | None = None   # where it failed
    sql: str
    columns: list[OutputColumn] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    row_count: int = 0
    elapsed_ms: int = 0
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None


@timed("step 5: run")
async def run_query(compiled: Compiled, spec: QuerySpec, cat: Catalog, dremio: AsyncDremio,
                    timeout_sec: float = QUERY_TIMEOUT_SEC) -> RunResult:
    started = time.monotonic()
    result = RunResult(status="ok", sql=compiled.sql, columns=compiled.columns)
    try:
        await dremio.explain(compiled.sql)
    except DremioError as err:
        return result.model_copy(update={"status": "failed", "stage": "check", "error": str(err)})
    try:
        rows, total, _ = await dremio.run(compiled.sql, max_rows=MAX_ROWS, timeout_sec=timeout_sec)
    except DremioError as err:
        return result.model_copy(update={"status": "failed", "stage": "run", "error": str(err)})
    result.rows, result.row_count = rows, total
    result.elapsed_ms = int((time.monotonic() - started) * 1000)
    result.warnings = sanity(compiled, spec, rows, total, cat)
    if not rows:
        result.status = "empty"
    return result


# ── sanity checks (pure: no Dremio) ──

def _default_limit(spec: QuerySpec) -> int | None:
    """The row limit the compiler added on its own (None when the user asked for one)."""
    if spec.rank is not None or spec.limit is not None:
        return None
    if spec.shape == "detail":
        return DETAIL_DEFAULT_LIMIT
    return MAX_ROWS if spec.dimensions or spec.buckets else None


def _empty(value: Any) -> bool:
    return value is None or value == "" or value == 0


def _calendar_key(start: date, end: date) -> str | None:
    """'2026-08' for a whole month, '2026' for a whole year, else None."""
    if start.day == 1 and end == (start.replace(day=28) + timedelta(days=4)).replace(day=1):
        return start.strftime("%Y-%m")
    if (start.month, start.day) == (1, 1) and end == date(start.year + 1, 1, 1):
        return str(start.year)
    return None


def _period_tables(spec: QuerySpec, cat: Catalog) -> list[str]:
    """Tables whose rows a period limits: the metrics' tables, the tables sets are built from (when the
    set has a period), and a listed table when its rows are limited to a period."""
    ids = [m.metric_id for m in spec.metrics if m.period] + \
          ([m.metric_id for m in spec.per.metrics if m.period] if spec.per else [])
    out = []
    for mid in ids:
        m = cat.metrics.get(mid) or {}
        parts = [m] if m.get("kind") != "ratio" else [cat.metrics.get(m.get(s) or "") or {}
                                                      for s in ("numerator_metric_id", "denominator_metric_id")]
        out += [p["entity_id"] for p in parts if p.get("entity_id") in cat.tables]
    for s in spec.sets.values():
        if s.period and s.key_column_id in cat.columns:
            out.append(cat.columns[s.key_column_id].entity_id)
    if spec.shape == "detail" and spec.detail_period and spec.entity_id in cat.tables:
        out.append(spec.entity_id)
    return list(dict.fromkeys(out))


def sanity(compiled: Compiled, spec: QuerySpec, rows: list[dict[str, Any]], total: int, cat: Catalog) -> list[str]:
    warnings: list[str] = []
    values = [c for c in compiled.columns if c.kind in ("metric", "derived")]

    # nothing, or nothing but zeros
    if not rows:
        warnings.append("no rows matched: check the conditions and the period")
    elif len(rows) == 1 and not spec.dimensions and values and all(_empty(rows[0].get(c.name)) for c in values):
        warnings.append("the result is 0 or empty: no rows matched the conditions and the period")
    elif len(rows) > 1:
        for c in values:
            if all(r.get(c.name) is None for r in rows):
                warnings.append(f"{c.name} has no value in any row")

    # cut by the default limit
    limit = _default_limit(spec)
    if limit is not None and (len(rows) >= limit or total > len(rows)):
        warnings.append(f"only the first {len(rows)} rows are shown; narrow the question to see the rest")

    # ids without a name
    names = [c for c in compiled.columns if c.kind == "label"]
    for c in names:
        dim = c.name.removesuffix("_label")
        missing = sum(1 for r in rows if r.get(dim) is not None and r.get(c.name) in (None, ""))
        if missing:
            warnings.append(f"{missing} {dim} value(s) have no name in their table")

    # periods outside the data the tables hold
    for tid in _period_tables(spec, cat):
        t = cat.tables[tid]
        p = t.profile
        for key, period in spec.periods.items():
            label = period.label or key
            if p.coverage_start and period.start < date.fromisoformat(p.coverage_start):
                warnings.append(f"{t.physical_name} has data from {p.coverage_start}; {label} starts before that")
            if p.coverage_end and period.end > date.fromisoformat(p.coverage_end) + timedelta(days=1):
                warnings.append(f"{t.physical_name} has data until {p.coverage_end}; {label} ends after that")
        if p.coverage_gaps and spec.periods:
            warnings.append(f"{t.physical_name}: {p.coverage_gaps}")

    # a total far from a value recorded on the metric for the same calendar period
    if len(rows) == 1 and not spec.dimensions and not spec.per:
        for ref in spec.metrics:
            period = spec.periods.get(ref.period or "")
            m = cat.metrics.get(ref.metric_id) or {}
            if period is None or not m.get("reference_values"):
                continue
            key = _calendar_key(period.start, period.end)
            recorded = next((r for r in m["reference_values"] if str(r.get("period")) == key), None)
            got = rows[0].get(ref.name)
            if recorded is None or not isinstance(got, (int, float)):
                continue
            expected = float(recorded["value"])
            diff = abs(got - expected) / abs(expected) * 100 if expected else (0.0 if got == 0 else 100.0)
            source = f" ({recorded['source']})" if recorded.get("source") else ""
            if diff > REFERENCE_TOLERANCE_PCT:
                warnings.append(f"{ref.name} = {got:g} differs by {diff:.1f}% from the value recorded for {key}: "
                                f"{expected:g}{source}")
    return warnings
