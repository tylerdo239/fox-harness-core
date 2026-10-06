"""Edit toolkit of step 6 (present the answer): chart datasets and charts.

The query result is the dataset "original". Transform tools make new datasets from it (d1, d2, …:
top N + other, pivot, histogram bins, running total, regroup, sort; pipeline_v4/chart_data.py), and
add_chart draws one dataset. ChartTools checks every chart against its dataset: the columns say which
is a grouping, a name, a time step or a measure, and the rows say how many groups there are and
whether values are numbers. Charts never carry code: steps are replayed by code in present.py.
"""

from typing import Any, ClassVar

from src.pipeline_v4.agents.base import Draft
from src.pipeline_v4.agents.parts import ChartPick, ChartsOut, DataStep
from src.pipeline_v4.chart_data import ORIGINAL, Dataset, StepError, apply, build
from src.pipeline_v4.tools.drafts import DraftToolkit
from src.pipeline_v4.tools.guide import Problem, Run, options

MAX_CHARTS = 5
MAX_DATASETS = 6
MAX_PIE_SLICES = 10
MAX_BARS = 50
MAX_TREEMAP = 60
PREVIEW_ROWS = 5

CHART_TYPES = ("bar", "bar_horizontal", "stacked_bar", "line", "area", "stacked_area", "pie", "donut", "scatter",
               "combo", "treemap")
TIME_ONLY = ("line", "area", "stacked_area")         # x must be a time step
SHARE = ("pie", "donut", "treemap")                  # parts of a whole: one non-negative measure
STACKED = ("stacked_bar", "stacked_area")            # parts of a whole per x: 2+ measures


def _number(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, int | float):
        return True
    try:
        float(str(v))
        return True
    except (TypeError, ValueError):
        return False


def preview(ds: Dataset) -> str:
    cols = [c.name for c in ds.columns]
    head = "| " + " | ".join(cols) + " |"
    def line(r: dict[str, Any]) -> str:
        return "| " + " | ".join("" if r.get(c) is None else str(r.get(c)) for c in cols) + " |"

    if len(ds.rows) <= PREVIEW_ROWS:
        return "\n".join([head, *map(line, ds.rows)])
    # the first rows and the last one (where a transform puts its "other" row)
    hidden = len(ds.rows) - PREVIEW_ROWS
    return "\n".join([head, *map(line, ds.rows[:PREVIEW_ROWS - 1]), f"… {hidden} more rows", line(ds.rows[-1])])


class ChartTools(DraftToolkit):
    parts: ClassVar = {"charts": lambda x: x.title}

    def __init__(self, draft: Draft[ChartsOut], original: Dataset, **kwargs: Any) -> None:
        self.original = original
        self.datasets = build(original, draft.value.datasets)
        super().__init__("chart_tools", draft, [
            self.top_n_other, self.pivot, self.bins, self.running_total, self.regroup, self.sort_rows,
            self.add_chart,
        ], **kwargs)

    # ── datasets ──

    def _derive(self, step: dict[str, Any]) -> str:
        if len(self.draft.value.datasets) >= MAX_DATASETS:
            return self.error(f"there are already {MAX_DATASETS} datasets", "add_chart on one of them, or call done")
        key = f"d{len(self.draft.value.datasets) + 1}"
        ds_step = DataStep(key=key, **{k: v for k, v in step.items() if v not in (None, "")})
        if ds_step.source not in self.datasets:
            return self.error(f"no dataset {ds_step.source!r}", f"send source as one of: {options(self.datasets)}")
        try:
            ds = apply(ds_step, self.datasets)
        except StepError as err:
            return self.error(err.problem)
        if not ds.rows:
            return self.error("the transform leaves no rows", "chart the source dataset itself")
        self.draft.value.datasets.append(ds_step)
        self.datasets[key] = ds
        measures = ", ".join(ds.measures) or "none"
        return self.ok(f"dataset {key}: {ds.note}; {len(ds.rows)} rows; split by: {', '.join(ds.splits) or 'none'}; "
                       f"measures: {measures}\n{preview(ds)}\nNext: add_chart(data={key!r}, …)")

    async def top_n_other(self, measure: str, n: int, other_label: str, source: str = ORIGINAL) -> str:
        """Keep the n largest rows of a measure and add the rest up into one row (too many groups for a
        pie, a treemap or a readable bar).

        Args:
            measure: an additive measure (a count or a sum) of the source.
            n: how many of the largest rows to keep (e.g. 5 to 9).
            other_label: the name of the row that adds up the rest, in the question's language.
            source: the dataset to start from (default original).
        """
        return self._derive({"op": "top_n_other", "source": source, "measure": measure, "n": n, "label": other_label})

    async def pivot(self, x: str, series: str, measure: str, source: str = ORIGINAL) -> str:
        """Turn a result split by two things into one row per x and one column per value of series
        (for a stacked_bar, stacked_area or a multi-line chart).

        Args:
            x: the column for the x axis (often a time step or the main grouping).
            series: the column whose values become the series (at most 8 values).
            measure: the measure in each cell.
            source: the dataset to start from (default original).
        """
        return self._derive({"op": "pivot", "source": source, "x": x, "series": series, "measure": measure})

    async def bins(self, measure: str, bins: int = 8, label: str = "", source: str = ORIGINAL) -> str:
        """A histogram: how many rows fall in each range of a measure (how values are spread).

        Args:
            measure: the measure to spread.
            bins: number of ranges, 2-20.
            label: the name of the count column, in the question's language (what the rows are).
            source: the dataset to start from (default original).
        """
        return self._derive({"op": "bins", "source": source, "measure": measure, "bins": bins, "label": label})

    async def running_total(self, x: str, measure: str, label: str = "", source: str = ORIGINAL) -> str:
        """Add a column with the measure added up along x (cumulative growth over time).

        Args:
            x: the column the total runs along (a time step).
            measure: an additive measure (a count or a sum).
            label: the name of the new column, in the question's language.
            source: the dataset to start from (default original).
        """
        return self._derive({"op": "running_total", "source": source, "x": x, "measure": measure, "label": label})

    async def regroup(self, by: str, agg: str, measure: str = "", label: str = "", source: str = ORIGINAL) -> str:
        """Aggregate the rows again by one column (e.g. a result split by two things, summed per one).

        Args:
            by: the column to group by.
            agg: sum, avg, min, max or count (count needs no measure).
            measure: the measure to aggregate.
            label: the name of the new column, in the question's language.
            source: the dataset to start from (default original).
        """
        if agg not in ("sum", "avg", "min", "max", "count"):
            return self.error(f"agg {agg!r} is unknown", "send agg as one of: sum, avg, min, max, count")
        return self._derive({"op": "regroup", "source": source, "by": by, "agg": agg, "measure": measure or None,
                             "label": label})

    async def sort_rows(self, by: str, direction: str = "desc", n: int = 0, source: str = ORIGINAL) -> str:
        """Order the rows by a column and optionally keep the first n.

        Args:
            by: the column to order by.
            direction: desc (largest first) or asc.
            n: keep only the first n rows (0 keeps all).
            source: the dataset to start from (default original).
        """
        if direction not in ("asc", "desc"):
            return self.error(f"direction {direction!r} is unknown", "send direction as asc or desc")
        return self._derive({"op": "sort_rows", "source": source, "by": by, "direction": direction, "n": n or None})

    # ── charts ──

    def _numeric(self, ds: Dataset, name: str) -> bool:
        c = ds.column(name)
        if c is not None and c.kind in ("metric", "derived"):
            return True
        values = [r.get(name) for r in ds.rows if r.get(name) is not None]
        return bool(values) and all(_number(v) for v in values)

    def _problem(self, ds: Dataset, data: str, ctype: str, x: str, y: list[str], title: str) -> str:
        measures, splits = ds.measures, ds.splits

        def again(**change: Any) -> Run:
            args = {"type": ctype, "x": x, "y": list(dict.fromkeys(y)), "title": title, "data": data, **change}
            return Run.of("add_chart", **args)

        unknown = [n for n in [x, *y] if ds.column(n) is None]
        if unknown:
            return Problem(f"not columns of dataset {data}: {', '.join(unknown)}",
                           f"x is one of: {options(splits)}; y is one or more of: {options(measures)}")
        if not y:
            return Problem("y is empty", again(y=measures[:1]) if measures else "call done: the data has no measure")
        xcol = ds.column(x)
        assert xcol is not None
        if ctype == "scatter":
            if len(y) != 1 or x == y[0] or not (self._numeric(ds, x) and self._numeric(ds, y[0])):
                bar_y = [n for n in dict.fromkeys([x, *y]) if n in measures][:1] or measures[:1]
                return Problem("a scatter needs two different numeric measures (x and one y)",
                               again(type="bar", x=splits[0], y=bar_y) if splits and bar_y else "call done")
            return ""
        if xcol.kind in ("metric", "derived"):
            return Problem(f"{x} is a measure; x is what the values are split by (a name, category or time)",
                           again(x=splits[0]) if splits else f"x is one of: {options(splits)}")
        if f"{x}_label" in {c.name for c in ds.columns}:
            return Problem(f"{x} is an id; the chart must show names", again(x=f"{x}_label"))
        not_numeric = [n for n in y if not self._numeric(ds, n)]
        if not_numeric:
            keep = [n for n in y if n not in not_numeric] or measures[:1]
            return Problem(f"y must be numeric measures; not numeric: {', '.join(not_numeric)}",
                           again(y=keep) if keep else "call done: the data has no measure")
        groups = len({str(r.get(x)) for r in ds.rows})
        if groups < len(ds.rows):
            others = [n for n in splits if n != x]
            fix: list[Any] = []
            if y[0] in ds.additive:
                fix.append(Run.of("regroup", by=x, agg="sum", measure=y[0], source=data))
            if others:
                fix.append(f"pivot(x={x!r}, series={others[0]!r}, measure={y[0]!r}) for a stacked chart")
            return Problem(f"{x} repeats: the dataset has {len(ds.rows)} rows for {groups} values of {x}"
                           + (f" (it is split by {', '.join(others)} too)" if others else ""),
                           *fix, "use an x whose values do not repeat")
        if ctype in TIME_ONLY and not xcol.time_grain:
            return Problem(f"a {ctype} follows time and {x} is not a time step",
                           again(type="stacked_bar" if ctype == "stacked_area" else "bar"))
        if ctype in SHARE:
            if len(y) != 1:
                return Problem(f"a {ctype} shows one measure", again(y=y[:1]))
            if ds.column(y[0]) and ds.column(y[0]).kind == "derived":  # type: ignore[union-attr]
                return Problem(f"a {ctype} shows the share of a measure (the share is computed for you)",
                               again(type="bar"))
            if xcol.time_grain:
                return Problem(f"a {ctype} is not for time steps", again(type="line"))
            if any(_number(r.get(y[0])) and float(r[y[0]]) < 0 for r in ds.rows):
                return Problem(f"a {ctype} can't show negative values", again(type="bar"))
            limit = MAX_TREEMAP if ctype == "treemap" else MAX_PIE_SLICES
            if groups > limit:
                fix = (Run.of("top_n_other", measure=y[0], n=limit - 1, other_label="<other, in the question's "
                              "language>", source=data) if y[0] in ds.additive else again(type="bar_horizontal"))
                return Problem(f"{groups} groups is too many for a {ctype} (at most {limit})", fix,
                               "use bar_horizontal instead")
        if ctype in STACKED and len(y) < 2:
            return Problem(f"a {ctype} stacks 2 or more measures (parts of each x)",
                           "pivot first (series = the second grouping), then chart its columns as y"
                           if len(splits) >= 2 else again(type="bar" if ctype == "stacked_bar" else "area"))
        if ctype in STACKED and any(n not in ds.additive for n in y):
            return Problem(f"a {ctype} adds the measures up, and {', '.join(n for n in y if n not in ds.additive)} "
                           "can't be added up", again(type="bar" if ctype == "stacked_bar" else "line"))
        if ctype == "combo" and len(y) != 2:
            return Problem("a combo shows exactly two measures: y[0] as bars, y[1] as a line on its own axis",
                           again(y=measures[:2]) if len(measures) >= 2 else again(type="bar", y=y[:1]))
        if ctype in ("bar", "bar_horizontal", "stacked_bar", "combo") and groups > MAX_BARS:
            return Problem(f"{groups} groups is too many bars (at most {MAX_BARS})",
                           Run.of("sort_rows", by=y[0], direction="desc", n=20, source=data),
                           "call done: the data table shows every row")
        return ""

    async def add_chart(self, type: str, x: str, y: list[str], title: str, data: str = ORIGINAL,  # noqa: A002
                        recommended: bool = False) -> str:
        """Add a chart of a dataset.

        Args:
            type: bar (compare groups), bar_horizontal (many groups or long names, rankings), stacked_bar
                (parts of each group: 2+ measures, e.g. pivot columns), line (a trend over time), area (a
                volume over time), stacked_area (parts of a total over time), pie / donut (each group's
                share of one measure, few groups), treemap (shares among many groups), scatter (two
                measures against each other), combo (two measures of different scale: y[0] bars, y[1] line).
            x: the column the values are split by (a name, category or time); for scatter, a measure.
            y: the measure column(s) to plot.
            title: a short title in the question's language.
            data: the dataset to draw: original (the query result) or one made by a transform (d1, d2, …).
            recommended: true for the single best chart.
        """
        if type not in CHART_TYPES:
            return self.error(f"chart type {type!r} is unknown", f"send type as one of: {', '.join(CHART_TYPES)}")
        if len(self.draft.value.charts) >= MAX_CHARTS:
            return self.error(f"there are already {MAX_CHARTS} charts, the most allowed", "call done")
        ds = self.datasets.get(data)
        if ds is None:
            return self.error(f"no dataset {data!r}", f"send data as one of: {options(self.datasets)}")
        if (problem := self._problem(ds, data, type, x, list(y), title)):
            return self.error(problem)
        if any(c.type == type and c.x == x and c.y == list(y) and c.data == data for c in self.draft.value.charts):
            return self.duplicate(f"a {type} chart of {', '.join(y)} by {x}")
        if not title.strip():
            return self.error("the title is empty", "send a short title in the question's language")
        if recommended:
            for c in self.draft.value.charts:
                c.recommended = False
        self.draft.value.charts.append(ChartPick(type=type, x=x, y=list(y), title=title.strip(),  # type: ignore[arg-type]
                                                 recommended=recommended, data=data))
        return self.ok(f"{type} chart of {', '.join(y)} by {x} (data {data})")
