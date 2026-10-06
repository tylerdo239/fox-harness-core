"""Datasets for charts: the query result ("original") and what code derives from it.

The chart agent never writes code: it picks a transform and its arguments (agents/parts.py DataStep),
this module checks and applies it. The steps are kept with the charts and replayed here when the
answer is shown, so every number on a chart comes from the result through code that is tested.

  top_n_other    keep the N largest rows of a measure, add the rest up into one "other" row
  pivot          one row per x, one column per value of `series` (long → wide, for stacked charts)
  bins           a histogram: how many rows fall in each range of a measure
  running_total  the measure added up along x (in x order)
  regroup        re-aggregate the rows by one column (sum, avg, min, max, count)
  sort_rows      order by a column, optionally keep the first N

Adding values up (top_n_other, pivot, regroup sum) is allowed only for additive measures (counts,
sums): an average or a ratio added up is a wrong number.
"""

import math
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from src.pipeline_v4.agents.parts import DataStep
from src.pipeline_v4.compiler import OutputColumn
from src.pipeline_v4.tools.guide import Problem, options

MAX_SERIES = 8     # pivot columns
MAX_BINS = 20
ORIGINAL = "original"


@dataclass
class Dataset:
    rows: list[dict[str, Any]]
    columns: list[OutputColumn]
    labels: dict[str, str] = field(default_factory=dict)   # what to show for each column
    additive: set[str] = field(default_factory=set)         # measures whose values can be added up
    note: str = ""                                          # how it was made (shown to the agent)

    def column(self, name: str) -> OutputColumn | None:
        return next((c for c in self.columns if c.name == name), None)

    @property
    def measures(self) -> list[str]:
        return [c.name for c in self.columns if c.kind in ("metric", "derived")]

    @property
    def splits(self) -> list[str]:
        names = {c.name for c in self.columns}
        return [c.name for c in self.columns if c.kind not in ("metric", "derived") and f"{c.name}_label" not in names]


class StepError(Exception):
    def __init__(self, problem: Problem) -> None:
        super().__init__(str(problem))
        self.problem = problem


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def _tidy(v: float) -> float | int:
    return int(v) if float(v).is_integer() else round(v, 2)


def _need(ds: Dataset, name: str | None, what: str, measures_only: bool = False) -> str:
    choices = ds.measures if measures_only else ds.splits
    if not name:
        raise StepError(Problem(f"give {what}", f"send {what} as one of: {options(choices)}"))
    col = ds.column(name)
    if col is None or (measures_only and name not in ds.measures):
        raise StepError(Problem(f"{name!r} is not a {'measure' if measures_only else 'column'} of this dataset",
                                f"send {what} as one of: {options(choices)}"))
    return name


def _additive(ds: Dataset, measure: str) -> None:
    if measure not in ds.additive:
        ok = [m for m in ds.measures if m in ds.additive]
        raise StepError(Problem(f"{measure} can't be added up (an average or a ratio summed is a wrong number)",
                                f"use an additive measure: {options(ok)}" if ok else
                                "use sort_rows to keep the first N rows instead"))


def _label(ds: Dataset, name: str) -> str:
    return ds.labels.get(name, name)


def apply(step: DataStep, sources: dict[str, Dataset]) -> Dataset:
    """The dataset `step` makes; StepError (with what to do instead) when it can't."""
    src = sources.get(step.source)
    if src is None:
        raise StepError(Problem(f"no dataset {step.source!r}", f"send source as one of: {options(sources)}"))
    rows = src.rows
    if step.op == "sort_rows":
        by = step.by or ""
        if src.column(by) is None:
            raise StepError(Problem(f"{by!r} is not a column of this dataset",
                                    f"send by as one of: {options(c.name for c in src.columns)}"))
        key = (lambda r: (_num(r.get(by)) is None, _num(r.get(by)) or 0)) if by in src.measures \
            else (lambda r: str(r.get(by) or ""))
        out = sorted(rows, key=key, reverse=step.direction != "asc")
        if by in src.measures and step.direction != "asc":     # nulls last either way
            out = [r for r in out if _num(r.get(by)) is not None] + [r for r in out if _num(r.get(by)) is None]
        if step.n:
            out = out[:step.n]
        return Dataset(out, src.columns, src.labels, src.additive, f"{len(out)} rows ordered by {by}")

    if step.op == "top_n_other":
        m = _need(src, step.measure, "measure", measures_only=True)
        _additive(src, m)
        n = step.n or 0
        if n < 2:
            raise StepError(Problem("n must be at least 2", "send n = how many of the largest rows to keep"))
        ranked = sorted(rows, key=lambda r: _num(r.get(m)) or 0, reverse=True)
        if len(ranked) <= n + 1:
            raise StepError(Problem(f"the dataset has only {len(ranked)} rows: nothing to group into 'other'",
                                    "chart the dataset itself"))
        rest = ranked[n:]
        other: dict[str, Any] = {c.name: None for c in src.columns}
        for c in src.columns:
            if c.kind not in ("metric", "derived"):
                other[c.name] = step.label or "Other"
        for name in src.measures:
            if name in src.additive:
                other[name] = _tidy(sum(_num(r.get(name)) or 0 for r in rest))
        return Dataset([*ranked[:n], other], src.columns, src.labels, src.additive,
                       f"the {n} largest rows by {m}, the other {len(rest)} added up into one row")

    if step.op == "pivot":
        x = _need(src, step.x, "x")
        series = _need(src, step.series, "series")
        m = _need(src, step.measure, "measure", measures_only=True)
        if x == series:
            raise StepError(Problem("x and series must be different columns",
                                    f"send series as one of: {options(s for s in src.splits if s != x)}"))
        values = list(dict.fromkeys(str(r.get(series)) for r in rows))
        if len(values) > MAX_SERIES:
            raise StepError(Problem(f"{series} has {len(values)} values: too many series (at most {MAX_SERIES})",
                                    f"first top_n_other or regroup to fewer {series} values, or pivot the other way "
                                    f"(series={x!r}, x={series!r})"))
        cells = Counter((str(r.get(x)), str(r.get(series))) for r in rows)
        if any(n > 1 for n in cells.values()):
            _additive(src, m)    # several rows for one cell are added up
        xcol = src.column(x)
        assert xcol is not None
        wide: dict[str, dict[str, Any]] = {}
        for r in rows:
            row = wide.setdefault(str(r.get(x)), {x: r.get(x), **{v: None for v in values}})
            v, cur = _num(r.get(m)), row[str(r.get(series))]
            row[str(r.get(series))] = (None if v is None else _tidy(v)) if cur is None else \
                (None if v is None else _tidy(cur + v))
        unit = (src.column(m) or xcol).unit
        cols = [xcol, *(OutputColumn(name=v, kind="metric", unit=unit) for v in values)]
        labels = {x: _label(src, x), **{v: v for v in values}}
        add = set(values) if m in src.additive else set()
        out = sorted(wide.values(), key=lambda r: str(r.get(x))) if xcol.time_grain else list(wide.values())
        return Dataset(out, cols, labels, add, f"one row per {x}, one column per {series} value ({m})")

    if step.op == "bins":
        m = _need(src, step.measure, "measure", measures_only=True)
        k = step.bins or 10
        if not 2 <= k <= MAX_BINS:
            raise StepError(Problem(f"bins must be 2 … {MAX_BINS}", "send bins = 5 to 10"))
        vals = [v for r in rows if (v := _num(r.get(m))) is not None]
        if len(vals) < 5:
            raise StepError(Problem(f"only {len(vals)} values: too few for a histogram", "chart the dataset itself"))
        lo, hi = min(vals), max(vals)
        if lo == hi:
            raise StepError(Problem(f"every {m} is {_tidy(lo)}: there is nothing to spread", "chart the dataset itself"))
        integral = all(float(v).is_integer() for v in vals)
        width = (hi - lo) / k
        if integral:
            width = max(1, math.ceil(width))
        edges = [lo + i * width for i in range(k + 1)]
        counts = [0] * k
        for v in vals:
            counts[min(int((v - lo) // width), k - 1)] += 1
        rng, cnt = f"{m}_range", f"{m}_count"

        def span(a: float, b: float, last: bool) -> str:
            if integral:
                top = int(b) if last else int(b) - 1
                return f"{int(a)}" if top <= int(a) else f"{int(a)}-{top}"
            return f"{_tidy(a)}-{_tidy(b)}"

        out = [{rng: span(edges[i], edges[i + 1] if i < k - 1 else hi, i == k - 1), cnt: counts[i]} for i in range(k)]
        cols = [OutputColumn(name=rng, kind="dimension"), OutputColumn(name=cnt, kind="metric")]
        return Dataset(out, cols, {rng: _label(src, m), cnt: step.label or "count"}, {cnt},
                       f"how many rows fall in each of {k} ranges of {m}")

    if step.op == "running_total":
        x = _need(src, step.x, "x")
        m = _need(src, step.measure, "measure", measures_only=True)
        _additive(src, m)
        xcol = src.column(x)
        out, total = [], 0.0
        ordered = sorted(rows, key=lambda r: str(r.get(x))) if xcol and xcol.time_grain else rows
        name = f"{m}_running_total"
        for r in ordered:
            total += _num(r.get(m)) or 0
            out.append({**r, name: _tidy(total)})
        unit = (src.column(m) or OutputColumn(name=m, kind="metric")).unit
        labels = {**src.labels, name: step.label or f"{_label(src, m)} (Σ)"}
        return Dataset(out, [*src.columns, OutputColumn(name=name, kind="metric", unit=unit)], labels,
                       src.additive, f"{m} added up along {x}")

    if step.op == "regroup":
        by = _need(src, step.by, "by")
        agg = step.agg or "sum"
        m = None if agg == "count" else _need(src, step.measure, "measure", measures_only=True)
        if agg == "sum" and m:
            _additive(src, m)
        groups: dict[str, list[dict[str, Any]]] = {}
        for r in rows:
            groups.setdefault(str(r.get(by)), []).append(r)
        name = f"{agg}_{m}" if m else "count"
        out = []
        for rs in groups.values():
            vals = [v for r in rs if (v := _num(r.get(m))) is not None] if m else []
            value: float | None = {
                "count": len(rs), "sum": sum(vals), "avg": sum(vals) / len(vals) if vals else None,
                "min": min(vals) if vals else None, "max": max(vals) if vals else None}[agg]
            out.append({by: rs[0].get(by), name: None if value is None else _tidy(value)})
        bycol = src.column(by)
        assert bycol is not None
        unit = (src.column(m) or bycol).unit if m else None
        base = _label(src, m) if m else ""
        labels = {by: _label(src, by), name: step.label or (f"{base} ({agg})" if m else "count")}
        return Dataset(out, [bycol, OutputColumn(name=name, kind="metric", unit=unit)], labels,
                       {name} if agg in ("sum", "count") else set(), f"{agg} of {m or 'rows'} by {by}")

    raise StepError(Problem(f"unknown transform {step.op!r}", "use top_n_other, pivot, bins, running_total, "
                            "regroup or sort_rows"))


def build(original: Dataset, steps: list[DataStep]) -> dict[str, Dataset]:
    """Every dataset the steps make (a step that fails now is left out; charts on it are dropped)."""
    out = {ORIGINAL: original}
    for s in steps:
        try:
            out[s.key] = apply(s, out)
        except StepError:
            continue
    return out
